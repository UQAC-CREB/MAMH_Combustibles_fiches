// MAMH — Prédisposition des communautés aux feux de forêt — application v2
import {
  TILES, BASEMAP, QC_BOUNDS, PROJ_LCC, YEAR_END, BUFFER_DEFAULT, BUFFER_MAX,
  FIRE_MIN_ZOOM, INDEX_PALETTE, INDEX_MAX, COLORS, FIRE_RAMP, DATA_VERSION,
} from './config.js';
import { loadCore, loadPoints } from './data.js';
import { unitSeries, zoneSeries, bufferStats, geomToLccPolys, makeContains, indexAt, indexStats } from './stats.js';
import { occChart, supChart, hbarChart, bindChartTips, fmtInt, fmtHa, fmtPct } from './charts.js';
import { Combo, norm } from './combobox.js';
import { openReportDialog } from './report.js';
import { RasterPicker } from './rasterpick.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const lcc = proj4('EPSG:4326', PROJ_LCC);

// ── État ───────────────────────────────────────────────────────────────────
export const S = {
  core: null, map: null,
  mode: 'mrc',            // 'mrc' | 'zone'
  unit: null,             // id de l'unité MRC sélectionnée
  zone: null,             // { geojson, polys, label }
  terrLH: [],             // lieux habités du territoire courant
  series: null,           // série INFO-MRC courante
  terrName: '',
  idx: null,              // indice du territoire : { mean, sd, n }
  lh: null,               // lieu habité sélectionné (objet de lh.json)
  bufKm: BUFFER_DEFAULT,
  buf: null,              // { comb[], pot[] } superficies ha
  lhIdx: null,            // indice dans la zone tampon : { mean, sd, n }
  log: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// Utilitaires
// ═══════════════════════════════════════════════════════════════════════════
export function indexColor(v) {
  const t = Math.max(0, Math.min(1, v / INDEX_MAX));
  for (let i = 1; i < INDEX_PALETTE.length; i++) {
    if (t <= INDEX_PALETTE[i][0]) return INDEX_PALETTE[i][1];
  }
  return INDEX_PALETTE.at(-1)[1];
}
export const fmtIdx = (v) => (v == null ? '—' : (+v).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

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
  return new Promise((res) => map.on('load', res));
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
    paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstSymbol);

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
  map.addLayer({ id: 'buffer-fill', type: 'fill', source: 'buffer', paint: { 'fill-color': COLORS.lh, 'fill-opacity': 0.08 } });
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
      const d = p.j ? `${String(p.j % 100).padStart(2, '0')}/${String(Math.floor(p.j / 100)).padStart(2, '0')}/${p.an}` : p.an;
      return `Départ de feu — ${d}<div class="tt-sub">Cause : ${p.c ? 'foudre' : 'humaine'}</div>`;
    }
    if (f.layer.id === 'feux-fill') {
      // un feu peut compter plusieurs polygones : on n'affiche que l'année
      const years = [...new Set(feats.filter(x => x.layer.id === 'feux-fill').map(x => x.properties.an))].sort((a, b) => b - a);
      return `Feu de forêt — ${years.slice(0, 5).join(', ')}${years.length > 5 ? '…' : ''}`;
    }
    return `${p.nom}<div class="tt-sub">Indice moyen de la MRC : ${fmtIdx(p.im)} ± ${fmtIdx(p.isd)}</div>`;
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
      if (v != null) lines.push(`${sw(indexColor(v))}Indice de prédisposition : <b>${fmtIdx(v)}</b>`);
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
        ? `${sw(c.hex)}Combustible : <b>${c.abb}</b>${c.lbl !== c.abb ? ` — ${c.lbl}` : ""}`
        : `${sw(c.hex)}Potentiel d’intensité et de propagation : <b>${c.lbl}</b>`);
    });
    render();
  });
  map.on('mouseout', () => { tt.style.display = 'none'; });
  map.on('click', (e) => {
    if (drawing) return;
    const lhF = map.queryRenderedFeatures(e.point, { layers: ['lh-circle'] })[0];
    if (lhF) { selectLH(S.core.lh[lhF.properties.idx], { fit: false }); return; }
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
    note.textContent = 'Rapprochez la carte (zoom régional) pour afficher les contours de feux.';
    return;
  }
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if (fireCache.boxes.some(bx => boxContains(bx, view))) return;
  const dx = (view[2] - view[0]) * 0.25, dy = (view[3] - view[1]) * 0.25;
  const q = [view[0] - dx, view[1] - dy, view[2] + dx, view[3] + dy];
  const token = ++fireCache.token;
  if (fireCache.feats.size > 60000) { fireCache.feats.clear(); fireCache.boxes = []; }
  note.innerHTML = '<span class="spin-inline"></span> Chargement des contours de feux…';
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
    note.textContent = 'Survolez un feu pour connaître sa superficie.';
  } catch (err) {
    console.warn('Feux :', err);
    note.textContent = 'Contours de feux indisponibles.';
  }
}

// ── Panneau des couches ───────────────────────────────────────────────────
function periodFilter() {
  const v = $('sel-periode').value;
  if (!v) return null;
  const [a, b] = v.split('-').map(Number);
  return ['all', ['>=', ['get', 'an'], a], ['<=', ['get', 'an'], b]];
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
  const map = S.map, core = S.core;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');

  // Périodes de 5 ans
  const sel = $('sel-periode');
  const opts = [['', 'Toutes les périodes'], [`1976-${YEAR_END}`, `Feux récents (1976-${YEAR_END})`], ['1880-1975', 'Feux anciens (1887-1975)']];
  for (let a = 2020; a >= 1885; a -= 5) opts.push([`${a}-${Math.min(a + 4, YEAR_END)}`, `${a}-${Math.min(a + 4, YEAR_END)}`]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.addEventListener('change', () => {
    const f = periodFilter();
    ['feux-fill', 'feux-line', 'pts'].forEach(id => map.setFilter(id, f));
  });
  $('ramp-feux').style.background = `linear-gradient(to right, ${FIRE_RAMP.map(([y, c]) => `${c} ${((y - 1887) / (YEAR_END - 1887) * 100).toFixed(1)}%`).join(', ')})`;

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

  // Légendes compactes
  const seen = new Set();
  $('leg-comb').innerHTML = core.classes.comb
    .map(c => ({ hex: c.hex, lbl: c.abb.replace(/[<>].*$|-100%$/, '').trim() }))
    .filter(c => !seen.has(c.lbl) && seen.add(c.lbl))
    .map(c => `<span><i style="background:${c.hex}"></i>${c.lbl}</span>`).join('');
  $('leg-pot').innerHTML = core.classes.pot.map(c => `<span><i style="background:${c.hex}"></i>${c.lbl}</span>`).join('');

  $('lp-toggle').addEventListener('click', () => {
    $('layers-panel').classList.toggle('collapsed');
    $('lp-arrow').textContent = $('layers-panel').classList.contains('collapsed') ? '▸' : '▾';
  });
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

export function selectUnit(id, { fit = true } = {}) {
  if (!id) { clearTerritory(); return; }
  setMode('mrc');
  const f = S.core.units.features.find(x => x.properties.id === id);
  S.unit = id; S.zone = null;
  S.map.getSource('zone').setData(EMPTY);
  comboMRC.set(id, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], id]);
  if (fit && f) S.map.fitBounds(geomBBox(f.geometry), { padding: 40, duration: 900 });
  S.terrName = `MRC ${f.properties.nom}`;
  S.idx = f.properties.im != null ? { mean: f.properties.im, sd: f.properties.isd, n: f.properties.in } : null;
  S.series = unitSeries(S.core, id);
  setTerritoryLH(S.core.lh.filter(r => r.u === id));
  renderIndex(); renderMRC();
  if (S.lh && S.lh.u !== id) selectLH(null);
}

async function setZone(geojson, label) {
  setMode('zone');
  S.unit = null;
  comboMRC.set(null, false);
  S.map.setFilter('units-sel', ['==', ['get', 'id'], '__']);
  const polys = geomToLccPolys(geojson, 50);     // simplification 50 m (grille de calcul : 1 km)
  if (!polys.length) { $('zone-msg').textContent = 'Géométrie non valide (polygone attendu).'; return; }
  S.zone = { geojson, polys, label };
  S.terrName = label;
  S.map.getSource('zone').setData(geojson);
  $('zone-msg').innerHTML = `<b>${label}</b> — calcul en cours… <span class="spin-inline"></span>`;
  $('mrc-content').innerHTML = '<div class="placeholder"><span class="spin-inline"></span> Calcul des statistiques de la zone…</div>';

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
  const ha = S.series ? S.series.areaHa : 0;
  $('zone-msg').innerHTML = `<b>${label}</b> — ${fmtInt(ha / 100)} km² · ${S.terrLH.length} communauté(s)`;
  renderIndex(); renderMRC();
  if (S.lh && !S.terrLH.includes(S.lh)) selectLH(null);
}

function setTerritoryLH(list) {
  S.terrLH = list.slice().sort((a, b) => lhName(a).localeCompare(lhName(b), 'fr'));
  comboLH.setItems(S.terrLH.map(r => ({ value: r.idx, label: lhName(r), sub: lhSub(r), keys: `${r.nom} ${r.al || ''} ${r.mun}` })), {
    disabled: !S.terrLH.length,
    placeholder: S.terrLH.length ? `Tapez ou choisissez (${S.terrLH.length})…` : (S.unit || S.zone ? 'Aucune communauté dans ce territoire' : '— Choisissez d\'abord un territoire —'),
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
    setZone(screenRectToPolygon([Math.min(a[0], p[0]), Math.min(a[1], p[1])], [Math.max(a[0], p[0]), Math.max(a[1], p[1])]), 'Zone tracée');
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

async function uploadShapefile(file) {
  $('zone-msg').innerHTML = `<span class="spin-inline"></span> Lecture de ${file.name}…`;
  try {
    let gj = await shp(await file.arrayBuffer());
    if (Array.isArray(gj)) gj = { type: 'FeatureCollection', features: gj.flatMap(g => g.features) };
    const polys = gj.features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
    if (!polys.length) throw new Error('Aucun polygone trouvé dans le fichier.');
    const fc = { type: 'FeatureCollection', features: polys };
    S.map.fitBounds(geomBBox(fc), { padding: 40, duration: 800 });
    await setZone(fc, `Zone importée (${file.name.replace(/\.zip$/i, '')})`);
  } catch (err) {
    console.error(err);
    $('zone-msg').textContent = `Impossible de lire le fichier : ${err.message || err}. Fournissez un .zip contenant .shp, .dbf et .prj.`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Panneau : indice, INFO-MRC, INFO-COMMUNAUTÉ
// ═══════════════════════════════════════════════════════════════════════════
function renderIndex() {
  const el = $('expo-value'), mk = $('expo-marker'), band = $('expo-band'), e = S.idx;
  if (!e) {
    el.innerHTML = `<div class="expo-note">${S.unit || S.zone ? 'Aucune donnée d’indice pour ce territoire.' : 'Choisissez un territoire pour afficher son indice moyen.'}</div>`;
    mk.style.display = band.style.display = 'none';
    return;
  }
  const pos = (v) => Math.max(0, Math.min(100, (v / INDEX_MAX) * 100));
  mk.style.display = band.style.display = 'block';
  mk.style.left = `${pos(e.mean)}%`;
  band.style.left = `${pos(e.mean - e.sd)}%`;
  band.style.width = `${pos(e.mean + e.sd) - pos(e.mean - e.sd)}%`;
  el.innerHTML = `<div class="expo-value"><span class="expo-num" style="color:${indexColor(e.mean)}">${fmtIdx(e.mean)}</span>
    <span class="expo-rank">moyenne · écart-type <b>${fmtIdx(e.sd)}</b></span></div>
    <div class="expo-note">${S.zone ? 'Zone définie' : S.terrName} — ${e.n} pixel${e.n > 1 ? 's' : ''} de 5 km.</div>`;
}

function chartWidth(el) { return Math.max(300, Math.round(el.clientWidth || 420)); }

/** Contenu INFO-MRC (panneau ou fiche agrandie). */
function mrcHTML(w, big = false) {
  const s = S.series;
  const period = `${s.y0}–${YEAR_END}`;
  const regNote = s.long && s.y0 >= 1972
    ? '<div class="expo-note">Territoire situé dans une zone de régime de feux, mais aucun feu ancien (1887-1975) n’y est répertorié.</div>'
    : S.zone && s.long && s.regimeFrac < 0.98
    ? `<div class="expo-note">La zone chevauche une zone de régime de feux (${fmtPct(s.regimeFrac * 100, 0)} de sa superficie) : les feux anciens n’y sont comptés que dans cette portion.</div>` : '';
  const idx = S.idx ? `<span>Indice : <b>${fmtIdx(S.idx.mean)}</b> ± ${fmtIdx(S.idx.sd)}</span>` : '';
  return `
    <div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${S.terrName}</div>
    <div class="stat-line"><span class="badge ${s.y0 < 1972 ? 'long' : ''}" title="${s.y0 < 1972 ? 'Feux anciens validés (zones de régime de feux) inclus' : 'Points d’origine dès 1972, contours de feux dès 1976'}">${s.y0 < 1972 ? 'Série longue' : 'Série courte'} · ${period}</span>
      <span>Combustibles : <b>${fmtInt(s.fuelHa)}</b> ha</span>${big ? idx : ''}</div>
    <div class="stat-line"><span>Feux (1972-${YEAR_END}) : <b>${fmtInt(s.totOcc)}</b> (H ${fmtInt(s.totH)} · F ${fmtInt(s.totF)})</span>
      <span>Brûlé : <b>${fmtInt(s.totSup)}</b> ha</span></div>
    ${regNote}
    <div class="chart-title">Occurrences et causes des feux</div>
    <div class="chart-legend"><span><i style="background:${COLORS.humain}"></i>Humain</span><span><i style="background:${COLORS.foudre}"></i>Foudre</span><span><i class="band"></i>Moyenne ± écart-type</span></div>
    <div class="chart">${occChart(s, { width: w, height: big ? 300 : 190, labels: w > 380 })}</div>
    <div class="chart-title">Superficies brûlées annuellement${S.log ? ' (échelle log)' : ''}</div>
    <div class="chart">${supChart(s, { width: w, height: big ? 280 : 180, log: S.log })}</div>`;
}

function setSummary(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.title = text ? `${text} — cliquez pour afficher les graphiques` : '';
  el.classList.toggle('on', !!text);
}

function renderMRC() {
  const el = $('mrc-content'), s = S.series;
  $('btn-big-mrc').disabled = !s;
  setSummary('sum-mrc', s ? S.terrName.replace(/^MRC /, '') : '');
  if (!s) {
    el.innerHTML = `<div class="placeholder">${S.unit || S.zone ? 'Aucune donnée de feux pour ce territoire.' : 'Choisissez une MRC ou définissez une zone pour afficher l’historique des feux.'}</div>`;
    return;
  }
  el.innerHTML = mrcHTML(chartWidth(el));
}

// ── Communauté ─────────────────────────────────────────────────────────────
export function combRows(ha, classes) {
  return classes.comb.map((c, k) => ({ label: c.abb, title: `${c.abb} — ${c.lbl}`, ha: ha[k], color: c.hex, group: c.grp }));
}
export function potRows(ha, classes) {
  return classes.pot.map((c, k) => ({ label: c.lbl === 'Absence combustible' ? 'Absence comb.' : c.lbl, title: c.lbl, ha: ha[k], color: c.hex })).reverse();
}
const COMB_ORDER = ['Résineux', 'Mixtes', 'Feuillus', 'Rémanents', 'Herbes', 'Brûlis', 'Dénudé', 'Eau', 'Urbain'];
export function sortComb(rows) {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (COMB_ORDER.indexOf(a.r.group) - COMB_ORDER.indexOf(b.r.group)) || a.i - b.i).map(x => x.r);
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
    S.map.getSource('buffer').setData(EMPTY);
    $('lh-content').innerHTML = '<div class="placeholder">Cliquez sur une communauté (point orange sur la carte) ou choisissez-la dans le menu.</div>';
    return;
  }
  // Territoire : si la communauté n'est pas dans le territoire courant, on bascule sur sa MRC
  if (!S.terrLH.includes(r)) selectUnit(r.u, { fit: false });
  S.map.getSource('buffer').setData(bufferCircle(r, S.bufKm));
  if (fit) S.map.fitBounds(geomBBox(bufferCircle(r, S.bufKm)), { padding: 40, duration: 800 });
  $('lh-content').innerHTML = `${lhHeader(r)}<div class="placeholder"><span class="spin-inline"></span> Chargement des combustibles…</div>`;
  await updateBuffer();
}

function lhHeader(r, big = false) {
  return `<div style="margin-top:4px;font-family:'Oswald',sans-serif;font-size:${big ? 19 : 15}px;color:var(--accent)">${lhName(r)}</div>
    <div class="box-sub">${lhSub(r) ? lhSub(r) + ' · ' : ''}${r.nat ? `${r.nat} <span class="badge" title="Toponyme préliminaire à valider (IDDPNQL)">à valider</span> · ` : ''}MRC ${S.core.units.features.find(f => f.properties.id === r.u)?.properties.nom || ''}</div>`;
}

async function updateBuffer() {
  const r = S.lh;
  if (!r) return;
  try {
    S.buf = await bufferStats(r.idx, S.bufKm);
    S.lhIdx = bufferIndex(r, S.bufKm);
  } catch (err) {
    console.error(err);
    $('lh-content').innerHTML = `${lhHeader(r)}<div class="placeholder">Données de combustibles indisponibles.</div>`;
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
    comb: hbarChart(comb, { width, rowH: combRowH, labelW: 52, groupW: 58, fontSize }),
  };
}

/** Graphiques INFO-COMMUNAUTÉ (panneau ou fiche agrandie). */
function lhChartsHTML(w, big = false) {
  const b = S.buf, cls = S.core.classes;
  const tot = b.comb.reduce((a, v) => a + v, 0);
  if (!tot) return '<div class="placeholder">Aucune donnée de combustibles dans cette zone tampon (hors du territoire couvert).</div>';
  const gap = big ? 24 : 12;
  const side = (w - gap) / 2 >= 230;               // côte à côte si la place le permet
  const cw = side ? Math.floor((w - gap) / 2) : w;
  const c = lhChartPair(b, cls, cw, big ? { combRowH: 19, fontSize: 10.5 } : { combRowH: 14, fontSize: 9.5 });
  const t1 = '<div class="chart-title">A) Superficie des combustibles</div>';
  const t2 = '<div class="chart-title">B) Potentiel d’intensité et de propagation</div>';
  return side
    ? `<div class="pair-grid" style="column-gap:${gap}px">${t1}${t2}<div class="chart">${c.comb}</div><div class="chart">${c.pot}</div></div>`
    : `${t1}<div class="chart">${c.comb}</div>${t2}<div class="chart">${c.pot}</div>`;
}

function lhStatsLine() {
  const tot = S.buf.comb.reduce((a, v) => a + v, 0);
  const i = S.lhIdx;
  return `<span>Superficie analysée : <b>${fmtInt(tot)}</b> ha</span>
    ${i ? `<span title="Moyenne ± écart-type des pixels de 5 km de la zone tampon">Indice : <b style="color:${indexColor(i.mean)}">${fmtIdx(i.mean)}</b> ± ${fmtIdx(i.sd)}</span>` : ''}`;
}

function renderLH() {
  const r = S.lh, b = S.buf, el = $('lh-content');
  if (!r || !b) return;
  const w = chartWidth(el);
  const prev = el.querySelector('#rng-buf');
  const focused = document.activeElement === prev;
  el.innerHTML = `${lhHeader(r)}
    <div class="slider-row"><span class="muted">Zone tampon</span>
      <input type="range" id="rng-buf" min="1" max="${BUFFER_MAX}" step="1" value="${S.bufKm}">
      <output id="out-buf">${S.bufKm} km</output></div>
    <div class="stat-line">${lhStatsLine()}</div>
    <div class="stat-line"><label class="toggle-line"><input type="checkbox" id="chk-show-comb" ${$('ly-comb').checked ? 'checked' : ''}> voir les combustibles sur la carte</label></div>
    ${lhChartsHTML(w)}`;
  const rng = el.querySelector('#rng-buf');
  if (focused) rng.focus();
  rng.addEventListener('input', () => {
    S.bufKm = +rng.value;
    el.querySelector('#out-buf').textContent = `${S.bufKm} km`;
    S.map.getSource('buffer').setData(bufferCircle(r, S.bufKm));
    clearTimeout(rng._t); rng._t = setTimeout(updateBuffer, 40);
  });
  el.querySelector('#chk-show-comb').addEventListener('change', (e) => {
    $('ly-comb').checked = e.target.checked; $('ly-comb').dispatchEvent(new Event('change'));
  });
}

/** Légende de la fiche communauté : classes et couleurs issues des LUT (classes.json). */
function buildLegends() {
  const cls = S.core.classes, groups = new Map();
  for (const c of cls.comb) {
    if (!groups.has(c.grp)) groups.set(c.grp, []);
    groups.get(c.grp).push(c);
  }
  const row = (hex, txt) => `<div class="leg-row"><div class="leg-swatch" style="background:${hex}"></div><span>${txt}</span></div>`;
  $('leg-comb-list').innerHTML = COMB_ORDER.filter(g => groups.has(g)).map(g =>
    `<div class="leg-group">${g}</div>` + groups.get(g).map(c => row(c.hex, `${c.abb} — ${c.lbl}`)).join('')).join('');
  $('leg-pot-list').innerHTML = '<div class="leg-group">Classes</div>' + cls.pot.map(c => row(c.hex, c.lbl)).join('');
}

/** Fiche agrandie (fenêtre surgissante) : 'mrc' ou 'lh'. */
function openBig(kind) {
  const body = $('fiche-body');
  $('modal-fiche').classList.add('open');
  const w = Math.max(600, body.clientWidth - 44);
  $('fiche-legend').dataset.kind = kind;
  if (kind === 'mrc' && S.series) {
    $('fiche-title').textContent = 'Fiche régionale — historique des feux';
    body.innerHTML = mrcHTML(w, true);
  } else if (kind === 'lh' && S.lh && S.buf) {
    $('fiche-title').textContent = 'Fiche communauté — combustibles';
    body.innerHTML = `${lhHeader(S.lh, true)}
      <div class="stat-line"><span>Zone tampon : <b>${S.bufKm} km</b></span>${lhStatsLine()}</div>
      ${lhChartsHTML(w, true)}`;
  }
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
  document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => { closeModals(); goTab(el.dataset.goto); }));

  // Modals
  const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target !== m) return;
    if (m.classList.contains('modal-top')) m.classList.remove('open'); else closeModals();
  }));
  $('btn-info').addEventListener('click', () => $('popup-accueil').classList.add('open'));

  // Mode
  document.querySelectorAll('#mode-seg button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.mode === S.mode) return;
    clearTerritory(); setMode(b.dataset.mode);
  }));

  // Combos
  comboMRC = new Combo($('combo-mrc'), { onSelect: (v) => selectUnit(v) });
  const units = S.core.units.features.map(f => f.properties).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  comboMRC.setItems(units.map(p => ({
    value: p.id, label: p.nom,
    sub: `indice moyen ${fmtIdx(p.im)}${norm(p.mrc) !== norm(p.nom) ? ` · MRC ${p.mrc}` : ''}`,
    keys: p.mrc,
  })));
  comboLH = new Combo($('combo-lh'), { onSelect: (v) => selectLH(v == null ? null : S.core.lh[v]) });

  // Zone
  $('btn-draw').addEventListener('click', () => { if (!drawing) startDraw(); });
  $('btn-extent').addEventListener('click', () => {
    const c = S.map.getCanvas();
    const w = c.clientWidth, h = c.clientHeight;
    setZone(screenRectToPolygon([0, 0], [w, h]), 'Emprise de la carte');
  });
  $('btn-upload').addEventListener('click', () => $('file-shp').click());
  $('file-shp').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadShapefile(f); e.target.value = ''; });
  $('btn-zone-clear').addEventListener('click', () => { clearTerritory(); $('zone-msg').textContent = 'Zone effacée.'; });

  // Boîtes repliables et fiches agrandies
  document.querySelectorAll('.box.collapsible .box-toggle').forEach(t => t.addEventListener('click', () => {
    const box = t.closest('.box');
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
async function init() {
  try {
    const [core] = await Promise.all([loadCore(), initMap()]);
    S.core = core;
    addLayers();
    bindUI();
    renderIndex();
    $('loading').classList.add('hidden');
    $('popup-accueil').classList.add('open');
  } catch (err) {
    console.error('Erreur init :', err);
    $('loading-msg').textContent = 'Erreur de chargement — voir la console.';
  }
}
init();
