# Prédisposition des MRC aux feux de forêts — Québec

> Application cartographique interactive permettant de consulter les fiches de prédisposition aux feux de forêt à l'échelle des MRC et des communautés du Québec.

**🔗 Application en ligne :** [https://uqac-creb.github.io/MAMH_Combustibles_fiches/](https://uqac-creb.github.io/MAMH_Combustibles_fiches/)

---

## Table des matières

1. [Contexte](#contexte)
2. [Fonctionnalités](#fonctionnalités)
3. [Architecture technique](#architecture-technique)
4. [Structure du dépôt](#structure-du-dépôt)
5. [Sources de données](#sources-de-données)
6. [Schéma des données](#schéma-des-données)
7. [Buckets Cloudflare R2](#buckets-cloudflare-r2)
8. [Pipeline de production des fiches](#pipeline-de-production-des-fiches)
9. [Développement local](#développement-local)
10. [Déploiement](#déploiement)
11. [Modifier les données](#modifier-les-données)
12. [Auteurs et contact](#auteurs-et-contact)

---

## Contexte

Ce projet est réalisé dans le cadre d'un partenariat entre l'**Observatoire régional de recherche sur la forêt boréale (CREB)** de l'Université du Québec à Chicoutimi (UQAC) et le **Ministère des Affaires Municipales et de l'Habitation du Québec (MAMH)**.

L'application permet aux gestionnaires municipaux, aux MRC et aux décideurs de visualiser et télécharger des fiches synthétiques caractérisant :

- **L'indice de prédisposition** de chaque MRC aux feux de forêt (calculé à partir de quatre indicateurs : superficies brûlées historiques, fréquence des départs de feu, indices forêt-météo projetés 2021–2050, et nature des combustibles actuels)
- **La composition en combustibles forestiers** (classification MCPCI/FBP, MRNF 2025) dans une zone tampon de 25 km autour de chaque communauté
- **Le potentiel d'intensité et de propagation** des feux de forêt par communauté

---

## Fonctionnalités

- Carte interactive (MapLibre GL JS) colorée par indice de prédisposition EXPO
- Navigation hiérarchique à 3 niveaux : **MRC → Communauté → Lieu habité**
- Affichage des zones tampons de 25 km au survol des points
- Consultation et téléchargement des fiches JPEG (MRC et communautés)
- Légende interactive des types de combustibles et du potentiel d'intensité
- Popup d'accueil et ressources utiles intégrées

---

## Architecture technique

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub Pages (hébergement statique)                            │
│                                                                 │
│  index.html  ←  fichier unique, zéro dépendance serveur         │
│    ├── MapLibre GL JS  (cartographie vectorielle)               │
│    ├── TopoJSON        (décodage zones tampons)                 │
│    └── Fetch API       (chargement données GeoJSON/JSON)        │
│                                                                 │
│  data/                                                          │
│    ├── mrc_s.geojson        (polygones MRC + attributs EXPO)    │
│    ├── lh_p.geojson         (points lieux habités)              │
│    ├── lh_25km_s.topojson   (zones tampons 25 km simplifiées)   │
│    └── lut.json             (table de correspondance complète)  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ fetch JPEG à la demande
                    ┌─────────────▼─────────────┐
                    │  Cloudflare R2 (CDN)       │
                    │  mamh-fiche-mrc            │
                    │  mamh-fiche-lh             │
                    └───────────────────────────┘
```

**Bibliothèques front-end (hébergées localement dans `lib/`) :**

| Bibliothèque | Rôle |
|---|---|
| `maplibre-gl.js` | Rendu cartographique WebGL |
| `topojson.min.js` | Décodage des zones tampons TopoJSON |

**Polices :** Google Fonts — Oswald + Source Sans 3 (chargées via CDN)

---

## Structure du dépôt

```
MAMH_Combustibles_fiches/
│
├── index.html                    # Application complète (HTML + CSS + JS)
├── legende_fiche_commun.png      # Image PNG de la légende (modale)
├── ObservatoireRegionalForetBoreal.png   # Logo UQAC-CREB
│
├── data/
│   ├── mrc_s.geojson             # 108 MRC du Québec (polygones simplifiés, WGS84)
│   ├── lh_p.geojson              # 1 664 lieux habités (points centroïdes, WGS84)
│   ├── lh_25km_s.topojson        # 1 664 zones tampons 25 km (TopoJSON, WGS84)
│   └── lut.json                  # Table de correspondance lH_ID ↔ MUN_ID ↔ MRC_IDm
│
└── lib/
    ├── maplibre-gl.js
    ├── maplibre-gl.css
    └── topojson.min.js
```

---

## Sources de données

| Couche | Source | URL |
|---|---|---|
| Combustibles forestiers 2025 | Données Québec — MRNF | [donneesquebec.ca](https://www.donneesquebec.ca/recherche/dataset/potentiel-d-intensite-et-de-propagation-des-feux-de-foret) |
| Potentiel d'intensité et de propagation | Données Québec — MRNF | [donneesquebec.ca](https://www.donneesquebec.ca/recherche/dataset/potentiel-d-intensite-et-de-propagation-des-feux-de-foret) |
| Découpages administratifs (MRC, municipalités) | Données Québec | [donneesquebec.ca](https://www.donneesquebec.ca/recherche/dataset/decoupages-administratifs) |
| Lieux habités | Données Québec | [donneesquebec.ca](https://www.donneesquebec.ca/recherche/dataset/lieu-habite) |
| Feux de forêts historiques | Données Québec — SOPFEU | [donneesquebec.ca](https://www.donneesquebec.ca/recherche/fr/dataset/feux-de-foret) |

La classification des combustibles suit la **Méthode canadienne de prévision du comportement des incendies de forêt (MCPCI / FBP System)** de Ressources naturelles Canada.

---

## Schéma des données

### `data/lut.json`

Table de correspondance principale. 1 664 entrées — une par lieu habité (`lH_ID`).

```json
{
  "lH_ID":      "LH_1478",
  "MUN_ID":     "MU_1041",
  "MRC_IDm":    "MRC_93A",
  "MOD_NM_MRC": "Lac-Saint-Jean-Est",
  "MUS_NM_MUN": "Saint-Ludger-de-Milot",
  "nomcartrou": "Saint-Ludger-de-Milot",
  "MRS_CO_MRC": 93
}
```

| Champ | Type | Description |
|---|---|---|
| `lH_ID` | string | Identifiant unique du lieu habité (ex. `LH_1478`) |
| `MUN_ID` | string | Identifiant de la municipalité (ex. `MU_1041`) |
| `MRC_IDm` | string | Identifiant modifié de la MRC (ex. `MRC_93A`) |
| `MOD_NM_MRC` | string | Nom d'affichage de la MRC |
| `MUS_NM_MUN` | string | Nom officiel de la municipalité |
| `nomcartrou` | string | Nom cartographique du lieu habité |
| `MRS_CO_MRC` | integer | Code numérique de la MRC |

### `data/mrc_s.geojson`

Polygones simplifiés des 108 MRC du Québec. Propriétés clés :

| Propriété | Description |
|---|---|
| `MRC_IDm` | Clé de jointure principale |
| `MOD_NM_MRC` | Nom d'affichage |
| `EXPO` | Indice de prédisposition aux feux (float, typiquement 0–6) |

### `data/lh_p.geojson`

Points centroïdes des 1 664 lieux habités. Propriétés :

| Propriété | Description |
|---|---|
| `lH_ID` | Clé de jointure principale |
| `MUN_ID` | Identifiant de la municipalité parente |
| `MRC_IDm` | Identifiant de la MRC parente |
| `nomcartrou` | Nom affiché sur la carte |
| `MUS_NM_MUN` | Nom de la communauté (municipalité) |
| `MOD_NM_MRC` | Nom de la MRC |

### `data/lh_25km_s.topojson`

Zones tampons de 25 km autour de chaque lieu habité, simplifiées à 100 m de tolérance (Douglas-Peucker en EPSG:32198) puis reprojetées en WGS84. Layer name : `lh_zones`. Propriétés : `lH_ID`, `MUN_ID`, `MRC_IDm`, `nomcartrou`.

---

## Buckets Cloudflare R2

Les fiches JPEG sont hébergées sur Cloudflare R2 et servies via CDN public.

| Bucket | URL publique | Nomenclature des fichiers |
|---|---|---|
| `mamh-fiche-mrc` | `https://pub-f2a93385f57b458d9df6612af09e15de.r2.dev` | `Portrait_feux_{MRC_IDm}.jpeg` |
| `mamh-fiche-lh` | `https://pub-7685fd1e38384bd5b20c2481e8e26963.r2.dev` | `FBP_carte_{lH_ID}.jpeg` |

**Exemples :**
```
Portrait_feux_MRC_93A.jpeg
FBP_carte_LH_1478.jpeg
```

Pour uploader de nouvelles fiches via **Wrangler CLI** :

```powershell
$env:CLOUDFLARE_API_TOKEN = "votre_token"   # Permission : R2 Storage Edit

# Upload en lot (PowerShell)
$bucket = "mamh-fiche-lh"
$dir    = "C:\chemin\vers\fiches"

foreach ($f in Get-ChildItem "$dir\*.jpeg") {
    wrangler r2 object put "$bucket/$($f.Name)" `
        --file "$($f.FullName)" `
        --content-type "image/jpeg" `
        --remote
}
```

---

## Pipeline de production des fiches

Les fiches JPEG sont générées par des scripts R maintenus séparément.

```
Shapefiles (EPSG:32198)          Tables CSV (MRNF)
      │                                 │
      └──────────────┬──────────────────┘
                     │
              ┌──────▼───────┐
              │  Scripts R   │
              │  (data.table │
              │  ggplot2     │
              │  sf, terra)  │
              └──────┬───────┘
                     │
          ┌──────────┴──────────┐
          │                     │
   STEP3_MRC.R            STEP4_Commun.R
   1 JPEG / MRC_IDm       1 JPEG / lH_ID
   (108 fiches)           (1 664 fiches)
          │                     │
          └──────────┬──────────┘
                     │  wrangler r2 object put
                     ▼
            Cloudflare R2 buckets
```

**Inputs clés :**

| Fichier | Description |
|---|---|
| `lh25km_clip_munic_mrc_mod.shp` | Zones tampons 25 km (EPSG:32198) |
| `lh_centroide_munic_mrc_mod.shp` | Centroïdes des lieux habités |
| `TA_Combustible_25_mod.csv` | Superficies par classe FBP, clé `lH_ID` |
| `TA_Potentiel_IP_25_mod.csv` | Potentiel d'intensité, clé `lH_ID` |
| `LUT_FBP_FUELTYPE_mrnf.csv` | Dictionnaire types de combustibles |
| `MAMH_MRC_MOD_EXPO_20260608.dbf` | Indice EXPO par MRC |

---

## Développement local

L'application est un fichier HTML statique autonome — aucun serveur Node.js ou backend requis.

```bash
# Option 1 : serveur Python minimal
cd MAMH_Combustibles_fiches/
python -m http.server 8080
# → http://localhost:8080

# Option 2 : extension VS Code "Live Server"
# Ouvrir index.html → clic droit → "Open with Live Server"
```

> ⚠️ **Ouvrir `index.html` directement avec `file://`ne fonctionnera pas** : les requêtes `fetch()` vers `data/` sont bloquées par les politiques CORS des navigateurs. Un serveur local est nécessaire.

**Aucune dépendance npm à installer** — les bibliothèques MapLibre et TopoJSON sont dans `lib/`.

---

## Déploiement

L'application est déployée automatiquement sur **GitHub Pages** à chaque push sur `main`.

URL : `https://uqac-creb.github.io/MAMH_Combustibles_fiches/`

Pour forcer un rechargement du cache navigateur après mise à jour des données, ajouter un paramètre de version dans `index.html` :

```javascript
// Exemple : forcer le rechargement de lut.json
fetch('data/lut.json?v=20260608').then(r => r.json())
```

---

## Modifier les données

### Mettre à jour les fiches JPEG

1. Générer les nouveaux JPEG avec les scripts R
2. Uploader vers le bucket Cloudflare R2 correspondant (voir [Buckets Cloudflare R2](#buckets-cloudflare-r2))

### Mettre à jour la carte (GeoJSON / TopoJSON)

Les fichiers spatiaux sont générés depuis les shapefiles sources avec Python (geopandas) et l'outil CLI `geo2topo` (npm `topojson-server`) :

```bash
# Régénérer lh_p.geojson depuis le shapefile centroïdes
python generate_spatial.py   # script à adapter selon vos shapefiles

# Convertir le shapefile buffer en TopoJSON
# 1. Simplifier à 100m (Douglas-Peucker, EPSG:32198) → export GeoJSON WGS84
# 2. Convertir en TopoJSON
geo2topo -q 1000000 lh_zones=lh_25km_s.geojson -o lh_25km_s.topojson
```

### Changer les URLs des buckets Cloudflare

Dans `index.html`, modifier les constantes en tête de script :

```javascript
const CLOUDFLARE_URL     = 'https://pub-XXXX.r2.dev';  // bucket fiches communautés
const CLOUDFLARE_URL_MRC = 'https://pub-YYYY.r2.dev';  // bucket fiches MRC
```

---

## Auteurs et contact

**Observatoire régional de recherche sur la forêt boréale (CREB) — UQAC**

| Nom | Rôle | Courriel |
|---|---|---|
| Hugues Dorion | Développement, géomatique, production des fiches | hdorion@uqac.ca |
| Victor Danneyrolles | Recherche, validation scientifique | vdanneyr@uqac.ca |
| Yan Boucher | Direction scientifique | yboucher@uqac.ca |

**Partenaire :** Ministère des Affaires Municipales et de l'Habitation du Québec (MAMH)

---

## Licence

© 2026 Observatoire régional de recherche sur la forêt boréale — UQAC. Tous droits réservés.  
Les données sources sont soumises aux licences de leurs producteurs respectifs (voir [Sources de données](#sources-de-données)).