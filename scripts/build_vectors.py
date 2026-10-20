# -*- coding: utf-8 -*-
"""
build_vectors.py — Données vectorielles de l'application v2 (feux)

Sorties :
  data/regime.geojson     contour des zones de régime de feux (séries longues validées)
  data/pts_origine.json   points d'origine 1972-2024 (colonnes compactes)
  tiles_v2/feux.fgb       contours de feux (FlatGeobuf indexé, lecture par emprise ; R2)
  data/grid_burn.bin.gz   superficies brûlées par cellule 1 km et par année (zones libres)
  ../work_v2/_feux_lcc.gpkg  cache des feux préparés (utilisé par build_units.py)

Les unités MRC, les lieux habités et les statistiques par unité : build_units.py.

Règle « séries longues » : les feux anciens (1887-1975) ne sont comptés que dans
les zones de régime de feux (REGIME_FEUX.gdb / ZONES_FEUX), seules zones où ils
ont été validés. Les feux récents (1976+) sont comptés partout.
"""
import gzip, json, struct, time
import numpy as np
import pandas as pd
import geopandas as gpd
import pyogrio
import shapely
from shapely.geometry import box

from config import *

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

OUT.mkdir(exist_ok=True)

def write_json(name, obj):
    p = OUT / name
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    log(f"  → {name} ({p.stat().st_size/1024:.0f} Ko)")

# ════════════════════════════════════════════════════════════════════════════
# 1. Régime de feux
# ════════════════════════════════════════════════════════════════════════════
log("Régime de feux")
regime = pyogrio.read_dataframe(REGIME_GDB, layer="ZONES_FEUX")
regime = regime[regime.ZONE_ID.notna()].to_crs(CRS_LCC)
regime["geometry"] = shapely.make_valid(regime.geometry.values)
regime_union = shapely.union_all(regime.geometry.values)

reg_out = regime[["ZONE_ID", "CYCLE_FEU", "geometry"]].copy()
reg_out["geometry"] = reg_out.geometry.simplify(250)
reg_out = reg_out.to_crs(4326)
reg_out.to_file(OUT / "regime.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)

# ════════════════════════════════════════════════════════════════════════════
# ════════════════════════════════════════════════════════════════════════════
# 4. Points d'origine
# ════════════════════════════════════════════════════════════════════════════
log("Points d'origine")
pt = gpd.read_file(PT_ORI_SHP)
pt["ANNEE"] = pd.to_numeric(pt.ANNEE, errors="coerce")
pt = pt[pt.ANNEE.between(1972, YEAR_END)]
pt_ll = pt.to_crs(4326)
date = pd.to_datetime(pt.DATE_DEBUT, errors="coerce")
cause = np.where(pt.CAUSE.str.startswith("Foudre"), 1, 0)   # 0 = Humain, 1 = Foudre
pts = {
    "n": int(len(pt)),
    "x": np.round(pt_ll.geometry.x.values, 4).tolist(),
    "y": np.round(pt_ll.geometry.y.values, 4).tolist(),
    "an": pt.ANNEE.astype(int).tolist(),
    "c": cause.astype(int).tolist(),
    "j": [int(d.strftime("%m%d")) if pd.notna(d) else 0 for d in date],   # MMJJ
    "ha": np.round(pt.SUP_HA.fillna(0).values.astype(float), 1).tolist(),
}
write_json("pts_origine.json", pts)

# ════════════════════════════════════════════════════════════════════════════
# 5. Contours de feux (récents + anciens validés)
# ════════════════════════════════════════════════════════════════════════════
log("Feux récents + anciens (découpés aux zones de régime)")
from build_units import load_fires
feux = load_fires(regime_union)
feux["area_ha"] = feux.geometry.area / 1e4
log(f"  {len(feux)} feux ({int((feux.t == 1).sum())} anciens)")

# Affichage : FlatGeobuf indexé (lecture par emprise, HTTP range)
disp = feux[["an", "t", "geometry"]].copy()
disp["ha"] = np.where(feux.t == 0, feux.SUPERFICIE.fillna(feux.area_ha), feux.area_ha).round(1)
disp["geometry"] = disp.geometry.simplify(20, preserve_topology=True)
disp = disp[~disp.geometry.is_empty].to_crs(4326)
disp = disp.sort_values("ha", ascending=False)   # gros feux dessinés en premier
TILES_OUT.mkdir(exist_ok=True)
fgb = TILES_OUT / "feux.fgb"          # > 100 Mo : hébergé sur Cloudflare R2 avec les tuiles
if fgb.exists(): fgb.unlink()
pyogrio.write_dataframe(disp, fgb, driver="FlatGeobuf", SPATIAL_INDEX="YES")
log(f"  → feux.fgb ({fgb.stat().st_size/1e6:.1f} Mo, {len(disp)} polygones)")

# ════════════════════════════════════════════════════════════════════════════
# 7. Grille 1 km : superficies brûlées par cellule et par année
# ════════════════════════════════════════════════════════════════════════════
log("Grille 1 km des superficies brûlées")
import rasterio
with rasterio.open(COMB_TIF) as s:
    gx0, gy0 = s.bounds.left, s.bounds.top
    ncols = int(np.ceil((s.bounds.right - gx0) / GRID_RES))
    nrows = int(np.ceil((gy0 - s.bounds.bottom) / GRID_RES))

cells, yrs, has = [], [], []
geoms = feux.geometry.values
years_arr = feux.an.values
bounds = shapely.bounds(geoms)
for k in range(len(geoms)):
    g = geoms[k]; minx, miny, maxx, maxy = bounds[k]
    c0 = int((minx - gx0) // GRID_RES); c1 = int((maxx - gx0) // GRID_RES)
    r0 = int((gy0 - maxy) // GRID_RES); r1 = int((gy0 - miny) // GRID_RES)
    if c0 == c1 and r0 == r1:
        cells.append(np.array([r0 * ncols + c0])); has.append(np.array([g.area / 1e4]))
    else:
        cc, rr = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
        cc = cc.ravel(); rr = rr.ravel()
        bx = shapely.box(gx0 + cc * GRID_RES, gy0 - (rr + 1) * GRID_RES,
                         gx0 + (cc + 1) * GRID_RES, gy0 - rr * GRID_RES)
        shapely.prepare(g)
        a = shapely.area(shapely.intersection(g, bx)) / 1e4
        m = a > 0.005
        cells.append(rr[m] * ncols + cc[m]); has.append(a[m])
    yrs.append(np.full(len(cells[-1]), years_arr[k] - YEAR0, dtype=np.uint8))
    if k % 20000 == 0: log(f"  {k}/{len(geoms)}")

cells = np.concatenate(cells).astype(np.uint32)
yrs = np.concatenate(yrs)
has = np.concatenate(has)
df = pd.DataFrame({"c": cells, "y": yrs, "ha": has}).groupby(["c", "y"], as_index=False).ha.sum()
df["ha"] = np.minimum(df.ha, 100.0)
df = df.sort_values(["c", "y"])
n = len(df)
# Format : en-tête JSON (meta) + Uint32 cellules + Uint8 années + Uint16 dixièmes d'ha
meta = {"n": n, "ncols": ncols, "nrows": nrows, "x0": gx0, "y0": gy0, "res": GRID_RES, "year0": YEAR0}
hdr = json.dumps(meta).encode()
raw = struct.pack("<I", len(hdr)) + hdr + b"\0" * ((4 - (4 + len(hdr)) % 4) % 4)
raw += df.c.values.astype("<u4").tobytes() + df.y.values.astype("u1").tobytes()
raw += b"\0" * ((2 - n % 2) % 2) + np.round(df.ha.values * 10).astype("<u2").tobytes()
(OUT / "grid_burn.bin.gz").write_bytes(gzip.compress(raw, 9))
log(f"  → grid_burn.bin.gz ({(OUT/'grid_burn.bin.gz').stat().st_size/1e6:.1f} Mo, {n} entrées)")
log("Terminé.")
