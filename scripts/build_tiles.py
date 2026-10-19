# -*- coding: utf-8 -*-
"""
build_tiles.py — Tuiles raster PMTiles (combustibles, potentiel I/P) pour la carte

Usage :  python build_tiles.py comb|pot [zmax]
Sortie : ../tiles_v2/combustibles_2025.pmtiles | potentiel_ip_2025.pmtiles
         (hors dépôt Git → à téléverser sur Cloudflare R2, voir README)

Les tuiles couvrent uniquement les zones à moins de 50 km d'un lieu habité
(rayon maximal des zones tampons de l'application), en PNG à palette (nearest).
"""
import io, sys, time, json
from multiprocessing import Pool
import numpy as np
import pandas as pd
import geopandas as gpd
import mercantile
import rasterio
import shapely
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as win_from_bounds
from pmtiles.tile import zxy_to_tileid, TileType, Compression
from pmtiles.writer import Writer

from config import *

KIND = sys.argv[1] if len(sys.argv) > 1 else "comb"
ZMIN, ZMAX = 5, int(sys.argv[2]) if len(sys.argv) > 2 else 12
TS = 256

if KIND == "comb":
    TIF, NODATA, NAME = COMB_TIF, COMB_NODATA, "combustibles_2025"
    lut = pd.read_csv(LUT_COMB, sep=";", encoding="latin-1").dropna(subset=["VALUE"])
else:
    TIF, NODATA, NAME = POT_TIF, POT_NODATA, "potentiel_ip_2025"
    lut = pd.read_csv(LUT_POT, sep=";", encoding="latin-1")

# Palette : index = valeur raster ; 255 = transparent
PAL = np.zeros((256, 3), dtype=np.uint8)
VALID = np.zeros(256, dtype=bool)
for v, h in zip(lut.VALUE.astype(int), lut.HEX_CODE.str.strip()):
    PAL[v] = [int(h[i:i + 2], 16) for i in (1, 3, 5)]
    VALID[v] = True

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:7.1f}s] {msg}", flush=True)


def init_worker():
    global SRC, TO_LCC, MASK
    SRC = rasterio.open(TIF)
    TO_LCC = Transformer.from_crs(3857, CRS_LCC, always_xy=True)
    MASK = shapely.from_wkb(open(OUT.parent / "scripts" / "_mask3857.wkb", "rb").read())
    shapely.prepare(MASK)


def render(t):
    z, x, y = t
    b = mercantile.xy_bounds(x, y, z)
    # centres des pixels de la tuile (EPSG:3857) → Lambert
    px = (b.right - b.left) / TS
    xs = b.left + (np.arange(TS) + 0.5) * px
    ys = b.top - (np.arange(TS) + 0.5) * px
    X, Y = np.meshgrid(xs, ys)
    lx, ly = TO_LCC.transform(X, Y)
    # fenêtre source + lecture décimée (utilise les aperçus .ovr aux petits zooms)
    x0, x1, y0, y1 = lx.min(), lx.max(), ly.min(), ly.max()
    win = win_from_bounds(x0 - 50, y0 - 50, x1 + 50, y1 + 50, SRC.transform)
    win = win.round_offsets().round_lengths()
    try:
        win = win.intersection(rasterio.windows.Window(0, 0, SRC.width, SRC.height))
    except rasterio.errors.WindowError:
        return t, None
    r0, c0 = int(win.row_off), int(win.col_off)
    h, w = int(win.height), int(win.width)
    if h < 1 or w < 1:
        return t, None
    # résolution de lecture ≈ taille d'un pixel de tuile (dans Lambert ~ px * facteur d'échelle)
    scale = max(1.0, (x1 - x0) / TS / 25 / 1.2)
    oh, ow = max(1, int(h / scale)), max(1, int(w / scale))
    arr = SRC.read(1, window=win, out_shape=(oh, ow), resampling=Resampling.nearest)
    inv = ~SRC.transform
    cc, rr = inv * (lx, ly)
    inside = (rr >= r0) & (rr < r0 + h) & (cc >= c0) & (cc < c0 + w)
    ri = np.clip(((rr - r0) * oh / h).astype(int), 0, oh - 1)
    ci = np.clip(((cc - c0) * ow / w).astype(int), 0, ow - 1)
    vals = np.where(inside, arr[ri, ci], NODATA)
    # masque 50 km autour des lieux habités
    m = rasterize([(MASK, 1)], out_shape=(TS, TS), transform=from_bounds(b.left, b.bottom, b.right, b.top, TS, TS),
                  fill=0, dtype="uint8", all_touched=True)
    vals = np.where((m == 1) & VALID[vals], vals, 255).astype(np.uint8)
    if (vals == 255).all():
        return t, None
    img = Image.fromarray(vals, mode="P")
    pal = PAL.copy(); img.putpalette(pal.ravel().tolist())
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True, transparency=255)
    return t, buf.getvalue()


if __name__ == "__main__":
    TILES_OUT.mkdir(exist_ok=True)
    # ── Masque : union des zones de 50 km (EPSG:3857), simplifié
    mk = OUT.parent / "scripts" / "_mask3857.wkb"
    if not mk.exists():
        lh = gpd.read_file(OUT.parent / "scripts" / "_lh_lcc.gpkg")
        u = shapely.union_all(lh.geometry.buffer(RING_KM * 1000 + 500, 32).values).simplify(200)
        u = gpd.GeoSeries([u], crs=CRS_LCC).to_crs(3857).iloc[0]
        mk.write_bytes(shapely.to_wkb(u))
    mask = shapely.from_wkb(mk.read_bytes())
    mask_ll = gpd.GeoSeries([mask], crs=3857).to_crs(4326).iloc[0]
    shapely.prepare(mask_ll)

    # ── Liste des tuiles touchant le masque
    tiles = []
    w, s, e, n = mask_ll.bounds
    for z in range(ZMIN, ZMAX + 1):
        cand = list(mercantile.tiles(w, s, e, n, z))
        boxes = shapely.box(*np.array([mercantile.bounds(t) for t in cand]).T)
        keep = shapely.intersects(mask_ll, boxes)
        tiles += [(t.z, t.x, t.y) for t, k in zip(cand, keep) if k]
        log(f"z{z}: {int(keep.sum())} tuiles")
    tiles.sort(key=lambda t: zxy_to_tileid(*t))

    out = TILES_OUT / f"{NAME}.pmtiles"
    n_ok, size = 0, 0
    with open(out, "wb") as f, Pool(8, initializer=init_worker) as pool:
        wr = Writer(f)
        for k, (t, data) in enumerate(pool.imap(render, tiles, chunksize=16)):
            if data is not None:
                wr.write_tile(zxy_to_tileid(*t), data); n_ok += 1; size += len(data)
            if k % 5000 == 0: log(f"  {k}/{len(tiles)} ({size/1e6:.0f} Mo)")
        wr.finalize(
            {"tile_type": TileType.PNG, "tile_compression": Compression.NONE,
             "min_zoom": ZMIN, "max_zoom": ZMAX,
             "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7),
             "max_lon_e7": int(e * 1e7), "max_lat_e7": int(n * 1e7),
             "center_zoom": 7, "center_lon_e7": int(-71.5e7), "center_lat_e7": int(48.5e7)},
            {"name": NAME, "attribution": "MRNF 2025 — Données Québec"},
        )
    log(f"→ {out} : {n_ok} tuiles, {out.stat().st_size/1e6:.0f} Mo")
