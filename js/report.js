// Rapport PDF généré dans le navigateur (jsPDF) — fiche territoire + fiches communautés
import { YEAR_END, COLORS, BASEMAP } from './config.js';
import { occChart, supChart, hbarChart, svgToPng, fmtInt, fmtPct } from './charts.js';
import { bufferStats } from './stats.js';
import { loadProvince } from './data.js';
import { S, lhName, lhSub, lhChartPair, bufferCircle, bufferIndex, fmtIdx, unitProps, combGroups } from './app.js';
import { t, loc, cAbb, cLbl, pLbl, LEGEND } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Polices standard PDF (WinAnsi) : on remplace les caractères non pris en charge
const pdfTxt = (s) => String(s ?? '')
  .replace(/[’‘]/g, "'").replace(/«\s*/g, '"').replace(/\s*»/g, '"').replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/ | /g, ' ').normalize('NFC').replace(/[^\x00-\xFF]/g, '');

export function openReportDialog() {
  refreshReportDialog(true);
  const list = $('rep-list');
  list.innerHTML = S.terrLH.length
    ? S.terrLH.map(r => `<label data-k="${(lhName(r) + ' ' + r.mun).toLowerCase()}"><input type="checkbox" value="${r.idx}" ${r === S.lh ? 'checked' : ''}> ${lhName(r)} ${lhSub(r) ? `<small>${lhSub(r)}</small>` : ''}</label>`).join('')
    : `<div class="muted" style="padding:6px">${t('rep.noLh')}</div>`;
  // page territoire (MRC / zone) cochée par défaut
  $('rep-terr-page').checked = !!S.series;
  $('rep-terr-page').disabled = !S.series;
  $('rep-progress').textContent = '';
  $('rep-bar').hidden = true;
  $('rep-go').disabled = false;
  $('modal-rapport').classList.add('open');
}

/** Textes de la fenêtre du rapport (aussi appelé lors d'un changement de langue). */
export function refreshReportDialog(force = false) {
  if (!force && !$('modal-rapport').classList.contains('open')) return;
  $('rep-terr').innerHTML = t('rep.terr', { t: S.terrName || t('rep.territory') });
  if ($('rep-buf')) $('rep-buf').textContent = S.bufKm;
  if (!S.terrLH.length && $('rep-list').querySelector('.muted')) $('rep-list').innerHTML = `<div class="muted" style="padding:6px">${t('rep.noLh')}</div>`;
}

function checked() { return [...$('rep-list').querySelectorAll('input:checked')].map(i => S.core.lh[+i.value]); }

$('rep-all').addEventListener('click', () => { $('rep-list').querySelectorAll('label:not([hidden]) input').forEach(i => { i.checked = true; }); });
$('rep-none').addEventListener('click', () => { $('rep-list').querySelectorAll('input').forEach(i => { i.checked = false; }); });
$('rep-filter').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  $('rep-list').querySelectorAll('label').forEach(l => { l.hidden = q && !l.dataset.k.includes(q); });
});
$('rep-go').addEventListener('click', () => generate().catch(err => {
  console.error(err);
  $('rep-progress').textContent = t('rep.err', { e: err.message || err });
  $('rep-go').disabled = false;
}));

// ── Capture de la carte ────────────────────────────────────────────────────
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function idle(map, timeout = 12000) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    map.once('idle', fin); setTimeout(fin, timeout);
  });
}

function circleBounds(r, km) {
  const dLat = km / 111.2, dLon = km / (111.2 * Math.cos(r.y * Math.PI / 180));
  return [[r.x - dLon, r.y - dLat], [r.x + dLon, r.y + dLat]];
}

// ── Fond de carte gris pâle (style MapLibre de l'application, sans étiquettes) reprojeté en Lambert ─
// Une carte MapLibre hors écran (Mercator) est rendue sur l'emprise voulue, puis rééchantillonnée.

const mercY = (la) => { const s = Math.sin((Math.max(-85, Math.min(85, la)) * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const mercX = (lo) => (lo + 180) / 360;

/** Rend le fond de carte (Mercator) couvrant [lon0, lat0, lon1, lat1] ; retourne pixels + transformation. */
async function renderMercatorBase([lon0, lat0, lon1, lat1], size = 1600) {
  const div = document.createElement('div');
  Object.assign(div.style, { position: 'fixed', left: '-10000px', top: '0', width: `${size}px`, height: `${size}px` });
  document.body.appendChild(div);
  const m = new maplibregl.Map({
    container: div, style: BASEMAP, interactive: false, attributionControl: false,
    bounds: [[lon0, lat0], [lon1, lat1]], fitBoundsOptions: { padding: 0 }, pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise((res) => m.once('load', res));
    m.getStyle().layers.forEach(l => { if (l.type === 'symbol') m.setLayoutProperty(l.id, 'visibility', 'none'); });
    await idle(m, 15000);
    const c = m.getCanvas();
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(c, 0, 0);
    const data = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
    // transformation linéaire Mercator normalisé → pixels, à partir de deux points projetés
    const pA = m.project([lon0, lat1]), pB = m.project([lon1, lat0]);
    const kx = (pB.x - pA.x) / (mercX(lon1) - mercX(lon0)), ky = (pB.y - pA.y) / (mercY(lat0) - mercY(lat1));
    const sc = c.width / div.clientWidth;
    return {
      data, W: tmp.width, H: tmp.height,
      toPx: (lo, la) => [((mercX(lo) - mercX(lon0)) * kx + pA.x) * sc, ((mercY(la) - mercY(lat1)) * ky + pA.y) * sc],
    };
  } finally {
    m.remove(); div.remove();
  }
}

/**
 * Peint le fond de carte dans ctx (W × H) : `inv(px, py)` → [lon, lat] (projection de la page).
 * Les coordonnées sont calculées sur une grille de 4 px puis interpolées.
 */
async function paintBasemap(ctx, W, H, inv) {
  const step = 4, gw = Math.ceil(W / step) + 1, gh = Math.ceil(H / step) + 1;
  const glon = new Float64Array(gw * gh), glat = new Float64Array(gw * gh);
  let lon0 = Infinity, lon1 = -Infinity, lat0 = Infinity, lat1 = -Infinity;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const [lo, la] = inv(i * step, j * step);
    glon[j * gw + i] = lo; glat[j * gw + i] = la;
    lon0 = Math.min(lon0, lo); lon1 = Math.max(lon1, lo); lat0 = Math.min(lat0, la); lat1 = Math.max(lat1, la);
  }
  let base;
  try { base = await renderMercatorBase([lon0, lat0, lon1, lat1]); } catch (e) { console.warn('Fond de carte :', e); return; }
  const out = ctx.createImageData(W, H), d = out.data, src = base.data;
  for (let py = 0; py < H; py++) {
    const gj = Math.min(gh - 2, Math.floor(py / step)), fy = py / step - gj;
    for (let px = 0; px < W; px++) {
      const gi = Math.min(gw - 2, Math.floor(px / step)), fx = px / step - gi;
      const k = gj * gw + gi;
      const lo = (glon[k] * (1 - fx) + glon[k + 1] * fx) * (1 - fy) + (glon[k + gw] * (1 - fx) + glon[k + gw + 1] * fx) * fy;
      const la = (glat[k] * (1 - fx) + glat[k + 1] * fx) * (1 - fy) + (glat[k + gw] * (1 - fx) + glat[k + gw + 1] * fx) * fy;
      const [mx, my] = base.toPx(lo, la);
      const xi = Math.floor(mx), yi = Math.floor(my), o = (py * W + px) * 4;
      if (xi < 0 || yi < 0 || xi >= base.W || yi >= base.H) { d[o] = d[o + 1] = d[o + 2] = 245; d[o + 3] = 255; continue; }
      const s = (yi * base.W + xi) * 4;
      d[o] = src[s]; d[o + 1] = src[s + 1]; d[o + 2] = src[s + 2]; d[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

// ── Cartes de la zone tampon (A : combustibles, B : potentiel) ─────────────
const APP_LAYERS = ['indice', 'units-fill', 'units-line', 'units-sel', 'zone-fill', 'zone-line', 'buffer-fill', 'buffer-line', 'buffer-mask',
  'pts', 'lh-circle', 'lh-label', 'feux-fill', 'feux-line', 'regime-line', 'comb', 'pot'];

function niceKm(km) {
  const c = [1, 2, 5, 10, 20, 25, 50, 100];
  return c.reduce((b, v) => (v <= km ? v : b), 1);
}

/** Flèche du nord, style « NorthArrow_1 » : cercle + trait vertical du haut du cercle jusqu'au centre. (cx, cy) = centre. */
function northArrow(ctx, cx, cy, s) {
  const r = s / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill();
  ctx.lineWidth = s * 0.1; ctx.strokeStyle = '#111'; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, 2 * Math.PI); ctx.stroke();
  ctx.lineWidth = s * 0.09;
  ctx.beginPath(); ctx.moveTo(cx, cy - r + ctx.lineWidth * 0.2); ctx.lineTo(cx, cy); ctx.stroke();
  ctx.restore();
}

/** Capture des deux cartes de la zone tampon de r (rayon km), recadrées au ratio `aspect`. */
async function captureBufferMaps(r, km, aspect) {
  const map = S.map;
  const style = map.getStyle().layers;
  const savedVis = Object.fromEntries(style.map(l => [l.id, map.getLayoutProperty(l.id, 'visibility') || 'visible']));
  const setVis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  try {
    // fond sans étiquettes ; aucune couche de l'application
    style.forEach(l => { if (l.type === 'symbol' || APP_LAYERS.includes(l.id)) setVis(l.id, false); });
    const cw = map.getCanvas().clientWidth, ch = map.getCanvas().clientHeight;
    const pad = { top: 20, bottom: 20, left: 20, right: 20 };
    if (cw / ch > aspect) { const p = (cw - ch * aspect) / 2 + 20; pad.left = p; pad.right = p; }
    else { const p = (ch - cw / aspect) / 2 + 20; pad.top = p; pad.bottom = p; }
    map.fitBounds(circleBounds(r, km * 1.3), { padding: pad, duration: 0 });
    const grab = async () => {
      await idle(map); await wait(120);
      const src = map.getCanvas();
      let sw = src.width, sh = src.height;
      if (sw / sh > aspect) sw = sh * aspect; else sh = sw / aspect;
      const c = document.createElement('canvas');
      c.width = Math.round(sw); c.height = Math.round(sh);
      c.getContext('2d').drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, sw, sh);
      return { c, ox: (src.width - sw) / 2, oy: (src.height - sh) / 2 };
    };
    const base = await grab();
    setVis('comb', true); const comb = await grab(); setVis('comb', false);
    setVis('pot', true); const pot = await grab(); setVis('pot', false);

    // géométrie en pixels du canevas (devicePixelRatio)
    const dpr = map.getCanvas().width / cw;
    const ring = bufferCircle(r, km).geometry.coordinates[0].map(ll => {
      const p = map.project(ll); return [p.x * dpr - base.ox, p.y * dpr - base.oy];
    });
    const ctr = map.project([r.x, r.y]);
    const cx = ctr.x * dpr - base.ox, cy = ctr.y * dpr - base.oy;
    const W = base.c.width, H = base.c.height, u = W / 500;          // unité graphique
    const mpp = (40075016.686 * Math.cos((r.y * Math.PI) / 180)) / (512 * 2 ** map.getZoom()) / dpr;
    const skm = niceKm((W * 0.32 * mpp) / 1000), sL = (skm * 1000) / mpp;

    const compose = (layer, arrow) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(base.c, 0, 0);
      ctx.save();
      ctx.beginPath(); ring.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath();
      ctx.clip();
      ctx.drawImage(layer.c, 0, 0);
      ctx.restore();
      ctx.beginPath(); ring.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath();
      ctx.lineWidth = 3 * u; ctx.strokeStyle = '#111'; ctx.stroke();
      // lieu habité + étiquette encadrée
      ctx.beginPath(); ctx.arc(cx, cy, 4.5 * u, 0, 2 * Math.PI); ctx.fillStyle = '#111'; ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.font = `bold ${Math.round(15 * u)}px Arial`;
      const label = lhName(r), tw = ctx.measureText(label).width, lh = 20 * u;
      const lx = cx - tw / 2 - 5 * u, ly = cy - 12 * u - lh;
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(lx, ly, tw + 10 * u, lh);
      ctx.lineWidth = 1.2 * u; ctx.strokeStyle = '#111'; ctx.strokeRect(lx, ly, tw + 10 * u, lh);
      ctx.fillStyle = '#111'; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + 5 * u, ly + lh / 2);
      // échelle
      const sx = 14 * u, sy = H - 22 * u, bh = 8 * u;
      ctx.fillStyle = '#fff'; ctx.fillRect(sx, sy, sL, bh);
      ctx.fillStyle = '#222'; ctx.fillRect(sx, sy, sL / 2, bh);
      ctx.lineWidth = 1 * u; ctx.strokeStyle = '#222'; ctx.strokeRect(sx, sy, sL, bh);
      ctx.font = `${Math.round(13 * u)}px Arial`; ctx.textBaseline = 'middle';
      ctx.fillText(`${skm} km`, sx + sL + 6 * u, sy + bh / 2);
      if (arrow) northArrow(ctx, W - 30 * u, 30 * u, 34 * u);    // une seule flèche : carte A (combustibles)
      return c.toDataURL('image/jpeg', 0.9);
    };
    return { comb: compose(comb, true), pot: compose(pot, false) };
  } finally {
    for (const [id, v] of Object.entries(savedVis)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// ── Carte de localisation (Québec en Lambert, territoire en rouge) ─────────
const LCC_DEF = '+proj=lcc +lat_1=60 +lat_2=46 +lat_0=44 +lon_0=-68.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs';

/** Anneaux [lon,lat] d'une géométrie GeoJSON (Feature, FeatureCollection, Polygon, MultiPolygon). */
function ringsOf(g, out = []) {
  if (!g) return out;
  if (g.type === 'FeatureCollection') g.features.forEach(f => ringsOf(f, out));
  else if (g.type === 'Feature') ringsOf(g.geometry, out);
  else if (g.type === 'Polygon') out.push(...g.coordinates);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(...p));
  return out;
}

async function locatorMap(territory, aspect, pxW = 900) {
  const prov = await loadProvince();
  const prj = proj4('EPSG:4326', LCC_DEF);
  const provRings = ringsOf(prov).map(r => r.map(c => prj.forward(c)));
  const terrRings = ringsOf(territory).map(r => r.map(c => prj.forward(c)));
  // emprise : Québec + 6 % de marge, ajustée au ratio de la boîte du PDF
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of provRings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = (x1 - x0) * 1.06, h = (y1 - y0) * 1.06;
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  const W = pxW, H = Math.round(pxW / aspect), k = W / w;
  const px = ([x, y]) => [(x - (cx - w / 2)) * k, (cy + h / 2 - y) * k];
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // fond de carte gris pâle reprojeté en Lambert
  await paintBasemap(ctx, W, H, (px, py) => prj.inverse([cx - w / 2 + px / k, cy + h / 2 - py / k]));
  const path = (rings) => {
    ctx.beginPath();
    for (const r of rings) r.forEach((p, i) => { const [a, b] = px(p); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
  };
  // Territoire (MRC ou zone) : rouge semi-transparent
  if (terrRings.length) {
    path(terrRings);
    ctx.fillStyle = 'rgba(214, 39, 40, 0.5)'; ctx.fill('evenodd');
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.5; ctx.stroke();
    // territoire trop petit pour être visible : cercle de repérage
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
    for (const r of terrRings) for (const p of r) { const [a, b] = px(p); tx0 = Math.min(tx0, a); tx1 = Math.max(tx1, a); ty0 = Math.min(ty0, b); ty1 = Math.max(ty1, b); }
    if (Math.max(tx1 - tx0, ty1 - ty0) < 14) {
      ctx.beginPath(); ctx.arc((tx0 + tx1) / 2, (ty0 + ty1) / 2, 12, 0, 2 * Math.PI);
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }
  // Périmètre du Québec : contour noir, fond transparent
  path(provRings);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  // Échelle 500 km
  const L = 500000 * k, sx = 24, sy = H - 26;
  ctx.fillStyle = '#111'; ctx.fillRect(sx, sy, L, 5);
  ctx.fillStyle = '#fff'; for (let i = 1; i < 5; i += 2) ctx.fillRect(sx + (L / 5) * i, sy + 1, L / 5, 3);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.strokeRect(sx, sy, L, 5);
  ctx.fillStyle = '#111'; ctx.font = `${Math.round(W / 40)}px Arial`; ctx.fillText('500 km', sx + L + 8, sy + 6);
  return c.toDataURL('image/png');
}

// ── Mise en page ───────────────────────────────────────────────────────────
const PW = 792, PH = 612, M = 18;          // lettre paysage (pt), marge 0,25 po
const LEFT_W = (PW - 2 * M) / 3;
const NAVY = [44, 62, 80], GREY_BG = [242, 242, 242], DARK = [44, 44, 44];

function footer(doc, x, y, w, h, sources) {
  doc.setFillColor(...GREY_BG); doc.setDrawColor(150); doc.rect(x, y, w, h, 'FD');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(pdfTxt(t('pdf.obs')), x + 12, y + 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text(pdfTxt('Hugues Dorion - hdorion@uqac.ca     Victor Danneyrolles - vdanneyr@uqac.ca'), x + 12, y + 29);
  doc.setFontSize(7);
  doc.text(pdfTxt(sources), x + 12, y + 41, { maxWidth: w - 24 });
  doc.setFontSize(6.5); doc.setTextColor(120);
  doc.text(pdfTxt(t('pdf.generated', { d: new Date().toLocaleDateString(loc()) })), PW - M, M - 5, { align: 'right' });
}

function wrap(doc, s, w) { return doc.splitTextToSize(pdfTxt(s), w); }

async function territoryPage(doc, mapImg) {
  const s = S.series, e = S.idx;
  const x = M, y = M, h = PH - 2 * M;
  const titleH = h * 0.42;
  // Panneau titre
  doc.setFillColor(...GREY_BG); doc.setDrawColor(60); doc.rect(x, y, LEFT_W, titleH, 'FD');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
  let ty = y + 34;
  for (const l of wrap(doc, t('pdf.terrTitle', { a: s.y0, b: YEAR_END }), LEFT_W - 28)) { doc.text(l, x + 14, ty); ty += 24; }
  ty += 10; doc.setFontSize(16);
  for (const l of wrap(doc, S.terrName, LEFT_W - 28)) { doc.text(l, x + 14, ty); ty += 19; }
  ty += 10; doc.setFontSize(12);
  if (e) {
    doc.text(pdfTxt(t('pdf.idxMean', { v: fmtIdx(e.mean) })), x + 14, ty); ty += 16;
    doc.text(pdfTxt(t('pdf.idxSd', { v: fmtIdx(e.sd) })), x + 14, ty); ty += 13;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(pdfTxt(t('pdf.idxNote', { n: e.n })), x + 14, ty); ty += 4;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  ty += 8;
  doc.text(pdfTxt(t('pdf.fires', { y: YEAR_END, n: fmtInt(s.totOcc), h: fmtInt(s.totH), f: fmtInt(s.totF) })), x + 14, ty); ty += 11;
  doc.text(pdfTxt(t('pdf.burned', { a: s.y0, b: YEAR_END, v: fmtInt(s.totSup) })), x + 14, ty); ty += 11;
  doc.text(pdfTxt(t('pdf.fuel', { v: fmtInt(s.fuelHa) })), x + 14, ty);
  // Carte
  const mapY = y + titleH, mapH = h - titleH;
  doc.addImage(mapImg, 'PNG', x, mapY, LEFT_W, mapH, undefined, 'FAST');
  doc.setDrawColor(60); doc.rect(x, mapY, LEFT_W, mapH);
  // Graphiques
  const rx = x + LEFT_W, rw = PW - M - rx, footH = 52;
  doc.rect(rx, y, rw, h);
  const chartH = (h - footH - 30) / 2;
  const pxW = 760, sc = rw / pxW;
  const occ = await svgToPng(occChart(s, { width: pxW, height: Math.round((chartH - 16) / sc), labels: true }), 2.5);
  const sup = await svgToPng(supChart(s, { width: pxW, height: Math.round((chartH - 16) / sc), log: S.log }), 2.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(pdfTxt(t('chart.occ')), rx + 10, y + 14);
  legend(doc, rx + rw - 10, y + 10);
  doc.addImage(occ.data, 'PNG', rx + 4, y + 18, rw - 8, (rw - 8) * occ.h / occ.w, undefined, 'FAST');
  const y2 = y + 18 + chartH;
  doc.text(pdfTxt(t('chart.sup') + (S.log ? t('chart.logPdf') : '')), rx + 10, y2 + 6);
  doc.addImage(sup.data, 'PNG', rx + 4, y2 + 10, rw - 8, (rw - 8) * sup.h / sup.w, undefined, 'FAST');
  footer(doc, rx, y + h - footH, rw, footH, t('pdf.terrSources'));
}

function legend(doc, xr, y) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const items = [[t('leg.human'), COLORS.humain], [t('leg.lightning'), COLORS.foudre]];
  let x = xr;
  for (const [lbl, c] of items.reverse()) {
    const w = doc.getTextWidth(lbl);
    x -= w; doc.setTextColor(...DARK); doc.text(lbl, x, y + 6);
    x -= 12; doc.setFillColor(c); doc.rect(x, y, 9, 8, 'F'); x -= 10;
  }
}

async function communityPage(doc, r, maps, buf) {
  const cls = S.core.classes;
  const x = M, y = M, h = PH - 2 * M, w = PW - 2 * M;
  const lw = w * 0.5;
  doc.setDrawColor(60); doc.rect(x, y, w, h);
  doc.setFillColor(...GREY_BG); doc.rect(x, y, lw, h, 'F');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  doc.text(pdfTxt(t('pdf.combTitle')), x + 22, y + 36);
  doc.text('(MRNF 2025)', x + 22, y + 62);
  doc.setFontSize(14); doc.setFont('helvetica', 'normal');
  let ty = y + 92;
  const lab = pdfTxt(t('pdf.community'));
  doc.text(lab, x + 22, ty);
  const lx = x + 22 + doc.getTextWidth(lab + ' ');
  doc.setFont('helvetica', 'bold');
  const nm = wrap(doc, lhName(r), lw - (lx - x) - 22);
  nm.forEach((l, i) => doc.text(l, lx, ty + i * 17));
  ty += nm.length * 17;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  const sub = [r.na && r.na !== r.nom ? `(${r.nom})` : '', r.mun ? t('pdf.municipality', { m: r.mun }) : '', r.nat ? t('pdf.nation', { n: r.nat }) : ''].filter(Boolean);
  for (const l of sub.flatMap(s => wrap(doc, s, lw - 44))) { doc.text(l, x + 22, ty); ty += 14; }
  ty += 8;
  const unit = unitProps(r.u);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
  if (unit) {
    doc.text(pdfTxt(`${t('mrc')} ${unit.nom}`), x + 22, ty); ty += 15;
    if (unit.im != null) { doc.text(pdfTxt(t('pdf.unitIdx', { m: fmtIdx(unit.im), s: fmtIdx(unit.isd) })), x + 22, ty); ty += 15; }
  }
  const bi = bufferIndex(r, S.bufKm);
  if (bi) { doc.text(pdfTxt(t('pdf.bufIdx', { m: fmtIdx(bi.mean), s: fmtIdx(bi.sd) })), x + 22, ty); ty += 15; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const tot = buf.comb.reduce((a, v) => a + v, 0);
  doc.text(pdfTxt(t('pdf.buffer', { k: S.bufKm, v: fmtInt(tot) })), x + 22, ty); ty += 10;
  doc.setDrawColor(60); doc.line(x, ty, x + lw, ty);

  // Graphiques A (combustibles) et B (potentiel), même hauteur
  const gy = ty + 8, gh = y + h - gy - 8;
  const cw = (lw - 30) / 2;
  const pair = lhChartPair(buf, cls, 250, { combRowH: 19, fontSize: 9.5 });
  const comb = await svgToPng(pair.comb, 2.5), pot = await svgToPng(pair.pot, 2.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
  doc.text(pdfTxt(t('lh.chartA')), x + 12, gy + 6);
  doc.text(wrap(doc, t('lh.chartB'), cw), x + 18 + cw, gy + 6);
  const fit = (img, bx, by, bw, bh) => {
    let iw = bw, ih = bw * img.h / img.w;
    if (ih > bh) { ih = bh; iw = bh * img.w / img.h; }
    doc.addImage(img.data, 'PNG', bx, by, iw, ih, undefined, 'FAST');
  };
  fit(comb, x + 8, gy + 18, cw, gh - 20);
  fit(pot, x + 14 + cw, gy + 18, cw, gh - 20);

  // Cartes A et B empilées
  const mx = x + lw, mw = w - lw, footH = 60, mh = (h - footH) / 2;
  const mapBox = (img, my, title) => {
    doc.addImage(img, 'JPEG', mx, my, mw, mh, undefined, 'FAST');
    doc.setDrawColor(60); doc.setLineWidth(0.8); doc.rect(mx, my, mw, mh);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    const tw = doc.getTextWidth(pdfTxt(title));
    doc.setFillColor(255, 255, 255); doc.setDrawColor(30); doc.setLineWidth(0.6);
    doc.rect(mx + 8, my + 7, tw + 8, 16, 'FD');
    doc.setTextColor(...DARK); doc.text(pdfTxt(title), mx + 12, my + 19);
  };
  mapBox(maps.comb, y, t('lh.chartA'));
  mapBox(maps.pot, y + mh, t('lh.chartB'));
  doc.setLineWidth(0.57);
  footer(doc, mx, y + h - footH, mw, footH, t('pdf.lhSources'));
}

// ── Page des légendes et explications (toujours ajoutée à la fin) ──────────
function legendPages(doc, newPage) {
  const L = LEGEND();
  const colW = (PW - 2 * M - 20 - 30) / 2, top = M + 46, bottom = PH - M - 12;
  let col = 0, y = top;
  const x = () => M + 10 + col * (colW + 30);
  const head = () => {
    newPage();
    doc.setDrawColor(60); doc.setLineWidth(0.57); doc.rect(M, M, PW - 2 * M, PH - 2 * M);
    doc.setFillColor(...GREY_BG); doc.rect(M, M, PW - 2 * M, 32, 'F');
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text(pdfTxt(t('pdf.legTitle')), M + 12, M + 22);
    col = 0; y = top;
  };
  const need = (hgt) => {
    if (y + hgt <= bottom) return;
    if (col === 0) { col = 1; y = top; } else head();
  };
  const section = (title) => {
    need(30);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(44, 62, 80);
    doc.text(pdfTxt(title), x(), y); y += 6;
    doc.setDrawColor(44, 62, 80); doc.setLineWidth(1); doc.line(x(), y, x() + colW, y); y += 13;
  };
  const sub = (h) => {
    need(26);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...DARK);
    for (const l of wrap(doc, h, colW)) { doc.text(l, x(), y); y += 11.5; }
    y += 1;
  };
  const para = (txt) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60);
    for (const l of wrap(doc, txt.replace(/\*\*/g, ''), colW)) { need(11); doc.text(l, x(), y); y += 10.5; }
    y += 4;
  };
  const swatch = (hex, txt, indent = 0) => {
    need(11);
    doc.setFillColor(hex); doc.setDrawColor(150); doc.setLineWidth(0.3);
    doc.rect(x() + indent, y - 7, 14, 8, 'FD');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...DARK);
    doc.text(pdfTxt(txt), x() + indent + 20, y); y += 11;
  };

  head();
  section(t('pdf.legMrc'));
  for (const b of L.mrc) {
    sub(b.h); b.p.forEach(para);
    if (b.sw) { b.sw.forEach(([c, l]) => swatch(c, l)); y += 4; }
  }
  section(t('pdf.legLh'));
  sub(L.lhComb.h); L.lhComb.p.forEach(para);
  for (const gr of combGroups()) {
    need(24);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(44, 62, 80);
    doc.text(pdfTxt(gr.label.toUpperCase()), x(), y); y += 11;
    gr.items.forEach(c => swatch(c.hex, cAbb(c) === cLbl(c) ? cLbl(c) : `${cAbb(c)} - ${cLbl(c)}`, 6));
  }
  y += 4;
  sub(L.lhPot.h); L.lhPot.p.forEach(para);
  S.core.classes.pot.forEach(c => swatch(c.hex, pLbl(c)));
  y += 6;
  for (const b of L.lhMore) { sub(b.h); b.p.forEach(para); }
}

// ── Génération ─────────────────────────────────────────────────────────────
async function generate() {
  const comms = checked();
  const withTerr = $('rep-terr-page').checked && !!S.series;
  if (!comms.length && !withTerr) { $('rep-progress').textContent = t('rep.pick'); return; }
  if (!window.jspdf) { $('rep-progress').textContent = t('rep.lib'); return; }
  $('rep-go').disabled = true;
  // Progression par étapes : page territoire + une page par communauté + enregistrement
  const nSteps = (withTerr ? 1 : 0) + comms.length + 2;   // + légendes + enregistrement
  let step = 0;
  const setBar = (pct) => {
    $('rep-bar').hidden = false;
    $('rep-bar-fill').style.width = `${pct}%`;
    $('rep-bar-pct').textContent = `${Math.round(pct)} %`;
  };
  const prog = (txt) => {
    setBar((step / nSteps) * 100);
    $('rep-progress').innerHTML = `<span class="spin-inline"></span> ${t('rep.step', { i: step + 1, n: nSteps, t: txt })}`;
    step++;
  };
  setBar(0);

  const map = S.map;
  const saved = { center: map.getCenter(), zoom: map.getZoom() };
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true });
  let first = true;
  const newPage = () => { if (!first) doc.addPage('letter', 'landscape'); first = false; };

  try {
    if (withTerr) {
      prog(t('rep.stepTerr'));
      const geom = S.zone ? S.zone.geojson : S.core.units.features.find(f => f.properties.id === S.unit);
      const img = await locatorMap(geom, LEFT_W / ((PH - 2 * M) * 0.58));
      newPage();
      await territoryPage(doc, img);
    }
    for (let k = 0; k < comms.length; k++) {
      const r = comms[k];
      prog(t('rep.stepLh', { i: k + 1, n: comms.length, name: lhName(r) }));
      const buf = await bufferStats(r.idx, S.bufKm);
      const w = PW - 2 * M;
      const maps = await captureBufferMaps(r, S.bufKm, (w * 0.5) / ((PH - 2 * M - 60) / 2));
      newPage();
      await communityPage(doc, r, maps, buf);
    }
    prog(t('rep.stepLeg'));
    legendPages(doc, newPage);
    prog(t('rep.stepSave'));
    const name = (S.terrName || 'territoire').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
    doc.save(`${t('rep.file')}_${name}_${new Date().toISOString().slice(0, 10)}.pdf`);
    setBar(100);
    $('rep-progress').textContent = t('rep.done', { n: doc.getNumberOfPages() });
  } finally {
    // Restauration de la vue (les couches sont rétablies par captureBufferMaps)
    map.jumpTo({ center: saved.center, zoom: saved.zoom });
    $('rep-go').disabled = false;
  }
}

