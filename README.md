# Prédisposition des communautés aux feux de forêt — Québec (v2)

> Application cartographique interactive : historique des feux par MRC ou par zone définie par l'utilisateur, combustibles et potentiel d'intensité et de propagation autour des communautés, et rapport PDF généré à la demande.

**🔗 Production (v1.0, branche `main`) :** <https://uqac-creb.github.io/MAMH_Combustibles_fiches/>
**🛠 Développement (v2, branche `v2-dev`) :** tester localement (voir [Développement local](#développement-local)).

La version 1.0 (fiches JPEG téléchargeables) est figée par le tag `v1.0`.

---

## Fonctionnalités (v2)

| Élément | Comportement |
|---|---|
| **Territoire** | Choix d'une **MRC** (saisie avec suggestions automatiques ou clic sur la carte) **ou d'une zone** : rectangle tracé à l'écran, emprise de la carte ou shapefile importé (.zip). |
| **Indice de prédisposition** | Indice EXPO et rang de la MRC ; pour une zone, indice de la MRC la plus représentée. Les MRC non évaluées ont un indice de 0. |
| **INFO-MRC** | Deux graphiques en temps réel : occurrences annuelles par cause (humaine / foudre, taux pour 100 000 ha de combustibles) et superficies brûlées (échelle log ou linéaire, % de la superficie combustible). Moyenne ± écart-type comme dans les fiches R. |
| **INFO-COMMUNAUTÉ** | Clic sur une communauté : potentiel d'intensité et de propagation et superficie des combustibles dans une zone tampon **ajustable de 1 à 50 km** (25 km par défaut), recalculée instantanément. |
| **Couches** | Indice (MRC), contours de feux (période de 5 ans, opacité, infobulle de superficie), points d'origine (date, cause), combustibles 2025, potentiel I/P, zones de régime de feux. |
| **Rapport PDF** | Page territoire (MRC ou zone) + une page par communauté cochée (1 seule cochée → sa fiche seulement). |
| **Toponymes autochtones** | Version préliminaire (`scripts/toponymes_autochtones.csv`), recherche par nom autochtone ou par alias — **à valider avec l'IDDPNQL**. |

### Règle des séries longues

Les **feux anciens (1887-1975)** n'ont été validés que dans les **zones de régime de feux** (`REGIME_FEUX.gdb / ZONES_FEUX`). Ils sont donc découpés à ces zones avant tout calcul :

- **MRC** : les unités territoriales de `MRC_MAJ_20260604.shp` (MRC subdivisées selon les régimes, suffixe `A` = dans un régime) affichent la série longue lorsqu'elles sont majoritairement dans un régime ; sinon la série commence en 1976.
- **Zone libre** : dès que la zone touche un régime, la série longue est affichée ; les feux anciens n'y sont comptés que dans la portion en régime (une note l'indique).
- Les occurrences (points d'origine) couvrent 1972-2024.

---

## Architecture

```
GitHub Pages (statique, branche main)              Cloudflare R2 (public, range requests)
├── index.html, css/, js/  (modules ES)            ├── combustibles_2025.pmtiles   tuiles raster PNG z5-12
├── lib/   MapLibre 5 (globe), pmtiles,            ├── potentiel_ip_2025.pmtiles   (≤ 50 km des lieux habités)
│          flatgeobuf, proj4, jsPDF, shpjs          └── feux.fgb                    contours de feux indexés
└── data/  ~10 Mo au total
    ├── units.geojson      132 unités (MRC + subdivisions régime), EXPO, RANG
    ├── lh.json            1 664 lieux habités (+ toponymes autochtones)
    ├── unit_stats.json    occurrences / superficies brûlées par unité et année (exact)
    ├── unit_fuel.json     superficie combustible par unité (dénominateur des taux)
    ├── pts_origine.json   44 471 points d'origine 1972-2024 (colonnes)
    ├── regime.geojson     zones de régime de feux
    ├── classes.json       classes et couleurs (LUT combustibles / potentiel)
    ├── rings.bin.gz       pixels par anneau de 1 km (0-50 km) et par classe, par lieu habité
    ├── grid_fuel.bin.gz   pixels combustibles par cellule de 1 km (zones libres)
    └── grid_burn.bin.gz   superficie brûlée par cellule de 1 km et par année (zones libres)
```

**Pourquoi c'est rapide :** aucun raster n'est téléchargé pour les calculs.

- **Zone tampon variable** : pour chaque lieu habité, les pixels de 25 m de chaque classe sont précomptés par anneau de 1 km jusqu'à 50 km ; le navigateur additionne simplement les anneaux jusqu'au rayon choisi.
- **Zone libre** : les superficies brûlées (par année) et combustibles sont précalculées sur une grille de 1 km (EPSG:32198) ; la zone sélectionne les cellules dont le centre est à l'intérieur. Les occurrences sont comptées exactement (points dans le polygone). Précision : ± 1 km sur le contour de la zone.
- **MRC** : statistiques exactes (intersection géométrique) précalculées.
- **Contours de feux** : FlatGeobuf avec index spatial ; seuls les feux de l'emprise visible sont lus (requêtes HTTP Range).
- **Projection** : MapLibre en **globe** aux petites échelles (formes réalistes pour le Nord du Québec), Mercator aux grandes échelles. Tous les calculs se font en NAD83 / Québec Lambert (EPSG:32198).

---

## Pipeline de données (`scripts/`)

Python ≥ 3.11 avec `geopandas`, `rasterio`, `shapely` 2, `pyogrio`, `pyproj`, `Pillow`, `pmtiles`, `mercantile`. Chemins des sources dans `scripts/config.py`.

```powershell
cd scripts
python build_vectors.py        # unités, lieux habités, points, feux, stats exactes, grille brûlée (~1 h 30)
python build_rasters.py        # anneaux 0-50 km, grille combustible, combustible par unité (~10 min, 5 processus)
python build_tiles.py comb     # tuiles PMTiles combustibles  → tiles_v2/
python build_tiles.py pot      # tuiles PMTiles potentiel I/P → tiles_v2/
```

| Source | Fichier |
|---|---|
| Combustibles 2025 (25 m) | `C:\1_Data\Geomatique\Combustible\Quebec\MRNF\Combustibles2025_combFBP_25m.tif` |
| Potentiel I/P 2025-26 | `...\Potentiel_Intensite_Propagation_Feux\Couche globale\Potentiel_IP_25-26.tif` |
| LUT | `C:\1_Data\Geomatique\Combustible\Quebec\_LUT` |
| Feux récents / points d'origine | `C:\1_Data\Geomatique\Feux\Original\MAJ2025\` |
| Feux anciens | `C:\1_Data\Geomatique\Feux\Original_ancien\FEUX_ANCIENS_PROV.gdb` |
| Régime de feux | `C:\1_Data\Geomatique\Feux\Regime_feux\REGIME_FEUX\REGIME_FEUX.gdb` |
| Unités MRC (subdivisions régime) | `3_Analyse_carto\20260514_MAMH_feux\shp\MRC_MAJ_20260604.shp` |
| Indice EXPO / RANG | `data/mrc_s.geojson` (v1) |
| Lieux habités | `C:\1_Data\Geomatique\Territoire_limite\Villes\lieuhabite.shp` + `data/lh_p.geojson` (identifiants `lH_ID`) |

**Nouvel indice matriciel (à venir)** : il suffira d'ajouter un passage dans `build_rasters.py` (moyenne par unité et par cellule de 1 km) et de remplacer `expo` dans `units.geojson` ; pour les zones, la moyenne sera calculée à la volée sur la grille comme les combustibles.

---

## Cloudflare R2 (tuiles et contours de feux)

Fichiers de `tiles_v2/` (exclus de Git) à téléverser dans un bucket public :

```powershell
$env:CLOUDFLARE_API_TOKEN = "votre_token"      # permission : R2 Storage Edit
wrangler r2 bucket create mamh-v2-carto
wrangler r2 bucket cors set mamh-v2-carto --file scripts/r2_cors.json
# Activer l'URL publique r2.dev du bucket (tableau de bord Cloudflare > R2 > bucket > Settings)

foreach ($f in "combustibles_2025.pmtiles","potentiel_ip_2025.pmtiles","feux.fgb") {
  wrangler r2 object put "mamh-v2-carto/$f" --file "tiles_v2/$f" --remote
}
```

Puis inscrire l'URL publique dans `js/config.js` (`R2_TILES_URL`).
`wrangler r2 object put` est limité à 300 Mo par fichier ; au-delà, utiliser `rclone` (API S3, téléversement multipart).

---

## Développement local

```powershell
python scripts/serve.py        # → http://localhost:8000
```

`serve.py` gère les requêtes HTTP Range (indispensables pour PMTiles et FlatGeobuf), contrairement à `python -m http.server`. En local, les fichiers de `tiles_v2/` sont servis directement.

---

## Auteurs et contact

**Observatoire régional de recherche sur la forêt boréale (CREB) — UQAC**

| Nom | Rôle | Courriel |
|---|---|---|
| Hugues Dorion | Développement, géomatique, production des fiches | hdorion@uqac.ca |
| Victor Danneyrolles | Recherche, validation scientifique | vdanneyr@uqac.ca |
| Emmanuelle Bergeron | Recherche | e4berger@uqac.ca |
| Yan Boucher | Direction scientifique | yboucher@uqac.ca |

**Partenaire :** Ministère des Affaires Municipales et de l'Habitation du Québec (MAMH)

© 2026 Observatoire régional de recherche sur la forêt boréale — UQAC. Les données sources sont soumises aux licences de leurs producteurs respectifs.
