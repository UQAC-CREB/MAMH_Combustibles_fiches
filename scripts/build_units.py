# -*- coding: utf-8 -*-
"""
build_units.py — Unités territoriales (MRC), lieux habités et statistiques par unité

Sorties (data/) :
  units.geojson     unités MRC découpées au trait de côte (parties terrestres seulement),
                    indice de prédisposition standardisé : moyenne (im) et écart-type (isd)
  lh.json           lieux habités (+ toponymes autochtones, brouillon) et leur unité
  unit_stats.json   occurrences / superficies brûlées par unité et par année (exact)
  indice.bin.gz     grille de l'indice (Float32, 5 km, EPSG:32198) : infobulle + statistiques des zones
  indice_3857.png   rendu de l'indice pour la carte (reprojeté EPSG:3857) + indice_meta.json

Feux : lus depuis ../work_v2/_feux_lcc.gpkg (créé par build_vectors.py ; sinon calculé ici).
"""
import gzip, json, struct, time
import numpy as np
import pandas as pd
import geopandas as gpd
import pyogrio
import rasterio
import shapely
from PIL import Image
from rasterio.features import rasterize
from rasterio.warp import calculate_default_transform, reproject, Resampling
from pyproj import Transformer

from config import *

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

def write_json(name, obj):
    p = OUT / name
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    log(f"  → {name} ({p.stat().st_size/1024:.0f} Ko)")

FEUX_CACHE = WORK / "_feux_lcc.gpkg"


def load_fires(regime_union):
    """Feux récents (1976+) + anciens (< 1976) découpés aux zones de régime."""
    if FEUX_CACHE.exists():
        return gpd.read_file(FEUX_CACHE)
    fr = pyogrio.read_dataframe(FEUX_GDB, layer="FEUX_PROV", columns=["EXERCICE", "SUPERFICIE"])
    fr["EXERCICE"] = pd.to_numeric(fr.EXERCICE, errors="coerce")
    fr = fr[fr.EXERCICE.between(1976, YEAR_END)]
    fr["t"] = 0
    fa = pyogrio.read_dataframe(FEUX_ANC_GDB, layer="FEUX_ANCIENS_PROV", columns=["EXERCICE", "SUPERFICIE"])
    fa["EXERCICE"] = pd.to_numeric(fa.EXERCICE, errors="coerce")
    fa = fa[fa.EXERCICE < 1976]
    fa["geometry"] = shapely.intersection(shapely.make_valid(fa.geometry.values), regime_union)
    fa["t"] = 1
    feux = gpd.GeoDataFrame(pd.concat([fr, fa], ignore_index=True), geometry="geometry", crs=CRS_LCC)
    feux["geometry"] = shapely.make_valid(feux.geometry.values)
    feux["geometry"] = [g if g.geom_type != "GeometryCollection" else
                        shapely.union_all([p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")])
                        for g in feux.geometry.values]
    feux = feux[~feux.geometry.is_empty & feux.geometry.notna()]
    feux["an"] = feux.EXERCICE.astype(int)
    feux = feux[["an", "t", "SUPERFICIE", "geometry"]]
    WORK.mkdir(exist_ok=True)
    feux.to_file(FEUX_CACHE, driver="GPKG")
    return feux


if __name__ == "__main__":
    # ── Régime de feux ────────────────────────────────────────────────────
    regime = pyogrio.read_dataframe(REGIME_GDB, layer="ZONES_FEUX")
    regime = regime[regime.ZONE_ID.notna()].to_crs(CRS_LCC)
    regime_union = shapely.union_all(shapely.make_valid(regime.geometry.values))

    # ── Unités : parties terrestres seulement (trait de côte provincial) ──
    log("Unités : découpage au trait de côte")
    prov = gpd.read_file(PROV_SHORE).to_crs(CRS_LCC)
    shore = shapely.make_valid(shapely.union_all(prov.geometry.values))
    shapely.prepare(shore)
    units = gpd.read_file(UNITS_SHP).to_crs(CRS_LCC)
    units["geometry"] = shapely.make_valid(units.geometry.values)
    units = units.dissolve(by="MRC_IDm", aggfunc="first", as_index=False)
    units["geometry"] = shapely.intersection(units.geometry.values, shore)
    units = units.explode(index_parts=False)
    units = units[units.geometry.geom_type.isin(["Polygon", "MultiPolygon"]) & (units.area > 1e4)]
    units = units.dissolve(by="MRC_IDm", aggfunc="first", as_index=False)
    units["MOD_NM_MRC"] = units.MOD_NM_MRC.str.strip()
    area = units.geometry.area
    reg_frac = shapely.area(shapely.intersection(units.geometry.values, regime_union)) / area
    units["LR"] = reg_frac > 0.5
    units["AREA_HA"] = (area / 1e4).round(0)
    units = units.sort_values("MRC_IDm").reset_index(drop=True)
    units["uid"] = np.arange(len(units), dtype=np.int32)
    log(f"  {len(units)} unités terrestres, {int(units.LR.sum())} en série longue")
    units[["uid", "MRC_IDm", "geometry"]].to_file(OUT.parent / "scripts" / "_units_lcc.gpkg", driver="GPKG")

    # ── Indice de prédisposition standardisé (5 km) ───────────────────────
    log("Indice de prédisposition")
    with rasterio.open(INDICE_TIF) as s:
        idx = s.read(1).astype(np.float32)
        itr, icrs = s.transform, s.crs
        ih, iw = s.shape
    idx[~np.isfinite(idx)] = np.nan
    im, isd, inn = [], [], []
    for g in units.geometry.values:
        m = rasterize([(g, 1)], out_shape=(ih, iw), transform=itr, fill=0, dtype="uint8")
        v = idx[(m == 1) & np.isfinite(idx)]
        if v.size == 0:                    # petite unité : pixels touchés
            m = rasterize([(g, 1)], out_shape=(ih, iw), transform=itr, fill=0, dtype="uint8", all_touched=True)
            v = idx[(m == 1) & np.isfinite(idx)]
        im.append(round(float(v.mean()), 3) if v.size else None)
        isd.append(round(float(v.std(ddof=1)), 3) if v.size > 1 else 0.0 if v.size else None)
        inn.append(int(v.size))
    units["IM"], units["ISD"], units["IN"] = im, isd, inn
    # Grille pour le navigateur : Float32 (NaN = sans donnée)
    meta = {"ncols": iw, "nrows": ih, "x0": itr.c, "y0": itr.f, "resx": itr.a, "resy": -itr.e}
    hdr = json.dumps(meta).encode()
    raw = struct.pack("<I", len(hdr)) + hdr + b"\0" * ((4 - (4 + len(hdr)) % 4) % 4) + idx.astype("<f4").tobytes()
    (OUT / "indice.bin.gz").write_bytes(gzip.compress(raw, 9))
    log(f"  → indice.bin.gz, plage {np.nanmin(idx):.3f}–{np.nanmax(idx):.3f}")

    # Rendu carte : reprojection EPSG:3857 (plus proche voisin, ~1 km) → PNG RGBA
    t, w, h = calculate_default_transform(icrs, "EPSG:3857", iw, ih, *rasterio.transform.array_bounds(ih, iw, itr), resolution=1500)
    dst = np.full((h, w), np.nan, dtype=np.float32)
    reproject(idx, dst, src_transform=itr, src_crs=icrs, dst_transform=t, dst_crs="EPSG:3857",
              resampling=Resampling.nearest, src_nodata=np.nan, dst_nodata=np.nan)
    pal = [(0.00, "#2d7a2d"), (0.07, "#8db840"), (0.15, "#d4c240"), (0.25, "#d4821a"),
           (0.38, "#c70e0e"), (0.55, "#900000"), (1.00, "#7d0404")]
    xs = [p[0] for p in pal]
    rgb = np.array([[int(c[i:i + 2], 16) for i in (1, 3, 5)] for _, c in pal], dtype=float)
    v = np.clip(np.nan_to_num(dst, nan=0), 0, 1)
    img = np.zeros((h, w, 4), dtype=np.uint8)
    for k in range(3):
        img[..., k] = np.interp(v, xs, rgb[:, k]).astype(np.uint8)
    img[..., 3] = np.where(np.isfinite(dst), 255, 0)
    Image.fromarray(img, "RGBA").save(OUT / "indice_3857.png", optimize=True)
    tr = Transformer.from_crs(3857, 4326, always_xy=True)
    L, T = t.c, t.f; R, B = L + t.a * w, T + t.e * h
    (lw, tn), (re, bs) = tr.transform(L, T), tr.transform(R, B)
    (OUT / "indice_meta.json").write_text(json.dumps({"coords": [[lw, tn], [re, tn], [re, bs], [lw, bs]]}), encoding="utf-8")
    log(f"  → indice_3857.png ({(OUT/'indice_3857.png').stat().st_size/1024:.0f} Ko, {w}×{h})")

    u_out = units[["uid", "MRC_IDm", "MOD_NM_MRC", "MRS_NM_MRC", "IM", "ISD", "IN", "LR", "AREA_HA", "geometry"]].copy()
    u_out.columns = ["uid", "id", "nom", "mrc", "im", "isd", "in", "lr", "ha", "geometry"]
    u_out["geometry"] = u_out.geometry.simplify(150, preserve_topology=True)
    u_out = u_out.to_crs(4326)
    (OUT / "units.geojson").unlink(missing_ok=True)
    u_out.to_file(OUT / "units.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
    log(f"  → units.geojson ({(OUT/'units.geojson').stat().st_size/1024:.0f} Ko)")

    # ── Lieux habités ─────────────────────────────────────────────────────
    log("Lieux habités")
    lh = gpd.read_file(V1_LH_GEOJSON).to_crs(CRS_LCC)
    src = gpd.read_file(LIEUHABITE).to_crs(CRS_LCC)[["nomcartrou", "mus_de_ind", "geometry"]]
    lh = gpd.sjoin_nearest(lh, src.rename(columns={"nomcartrou": "nom_src"}), how="left", max_distance=500)
    lh = lh[~lh.index.duplicated()].drop(columns="index_right")
    topo = pd.read_csv(OUT.parent / "scripts" / "toponymes_autochtones.csv", sep=";", dtype=str).fillna("").set_index("nomcartrou")
    valid_ids = set(units.MRC_IDm)
    uj = gpd.sjoin(lh[["geometry"]], units[["MRC_IDm", "geometry"]], predicate="within", how="left")
    uj = uj[~uj.index.duplicated()]
    nn = gpd.sjoin_nearest(lh[["geometry"]], units[["MRC_IDm", "geometry"]], how="left")
    nn = nn[~nn.index.duplicated()]
    uj["MRC_IDm"] = uj.MRC_IDm.fillna(nn.MRC_IDm)
    lh["unit"] = [m if m in valid_ids else s for m, s in zip(lh.MRC_IDm, uj.MRC_IDm)]
    ll = lh.to_crs(4326)
    rows = []
    for _, r in ll.iterrows():
        t_ = topo.loc[r.nomcartrou] if r.nomcartrou in topo.index else None
        auto = t_ is not None or r.get("mus_de_ind") == "Territoire autochtone"
        rows.append({"id": r.lH_ID, "nom": r.nomcartrou, "mun": r.MUS_NM_MUN, "u": r.unit,
                     "x": round(r.geometry.x, 5), "y": round(r.geometry.y, 5),
                     **({"na": t_.nom_autochtone, "al": t_.alias, "nat": t_.nation} if t_ is not None else {}),
                     **({"aut": 1} if auto else {})})
    lh[["lH_ID", "geometry"]].reset_index(drop=True).to_file(OUT.parent / "scripts" / "_lh_lcc.gpkg", driver="GPKG")
    write_json("lh.json", rows)

    # ── Statistiques de feux par unité ────────────────────────────────────
    log("Feux (cache ou calcul)")
    feux = load_fires(regime_union)
    log(f"  {len(feux)} feux")
    pairs = gpd.sjoin(feux[["an", "t", "geometry"]], units[["MRC_IDm", "LR", "geometry"]], predicate="intersects")
    pairs = pairs[(pairs.t == 0) | pairs.LR]           # anciens : unités en régime seulement
    fg = feux.geometry.values[feux.index.get_indexer(pairs.index)]
    ug = units.set_index("MRC_IDm").geometry.loc[pairs.MRC_IDm].values
    shapely.prepare(ug)
    inside = shapely.contains(ug, fg)
    ha = np.where(inside, shapely.area(fg), 0.0)
    cut = ~inside
    ha[cut] = shapely.area(shapely.intersection(fg[cut], ug[cut]))
    pairs["ha"] = ha / 1e4
    sup = pairs.groupby(["MRC_IDm", "an"]).ha.sum()
    log(f"  intersections : {len(pairs)} paires ({int(cut.sum())} découpées)")

    pt = gpd.read_file(PT_ORI_SHP)
    pt["ANNEE"] = pd.to_numeric(pt.ANNEE, errors="coerce")
    pt = pt[pt.ANNEE.between(1972, YEAR_END)].to_crs(CRS_LCC)
    pt["c"] = np.where(pt.CAUSE.str.startswith("Foudre"), 1, 0)
    pj = gpd.sjoin(pt[["ANNEE", "c", "geometry"]], units[["MRC_IDm", "geometry"]], predicate="within")
    occ = pj.groupby(["MRC_IDm", "ANNEE", "c"]).size()

    stats = {}
    sup_ids = set(sup.index.get_level_values(0))
    for _, u in units.iterrows():
        uid = u.MRC_IDm
        s = sup.loc[uid] if uid in sup_ids else pd.Series(dtype=float)
        # Début de série : points d'origine dès 1972 ; feux anciens (régimes) avant
        y0 = min(int(s.index.min()), 1972) if (u.LR and len(s)) else 1972
        years = range(y0, YEAR_END + 1)
        stats[uid] = {"y0": y0,
                      "sup": [round(float(s.get(y, 0.0)), 1) for y in years],
                      "h": [int(occ.get((uid, y, 0), 0)) for y in years],
                      "f": [int(occ.get((uid, y, 1), 0)) for y in years]}
    write_json("unit_stats.json", stats)
    c = stats.get("MRC_93A")
    if c:
        log(f"  contrôle MRC_93A : y0={c['y0']}, sup1918={c['sup'][1918-c['y0']]:.0f} ha, feux1987={c['h'][1987-c['y0']]+c['f'][1987-c['y0']]}")
    log("Terminé.")
