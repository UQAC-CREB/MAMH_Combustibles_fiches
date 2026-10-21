// MAMH — Prédisposition des communautés aux feux de forêt — application v2
import {
  TILES, BASEMAP, QC_BOUNDS, PROJ_LCC, YEAR_END, PT_YEAR_END, BUFFER_DEFAULT, BUFFER_MAX,
  FIRE_MIN_ZOOM, INDEX_PALETTE, INDEX_MAX, COLORS, FIRE_RAMP, DATA_VERSION,
} from './config.js';
import { loadCore, loadPoints } from './data.js';
import { unitSeries, zoneSeries, bufferStats, geomToLccPolys, makeContains, indexAt, indexStats } from './stats.js';
import { occChart, supChart, hbarChart, bindChartTips, fmtInt, fmtPct } from './charts.js';
import { Combo, norm } from './combobox.js';
import { openReportDialog, refreshReportDialog } from './report.js';
import { RasterPicker } from './rasterpick.js';
import { initErrors, watchMap, logEvent } from './errors.js';
import { t, loc, getLang, setLang, onLang, applyStatic, cAbb, cLbl, cGrp, pLbl, pShort, LEGEND } from './i18n.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const lcc = proj4('EPSG:4326', PROJ_LCC);

// ── État ───────────────────────────────────────────────────────────────────
export const S = {
  core: null, map: null,
  mode: 'mrc',            // 'mrc' | 'zone'
  unit: null,             // id de l'unité MRC sélectionnée
  zone: null,             // { geojson, polys, kind: { k: 'drawn'|'extent' } }
  terrLH: [],             // lieux habités du territoire courant
  series: null,           // série INFO-MRC courante
  terrName: '',
  idx: null,              // indice du territoire : { mean, sd, n }
  lh: null,               // lieu habité sélectionné (objet de lh.json)
  bufKm: BUFFER_DEFAULT,
  buf: null,              // { comb[], pot[] } superficies ha
  lhIdx: null,            // indice dans la zone tampon : { mean, sd, n }
  autoComb: false,        // combustibles affichés automatiquement à la sélection d'une communauté
  log: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// Utilitaires
// ═══════════════════════════════════════════════════════════════════════════
/** Couleur (opaque) de l'indice : pastilles et chiffres ; sous 0,25 on garde le vert lisible. */
export function indexColor(v) {
  const x = Math.max(0, Math.min(1, v / INDEX_MAX));
  for (let i = 1; i < INDEX_PALETTE.length; i++) {
    if (x <= INDEX_PALETTE[i][0]) return INDEX_PALETTE[x - INDEX_PALETTE[i - 1][0] < INDEX_PALETTE[i][0] - x ? i - 1 : i][1];
  }
  return INDEX_PALETTE.at(-1)[1];
}
export const fmtIdx = (v) => (v == null ? '—' : (+v).toLocaleString(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function geomBBox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
    else c.forEach(walk);
  };
  if (g.type === 'FeatureCollection') g.features.forEach(f => walk(f.geometry.coordinates));
  else if (g.type === 'Feature') walk(g.geometry.coordinates);
  else walk(g.coordinates);
  return [[x0, y0], [x1, y1]];
}

export const lhName = (r) => r.na || r.nom;
export const lhSub = (r) => [r.na && r.na !== r.nom ? r.nom : null, r.mun !== r.nom ? r.mun : null].filter(Boolean).join(' · ');
export const unitProps = (id) => S.core.units.features.find(f => f.properties.id === id)?.properties;

/** Nom du territoire courant dans la langue active. */
function terrLabel() {
  if (S.unit) return `${t('mrc')} ${unitProps(S.unit)?.nom || ''}`;
  if (S.zone) return t(S.zone.kind.k === 'extent' ? 'zone.extent' : 'zone.drawn');
  return '';
}

/** Cercle (zone tampon) construit en Lambert, cohérent avec le calcul des anneaux. */
export function bufferCircle(r, km) {
  const [cx, cy] = lcc.forward([r.x, r.y]);
  const ring = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * 2 * Math.PI;
    ring.push(lcc.inverse([cx + km * 1000 * Math.cos(a), cy + km * 1000 * Math.sin(a)]));
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Masque mondial troué par la zone tampon (anneau intérieur = cercle, sens inverse). */
function bufferMask(r, km) {
  const hole = bufferCircle(r, km).geometry.coordinates[0].slice().reverse();
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, hole] } };
}

/** Affiche (ou retire) la zone tampon et son masque. */
function showBuffer(r) {
  S.map.getSource('buffer').setData(r ? bufferCircle(r, S.bufKm) : EMPTY);
  S.map.getSource('buffer-mask').setData(r ? bufferMask(r, S.bufKm) : EMPTY);
}

// ═══════════════════════════════════════════════════════════════════════════
// Carte
// ═══════════════════════════════════════════════════════════════════════════
function initMap() {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const map = new maplibregl.Map({
    container: 'map-container', style: BASEMAP, bounds: QC_BOUNDS,
    fitBoundsOptions: { padding: 20 }, attributionControl: false, maxPitch: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },   // capture pour le rapport PDF
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.on('style.load', () => { try { map.setProjection({ type: 'globe' }); } catch (e) { /* MapLibre < 5 */ } });
  S.map = map;
  // Le cadrage initial est calculé en Mercator : on recadre une fois le globe actif,
  // en laissant de la place à droite pour le panneau des couches.
  return new Promise((res) => map.on('load', () => { fitQuebec(); res(); }));
}

/** Cadre toute la province, sans la cacher sous le panneau des couches. */
function fitQuebec() {
  const lp = $('layers-panel'), cw = S.map.getContainer().clientWidth;
  const lpw = lp && !lp.classList.contains('collapsed') ? lp.offsetWidth + 10 : 0;
  const right = lpw && cw - lpw > 300 ? lpw + 10 : 20;   // petit écran : le panneau chevauche la carte
  S.map.fitBounds(QC_BOUNDS, { padding: { top: 20, bottom: 20, left: 20, right }, duration: 0 });
}

function addLayers() {
  const map = S.map, core = S.core;
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

  // Rasters (PMTiles, Cloudflare R2)
  map.addSource('comb', { type: 'raster', url: `pmtiles://${TILES.comb}`, tileSize: 256 });
  map.addSource('pot', { type: 'raster', url: `pmtiles://${TILES.pot}`, tileSize: 256 });
  map.addLayer({ id: 'comb', type: 'raster', source: 'comb', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);
  map.addLayer({ id: 'pot', type: 'raster', source: 'pot', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);

  // Indice de prédisposition standardisé (raster 5 km, rendu EPSG:3857)
  map.addSource('indice', { type: 'image', url: `data/indice_3857.png?v=${DATA_VERSION}`, coordinates: core.indiceMeta.coords });
  map.addLayer({ id: 'indice', type: 'raster', source: 'indice',
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);

  // Unités MRC (remplissage invisible : survol et clic)
  map.addSource('units', { type: 'geojson', data: core.units, promoteId: 'uid' });
  map.addLayer({ id: 'units-fill', type: 'fill', source: 'units',
    paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, firstSymbol);

  // Régime de feux
  map.addSource('regime', { type: 'geojson', data: core.regime });
  map.addLayer({ id: 'regime-line', type: 'line', source: 'regime', layout: { visibility: 'none' },
    paint: { 'line-color': '#9a5b10', 'line-width': 1.6, 'line-dasharray': [3, 2] } });

  // Contours de feux (FlatGeobuf → GeoJSON selon l'emprise)
  map.addSource('feux', { type: 'geojson', data: EMPTY, tolerance: 0.3 });
  const fireColor = ['interpolate', ['linear'], ['get', 'an'], ...FIRE_RAMP.flat()];
  map.addLayer({ id: 'feux-fill', type: 'fill', source: 'feux', layout: { visibility: 'none' },
    paint: { 'fill-color': fireColor, 'fill-opacity': 0.6 } });
  map.addLayer({ id: 'feux-line', type: 'line', source: 'feux', minzoom: 8, layout: { visibility: 'none' },
    paint: { 'line-color': fireColor, 'line-width': 0.6, 'line-opacity': 0.9 } });

  map.addLayer({ id: 'units-line', type: 'line', source: 'units', paint: { 'line-color': '#555', 'line-width': 0.7, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'units-sel', type: 'line', source: 'units', filter: ['==', ['get', 'id'], '__'],
    paint: { 'line-color': COLORS.sel, 'line-width': 3 } });

  // Zone définie par l'utilisateur
  map.addSource('zone', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': COLORS.sel, 'fill-opacity': 0.06 } });
  map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': COLORS.sel, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

  // Zone tampon de la communauté
  map.addSource('buffer', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'buffer-fill', type: 'fill', source: 'buffer', paint: { 'fill-color': COLORS.lh, 'fill-opacity': 0 } });
  // Masque : tout l'extérieur de la zone tampon est grisé (l'intérieur reste entièrement visible)
  map.addSource('buffer-mask', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'buffer-mask', type: 'fill', source: 'buffer-mask',
    paint: { 'fill-color': '#6b7280', 'fill-opacity': 0.5, 'fill-antialias': false } });
  map.addLayer({ id: 'buffer-line', type: 'line', source: 'buffer', paint: { 'line-color': '#111', 'line-width': 2 } });

  // Points d'origine
  map.addSource('pts', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 9, 3.5, 12, 5],
      'circle-color': ['match', ['get', 'c'], 1, COLORS.foudre, COLORS.humain],
      'circle-stroke-color': '#fff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0, 9, 0.8],
    } });

  // Lieux habités du territoire
  map.addSource('lh', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'lh-circle', type: 'circle', source: 'lh',
    paint: {
      'circle-radius': ['case', ['get', 'sel'], 7.5, 5], 'circle-color': ['case', ['get', 'sel'], '#111', COLORS.lh],
      'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff',
    } });
  map.addLayer({ id: 'lh-label', type: 'symbol', source: 'lh',
    layout: {
      'text-field': ['get', 'nom'], 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': ['case', ['get', 'sel'], 13, 11], 'text-offset': [0, 1.1], 'text-anchor': 'top',
      'text-optional': true, 'symbol-sort-key': ['case', ['get', 'sel'], 0, 1],
    },
    paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 2 } });

  bindMapEvents();
  bindLayerPanel();
}

// ── Interactions carte ─────────────────────────────────────────────────────
function bindMapEvents() {
  const map = S.map, tt = $('map-tooltip');
  const layers = ['lh-circle', 'pts', 'feux-fill', 'units-fill'];
  const pickers = { comb: new RasterPicker(TILES.comb), pot: new RasterPicker(TILES.pot) };
  const combByV = new Map(S.core.classes.comb.map(c => [c.v, c]));
  const potByV = new Map(S.core.classes.pot.map(c => [c.v, c]));
  const sw = (hex) => `<i class="tt-sw" style="background:${hex}"></i>`;
  let token = 0;

  const place = (pt) => {
    const r = $('map').getBoundingClientRect();
    let x = pt.x + 14, y = pt.y + 14;
    if (x + tt.offsetWidth > r.width - 6) x = pt.x - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > r.height - 6) y = pt.y - tt.offsetHeight - 14;
    tt.style.left = `${x}px`; tt.style.top = `${y}px`;
  };

  /** Élément vectoriel survolé (titre + sous-titre). */
  function featureHTML(f, feats) {
    if (!f) return '';
    const p = f.properties;
    if (f.layer.id === 'lh-circle') {
      const r = S.core.lh[p.idx];
      return `${lhName(r)}<div class="tt-sub">${lhSub(r) || ''}</div>`;
    }
    if (f.layer.id === 'pts') {
      const dd = String(p.j % 100).padStart(2, '0'), mm = String(Math.floor(p.j / 100)).padStart(2, '0');
      const d = p.j ? (getLang() === 'en' ? `${p.an}-${mm}-${dd}` : `${dd}/${mm}/${p.an}`) : p.an;
      return `${t('tt.fireStart', { d })}<div class="tt-sub">${t('tt.cause', { c: t(p.c ? 'cause.f' : 'cause.h') })}</div>`;
    }
    if (f.layer.id === 'feux-fill') {
      // un feu peut compter plusieurs polygones : on n'affiche que l'année
      const years = [...new Set(feats.filter(x => x.layer.id === 'feux-fill').map(x => x.properties.an))].sort((a, b) => b - a);
      return t('tt.fire', { y: years.slice(0, 5).join(', ') + (years.length > 5 ? '…' : '') });
    }
    return `${p.nom}<div class="tt-sub">${t('tt.unitIdx', { m: fmtIdx(p.im), s: fmtIdx(p.isd) })}</div>`;
  }

  map.on('mousemove', async (e) => {
    if (drawing) return;
    const my = ++token;
    const feats = map.queryRenderedFeatures(e.point, { layers: layers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') });
    const f = feats[0];
    map.getCanvas().style.cursor = f && (f.layer.id === 'lh-circle' || (f.layer.id === 'units-fill' && S.mode === 'mrc')) ? 'pointer' : '';
    const { lng, lat } = e.lngLat;

    // Valeurs des couches raster activées
    const lines = [];
    if ($('ly-indice').checked) {
      const v = indexAt(S.core, lng, lat);
      if (v != null) lines.push(`${sw(indexColor(v))}${t('tt.index', { v: fmtIdx(v) })}`);
    }
    const head = featureHTML(f, feats);
    const render = () => {
      if (!head && !lines.length) { tt.style.display = 'none'; return; }
      tt.innerHTML = head + (lines.length ? `<div class="tt-sub tt-rasters">${lines.join('<br>')}</div>` : '');
      tt.style.display = 'block';
      place(e.point);
    };
    render();

    const want = ['comb', 'pot'].filter(k => $(`ly-${k}`).checked);
    if (!want.length) return;
    const vals = await Promise.all(want.map(k => pickers[k].valueAt(lng, lat, map.getZoom())));
    if (my !== token) return;                      // le curseur a bougé entre-temps
    want.forEach((k, n) => {
      const v = vals[n];
      if (v == null) return;
      const c = (k === 'comb' ? combByV : potByV).get(v);
      if (!c) return;
      lines.push(k === 'comb'
        ? `${sw(c.hex)}${t('tt.comb', { a: cAbb(c), l: cLbl(c) !== cAbb(c) ? ` — ${cLbl(c)}` : '' })}`
        : `${sw(c.hex)}${t('tt.pot', { l: pLbl(c) })}`);
    });
    render();
  });
  map.on('mouseout', () => { tt.style.display = 'none'; });
  map.on('click', (e) => {
    if (drawing) return;
    const lhF = map.queryRenderedFeatures(e.point, { layers: ['lh-circle'] })[0];
    if (lhF) { selectLH(S.core.lh[lhF.properties.idx]); return; }
    if (S.mode !== 'mrc') return;
    const u = map.queryRenderedFeatures(e.point, { layers: ['units-fill'] })[0];
    if (u) selectUnit(u.properties.id);
  });
  map.on('moveend', () => { loadFiresInView(); });
}

// ── Contours de feux : lecture FlatGeobuf par emprise ─────────────────────
const fireCache = { boxes: [], feats: new Map(), token: 0 };
function boxContains(a, b) { return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]; }

export async function loadFiresInView() {
  const map = S.map;
  const note = $('feux-note');
  if (!$('ly-feux').checked) return;
  if (map.getZoom() < FIRE_MIN_ZOOM) {
    note.textContent = t('fires.zoom');
    return;
  }
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if (fireCache.boxes.some(bx => boxContains(bx, view))) return;
  const dx = (view[2] - view[0]) * 0.25, dy = (view[3] - view[1]) * 0.25;
  const q = [view[0] - dx, view[1] - dy, view[2] + dx, view[3] + dy];
  const token = ++fireCache.token;
  // cache limité : trop de polygones épuisent la mémoire graphique (écran noir)
  if (fireCache.feats.size > 30000) { fireCache.feats.clear(); fireCache.boxes = []; }
  note.innerHTML = `<span class="spin-inline"></span> ${t('fires.loading')}`;
  try {
    let k = 0;
    const iter = flatgeobuf.deserialize(`${TILES.feux}?v=${DATA_VERSION}`, { minX: q[0], minY: q[1], maxX: q[2], maxY: q[3] });
    for await (const f of iter) {
      if (token !== fireCache.token) return;
      const c = f.geometry.coordinates;
      const first = f.geometry.type === 'Polygon' ? c[0][0] : c[0][0][0];
      const key = `${f.properties.an}|${f.properties.ha}|${first[0].toFixed(5)}|${first[1].toFixed(5)}`;
      fireCache.feats.set(key, f);
      if (++k % 3000 === 0) map.getSource('feux').setData({ type: 'FeatureCollection', features: [...fireCache.feats.values()] });
    }
    fireCache.boxes.push(q);
    map.getSource('feux').setData({ type: 'FeatureCollection', features: [...fireCache.feats.values()] });
    note.textContent = t('fires.hover');
  } catch (err) {
    console.warn('Feux :', err);
    logEvent('feux', err.message || err);
    note.textContent = t('fires.na');
  }
}

// ── Panneau des couches ───────────────────────────────────────────────────
// Deux grandes périodes ; le curseur double choisit les années de début et de fin dans la période.
const PERIODS = { recent: [1976, YEAR_END], old: [1887, 1975] };
const PERIOD_DEFAULT = 'recent';

function buildPeriods() {
  const sel = $('sel-periode'), cur = sel.value || PERIOD_DEFAULT;
  sel.innerHTML = [['recent', t('period.recent', { y: YEAR_END })], ['old', t('period.old')]]
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = cur;
}

/** Bornes du curseur et rampe de couleurs selon la période choisie (années remises aux extrémités). */
function setPeriodRange() {
  const [lo, hi] = PERIODS[$('sel-periode').value];
  for (const [id, v] of [['yr-a', lo], ['yr-b', hi]]) Object.assign($(id), { min: lo, max: hi, value: v });
  $('yr-lo').textContent = lo; $('yr-hi').textContent = hi;
  const pct = (y) => ((y - lo) / (hi - lo) * 100).toFixed(1);
  $('ramp-feux').style.background = `linear-gradient(to right, ${FIRE_RAMP.map(([y, c]) => `${c} ${pct(y)}%`).join(', ')})`;
  applyYears();
}

/** Années choisies → filtre des contours et des points d'origine. */
function applyYears() {
  const [lo, hi] = PERIODS[$('sel-periode').value];
  let a = +$('yr-a').value, b = +$('yr-b').value;
  if (a > b) [a, b] = [b, a];
  const pct = (y) => `${(y - lo) / (hi - lo) * 100}%`;
  $('yr-shade-a').style.width = pct(a);
  $('yr-shade-b').style.left = pct(b);
  $('yr-sel').textContent = a === b ? `${a}` : `${a} – ${b}`;
  const f = ['all', ['>=', ['get', 'an'], a], ['<=', ['get', 'an'], b]];
  ['feux-fill', 'feux-line', 'pts'].forEach(id => S.map.setFilter(id, f));
}

function buildMiniLegends() {
  // combustibles : nom complet de chaque classe, regroupées comme dans les graphiques
  $('leg-comb').innerHTML = combGroups().map(gr => `<span class="leg-mini-grp">${gr.label}</span>` +
    gr.items.map(c => `<span><i style="background:${c.hex}"></i><b>${cAbb(c)}</b>${cLbl(c) !== cAbb(c) ? ` ${cLbl(c)}` : ''}</span>`).join('')).join('');
  $('leg-pot').innerHTML = S.core.classes.pot.map(c => `<span><i style="background:${c.hex}"></i>${pLbl(c)}</span>`).join('');
}

async function refreshPoints() {
  if (!$('ly-pts').checked) return;
  const map = S.map;
  if (!map.getSource('pts')._loaded) {
    const p = await loadPoints();
    const feats = new Array(p.n);
    for (let i = 0; i < p.n; i++) feats[i] = { type: 'Feature', properties: { an: p.an[i], c: p.c[i], j: p.j[i], ha: p.ha[i] }, geometry: { type: 'Point', coordinates: [p.x[i], p.y[i]] } };
    map.getSource('pts').setData({ type: 'FeatureCollection', features: feats });
    map.getSource('pts')._loaded = true;
  }
}

function bindLayerPanel() {
  const map = S.map;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');

  buildPeriods();
  setPeriodRange();
  $('sel-periode').addEventListener('change', setPeriodRange);
  $('yr-a').addEventListener('input', applyYears);
  $('yr-b').addEventListener('input', applyYears);

  $('ly-indice').addEventListener('change', (e) => vis('indice', e.target.checked));
  $('op-indice').addEventListener('input', (e) => map.setPaintProperty('indice', 'raster-opacity', e.target.value / 100));
  $('ly-feux').addEventListener('change', (e) => { vis('feux-fill', e.target.checked); vis('feux-line', e.target.checked); loadFiresInView(); });
  $('op-feux').addEventListener('input', (e) => {
    map.setPaintProperty('feux-fill', 'fill-opacity', e.target.value / 100);
    map.setPaintProperty('feux-line', 'line-opacity', Math.min(1, e.target.value / 100 + 0.3));
  });
  $('ly-pts').addEventListener('change', async (e) => { vis('pts', e.target.checked); if (e.target.checked) await refreshPoints(); });
  const rasterToggle = (id) => {
    $(`ly-${id}`).addEventListener('change', (e) => {
      vis(id, e.target.checked);
      if (e.target.checked && $('ly-indice').checked) {
        // l'indice masquerait le raster : on le masque
        $('ly-indice').checked = false; vis('indice', false);
      }
    });
    $(`op-${id}`).addEventListener('input', (e) => map.setPaintProperty(id, 'raster-opacity', e.target.value / 100));
  };
  rasterToggle('comb'); rasterToggle('pot');
  $('ly-regime').addEventListener('change', (e) => vis('regime-line', e.target.checked));

  buildMiniLegends();

  $('lp-toggle').addEventListener('click', () => {
    $('layers-panel').classList.toggle('collapsed');
    $('lp-arrow').textContent = $('layers-panel').classList.contains('collapsed') ? '▸' : '▾';
  });
}

/** Coche / décoche une couche du panneau (mêmes effets qu'un clic). */
function setLayer(id, on) {
  if ($(id).checked === on) return;
  $(id).checked = on; $(id).dispatchEvent(new Event('change'));
}

/** Couches et réglages de départ. */
function resetLayers() {
  const on = { 'ly-indice': true, 'ly-feux': false, 'ly-pts': false, 'ly-comb': false, 'ly-pot': false, 'ly-regime': false };
  for (const [id, v] of Object.entries(on)) setLayer(id, v);
  for (const el of document.querySelectorAll('#layers-panel input[type=range][id^="op-"]')) {
    el.value = el.defaultValue; el.dispatchEvent(new Event('input'));
  }
  $('sel-periode').value = PERIOD_DEFAULT; setPeriodRange();
}

// ═══════════════════════════════════════════════════════════════════════════
// Territoire : MRC ou zone
// ═══════════════════════════════════════════════════════════════════════════
let comboMRC, comboLH;
let lhLcc = null;             // coordonnées Lambert des lieux habités

function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('#mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('sec-mrc').style.display = mode === 'mrc' ? '' : 'none';
  $('sec-zone').style.display = mode === 'zone' ? '' : 'none';
}

function clearTerritory() {
  S.unit = null; S.zone = null; S.series = null; S.terrLH = []; S.idx = null; S.terrName = '';
  S.map.setFilter('units-sel', ['==', ['get', 'id'], '__']);
  S.map.getSource('zone').setData(EMPTY);
  comboMRC.set(null, false);
  setTerritoryLH([]);
  renderIndex(); renderMRC();
  selectLH(null);
}

/** Bouton Réinitialiser : territoire, communauté, zone tampon, couches et cadrage de départ. */
function resetAll() {
  if (drawing) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  clearTerritory();
  setMode('mrc');
  S.bufKm = BUFFER_DEFAULT;
  S.autoComb = false;
  resetLayers();
  applyStatic();                       // textes d'aide d'origine (zone, notes des couches)
  document.querySelectorAll('#box-mrc, #box-lh').forEach(b => b.classList.add('collapsed'));
  document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  S.map.stop();
  fitQuebec();
}

export function selectUnit(id, { fit = true, keepLH = false } = {}) {
  if (!id) { clearTerritory(); return; }
  // nouveau territoire : l'affichage communauté repart à zéro (sauf bascule depuis selectLH)
  if (S.lh && !keepLH && id !== S.unit) selectLH(null);
  setMode('mrc');
  const f = S.core.units.features.find(x => x.properties.id === id);
  S.unit = id; S.zone = null;
  S.map.getSource('zone').setData(EMPTY);
  comboMRC.set(id, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], id]);
  if (fit && f) S.map.fitBounds(geomBBox(f.geometry), { padding: 40, duration: 900 });
  S.terrName = terrLabel();
  S.idx = f.properties.im != null ? { mean: f.properties.im, sd: f.properties.isd, n: f.properties.in } : null;
  S.series = unitSeries(S.core, id);
  setTerritoryLH(S.core.lh.filter(r => r.u === id));
  renderIndex(); renderMRC();
}

function zoneMsg() {
  if (!S.zone) return;
  const ha = S.series ? S.series.areaHa : 0;
  $('zone-msg').innerHTML = S.zone.pending
    ? `<b>${S.terrName}</b> — ${t('zone.computing')} <span class="spin-inline"></span>`
    : `<b>${S.terrName}</b> — ${t('zone.summary', { km2: fmtInt(ha / 100), n: S.terrLH.length })}`;
}

async function setZone(geojson, kind) {
  if (S.lh) selectLH(null);
  setMode('zone');
  S.unit = null;
  comboMRC.set(null, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], '__']);
  const polys = geomToLccPolys(geojson, 50);     // simplification 50 m (grille de calcul : 1 km)
  if (!polys.length) { $('zone-msg').textContent = t('zone.invalid'); return; }
  S.zone = { geojson, polys, kind, pending: true };
  S.terrName = terrLabel();
  S.map.getSource('zone').setData(geojson);
  zoneMsg();
  $('mrc-content').innerHTML = `<div class="placeholder"><span class="spin-inline"></span> ${t('zone.computingStats')}</div>`;

  // lieux habités dans la zone
  const inZone = makeContains(polys);
  lhLcc ??= S.core.lh.map(r => lcc.forward([r.x, r.y]));
  setTerritoryLH(S.core.lh.filter((r, i) => inZone(lhLcc[i][0], lhLcc[i][1])));

  // indice : moyenne et écart-type des pixels de 5 km de la zone
  S.idx = indexStats(S.core, polys);
  try {
    S.series = await zoneSeries(S.core, polys);
  } catch (err) {
    console.error(err); S.series = null;
  }
  if (S.zone?.polys !== polys) return;      // zone remplacée entre-temps
  S.zone.pending = false;
  zoneMsg();
  renderIndex(); renderMRC();
}

function lhPlaceholder() {
  return S.terrLH.length ? t('lh.ph.choose', { n: S.terrLH.length }) : t(S.unit || S.zone ? 'lh.ph.none' : 'lh.ph.first');
}

function setTerritoryLH(list) {
  S.terrLH = list.slice().sort((a, b) => lhName(a).localeCompare(lhName(b), 'fr'));
  comboLH.setItems(S.terrLH.map(r => ({ value: r.idx, label: lhName(r), sub: lhSub(r), keys: `${r.nom} ${r.al || ''} ${r.mun}` })), {
    disabled: !S.terrLH.length, placeholder: lhPlaceholder(),
  });
  refreshLHLayer();
  $('btn-rapport').disabled = !(S.series || S.terrLH.length);
}

function refreshLHLayer() {
  S.map.getSource('lh').setData({
    type: 'FeatureCollection',
    features: S.terrLH.map(r => ({ type: 'Feature', properties: { idx: r.idx, nom: lhName(r), sel: r === S.lh }, geometry: { type: 'Point', coordinates: [r.x, r.y] } })),
  });
}

function mrcItems() {
  const units = S.core.units.features.map(f => f.properties).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  return units.map(p => ({
    value: p.id, label: p.nom,
    sub: `${t('mrc.sub', { i: fmtIdx(p.im) })}${norm(p.mrc) !== norm(p.nom) ? ` · ${t('mrc')} ${p.mrc}` : ''}`,
    keys: p.mrc,
  }));
}

// ── Dessin d'un rectangle ──────────────────────────────────────────────────
let drawing = false;
function startDraw() {
  const map = S.map, mapEl = $('map'), box = $('draw-box');
  drawing = true; mapEl.classList.add('drawing'); $('btn-draw').classList.add('on');
  map.dragPan.disable(); map.boxZoom.disable();
  let start = null;
  const canvas = map.getCanvasContainer();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onDown = (e) => {
    if (e.button !== 0) return;
    start = pos(e); box.style.display = 'block';
    Object.assign(box.style, { left: `${start[0]}px`, top: `${start[1]}px`, width: '0px', height: '0px' });
  };
  const onMove = (e) => {
    if (!start) return;
    const p = pos(e);
    Object.assign(box.style, {
      left: `${Math.min(p[0], start[0])}px`, top: `${Math.min(p[1], start[1])}px`,
      width: `${Math.abs(p[0] - start[0])}px`, height: `${Math.abs(p[1] - start[1])}px`,
    });
  };
  const onUp = (e) => {
    if (!start) return;
    const p = pos(e), a = start;
    start = null; stop();
    if (Math.abs(p[0] - a[0]) < 8 || Math.abs(p[1] - a[1]) < 8) return;
    setZone(screenRectToPolygon([Math.min(a[0], p[0]), Math.min(a[1], p[1])], [Math.max(a[0], p[0]), Math.max(a[1], p[1])]), { k: 'drawn' });
  };
  const onKey = (e) => { if (e.key === 'Escape') { start = null; stop(); } };
  function stop() {
    drawing = false; mapEl.classList.remove('drawing'); $('btn-draw').classList.remove('on');
    box.style.display = 'none';
    map.dragPan.enable(); map.boxZoom.enable();
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
  }
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
}

/** Rectangle écran → polygone géographique (arêtes densifiées : globe / Mercator). */
function screenRectToPolygon([x0, y0], [x1, y1]) {
  const pts = [], n = 16;
  const edge = (ax, ay, bx, by) => { for (let i = 0; i < n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]); };
  edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
  const ring = pts.map(p => { const ll = S.map.unproject(p); return [+ll.lng.toFixed(5), +ll.lat.toFixed(5)]; });
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Panneau : indice, INFO-MRC, INFO-COMMUNAUTÉ
// ═══════════════════════════════════════════════════════════════════════════
function renderIndex() {
  const el = $('expo-value'), mk = $('expo-marker'), band = $('expo-band'), e = S.idx;
  if (!e) {
    el.innerHTML = `<div class="expo-note">${t(S.unit || S.zone ? 'idx.none' : 'idx.choose')}</div>`;
    mk.style.display = band.style.display = 'none';
    return;
  }
  const pos = (v) => Math.max(0, Math.min(100, (v / INDEX_MAX) * 100));
  mk.style.display = band.style.display = 'block';
  mk.style.left = `${pos(e.mean)}%`;
  band.style.left = `${pos(e.mean - e.sd)}%`;
  band.style.width = `${pos(e.mean + e.sd) - pos(e.mean - e.sd)}%`;
  el.innerHTML = `<div class="expo-value"><span class="expo-num" style="color:${indexColor(e.mean)}">${fmtIdx(e.mean)}</span>
    <span class="expo-rank">${t('idx.meanSd', { s: fmtIdx(e.sd) })}</span></div>
    <div class="expo-note">${t('idx.note', { t: S.zone ? t('idx.zone') : S.terrName, n: e.n })}</div>`;
}

function chartWidth(el) { return Math.max(300, Math.round(el.clientWidth || 420)); }

/** Contenu INFO-MRC (panneau ou fiche agrandie). */
function mrcHTML(w, big = false) {
  const s = S.series;
  const period = `${s.y0}–${YEAR_END}`;
  const regNote = s.long && s.y0 >= 1972
    ? `<div class="expo-note">${t('mrc.regNoOld')}</div>`
    : S.zone && s.long && s.regimeFrac < 0.98
    ? `<div class="expo-note">${t('mrc.regPart', { p: fmtPct(s.regimeFrac * 100, 0) })}</div>` : '';
  const idx = S.idx ? `<span>${t('idx.short', { m: fmtIdx(S.idx.mean), s: fmtIdx(S.idx.sd) })}</span>` : '';
  const long = s.y0 < 1972;
  return `
    <div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${S.terrName}</div>
    <div class="stat-line"><span class="badge ${long ? 'long' : ''}" title="${t(long ? 'mrc.longTitle' : 'mrc.shortTitle')}">${t(long ? 'mrc.long' : 'mrc.short')} · ${period}</span>
      <span>${t('mrc.fuel', { v: fmtInt(s.fuelHa) })}</span>${big ? idx : ''}</div>
    <div class="stat-line"><span>${t('mrc.fires', { y: PT_YEAR_END, n: fmtInt(s.totOcc), h: fmtInt(s.totH), f: fmtInt(s.totF) })}</span>
      <span>${t('mrc.burned', { v: fmtInt(s.totSup) })}</span></div>
    ${regNote}
    <div class="chart-title">${t('chart.occ')}</div>
    <div class="chart-legend"><span><i style="background:${COLORS.humain}"></i>${t('leg.human')}</span><span><i style="background:${COLORS.foudre}"></i>${t('leg.lightning')}</span><span><i class="band"></i>${t('leg.meanSd')}</span></div>
    <div class="chart">${occChart(s, { width: w, height: big ? 300 : 190, labels: w > 380 })}</div>
    <div class="chart-title">${t('chart.sup')}${S.log ? t('chart.log') : ''}</div>
    <div class="chart">${supChart(s, { width: w, height: big ? 280 : 180, log: S.log })}</div>`;
}

function setSummary(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.title = text ? t('summary.click', { t: text }) : '';
  el.classList.toggle('on', !!text);
}

function renderMRC() {
  const el = $('mrc-content'), s = S.series;
  $('btn-big-mrc').disabled = !s;
  setSummary('sum-mrc', s ? (S.unit ? unitProps(S.unit)?.nom : S.terrName) : '');
  if (!s) {
    el.innerHTML = `<div class="placeholder">${t(S.unit || S.zone ? 'mrc.noData' : 'mrc.choose')}</div>`;
    return;
  }
  el.innerHTML = mrcHTML(chartWidth(el));
}

// ── Communauté ─────────────────────────────────────────────────────────────
export function combRows(ha, classes) {
  return classes.comb.map((c, k) => ({ label: cAbb(c), title: `${cAbb(c)} — ${cLbl(c)}`, ha: ha[k], color: c.hex, grpKey: c.grp, group: cGrp(c.grp) }));
}
export function potRows(ha, classes) {
  return classes.pot.map((c, k) => ({ label: pShort(c), title: pLbl(c), ha: ha[k], color: c.hex })).reverse();
}
export const COMB_ORDER = ['Résineux', 'Mixtes', 'Feuillus', 'Rémanents', 'Herbes', 'Brûlis', 'Dénudé', 'Eau', 'Urbain'];
export function sortComb(rows) {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (COMB_ORDER.indexOf(a.r.grpKey) - COMB_ORDER.indexOf(b.r.grpKey)) || a.i - b.i).map(x => x.r);
}

/** Indice de prédisposition dans la zone tampon (pixels de 5 km dont le centre est dans le cercle). */
export function bufferIndex(r, km) {
  return indexStats(S.core, geomToLccPolys(bufferCircle(r, km)), [r.x, r.y]);
}

export async function selectLH(r, { fit = true } = {}) {
  S.lh = r;
  comboLH.set(r ? r.idx : null, false);
  refreshLHLayer();
  $('btn-big-lh').disabled = !r;
  setSummary('sum-lh', r ? lhName(r) : '');
  if (!r) {
    S.buf = null; S.lhIdx = null;
    showBuffer(null);
    $('lh-content').innerHTML = `<div class="placeholder">${t('lh.choose')}</div>`;
    // combustibles ouverts automatiquement : on revient à l'indice
    if (S.autoComb) {
      S.autoComb = false;
      setLayer('ly-comb', false); setLayer('ly-indice', true);
    }
    return;
  }
  // Territoire : si la communauté n'est pas dans le territoire courant, on bascule sur sa MRC
  if (!S.terrLH.includes(r)) selectUnit(r.u, { fit: false, keepLH: true });
  showBuffer(r);
  // combustibles affichés et zoom sur la zone tampon
  if (!$('ly-comb').checked) { setLayer('ly-comb', true); S.autoComb = true; }
  if (fit) S.map.fitBounds(geomBBox(bufferCircle(r, S.bufKm)), { padding: 40, duration: 800 });
  $('lh-content').innerHTML = `${lhHeader(r)}<div class="placeholder"><span class="spin-inline"></span> ${t('lh.loading')}</div>`;
  await updateBuffer();
}

function lhHeader(r, big = false) {
  return `<div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${lhName(r)}</div>
    <div class="box-sub">${lhSub(r) ? lhSub(r) + ' · ' : ''}${r.nat ? `${r.nat} <span class="badge" title="${t('lh.toValidateTitle')}">${t('lh.toValidate')}</span> · ` : ''}${t('mrc')} ${unitProps(r.u)?.nom || ''}</div>`;
}

async function updateBuffer() {
  const r = S.lh;
  if (!r) return;
  try {
    S.buf = await bufferStats(r.idx, S.bufKm);
    S.lhIdx = bufferIndex(r, S.bufKm);
  } catch (err) {
    console.error(err);
    $('lh-content').innerHTML = `${lhHeader(r)}<div class="placeholder">${t('lh.na')}</div>`;
    return;
  }
  if (S.lh !== r) return;
  renderLH();
}

/**
 * Paire de graphiques communauté de MÊME hauteur (comme les fiches v1) : les classes de
 * potentiel s'alignent grossièrement sur les groupes de combustibles correspondants.
 */
export function lhChartPair(buf, cls, width, { combRowH = 14, fontSize = 9.5 } = {}) {
  const comb = sortComb(combRows(buf.comb, cls)), pot = potRows(buf.pot, cls);
  const potRowH = (combRowH * comb.length) / pot.length;
  return {
    pot: hbarChart(pot, { width, rowH: potRowH, labelW: 86, fontSize: fontSize + 1 }),
    comb: hbarChart(comb, { width, rowH: combRowH, labelW: 52, groupW: 64, fontSize }),
  };
}

/** Graphiques INFO-COMMUNAUTÉ (panneau ou fiche agrandie). */
function lhChartsHTML(w, big = false) {
  const b = S.buf, cls = S.core.classes;
  const tot = b.comb.reduce((a, v) => a + v, 0);
  if (!tot) return `<div class="placeholder">${t('lh.noFuel')}</div>`;
  const gap = big ? 24 : 12;
  const side = (w - gap) / 2 >= 230;               // côte à côte si la place le permet
  const cw = side ? Math.floor((w - gap) / 2) : w;
  const c = lhChartPair(b, cls, cw, big ? { combRowH: 19, fontSize: 10.5 } : { combRowH: 14, fontSize: 9.5 });
  const t1 = `<div class="chart-title">${t('lh.chartA')}</div>`;
  const t2 = `<div class="chart-title">${t('lh.chartB')}</div>`;
  return side
    ? `<div class="pair-grid" style="column-gap:${gap}px">${t1}${t2}<div class="chart">${c.comb}</div><div class="chart">${c.pot}</div></div>`
    : `${t1}<div class="chart">${c.comb}</div>${t2}<div class="chart">${c.pot}</div>`;
}

function lhStatsLine() {
  const tot = S.buf.comb.reduce((a, v) => a + v, 0);
  const i = S.lhIdx;
  return `<span>${t('lh.area', { v: fmtInt(tot) })}</span>
    ${i ? `<span title="${t('idx.shortTitle')}">${t('idx.short', { m: `<b style="color:${indexColor(i.mean)}">${fmtIdx(i.mean)}</b>`, s: fmtIdx(i.sd) }).replace('<b><b', '<b').replace('</b></b>', '</b>')}</span>` : ''}`;
}

function renderLH() {
  const r = S.lh, b = S.buf, el = $('lh-content');
  if (!r || !b) {
    if (!r) el.innerHTML = `<div class="placeholder">${t('lh.choose')}</div>`;
    return;
  }
  const w = chartWidth(el);
  const prev = el.querySelector('#rng-buf');
  const focused = document.activeElement === prev;
  el.innerHTML = `${lhHeader(r)}
    <div class="slider-row"><span class="muted">${t('lh.buffer')}</span>
      <input type="range" id="rng-buf" min="1" max="${BUFFER_MAX}" step="1" value="${S.bufKm}">
      <output id="out-buf">${S.bufKm} km</output></div>
    <div class="stat-line">${lhStatsLine()}</div>
    <div class="stat-line"><label class="toggle-line"><input type="checkbox" id="chk-show-comb" ${$('ly-comb').checked ? 'checked' : ''}> ${t('lh.showComb')}</label></div>
    ${lhChartsHTML(w)}`;
  const rng = el.querySelector('#rng-buf');
  if (focused) rng.focus();
  rng.addEventListener('input', () => {
    S.bufKm = +rng.value;
    el.querySelector('#out-buf').textContent = `${S.bufKm} km`;
    showBuffer(r);
    clearTimeout(rng._t); rng._t = setTimeout(updateBuffer, 40);
  });
  el.querySelector('#chk-show-comb').addEventListener('change', (e) => { setLayer('ly-comb', e.target.checked); S.autoComb = false; });
}

// ── Légendes des fiches (contenu commun aux fenêtres et au rapport PDF) ────
export const mdBold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

/** Classes de combustibles regroupées, dans l'ordre des graphiques. */
export function combGroups() {
  const groups = new Map();
  for (const c of S.core.classes.comb) {
    if (!groups.has(c.grp)) groups.set(c.grp, []);
    groups.get(c.grp).push(c);
  }
  return COMB_ORDER.filter(g => groups.has(g)).map(g => ({ g, label: cGrp(g), items: groups.get(g) }));
}

/** Liste des 6 variables de l'indice (HTML). */
export function idxVarsHTML(L) {
  return `<ol class="vars-list">${L.idxVars.map(([n, d, p]) => `<li><b>${n}</b> — ${d} <span class="vars-p">P=${p}</span></li>`).join('')}</ol>`;
}

function buildLegends() {
  const L = LEGEND();
  $('idx-tip').innerHTML = `${L.idxConcept}<br><br><b>${L.idxVarsTitle}</b>${idxVarsHTML(L)}${L.idxVarsNote}<br><br>${L.idxScale}`;
  const row = (hex, txt) => `<div class="leg-row"><div class="leg-swatch" style="background:${hex}"></div><span>${txt}</span></div>`;
  const block = (b, extra = '') => `<div class="leg-block"><div class="leg-sub">${b.h}</div>${b.p.map(p => `<p>${mdBold(p)}</p>`).join('')}${extra}</div>`;
  $('leg-mrc-body').innerHTML = L.mrc.map(b => block(b,
    (b.sw ? `<p>${b.sw.map(([c, l]) => `<span class="sw-inline" style="background:${c}"></span>${l}`).join(' &nbsp; ')}</p>` : '') +
    (b.vars ? `<p><b>${L.idxVarsTitle}</b></p>${idxVarsHTML(L)}<p>${L.idxVarsNote}</p>` : ''))).join('');
  $('leg-lh-body').innerHTML = `
    <div>
      <div class="leg-col-title">${L.lhComb.h}</div>
      <p class="leg-intro">${L.lhComb.p.map(mdBold).join('<br><br>')}<br>
        <a href="https://ressources-naturelles.canada.ca" target="_blank" rel="noopener">${L.links.fbp}</a></p>
      ${combGroups().map(gr => `<div class="leg-group">${gr.label}</div>` + gr.items.map(c => row(c.hex, cAbb(c) === cLbl(c) ? cLbl(c) : `${cAbb(c)} — ${cLbl(c)}`)).join('')).join('')}
    </div>
    <div>
      <div class="leg-col-title">${L.lhPot.h}</div>
      <p class="leg-intro">${L.lhPot.p.map(mdBold).join('<br><br>')}<br>
        <a href="https://www.donneesquebec.ca/recherche/dataset/potentiel-d-intensite-et-de-propagation-des-feux-de-foret" target="_blank" rel="noopener">${L.links.pot}</a></p>
      <div class="leg-group">${L.links.classes}</div>
      ${S.core.classes.pot.map(c => row(c.hex, pLbl(c))).join('')}
      ${L.lhMore.map(b => `<div class="leg-col-title" style="margin-top:16px">${b.h}</div><p class="leg-intro">${b.p.map(mdBold).join('<br>')}</p>`).join('')}
    </div>`;
}

/** Fiche agrandie (fenêtre surgissante) : 'mrc' ou 'lh'. */
let bigKind = null;
function openBig(kind) {
  const body = $('fiche-body');
  bigKind = kind;
  $('modal-fiche').classList.add('open');
  const w = Math.max(600, body.clientWidth - 44);
  $('fiche-legend').dataset.kind = kind;
  if (kind === 'mrc' && S.series) {
    $('fiche-title').textContent = t('big.mrc');
    body.innerHTML = mrcHTML(w, true);
  } else if (kind === 'lh' && S.lh && S.buf) {
    $('fiche-title').textContent = t('big.lh');
    body.innerHTML = `${lhHeader(S.lh, true)}
      <div class="stat-line"><span>${t('lh.bufferKm', { k: S.bufKm })}</span>${lhStatsLine()}</div>
      ${lhChartsHTML(w, true)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Changement de langue : tout le contenu généré est recalculé
// ═══════════════════════════════════════════════════════════════════════════
function relabel() {
  S.terrName = terrLabel();
  buildPeriods();
  buildMiniLegends();
  buildLegends();
  comboMRC.setItems(mrcItems());
  comboMRC.set(S.unit, false);
  comboLH.setItems(S.terrLH.map(r => ({ value: r.idx, label: lhName(r), sub: lhSub(r), keys: `${r.nom} ${r.al || ''} ${r.mun}` })), {
    disabled: !S.terrLH.length, placeholder: lhPlaceholder(),
  });
  comboLH.set(S.lh ? S.lh.idx : null, false);
  if (S.zone) zoneMsg();
  renderIndex(); renderMRC(); renderLH();
  setSummary('sum-lh', S.lh ? lhName(S.lh) : '');
  if ($('modal-fiche').classList.contains('open') && bigKind) openBig(bigKind);
  refreshReportDialog();
  const note = $('feux-note');
  if ($('ly-feux').checked) note.textContent = t(S.map.getZoom() < FIRE_MIN_ZOOM ? 'fires.zoom' : 'fires.hover');
}

// ═══════════════════════════════════════════════════════════════════════════
// UI générale
// ═══════════════════════════════════════════════════════════════════════════
function bindUI() {
  // Onglets
  const goTab = (tab) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  };
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));
  // liens vers les onglets (délégation : le texte des fenêtres est remplacé lors d'un changement de langue)
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { closeModals(); goTab(g.dataset.goto); }
  });

  // Modals
  const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target !== m) return;
    if (m.classList.contains('modal-top')) m.classList.remove('open'); else closeModals();
  }));
  $('btn-info').addEventListener('click', () => $('popup-accueil').classList.add('open'));
  $('btn-reset').addEventListener('click', resetAll);

  // Langue
  document.querySelectorAll('.lang-btn').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
  onLang(relabel);

  // Mode
  document.querySelectorAll('#mode-seg button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.mode === S.mode) return;
    clearTerritory(); setMode(b.dataset.mode);
  }));

  // Combos
  comboMRC = new Combo($('combo-mrc'), { onSelect: (v) => selectUnit(v), empty: () => t('combo.none') });
  comboMRC.setItems(mrcItems());
  comboLH = new Combo($('combo-lh'), { onSelect: (v) => selectLH(v == null ? null : S.core.lh[v]), empty: () => t('combo.none') });
  comboLH.setItems([], { disabled: true, placeholder: lhPlaceholder() });

  // Zone
  $('btn-draw').addEventListener('click', () => { if (!drawing) startDraw(); });
  $('btn-extent').addEventListener('click', () => {
    const c = S.map.getCanvas();
    setZone(screenRectToPolygon([0, 0], [c.clientWidth, c.clientHeight]), { k: 'extent' });
  });
  $('btn-zone-clear').addEventListener('click', () => { clearTerritory(); $('zone-msg').textContent = t('zone.cleared'); });

  // Boîtes repliables et fiches agrandies
  document.querySelectorAll('.box.collapsible .box-toggle').forEach(tg => tg.addEventListener('click', () => {
    const box = tg.closest('.box');
    box.classList.toggle('collapsed');
    // graphiques redessinés à la largeur réelle une fois la boîte dépliée
    if (!box.classList.contains('collapsed')) { if (box.id === 'box-mrc') renderMRC(); else renderLH(); }
  }));
  $('btn-big-mrc').addEventListener('click', () => openBig('mrc'));
  $('btn-big-lh').addEventListener('click', () => openBig('lh'));
  $('btn-big-mrc').disabled = $('btn-big-lh').disabled = true;
  bindChartTips($('fiche-body'));

  // Légendes des fiches (fenêtres par-dessus la fiche agrandie au besoin)
  buildLegends();
  const openLegend = (k) => $(`modal-leg-${k}`).classList.add('open');
  document.querySelectorAll('[data-legend]').forEach(b => b.addEventListener('click', () => openLegend(b.dataset.legend)));
  $('fiche-legend').addEventListener('click', () => openLegend($('fiche-legend').dataset.kind || 'mrc'));
  document.querySelectorAll('[data-close-self]').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('open')));

  // Log
  $('chk-log').addEventListener('change', (e) => { S.log = e.target.checked; renderMRC(); });

  // Rapport
  $('btn-rapport').addEventListener('click', () => openReportDialog());

  // Infobulles des graphiques
  bindChartTips($('tab-explorer'));

  // Re-rendu des graphiques au redimensionnement du panneau
  let lastW = 0;
  new ResizeObserver(() => {
    const w = $('mrc-content').clientWidth;
    if (Math.abs(w - lastW) < 12) return;
    lastW = w;
    clearTimeout(bindUI._t);
    bindUI._t = setTimeout(() => { renderMRC(); renderLH(); }, 120);
  }).observe($('panel'));

  // Redimensionnement du panneau
  const resizer = $('resizer'), panel = $('panel');
  let drag = false, x0 = 0, w0 = 0;
  resizer.addEventListener('mousedown', (e) => { drag = true; x0 = e.clientX; w0 = panel.offsetWidth; resizer.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const w = Math.min(Math.max(w0 + e.clientX - x0, 300), innerWidth * 0.65);
    panel.style.width = `${w}px`; panel.style.maxWidth = 'none'; S.map?.resize();
  });
  document.addEventListener('mouseup', () => { if (!drag) return; drag = false; resizer.classList.remove('dragging'); document.body.style.userSelect = ''; S.map?.resize(); });
}

// ═══════════════════════════════════════════════════════════════════════════
// Démarrage
// ═══════════════════════════════════════════════════════════════════════════
/** État résumé de l'application (rapport d'erreur). */
function appState() {
  const m = S.map;
  return {
    territoire: S.unit || (S.zone ? `zone:${S.zone.kind.k}` : null), communaute: S.lh?.id || null, zoneTamponKm: S.bufKm,
    zoom: m ? +m.getZoom().toFixed(2) : null, centre: m ? m.getCenter().toArray().map(v => +v.toFixed(3)) : null,
    couches: ['indice', 'feux', 'pts', 'comb', 'pot', 'regime'].filter(k => $(`ly-${k}`)?.checked),
    contoursFeuxEnCache: fireCache.feats.size,
  };
}

async function init() {
  applyStatic();
  initErrors(appState);
  try {
    const [core] = await Promise.all([loadCore(), initMap()]);
    watchMap(S.map);
    S.core = core;
    addLayers();
    bindUI();
    renderIndex(); renderMRC(); renderLH();
    $('loading').classList.add('hidden');
    $('popup-accueil').classList.add('open');
  } catch (err) {
    console.error('Erreur init :', err);
    logEvent('démarrage', err.message || err, err.stack);
    $('loading-msg').textContent = t('loading.error');
  }
}
init();
