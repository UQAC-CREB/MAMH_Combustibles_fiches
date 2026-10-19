# -*- coding: utf-8 -*-
"""Chemins et constantes partagés par les scripts de préparation des données v2."""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
OUT = WEB / "data"
# Tuiles raster (PMTiles) : exclues de Git (.gitignore), téléversées sur Cloudflare R2
TILES_OUT = WEB / "tiles_v2"

# ── Sources ─────────────────────────────────────────────────────────────────
COMB_TIF = r"C:/1_Data/Geomatique/Combustible/Quebec/MRNF/Combustibles2025_combFBP_25m.tif"
POT_TIF = r"C:/1_Data/Geomatique/Combustible/Quebec/Propagation_feux/Potentiel_Intensite_Propagation_Feux/Couche globale/Potentiel_IP_25-26.tif"
LUT_COMB = r"C:/1_Data/Geomatique/Combustible/Quebec/_LUT/LUT_FBP_FUELTYPE_mrnf.csv"
LUT_POT = r"C:/1_Data/Geomatique/Combustible/Quebec/_LUT/MunicID_propag_class_lut.csv"

LIEUHABITE = r"C:/1_Data/Geomatique/Territoire_limite/Villes/lieuhabite.shp"
UNITS_SHP = r"C:/0_Projet/MAMH_prediposition_feux/3_Analyse_carto/20260514_MAMH_feux/shp/MRC_MAJ_20260604.shp"
# Indice EXPO / RANG (v1) : 107 unités ; les unités absentes reçoivent EXPO = 0
V1_MRC_GEOJSON = WEB / "data" / "mrc_s.geojson"
V1_LH_GEOJSON = WEB / "data" / "lh_p.geojson"

FEUX_GDB = r"C:/1_Data/Geomatique/Feux/Original/MAJ2025/FEUX_PROV.gdb"
FEUX_ANC_GDB = r"C:/1_Data/Geomatique/Feux/Original_ancien/FEUX_ANCIENS_PROV.gdb"
PT_ORI_SHP = r"C:/1_Data/Geomatique/Feux/Original/MAJ2025/Feux_pt_ori_SHP/FEUX_PT_ORI_1972_2024.shp"
REGIME_GDB = r"C:/1_Data/Geomatique/Feux/Regime_feux/REGIME_FEUX/REGIME_FEUX.gdb"

# ── Constantes ──────────────────────────────────────────────────────────────
CRS_LCC = "EPSG:32198"   # NAD83 / Québec Lambert
YEAR_END = 2024
YEAR0 = 1880             # origine des années encodées sur 1 octet
GRID_RES = 1000          # grille de statistiques (m)
RING_KM = 50             # rayon max. des zones tampons communautés
COMB_NODATA = 255
POT_NODATA = 15
# Codes combustibles « non combustibles » (exclus du dénominateur, cf. STEP2_Preparation_table_ficheMRC.R)
NFUEL_CODES = (101, 102, 103, 104)
