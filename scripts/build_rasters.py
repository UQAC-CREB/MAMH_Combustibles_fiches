# -*- coding: utf-8 -*-
"""
build_rasters.py — Statistiques raster (combustibles 2025, potentiel I/P 25-26)

Sorties (data/) :
  rings.bin.gz     nb de pixels 25 m par anneau de 1 km (0-50 km) et par classe,
                   pour chaque lieu habité (ordre de lh.json). Le navigateur additionne
                   les anneaux jusqu'au rayon choisi → zone tampon variable instantanée.
  grid_fuel.bin.gz pixels combustibles par cellule 1 km (dénominateur des taux, zones libres)
  unit_fuel.json   superficie combustible (ha) exacte par unité (dénominateur des taux, MRC)
  classes.json     classes, couleurs et libellés (LUT)

Prérequis : build_vectors.py (fichiers _units_lcc.gpkg et _lh_lcc.gpkg).
"""
import gzip, json, struct, time
from multiprocessing import Pool
import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from rasterio.windows import Window
from rasterio.features import rasterize

from config import *

BLOCK = 1000                     # lignes par bloc (multiple de 40 → cellules 1 km entières)
CELL = GRID_RES // 25            # 40 pixels par cellule
R_PX = RING_KM * 1000 // 25      # 2000 pixels

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

# ── LUT ────────────────────────────────────────────────────────────────────
lut_c = pd.read_csv(LUT_COMB, sep=";", encoding="latin-1")
lut_c = lut_c[["TYPE", "ABB_F", "VALUE", "TYPE_F", "HEX_CODE", "CODE_CL", "CLASS_GLOBAL"]].dropna(subset=["VALUE"])
lut_c["VALUE"] = lut_c.VALUE.astype(int)
lut_p = pd.read_csv(LUT_POT, sep=";", encoding="latin-1")
NC, NP = len(lut_c), len(lut_p)

# valeur raster → index compact (NC = nodata/inconnu)
MAP_C = np.full(256, NC, dtype=np.uint8)
for i, v in enumerate(lut_c.VALUE): MAP_C[v] = i
FUEL_C = np.zeros(256, dtype=bool)
for v in lut_c.VALUE:
    if v not in NFUEL_CODES: FUEL_C[v] = True
MAP_P = np.full(256, NP, dtype=np.uint8)
for i, v in enumerate(lut_p.VALUE.astype(int)): MAP_P[v] = i

# Gabarit d'anneaux (pixel → n° d'anneau, 255 au-delà de 50 km)
yy, xx = np.mgrid[-R_PX:R_PX + 1, -R_PX:R_PX + 1]
RING = np.floor(np.hypot(yy, xx) * 25 / 1000).astype(np.uint16)
RING[RING >= RING_KM] = 255
del yy, xx


def lh_pixels(transform):
    lh = gpd.read_file(OUT.parent / "scripts" / "_lh_lcc.gpkg")
    inv = ~transform
    cols, rows = inv * (lh.geometry.x.values, lh.geometry.y.values)
    return np.floor(rows).astype(int), np.floor(cols).astype(int)


def ring_block(arr, b0, lrows, lcols, mapping, nk):
    """Accumule les comptes par anneau/classe pour les lieux touchant le bloc [b0, b0+h)."""
    h, w = arr.shape
    out = np.zeros((len(lrows), RING_KM, nk), dtype=np.uint32)
    vals = mapping[arr]                                       # uint8, classes compactes
    nbin = 256 * (nk + 1)
    for i, (r, c) in enumerate(zip(lrows, lcols)):
        r0, r1 = max(r - R_PX, b0), min(r + R_PX + 1, b0 + h)
        if r0 >= r1: continue
        c0, c1 = max(c - R_PX, 0), min(c + R_PX + 1, w)
        if c0 >= c1: continue
        t = RING[r0 - (r - R_PX): r1 - (r - R_PX), c0 - (c - R_PX): c1 - (c - R_PX)]
        v = vals[r0 - b0: r1 - b0, c0:c1]
        cnt = np.bincount((t.astype(np.uint32) * (nk + 1) + v).ravel(), minlength=nbin)
        out[i] = cnt[: RING_KM * (nk + 1)].reshape(RING_KM, nk + 1)[:, :nk]
    return out


def work_comb(b0):
    with rasterio.open(COMB_TIF) as s:
        h = min(BLOCK, s.height - b0)
        arr = s.read(1, window=Window(0, b0, s.width, h))
        tr = s.transform
        W = s.width
    # 1. Anneaux
    lrows, lcols = LH_C
    sel = np.where((lrows + R_PX >= b0) & (lrows - R_PX < b0 + h))[0]
    rings = ring_block(arr, b0, lrows[sel], lcols[sel], MAP_C, NC)
    # 2. Grille 1 km : pixels combustibles
    fuel = FUEL_C[arr]
    ncell_c = int(np.ceil(W / CELL)); nrow_c = int(np.ceil(h / CELL))
    pad = np.zeros((nrow_c * CELL, ncell_c * CELL), dtype=np.uint8)
    pad[:h, :W] = fuel
    grid = pad.reshape(nrow_c, CELL, ncell_c, CELL).sum(axis=(1, 3)).astype(np.uint16)
    # 3. Superficie combustible par unité
    btr = tr * tr.translation(0, b0)
    shapes = [(g, int(u) + 1) for g, u in zip(UNITS.geometry.values, UNITS.uid.values)]
    ur = rasterize(shapes, out_shape=(h, W), transform=btr, fill=0, dtype="uint8")
    ufuel = np.bincount(ur[fuel], minlength=256)
    return b0, sel, rings, grid, ufuel


def work_pot(b0):
    with rasterio.open(POT_TIF) as s:
        h = min(BLOCK, s.height - b0)
        arr = s.read(1, window=Window(0, b0, s.width, h))
    lrows, lcols = LH_P
    sel = np.where((lrows + R_PX >= b0) & (lrows - R_PX < b0 + h))[0]
    return b0, sel, ring_block(arr, b0, lrows[sel], lcols[sel], MAP_P, NP)


def init_worker():
    global LH_C, LH_P, UNITS
    with rasterio.open(COMB_TIF) as s: LH_C = lh_pixels(s.transform)
    with rasterio.open(POT_TIF) as s: LH_P = lh_pixels(s.transform)
    UNITS = gpd.read_file(OUT.parent / "scripts" / "_units_lcc.gpkg")
    UNITS["geometry"] = UNITS.geometry.simplify(10)


if __name__ == "__main__":
    nlh = len(gpd.read_file(OUT.parent / "scripts" / "_lh_lcc.gpkg"))
    units = gpd.read_file(OUT.parent / "scripts" / "_units_lcc.gpkg")
    with rasterio.open(COMB_TIF) as s: HC, WC = s.height, s.width
    with rasterio.open(POT_TIF) as s: HP = s.height

    rings_c = np.zeros((nlh, RING_KM, NC), dtype=np.uint32)
    rings_p = np.zeros((nlh, RING_KM, NP), dtype=np.uint32)
    grid_rows = {}
    ufuel = np.zeros(256, dtype=np.int64)

    with Pool(7, initializer=init_worker) as pool:
        log(f"Combustibles : {int(np.ceil(HC/BLOCK))} blocs")
        for k, (b0, sel, r, g, uf) in enumerate(pool.imap_unordered(work_comb, range(0, HC, BLOCK))):
            rings_c[sel] += r; grid_rows[b0] = g; ufuel += uf
            log(f"  comb bloc {b0} ({k+1})")
        log("Potentiel I/P")
        for k, (b0, sel, r) in enumerate(pool.imap_unordered(work_pot, range(0, HP, BLOCK))):
            rings_p[sel] += r
            log(f"  pot bloc {b0} ({k+1})")

    # ── rings.bin.gz : en-tête JSON + Uint32 [nlh][50][NC] + Uint32 [nlh][50][NP]
    meta = {"nlh": nlh, "nr": RING_KM, "nc": NC, "np": NP, "px_ha": 0.0625}
    hdr = json.dumps(meta).encode()
    raw = struct.pack("<I", len(hdr)) + hdr + b"\0" * ((4 - (4 + len(hdr)) % 4) % 4)
    raw += rings_c.astype("<u4").tobytes() + rings_p.astype("<u4").tobytes()
    (OUT / "rings.bin.gz").write_bytes(gzip.compress(raw, 9))
    log(f"→ rings.bin.gz ({(OUT/'rings.bin.gz').stat().st_size/1e6:.1f} Mo)")

    # ── grid_fuel.bin.gz : Uint16 [nrows][ncols] (pixels combustibles 25 m par km²)
    grid = np.concatenate([grid_rows[b] for b in sorted(grid_rows)], axis=0)
    with rasterio.open(COMB_TIF) as s:
        meta = {"ncols": grid.shape[1], "nrows": grid.shape[0], "x0": s.bounds.left,
                "y0": s.bounds.top, "res": GRID_RES, "px_ha": 0.0625}
    hdr = json.dumps(meta).encode()
    raw = struct.pack("<I", len(hdr)) + hdr + b"\0" * ((4 - (4 + len(hdr)) % 4) % 4)
    raw += grid.astype("<u2").tobytes()
    (OUT / "grid_fuel.bin.gz").write_bytes(gzip.compress(raw, 9))
    log(f"→ grid_fuel.bin.gz ({(OUT/'grid_fuel.bin.gz').stat().st_size/1e6:.1f} Mo)")

    # ── unit_fuel.json
    uf = {mid: round(float(ufuel[int(u) + 1]) * 0.0625, 0) for mid, u in zip(units.MRC_IDm, units.uid)}
    (OUT / "unit_fuel.json").write_text(json.dumps(uf, ensure_ascii=False), encoding="utf-8")
    log(f"→ unit_fuel.json (MRC_93A = {uf.get('MRC_93A')} ha)")

    # ── classes.json
    classes = {
        "comb": [{"v": int(r.VALUE), "abb": r.TYPE, "lbl": r.TYPE_F.strip(), "hex": r.HEX_CODE.strip(),
                  "grp": r.CLASS_GLOBAL.strip(), "fuel": int(r.VALUE) not in NFUEL_CODES}
                 for r in lut_c.itertuples()],
        "pot": [{"v": int(r.VALUE), "lbl": r.CLASS_NM.strip(), "hex": r.HEX_CODE.strip()}
                for r in lut_p.itertuples()],
    }
    (OUT / "classes.json").write_text(json.dumps(classes, ensure_ascii=False, indent=1), encoding="utf-8")
    log("Terminé.")
