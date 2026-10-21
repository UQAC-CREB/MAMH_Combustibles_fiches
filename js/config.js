// Configuration de l'application v2

export const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// Tuiles raster PMTiles et contours de feux FlatGeobuf : servis localement en développement (scripts/serve.py),
// depuis Cloudflare R2 en production. → Remplacer R2_TILES_URL après le téléversement.
export const R2_TILES_URL = 'https://pub-484da2c562d54ec39393660f95b0716a.r2.dev';   // bucket mamh-v2-carto
export const TILES_BASE = IS_LOCAL ? `${location.origin}${location.pathname.replace(/[^/]*$/, '')}tiles_v2` : R2_TILES_URL;
export const TILES = {
  comb: `${TILES_BASE}/combustibles_2025.pmtiles`,
  pot: `${TILES_BASE}/potentiel_ip_2025.pmtiles`,
  feux: `${TILES_BASE}/feux.fgb`,
};

export const DATA_VERSION = '20261021b';
export const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
export const QC_BOUNDS = [[-79.8, 44.9], [-57.0, 62.6]];

// NAD83 / Québec Lambert (EPSG:32198)
export const PROJ_LCC = '+proj=lcc +lat_1=60 +lat_2=46 +lat_0=44 +lon_0=-68.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs';

export const YEAR_END = 2025;       // dernière année des contours de feux (MAJ2026)
export const PT_YEAR_END = 2024;    // dernière année des points d'origine (occurrences)
export const BUFFER_DEFAULT = 25;
export const BUFFER_MAX = 50;
export const FIRE_MIN_ZOOM = 6.5;     // zoom à partir duquel les contours de feux sont chargés

// Palette de l'indice de prédisposition standardisé (0 à 1) : [valeur, couleur, opacité]
// 0 ≈ transparent → vert de la v2 → jaune à 0,5 → rouge foncé à 1 (même palette que scripts/config.py).
export const INDEX_PALETTE = [
  [0.00, '#8db840', 0.0], [0.10, '#8db840', 0.35], [0.25, '#8db840', 1], [0.50, '#f5e000', 1],
  [0.62, '#f39c12', 1], [0.80, '#e31a1c', 1], [1.00, '#67001f', 1],
];
export const INDEX_MAX = 1;

export const COLORS = { humain: '#56B4E9', foudre: '#E69F00', burn: '#8b0000', lh: '#e67e22', sel: '#2980b9' };

// Rampe de couleurs des contours de feux selon l'année
export const FIRE_RAMP = [
  [1887, '#5b3a8c'], [1940, '#7b5fb0'], [1975, '#a68bd0'],
  [1976, '#2c7fb8'], [1990, '#41b6c4'], [2005, '#fdae61'], [2015, '#f46d43'], [2025, '#a50026'],
];
