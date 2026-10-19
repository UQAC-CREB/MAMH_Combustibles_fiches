# -*- coding: utf-8 -*-
"""
build_vectors.py — Données vectorielles de l'application v2

Sorties (data/) :
  units.geojson        unités territoriales (MRC + subdivisions régime de feux), EXPO, RANG
  regime.geojson       contour des zones de régime de feux (séries longues validées)
  lh.json              lieux habités (+ toponymes autochtones, brouillon)
  pts_origine.json     points d'origine 1972-2024 (colonnes compactes)
  ../tiles_v2/feux.fgb contours de feux (FlatGeobuf indexé, lecture par emprise ; R2)
  unit_stats.json      occurrences / superficies brûlées par unité et par année (exact)
  grid_burn.bin.gz     superficies brûlées par cellule 1 km et par année (zones libres)

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
# 2. Unités territoriales
# ════════════════════════════════════════════════════════════════════════════
log("Unités territoriales")
units = gpd.read_file(UNITS_SHP).to_crs(CRS_LCC)
units["geometry"] = shapely.make_valid(units.geometry.values)
units = units.dissolve(by="MRC_IDm", aggfunc="first", as_index=False)
units["MOD_NM_MRC"] = units.MOD_NM_MRC.str.strip()

v1 = gpd.read_file(V1_MRC_GEOJSON)
v1 = v1.drop_duplicates("MRC_IDm").set_index("MRC_IDm")
units["EXPO"] = units.MRC_IDm.map(v1.EXPO).fillna(0.0).astype(float).round(2)
units["RANG"] = units.MRC_IDm.map(v1.RANG).fillna("")
units["IN_V1"] = units.MRC_IDm.isin(v1.index)

area = units.geometry.area
reg_frac = shapely.area(shapely.intersection(units.geometry.values, regime_union)) / area
units["LR"] = (reg_frac > 0.5)          # série longue (unité dans un régime de feux)
units["AREA_HA"] = (area / 1e4).round(0)
units = units.sort_values("MRC_IDm").reset_index(drop=True)
units["uid"] = np.arange(len(units), dtype=np.int32)   # index compact (rasterisation)
log(f"  {len(units)} unités, {int(units.LR.sum())} en série longue, {int((~units.IN_V1).sum())} hors indice v1 (EXPO=0)")

u_out = units[["uid", "MRC_IDm", "MOD_NM_MRC", "MRS_NM_MRC", "EXPO", "RANG", "LR", "AREA_HA", "geometry"]].copy()
u_out.columns = ["uid", "id", "nom", "mrc", "expo", "rang", "lr", "ha", "geometry"]
u_out["geometry"] = u_out.geometry.simplify(150, preserve_topology=True)
u_out = u_out.to_crs(4326)
u_out.to_file(OUT / "units.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
log(f"  → units.geojson ({(OUT/'units.geojson').stat().st_size/1024:.0f} Ko)")
units[["uid", "MRC_IDm", "geometry"]].to_file(OUT.parent / "scripts" / "_units_lcc.gpkg", driver="GPKG")

# ════════════════════════════════════════════════════════════════════════════
# 3. Lieux habités
# ════════════════════════════════════════════════════════════════════════════
log("Lieux habités")
lh = gpd.read_file(V1_LH_GEOJSON).to_crs(CRS_LCC)
src = gpd.read_file(LIEUHABITE).to_crs(CRS_LCC)[["nomcartrou", "typentitto", "mus_de_ind", "geometry"]]
lh = gpd.sjoin_nearest(lh, src.rename(columns={"nomcartrou": "nom_src"}), how="left", max_distance=500)
lh = lh[~lh.index.duplicated()]
topo = pd.read_csv(OUT.parent / "scripts" / "toponymes_autochtones.csv", sep=";", dtype=str).fillna("")
topo = topo.set_index("nomcartrou")

# Unité : celle de la LUT v1 si elle existe dans les unités, sinon jointure spatiale
uj = gpd.sjoin(lh[["lH_ID", "geometry"]], units[["MRC_IDm", "geometry"]], predicate="within", how="left")
uj = uj[~uj.index.duplicated()]
# Lieux hors de toute unité (côte, îles) : unité la plus proche
nn = gpd.sjoin_nearest(lh[["geometry"]], units[["MRC_IDm", "geometry"]], how="left")
nn = nn[~nn.index.duplicated()]
uj["MRC_IDm"] = uj.MRC_IDm.fillna(nn.MRC_IDm)
valid_ids = set(units.MRC_IDm)
lh["unit"] = [m if m in valid_ids else s for m, s in zip(lh.MRC_IDm, uj.MRC_IDm)]

ll = lh.to_crs(4326)
rows = []
for i, r in ll.iterrows():
    t = topo.loc[r.nomcartrou] if r.nomcartrou in topo.index else None
    auto = bool(t is not None) or (r.get("mus_de_ind") == "Territoire autochtone")
    rows.append({
        "id": r.lH_ID, "nom": r.nomcartrou, "mun": r.MUS_NM_MUN, "u": r.unit,
        "x": round(r.geometry.x, 5), "y": round(r.geometry.y, 5),
        **({"na": t.nom_autochtone, "al": t.alias, "nat": t.nation} if t is not None else {}),
        **({"aut": 1} if auto else {}),
    })
lh_lcc = lh[["lH_ID", "geometry"]].reset_index(drop=True)
lh_lcc.to_file(OUT.parent / "scripts" / "_lh_lcc.gpkg", driver="GPKG")
write_json("lh.json", rows)
log(f"  {len(rows)} lieux, {sum('na' in r for r in rows)} toponymes autochtones")

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

pt_lcc = pt.to_crs(CRS_LCC)
pj = gpd.sjoin(pt_lcc[["ANNEE", "geometry"]].assign(c=cause), units[["MRC_IDm", "LR", "geometry"]],
               predicate="within", how="inner")

# ════════════════════════════════════════════════════════════════════════════
# 5. Contours de feux (récents + anciens validés)
# ════════════════════════════════════════════════════════════════════════════
log("Feux récents")
fr = pyogrio.read_dataframe(FEUX_GDB, layer="FEUX_PROV", columns=["EXERCICE", "SUPERFICIE"])
fr["EXERCICE"] = pd.to_numeric(fr.EXERCICE, errors="coerce")
fr = fr[fr.EXERCICE.between(1976, YEAR_END)]
fr["geometry"] = shapely.make_valid(fr.geometry.values)
fr["t"] = 0
log(f"  {len(fr)} feux récents")

log("Feux anciens (découpés aux zones de régime)")
fa = pyogrio.read_dataframe(FEUX_ANC_GDB, layer="FEUX_ANCIENS_PROV", columns=["EXERCICE", "SUPERFICIE"])
fa["EXERCICE"] = pd.to_numeric(fa.EXERCICE, errors="coerce")
fa = fa[fa.EXERCICE < 1976]
fa["geometry"] = shapely.make_valid(fa.geometry.values)
fa["geometry"] = shapely.intersection(fa.geometry.values, regime_union)
fa = fa[~fa.geometry.is_empty]
fa["t"] = 1
log(f"  {len(fa)} feux anciens dans les régimes")

feux = pd.concat([fr, fa], ignore_index=True)
feux = gpd.GeoDataFrame(feux, geometry="geometry", crs=CRS_LCC)
feux = feux[feux.geometry.geom_type.isin(["Polygon", "MultiPolygon", "GeometryCollection"])]
feux["geometry"] = shapely.make_valid(feux.geometry.values)
feux["geometry"] = [g if g.geom_type != "GeometryCollection" else
                    shapely.union_all([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
                    for g in feux.geometry.values]
feux = feux[~feux.geometry.is_empty]
feux["area_ha"] = feux.geometry.area / 1e4
feux["an"] = feux.EXERCICE.astype(int)

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
# 6. Statistiques exactes par unité
# ════════════════════════════════════════════════════════════════════════════
log("Intersection feux × unités")
ov = gpd.overlay(feux[["an", "t", "geometry"]], units[["MRC_IDm", "LR", "geometry"]],
                 how="intersection", keep_geom_type=True)
ov["ha"] = ov.geometry.area / 1e4
ov = ov[(ov.t == 0) | ov.LR]                 # anciens : seulement unités en régime
sup = ov.groupby(["MRC_IDm", "an"]).ha.sum()
occ = pj.groupby(["MRC_IDm", "ANNEE", "c"]).size()

stats = {}
for _, u in units.iterrows():
    uid = u.MRC_IDm
    s = sup.loc[uid] if uid in sup.index.get_level_values(0) else pd.Series(dtype=float)
    o = occ.loc[uid] if uid in occ.index.get_level_values(0) else pd.Series(dtype=int)
    # Début de série : points d'origine dès 1972 ; feux anciens (régimes) avant
    y0 = 1972
    if u.LR and len(s):
        y0 = min(int(s.index.min()), 1972)
    years = list(range(y0, YEAR_END + 1))
    rec = {"y0": y0,
           "sup": [round(float(s.get(y, 0.0)), 1) for y in years],
           "h": [int(o.get((y, 0), 0)) for y in years],
           "f": [int(o.get((y, 1), 0)) for y in years]}
    stats[uid] = rec
write_json("unit_stats.json", stats)

# Contrôle : MRC_93A vs fiche R (1918 ≈ 23 000 ha ; 1987 = 23 feux)
c = stats.get("MRC_93A")
if c:
    y0 = c["y0"]
    log(f"  contrôle MRC_93A : y0={y0}, sup1918={c['sup'][1918-y0]:.0f} ha, feux1987={c['h'][1987-y0]+c['f'][1987-y0]}")

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
