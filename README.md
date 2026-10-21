# Prédisposition des communautés aux feux de forêt — Québec (v2)

> Application cartographique interactive : historique des feux par MRC ou par zone définie par l'utilisateur, combustibles et potentiel d'intensité et de propagation autour des communautés, et rapport PDF généré à la demande.

**🔗 Production (v1.0, branche `main`) :** <https://uqac-creb.github.io/MAMH_Combustibles_fiches/>
**🛠 Aperçu v2 (branche `v2-dev`) :** <https://uqac-creb.github.io/MAMH_Combustibles_fiches_v2/> — [English version](https://uqac-creb.github.io/MAMH_Combustibles_fiches_v2/?lang=en)
publié depuis le dépôt de prévisualisation [UQAC-CREB/MAMH_Combustibles_fiches_v2](https://github.com/UQAC-CREB/MAMH_Combustibles_fiches_v2) (voir [Aperçu de la v2](#aperçu-de-la-v2-github-pages)) ; tests locaux : voir [Développement local](#développement-local).

La version 1.0 (fiches JPEG téléchargeables) est figée par le tag `v1.0`.

---

## Fonctionnalités (v2)

| Élément | Comportement |
|---|---|
| **Territoire** | Choix d'une **MRC** (saisie avec suggestions automatiques ou clic sur la carte) **ou d'une zone** : rectangle tracé à l'écran ou emprise de la carte. Bouton **↺ Réinitialiser** ; changer de territoire efface la communauté affichée. |
| **Indice de prédisposition** | Raster standardisé (0 à 1, pixels de 5 km) affiché sur la carte, valeur au survol ; moyenne et écart-type pour la MRC, la zone définie et la zone tampon de chaque communauté. |
| **Panneau** | Boîtes INFO-MRC et INFO-COMMUNAUTÉ repliables, avec un bouton « Agrandir » qui ouvre la fiche en grand dans une fenêtre surgissante. |
| **INFO-MRC** | Deux graphiques en temps réel : occurrences annuelles par cause (humaine / foudre, taux pour 100 000 ha de combustibles) et superficies brûlées (échelle log ou linéaire, % de la superficie combustible). Moyenne ± écart-type comme dans les fiches R. |
| **INFO-COMMUNAUTÉ** | Clic sur une communauté : potentiel d'intensité et de propagation et superficie des combustibles dans une zone tampon **ajustable de 1 à 50 km** (25 km par défaut), recalculée instantanément. |
| **Couches** | Indice (raster 5 km), contours de feux (masqués par défaut ; feux récents ou anciens, curseur année de début / de fin, opacité, infobulle), points d'origine (date, cause), combustibles 2025, potentiel I/P. |
| **Rapport PDF** | Page territoire (MRC ou zone, cochée par défaut) + une page par communauté cochée + page de légendes et d'explications (toujours incluse). |
| **Bilingue** | Bouton FR / EN dans l'en-tête : interface, graphiques, légendes, infobulles et rapport PDF (`js/i18n.js` ; `?lang=en` force l'anglais). « MRC » devient « RCM » en anglais. |
| **Toponymes autochtones** | Version préliminaire (`scripts/toponymes_autochtones.csv`), recherche par nom autochtone ou par alias — **à valider avec l'IDDPNQL**. |

### Découpages territoriaux et zones tampons

- **Unités MRC** : MRC d'origine (`mrc_s.shp`, SDA 20k) découpées au trait de côte `Prov_qclcc_shoreline_s` (parties terrestres seulement : pas de « patates » de MRC dans l'eau ; 113 unités).
  Une MRC n'est scindée que si ses polygones d'origine sont **non contigus** (parties à plus de 5 km, `SPLIT_TOL`) ; la contiguïté est évaluée avant le découpage à la côte, de sorte que les îles (Anticosti, Îles-de-la-Madeleine…) restent dans leur MRC. Cas concernés : **Eeyou Istchee** (terres cries, une unité par communauté : TNO de la Jamésie autour des communautés) et **Caniapiscau** (secteurs Fermont et Schefferville). Un groupe de parties sans communauté (miette, TNO isolé) est rattaché au secteur le plus proche, et une communauté située à moins de 2 km d'un secteur (souvent en bordure de ses terres) lui est rattachée.
- **Zones tampons de 50 km** (`LH_50km_ident_Qc_singlepart_v2_s.shp`, champ `CO_TER`) appliquées aux rasters de combustibles et de potentiel :
  `Quebec_buffer` = données conservées ; `EAU` = pixels sans donnée remplacés par la classe Eau (combustibles) ou Absence combustible (potentiel) ; `No-Data` (autres provinces, États-Unis) et hors zones = NA, exclus des calculs.

### Séries selon les données disponibles

Les zones de régime de feux ne sont plus utilisées. Les graphiques et la carte s'ajustent aux données de contours de feux disponibles :

- **MRC et zone libre** : si des **contours de feux anciens (1887-1975)** existent dans le territoire, la **série longue** est affichée (à partir du premier feu ancien) ; sinon la série commence en 1972 (points d'origine) et 1976 (contours de feux récents).
- Les feux anciens sont utilisés tels quels (sans découpage), sur la carte comme dans les calculs.
- Les occurrences (points d'origine) couvrent 1972-2024 ; les contours de feux récents, 1976-2025 (MAJ2026 : le fichier des points n'inclut pas encore 2025).

---

## Architecture

```
GitHub Pages (statique, branche main)              Cloudflare R2 (public, range requests)
├── index.html, css/, js/  (modules ES)            ├── combustibles_2025.pmtiles   tuiles raster PNG z5-12
├── lib/   MapLibre 5 (globe), pmtiles,            ├── potentiel_ip_2025.pmtiles   (≤ 50 km des lieux habités)
│          flatgeobuf, proj4, jsPDF                 └── feux.fgb                    contours de feux indexés
└── data/  ~10 Mo au total
    ├── units.geojson      113 unités terrestres (MRC d'origine), indice moyen / écart-type, série longue
    ├── lh.json            1 664 lieux habités (+ toponymes autochtones)
    ├── unit_stats.json    occurrences / superficies brûlées par unité et année (exact)
    ├── unit_fuel.json     superficie combustible par unité (dénominateur des taux)
    ├── pts_origine.json   44 471 points d'origine 1972-2024 (colonnes)
    ├── indice.bin.gz      indice standardisé (grille 5 km) : survol et statistiques
    ├── indice_3857.png    rendu de l'indice pour la carte (+ indice_meta.json)
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
python build_corrected_rasters.py  # rasters corrigés selon CO_TER → ../work_v2/ (~4 min)
python build_units.py              # cache des feux, unités (trait de côte), indice, lieux habités, stats par unité
python build_vectors.py            # points d'origine, feux.fgb, grille brûlée (réutilise le cache des feux)
python build_rasters.py            # anneaux 0-50 km, grille combustible, combustible par unité (~3 min)
python build_tiles.py comb         # tuiles PMTiles combustibles  → tiles_v2/ (~3 min)
python build_tiles.py pot          # tuiles PMTiles potentiel I/P → tiles_v2/
```

Si seuls les découpages ou l'indice changent : `build_units.py` puis `build_rasters.py --unit-fuel` suffisent (le cache des feux est réutilisé ; les anneaux et la grille combustible ne dépendent pas des unités).

Les données de `C:\1_Data` sont des originaux : les scripts les lisent sans jamais les modifier.

| Source | Fichier |
|---|---|
| Combustibles 2025 (25 m) | `C:\1_Data\Geomatique\Combustible\Quebec\MRNF\Combustibles2025_combFBP_25m.tif` |
| Potentiel I/P 2025-26 | `...\Potentiel_Intensite_Propagation_Feux\Couche globale\Potentiel_IP_25-26.tif` |
| LUT | `C:\1_Data\Geomatique\Combustible\Quebec\_LUT` |
| Feux récents / points d'origine | `C:\1_Data\Geomatique\Feux\Original\MAJ2026\` |
| Feux anciens | `C:\1_Data\Geomatique\Feux\Original_ancien\FEUX_ANCIENS_PROV.gdb` |
| MRC d'origine (lecture seule) | `C:\1_Data\Geomatique\Territoire_limite\Region_administrative\mrc_s.shp` |
| Trait de côte, zones tampons 50 km, indice standardisé | `3_Analyse_carto\20260514_MAMH_feux\Data_20261020\` |
| Lieux habités | `C:\1_Data\Geomatique\Territoire_limite\Villes\lieuhabite.shp` + `data/lh_p.geojson` (identifiants `lH_ID`) |

**Indice de prédisposition** : pour une nouvelle version de `standardized_indx_pred.tif`, relancer `build_units.py`. La palette de couleurs (celle de la v1) est étirée sur 0-1 (`INDEX_PALETTE` dans `js/config.js`).

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

## Hébergement : GitHub Pages + R2

L'application est **100 % statique** : GitHub Pages sert `index.html`, `css/`, `js/`, `lib/` et `data/` tels quels, et tous les calculs se font dans le navigateur. **Aucun Python ne tourne en ligne** : les scripts de `scripts/` servent uniquement à préparer les données sur le poste, et `serve.py` remplace `python -m http.server` pour les tests locaux.

## Aperçu de la v2 (GitHub Pages)

GitHub Pages ne publie qu'une branche par dépôt : la production (`main`) reste dans ce dépôt, et la branche `v2-dev` est poussée vers un dépôt de prévisualisation dont GitHub Pages publie la branche `main`.

```powershell
# une seule fois
git remote add preview git@github.com:UQAC-CREB/MAMH_Combustibles_fiches_v2.git
# à chaque mise à jour de l'aperçu
git push preview v2-dev:main
```

Lien : <https://uqac-creb.github.io/MAMH_Combustibles_fiches_v2/>. Les tuiles et contours de feux (Cloudflare R2) fonctionnent sans changement : l'origine `uqac-creb.github.io` est déjà autorisée dans `scripts/r2_cors.json`.

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
