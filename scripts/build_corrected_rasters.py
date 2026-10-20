# -*- coding: utf-8 -*-
"""
build_corrected_rasters.py — Rasters combustibles / potentiel corrigés selon les zones tampons de 50 km

Zones tampons (LH_50km_ident_Qc_singlepart_v2_s.shp, champ CO_TER) :
  Quebec_buffer  zone de validité : données conservées
  EAU            plans d'eau hors du raster MRNF : pixels sans donnée → classe Eau (combustibles)
                 ou Absence combustible (potentiel)
  No-Data        hors Québec (autres provinces, États-Unis) : NA, exclus de l'analyse
  (hors zones)   NA

Sorties (../work_v2/, hors dépôt) : combustibles_2025_corr.tif, potentiel_ip_2025_corr.tif
(tuilés 256, deflate, aperçus nearest) — utilisés par build_rasters.py et build_tiles.py.
"""
import sys, time
from multiprocessing import Pool
import numpy as np
import geopandas as gpd
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.windows import Window

from config import *

BLOCK = 1024
CODES = {"Quebec_buffer": 1, "EAU": 2, "No-Data": 3}

t0 = time.time()
def log(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)


def init_worker(src_path, nodata, fill):
    global SRC, SHAPES, NODATA, FILL
    SRC = rasterio.open(src_path)
    NODATA, FILL = nodata, fill
    b = gpd.read_file(LH_BUFFER50).to_crs(CRS_LCC)
    b["code"] = b.CO_TER.map(CODES).fillna(0).astype(int)
    b = b.sort_values("code")           # No-Data en dernier : prioritaire en cas de chevauchement
    SHAPES = list(zip(b.geometry.values, b.code.values))


def work(r0):
    h = min(BLOCK, SRC.height - r0)
    win = Window(0, r0, SRC.width, h)
    arr = SRC.read(1, window=win)
    tr = rasterio.windows.transform(win, SRC.transform)
    zone = rasterize(SHAPES, out_shape=(h, SRC.width), transform=tr, fill=0, dtype="uint8")
    out = np.where(zone == 1, arr, NODATA)
    out = np.where(zone == 2, np.where(arr == NODATA, FILL, arr), out)
    return r0, out.astype(np.uint8), np.bincount(zone.ravel(), minlength=4)


def correct(src_path, dst_path, nodata, fill):
    WORK.mkdir(exist_ok=True)
    with rasterio.open(src_path) as s:
        prof = s.profile.copy()
        H = s.height
    prof.update(driver="GTiff", dtype="uint8", nodata=nodata, tiled=True, blockxsize=256, blockysize=256,
                compress="deflate", predictor=1, BIGTIFF="IF_SAFER")
    cnt = np.zeros(4, dtype=np.int64)
    with rasterio.open(dst_path, "w", **prof) as dst, \
         Pool(6, initializer=init_worker, initargs=(src_path, nodata, fill)) as pool:
        for k, (r0, out, c) in enumerate(pool.imap(work, range(0, H, BLOCK))):
            dst.write(out, 1, window=Window(0, r0, out.shape[1], out.shape[0]))
            cnt += c
            if k % 10 == 0: log(f"  bloc {r0}/{H}")
    log(f"  zones (km²) : Quebec_buffer {cnt[1]*625/1e6:,.0f} · EAU {cnt[2]*625/1e6:,.0f} · No-Data {cnt[3]*625/1e6:,.0f}")
    log("  aperçus…")
    with rasterio.open(dst_path, "r+") as dst:
        dst.build_overviews([2, 4, 8, 16, 32, 64], Resampling.nearest)
    log(f"→ {dst_path}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["comb", "pot"]
    if "comb" in which:
        log("Combustibles"); correct(COMB_TIF_RAW, COMB_TIF, COMB_NODATA, COMB_WATER)
    if "pot" in which:
        log("Potentiel I/P"); correct(POT_TIF_RAW, POT_TIF, POT_NODATA, POT_NOFUEL)
