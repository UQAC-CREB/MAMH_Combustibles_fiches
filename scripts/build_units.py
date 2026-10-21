# -*- coding: utf-8 -*-
"""
build_units.py — Unités territoriales (MRC), lieux habités et statistiques par unité

Sorties (data/) :
  units.geojson     MRC d'origine découpées au trait de côte (parties terrestres seulement) ;
                    une MRC aux parties non contiguës est scindée (Eeyou Istchee : une unité par
                    communauté crie ; Caniapiscau : secteurs Fermont et Schefferville) ;
                    indice de prédisposition standardisé : moyenne (im) et écart-type (isd) ;
                    lr = série longue (contours de feux anciens 1887-1975 présents dans l'unité)
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

FEUX_CACHE = WORK / "_feux_lcc_v3.gpkg"     # feux anciens non découpés (sans zones de régime)


def load_fires():
    """Feux récents (1976+) + anciens (< 1976), tels que disponibles."""
    if FEUX_CACHE.exists():
        return gpd.read_file(FEUX_CACHE)
    fr = pyogrio.read_dataframe(FEUX_GDB, layer="FEUX_PROV", columns=["EXERCICE", "SUPERFICIE"])
    fr["EXERCICE"] = pd.to_numeric(fr.EXERCICE, errors="coerce")
    fr = fr[fr.EXERCICE.between(1976, YEAR_END)]
    fr["t"] = 0
    fa = pyogrio.read_dataframe(FEUX_ANC_GDB, layer="FEUX_ANCIENS_PROV", columns=["EXERCICE", "SUPERFICIE"])
    fa["EXERCICE"] = pd.to_numeric(fa.EXERCICE, errors="coerce")
    fa = fa[fa.EXERCICE < 1976]
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


def render_index_png(idx=None, itr=None, icrs=None):
    """Rendu de l'indice pour la carte : reprojection EPSG:3857 (plus proche voisin, ~1,5 km) → PNG RGBA
    selon INDEX_PALETTE (transparence progressive vers 0) + indice_meta.json (coins géographiques)."""
    if idx is None:
        with rasterio.open(INDICE_TIF) as s:
            idx, itr, icrs = s.read(1).astype(np.float32), s.transform, s.crs
        idx[~np.isfinite(idx)] = np.nan
    ih, iw = idx.shape
    t, w, h = calculate_default_transform(icrs, "EPSG:3857", iw, ih, *rasterio.transform.array_bounds(ih, iw, itr), resolution=1500)
    dst = np.full((h, w), np.nan, dtype=np.float32)
    reproject(idx, dst, src_transform=itr, src_crs=icrs, dst_transform=t, dst_crs="EPSG:3857",
              resampling=Resampling.nearest, src_nodata=np.nan, dst_nodata=np.nan)
    xs = [p[0] for p in INDEX_PALETTE]
    rgba = np.array([[int(c[i:i + 2], 16) for i in (1, 3, 5)] + [a * 255] for _, c, a in INDEX_PALETTE], dtype=float)
    v = np.clip(np.nan_to_num(dst, nan=0), 0, 1)
    img = np.zeros((h, w, 4), dtype=np.uint8)
    for k in range(4):
        img[..., k] = np.interp(v, xs, rgba[:, k]).round().astype(np.uint8)
    img[..., 3] = np.where(np.isfinite(dst), img[..., 3], 0)
    Image.fromarray(img, "RGBA").save(OUT / "indice_3857.png", optimize=True)
    tr = Transformer.from_crs(3857, 4326, always_xy=True)
    L, T = t.c, t.f; R, B = L + t.a * w, T + t.e * h
    (lw, tn), (re, bs) = tr.transform(L, T), tr.transform(R, B)
    (OUT / "indice_meta.json").write_text(json.dumps({"coords": [[lw, tn], [re, tn], [re, bs], [lw, bs]]}), encoding="utf-8")
    log(f"  → indice_3857.png ({(OUT/'indice_3857.png').stat().st_size/1024:.0f} Ko, {w}×{h})")


def export_province():
    """Contour provincial simplifié (carte de localisation du rapport PDF) → data/province.geojson."""
    prov = gpd.read_file(PROV_SHORE).to_crs(CRS_LCC)
    g = shapely.make_valid(shapely.union_all(prov.geometry.values))
    parts = [p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon" and p.area > 20e6]   # îles > 20 km²
    g = shapely.MultiPolygon(parts).simplify(1500, preserve_topology=True)
    out = gpd.GeoDataFrame(geometry=[g], crs=CRS_LCC).to_crs(4326)
    p = OUT / "province.geojson"
    p.unlink(missing_ok=True)
    out.to_file(p, driver="GeoJSON", COORDINATE_PRECISION=3)
    log(f"  → province.geojson ({p.stat().st_size/1024:.0f} Ko, {len(parts)} parties)")


def split_groups(geom, lh):
    """Parties d'une MRC regroupées par proximité (< SPLIT_TOL). Un groupe sans communauté
    (miette, TNO isolé) est rattaché au groupe le plus proche : chaque secteur entoure une communauté."""
    parts = [p for p in getattr(geom, "geoms", [geom]) if p.geom_type == "Polygon"]
    if len(parts) == 1:
        return [geom]
    hull = shapely.union_all([p.buffer(SPLIT_TOL / 2) for p in parts])
    groups = [shapely.union_all([p for p in parts if h.intersects(p)]) for h in getattr(hull, "geoms", [hull])]
    big = [g for g in groups if (lh.distance(g) < LH_NEAR).any()] or [max(groups, key=lambda g: g.area)]
    for g in groups:
        if not any(g is b for b in big):
            k = int(np.argmin([b.distance(g) for b in big]))
            big[k] = shapely.union_all([big[k], g])
    return sorted(big, key=lambda g: -g.area)


# MRC au libellé provisoire dans le découpage officiel
MRC_NAME_FIX = {"993": "Eeyou Istchee"}
# Communautés qui nomment de préférence un secteur de MRC scindée (sinon : la plus proche du plus grand morceau)
SECTOR_PREF = {"Fermont", "Schefferville"}


def build_unit_geoms(shore, lh):
    """MRC d'origine (mrc_s, lecture seule) → unités terrestres.
    La contiguïté est évaluée AVANT le découpage au trait de côte : dans mrc_s, la mer relie les îles
    (Anticosti, Îles-de-la-Madeleine…) à leur MRC ; seules les MRC réellement morcelées sont scindées."""
    mrc = gpd.read_file(MRC_SHP).to_crs(CRS_LCC)
    mrc["geometry"] = shapely.make_valid(mrc.geometry.values)
    mrc = mrc.dissolve(by="MRS_CO_MRC", aggfunc="first", as_index=False)
    rows = []
    for r in mrc.itertuples():
        name = MRC_NAME_FIX.get(r.MRS_CO_MRC, r.MRS_NM_MRC.strip())
        groups = split_groups(r.geometry, lh)
        for k, g in enumerate(groups):
            land = shapely.intersection(g, shore)
            land = shapely.union_all([p for p in getattr(land, "geoms", [land])
                                      if p.geom_type == "Polygon" and p.area > 1e4])
            if land.is_empty:
                continue
            nom, sect = name, None
            if len(groups) > 1:
                near = lh[lh.distance(g) < SPLIT_TOL]
                pref = near[near.nomcartrou.isin(SECTOR_PREF)]
                if len(pref):
                    sect = pref.nomcartrou.iloc[0]
                else:
                    core = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
                    sect = lh.nomcartrou.iloc[int(np.argmin(lh.distance(core).values))]
                nom = f"{name} — {sect}"
            rows.append({"MRC_IDm": f"MRC_{r.MRS_CO_MRC}" + (f"_{k + 1}" if len(groups) > 1 else ""),
                         "MOD_NM_MRC": nom, "MRS_NM_MRC": name, "split": len(groups) > 1, "sect": sect,
                         "geometry": land})
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=CRS_LCC)


def write_units(units):
    u_out = units[["uid", "MRC_IDm", "MOD_NM_MRC", "MRS_NM_MRC", "IM", "ISD", "IN", "LR", "AREA_HA", "geometry"]].copy()
    u_out.columns = ["uid", "id", "nom", "mrc", "im", "isd", "in", "lr", "ha", "geometry"]
    u_out["geometry"] = u_out.geometry.simplify(150, preserve_topology=True)
    u_out = u_out.to_crs(4326)
    (OUT / "units.geojson").unlink(missing_ok=True)
    u_out.to_file(OUT / "units.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
    log(f"  → units.geojson ({(OUT/'units.geojson').stat().st_size/1024:.0f} Ko, {len(u_out)} unités, {int(u_out.lr.sum())} en série longue)")


if __name__ == "__main__":
    export_province()
    # ── Unités : MRC d'origine, parties terrestres seulement (trait de côte) ──
    log("Unités : MRC d'origine découpées au trait de côte")
    prov = gpd.read_file(PROV_SHORE).to_crs(CRS_LCC)
    shore = shapely.make_valid(shapely.union_all(prov.geometry.values))
    shapely.prepare(shore)
    lh_src = gpd.read_file(V1_LH_GEOJSON).to_crs(CRS_LCC)
    units = build_unit_geoms(shore, lh_src)
    units["AREA_HA"] = (units.geometry.area / 1e4).round(0)
    units = units.sort_values("MRC_IDm").reset_index(drop=True)
    units["uid"] = np.arange(len(units), dtype=np.int32)
    log(f"  {len(units)} unités terrestres ({int(units.split.sum())} issues de MRC scindées)")
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

    render_index_png(idx, itr, icrs)


    # ── Lieux habités ─────────────────────────────────────────────────────
    log("Lieux habités")
    lh = lh_src
    src = gpd.read_file(LIEUHABITE).to_crs(CRS_LCC)[["nomcartrou", "mus_de_ind", "geometry"]]
    lh = gpd.sjoin_nearest(lh, src.rename(columns={"nomcartrou": "nom_src"}), how="left", max_distance=500)
    lh = lh[~lh.index.duplicated()].drop(columns="index_right")
    topo = pd.read_csv(OUT.parent / "scripts" / "toponymes_autochtones.csv", sep=";", dtype=str).fillna("").set_index("nomcartrou")
    uj = gpd.sjoin(lh[["geometry"]], units[["MRC_IDm", "geometry"]], predicate="within", how="left")
    uj = uj[~uj.index.duplicated()]
    nn = gpd.sjoin_nearest(lh[["geometry"]], units[["MRC_IDm", "geometry"]], how="left")
    nn = nn[~nn.index.duplicated()]
    uj["MRC_IDm"] = uj.MRC_IDm.fillna(nn.MRC_IDm)
    # secteurs scindés (Eeyou Istchee…) : la communauté qui nomme le secteur est souvent en bordure
    # de ses terres (Waswanipi) ; les autres lieux voisins gardent leur MRC (Kuujjuarapik → Kativik)
    sp = units[units.split]
    dn = gpd.sjoin_nearest(lh[["nomcartrou", "geometry"]], sp[["MRC_IDm", "sect", "geometry"]], how="left", max_distance=LH_NEAR)
    dn = dn[~dn.index.duplicated()]
    moved = dn.MRC_IDm.notna() & (dn.MRC_IDm != uj.MRC_IDm) & (dn.nomcartrou == dn.sect)
    uj.loc[moved, "MRC_IDm"] = dn.MRC_IDm[moved]
    log(f"  {int(moved.sum())} lieu(x) rattaché(s) à un secteur voisin : {', '.join(lh.nomcartrou[moved])}")
    lh["unit"] = uj.MRC_IDm
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
    feux = load_fires()
    log(f"  {len(feux)} feux ({int((feux.t == 1).sum())} anciens)")
    pairs = gpd.sjoin(feux[["an", "t", "geometry"]], units[["MRC_IDm", "geometry"]], predicate="intersects")
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
    pt = pt[pt.ANNEE.between(1972, PT_YEAR_END)].to_crs(CRS_LCC)
    pt["c"] = np.where(pt.CAUSE.str.startswith("Foudre"), 1, 0)
    pj = gpd.sjoin(pt[["ANNEE", "c", "geometry"]], units[["MRC_IDm", "geometry"]], predicate="within")
    occ = pj.groupby(["MRC_IDm", "ANNEE", "c"]).size()

    stats = {}
    sup_ids = set(sup.index.get_level_values(0))
    long_ids = set()
    for _, u in units.iterrows():
        uid = u.MRC_IDm
        s = sup.loc[uid] if uid in sup_ids else pd.Series(dtype=float)
        s = s[s > 0]
        # Série longue si des contours de feux anciens (< 1976) existent dans l'unité ;
        # sinon la série débute avec les points d'origine (1972).
        y0 = min(int(s.index.min()), 1972) if len(s) else 1972
        if y0 < 1972: long_ids.add(uid)
        years = range(y0, YEAR_END + 1)
        stats[uid] = {"y0": y0,
                      "sup": [round(float(s.get(y, 0.0)), 1) for y in years],
                      "h": [int(occ.get((uid, y, 0), 0)) for y in years],
                      "f": [int(occ.get((uid, y, 1), 0)) for y in years]}
    write_json("unit_stats.json", stats)
    c = stats.get("MRC_93")
    if c:
        log(f"  contrôle MRC_93 : y0={c['y0']}, sup1918={c['sup'][1918-c['y0']]:.0f} ha, feux1987={c['h'][1987-c['y0']]+c['f'][1987-c['y0']]}")

    # ── units.geojson (après les statistiques : lr = série longue) ────────
    units["LR"] = units.MRC_IDm.isin(long_ids)
    write_units(units)
    log("Terminé.")
