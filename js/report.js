// Rapport PDF généré dans le navigateur (jsPDF) — fiche territoire + fiches communautés
import { YEAR_END, COLORS } from './config.js';
import { occChart, supChart, hbarChart, svgToPng, fmtInt, fmtPct } from './charts.js';
import { bufferStats } from './stats.js';
import { S, lhName, lhSub, combRows, potRows, sortComb, loadFiresInView, bufferCircle } from './app.js';

const $ = (id) => document.getElementById(id);
let autoTerr = true;

// Polices standard PDF (WinAnsi) : on remplace les caractères non pris en charge
const pdfTxt = (s) => String(s ?? '')
  .replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/ | /g, ' ').normalize('NFC').replace(/[^\x00-\xFF]/g, '');

export function openReportDialog() {
  const terr = S.terrName || 'Territoire';
  $('rep-terr').innerHTML = `Territoire : <b>${terr}</b>`;
  $('rep-buf').textContent = S.bufKm;
  const list = $('rep-list');
  list.innerHTML = S.terrLH.length
    ? S.terrLH.map(r => `<label data-k="${(lhName(r) + ' ' + r.mun).toLowerCase()}"><input type="checkbox" value="${r.idx}" ${r === S.lh ? 'checked' : ''}> ${lhName(r)} ${lhSub(r) ? `<small>${lhSub(r)}</small>` : ''}</label>`).join('')
    : '<div class="muted" style="padding:6px">Aucune communauté dans ce territoire.</div>';
  autoTerr = true;
  syncTerr();
  $('rep-progress').textContent = '';
  $('rep-go').disabled = false;
  $('modal-rapport').classList.add('open');
}

function checked() { return [...$('rep-list').querySelectorAll('input:checked')].map(i => S.core.lh[+i.value]); }

// Une seule communauté → sa fiche seulement ; plusieurs (ou aucune) → page territoire en premier
function syncTerr() {
  if (!autoTerr) return;
  $('rep-terr-page').checked = checked().length !== 1 && !!S.series;
}

$('rep-list').addEventListener('change', syncTerr);
$('rep-terr-page').addEventListener('change', () => { autoTerr = false; });
$('rep-all').addEventListener('click', () => { $('rep-list').querySelectorAll('label:not([hidden]) input').forEach(i => { i.checked = true; }); syncTerr(); });
$('rep-none').addEventListener('click', () => { $('rep-list').querySelectorAll('input').forEach(i => { i.checked = false; }); syncTerr(); });
$('rep-filter').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  $('rep-list').querySelectorAll('label').forEach(l => { l.hidden = q && !l.dataset.k.includes(q); });
});
$('rep-go').addEventListener('click', () => generate().catch(err => {
  console.error(err);
  $('rep-progress').textContent = `Erreur : ${err.message || err}`;
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

async function captureMap(bounds, aspect) {
  const map = S.map;
  // marges telles que l'emprise tienne dans la zone recadrée (ratio du PDF)
  const W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
  const pad = { top: 24, bottom: 24, left: 24, right: 24 };
  if (W / H > aspect) { const p = (W - H * aspect) / 2 + 24; pad.left = p; pad.right = p; }
  else { const p = (H - W / aspect) / 2 + 24; pad.top = p; pad.bottom = p; }
  map.fitBounds(bounds, { padding: pad, duration: 0 });
  await idle(map);
  await loadFiresInView();
  await idle(map);
  await wait(150);
  const src = map.getCanvas();
  // recadrage au centre selon le ratio de la boîte du PDF
  let sw = src.width, sh = src.height;
  if (sw / sh > aspect) sw = sh * aspect; else sh = sw / aspect;
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, sw, sh);
  return c.toDataURL('image/jpeg', 0.88);
}

function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
    else c.forEach(walk);
  };
  (geom.features || [geom]).forEach(f => walk((f.geometry || f).coordinates));
  return [[x0, y0], [x1, y1]];
}

function circleBounds(r, km) {
  const dLat = km / 111.2, dLon = km / (111.2 * Math.cos(r.y * Math.PI / 180));
  return [[r.x - dLon, r.y - dLat], [r.x + dLon, r.y + dLat]];
}

// ── Mise en page ───────────────────────────────────────────────────────────
const PW = 792, PH = 612, M = 18;          // lettre paysage (pt), marge 0,25 po
const LEFT_W = (PW - 2 * M) / 3;
const NAVY = [44, 62, 80], GREY_BG = [242, 242, 242], DARK = [44, 44, 44];

function footer(doc, x, y, w, h, sources) {
  doc.setFillColor(...GREY_BG); doc.setDrawColor(150); doc.rect(x, y, w, h, 'FD');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(pdfTxt('Observatoire régional de recherche sur la forêt boréale'), x + 12, y + 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text(pdfTxt('Hugues Dorion - hdorion@uqac.ca     Victor Danneyrolles - vdanneyr@uqac.ca'), x + 12, y + 29);
  doc.setFontSize(7);
  doc.text(pdfTxt(sources), x + 12, y + 41, { maxWidth: w - 24 });
  doc.setFontSize(6.5); doc.setTextColor(120);
  doc.text(pdfTxt(`Généré le ${new Date().toLocaleDateString('fr-CA')} - application v2.0 (bêta)`), PW - M, M - 5, { align: 'right' });
}

function wrap(doc, s, w) { return doc.splitTextToSize(pdfTxt(s), w); }

async function territoryPage(doc, mapImg) {
  const s = S.series, e = S.expoInfo;
  const x = M, y = M, h = PH - 2 * M;
  const titleH = h * 0.42;
  // Panneau titre
  doc.setFillColor(...GREY_BG); doc.setDrawColor(60); doc.rect(x, y, LEFT_W, titleH, 'FD');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
  let ty = y + 34;
  for (const l of wrap(doc, `Portrait de l'historique des feux de forêt ${s.y0} à ${YEAR_END}`, LEFT_W - 28)) { doc.text(l, x + 14, ty); ty += 24; }
  ty += 10; doc.setFontSize(16);
  for (const l of wrap(doc, S.terrName, LEFT_W - 28)) { doc.text(l, x + 14, ty); ty += 19; }
  ty += 10; doc.setFontSize(12);
  if (e) {
    doc.text(pdfTxt(e.rang ? `Rang de prédisposition : ${e.rang} / 107` : 'MRC non évaluée'), x + 14, ty); ty += 16;
    doc.text(pdfTxt(`Indice de prédisposition : ${(+e.expo).toFixed(2)} / 6`), x + 14, ty); ty += 14;
    if (e.majority) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      for (const l of wrap(doc, `(MRC la plus représentée dans la zone : ${e.unitName})`, LEFT_W - 28)) { doc.text(l, x + 14, ty); ty += 10; }
    }
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  ty += 8;
  doc.text(pdfTxt(`Feux 1972-${YEAR_END} : ${fmtInt(s.totOcc)} (humain ${fmtInt(s.totH)}, foudre ${fmtInt(s.totF)})`), x + 14, ty); ty += 11;
  doc.text(pdfTxt(`Superficie brûlée ${s.y0}-${YEAR_END} : ${fmtInt(s.totSup)} ha`), x + 14, ty); ty += 11;
  doc.text(pdfTxt(`Superficie combustible : ${fmtInt(s.fuelHa)} ha`), x + 14, ty);
  // Carte
  const mapY = y + titleH, mapH = h - titleH;
  doc.addImage(mapImg, 'JPEG', x, mapY, LEFT_W, mapH);
  doc.setDrawColor(60); doc.rect(x, mapY, LEFT_W, mapH);
  // Graphiques
  const rx = x + LEFT_W, rw = PW - M - rx, footH = 52;
  doc.rect(rx, y, rw, h);
  const chartH = (h - footH - 30) / 2;
  const pxW = 760, sc = rw / pxW;
  const occ = await svgToPng(occChart(s, { width: pxW, height: Math.round((chartH - 16) / sc), labels: true }), 2.5);
  const sup = await svgToPng(supChart(s, { width: pxW, height: Math.round((chartH - 16) / sc), log: S.log }), 2.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(pdfTxt('Occurrences et causes des feux'), rx + 10, y + 14);
  legend(doc, rx + rw - 10, y + 10);
  doc.addImage(occ.data, 'PNG', rx + 4, y + 18, rw - 8, (rw - 8) * occ.h / occ.w, undefined, 'FAST');
  const y2 = y + 18 + chartH;
  doc.text(pdfTxt(`Superficies brûlées annuellement${S.log ? ' (échelle logarithmique)' : ''}`), rx + 10, y2 + 6);
  doc.addImage(sup.data, 'PNG', rx + 4, y2 + 10, rw - 8, (rw - 8) * sup.h / sup.w, undefined, 'FAST');
  footer(doc, rx, y + h - footH, rw, footH,
    'Sources (donneesquebec.ca) : Cartographie des points d\'origine des feux de forêt (1972-2024) - Feux de forêt (depuis 1976) - Feux anciens (1887-1975, zones de régime de feux seulement) - Combustibles 2025 (MRNF). Trait pointillé : moyenne des années avec feux ; bande grise : +/- 1 écart-type.');
}

function legend(doc, xr, y) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const items = [['Humain', COLORS.humain], ['Foudre', COLORS.foudre]];
  let x = xr;
  for (const [lbl, c] of items.reverse()) {
    const w = doc.getTextWidth(lbl);
    x -= w; doc.setTextColor(...DARK); doc.text(lbl, x, y + 6);
    x -= 12; doc.setFillColor(c); doc.rect(x, y, 9, 8, 'F'); x -= 10;
  }
}

async function communityPage(doc, r, mapImg, buf) {
  const cls = S.core.classes;
  const x = M, y = M, h = PH - 2 * M, w = PW - 2 * M;
  const lw = w * 0.5;
  doc.setDrawColor(60); doc.rect(x, y, w, h);
  doc.setFillColor(...GREY_BG); doc.rect(x, y, lw, h, 'F');
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  doc.text(pdfTxt('Cartographie des combustibles'), x + 22, y + 36);
  doc.text('(MRNF 2025)', x + 22, y + 62);
  doc.setFontSize(14); doc.setFont('helvetica', 'normal');
  let ty = y + 92;
  const nm = wrap(doc, `Communauté : ${lhName(r)}`, lw - 44);
  for (const l of nm) { doc.text(l, x + 22, ty); ty += 17; }
  doc.setFontSize(11);
  const sub = [r.na && r.na !== r.nom ? `(${r.nom})` : '', r.mun ? `Municipalité : ${r.mun}` : '', r.nat ? `Nation : ${r.nat} (toponyme à valider)` : ''].filter(Boolean);
  for (const l of sub.flatMap(s => wrap(doc, s, lw - 44))) { doc.text(l, x + 22, ty); ty += 14; }
  ty += 8;
  const unit = S.core.units.features.find(f => f.properties.id === r.u)?.properties;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
  if (unit) {
    doc.text(pdfTxt(`MRC ${unit.nom}`), x + 22, ty); ty += 15;
    doc.text(pdfTxt(unit.rang ? `Rang de prédisposition : ${unit.rang} / 107` : 'MRC non évaluée'), x + 22, ty); ty += 15;
    doc.text(pdfTxt(`Indice de prédisposition : ${(+unit.expo).toFixed(2)} / 6`), x + 22, ty); ty += 15;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const tot = buf.comb.reduce((a, v) => a + v, 0);
  doc.text(pdfTxt(`Zone tampon : ${S.bufKm} km (${fmtInt(tot)} ha analysés)`), x + 22, ty); ty += 10;
  doc.setDrawColor(60); doc.line(x, ty, x + lw, ty);
  // Graphiques
  const gy = ty + 8, gh = y + h - gy - 8;
  const cw = (lw - 30) / 2;
  const potSvg = hbarChart(potRows(buf.pot, cls), { width: 250, rowH: 52, labelW: 86, fontSize: 11 });
  const combSvg = hbarChart(sortComb(combRows(buf.comb, cls)), { width: 250, rowH: 19, labelW: 52, groupW: 54, fontSize: 9.5 });
  const pot = await svgToPng(potSvg, 2.5), comb = await svgToPng(combSvg, 2.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
  doc.text(pdfTxt("Potentiel d'intensité et de propagation"), x + 12, gy + 6);
  doc.text(pdfTxt('Superficie des combustibles'), x + 18 + cw, gy + 6);
  const fit = (img, bx, by, bw, bh) => {
    let iw = bw, ih = bw * img.h / img.w;
    if (ih > bh) { ih = bh; iw = bh * img.w / img.h; }
    doc.addImage(img.data, 'PNG', bx, by, iw, ih, undefined, 'FAST');
  };
  fit(pot, x + 8, gy + 12, cw, gh - 14);
  fit(comb, x + 14 + cw, gy + 12, cw, gh - 14);
  // Carte
  const mx = x + lw, mw = w - lw, footH = 60;
  doc.addImage(mapImg, 'JPEG', mx, y, mw, h - footH);
  doc.line(mx, y, mx, y + h);
  footer(doc, mx, y + h - footH, mw, footH,
    'Sources (donneesquebec.ca) : Potentiel d\'intensité et de propagation des feux de forêt - Combustibles 2025 (MRNF) - Découpages administratifs 1/20 000 - Lieux habités. Le potentiel mesure la gravité potentielle s\'il y a ignition, et non la probabilité d\'un feu.');
}

// ── Génération ─────────────────────────────────────────────────────────────
async function generate() {
  const comms = checked();
  const withTerr = $('rep-terr-page').checked && !!S.series;
  if (!comms.length && !withTerr) { $('rep-progress').textContent = 'Cochez au moins une communauté ou la page territoire.'; return; }
  if (!window.jspdf) { $('rep-progress').textContent = 'Bibliothèque PDF en cours de chargement, réessayez.'; return; }
  $('rep-go').disabled = true;
  const prog = (t) => { $('rep-progress').innerHTML = `<span class="spin-inline"></span> ${t}`; };

  const map = S.map;
  const saved = {
    center: map.getCenter(), zoom: map.getZoom(),
    comb: $('ly-comb').checked, expoOp: $('op-expo').value, lh: S.lh,
    vis: Object.fromEntries(['feux-fill', 'feux-line', 'units-fill', 'pts', 'pot'].map(id => [id, map.getLayoutProperty(id, 'visibility') || 'visible'])),
  };
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true });
  let first = true;
  const newPage = () => { if (!first) doc.addPage('letter', 'landscape'); first = false; };

  try {
    if (withTerr) {
      prog('Page territoire…');
      const geom = S.zone ? S.zone.geojson : S.core.units.features.find(f => f.properties.id === S.unit);
      const img = await captureMap(bboxOf(geom), LEFT_W / ((PH - 2 * M) * 0.58));
      newPage();
      await territoryPage(doc, img);
    }
    // Combustibles visibles pour les cartes des communautés
    if (comms.length) {
      $('ly-comb').checked = true; $('ly-comb').dispatchEvent(new Event('change'));
      ['feux-fill', 'feux-line', 'units-fill', 'pts', 'pot'].forEach(id => map.setLayoutProperty(id, 'visibility', 'none'));
    }
    for (let k = 0; k < comms.length; k++) {
      const r = comms[k];
      prog(`Communauté ${k + 1} / ${comms.length} : ${lhName(r)}…`);
      const buf = await bufferStats(r.idx, S.bufKm);
      S.lh = r;
      map.getSource('lh').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { idx: r.idx, nom: lhName(r), sel: true }, geometry: { type: 'Point', coordinates: [r.x, r.y] } }] });
      map.getSource('buffer').setData(bufferCircle(r, S.bufKm));
      const w = PW - 2 * M;
      const img = await captureMap(circleBounds(r, S.bufKm * 1.08), (w * 0.5) / (PH - 2 * M - 50));
      newPage();
      await communityPage(doc, r, img, buf);
    }
    const name = (S.terrName || 'territoire').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
    doc.save(`Rapport_feux_${name}_${new Date().toISOString().slice(0, 10)}.pdf`);
    $('rep-progress').textContent = `Rapport généré (${doc.getNumberOfPages()} page${doc.getNumberOfPages() > 1 ? 's' : ''}).`;
  } finally {
    // Restauration de l'état de la carte
    for (const [id, on] of Object.entries(saved.vis)) map.setLayoutProperty(id, 'visibility', on);
    $('ly-comb').checked = saved.comb; $('ly-comb').dispatchEvent(new Event('change'));
    $('op-expo').value = saved.expoOp; $('op-expo').dispatchEvent(new Event('input'));
    S.lh = saved.lh;
    map.getSource('buffer').setData(S.lh ? bufferCircle(S.lh, S.bufKm) : { type: 'FeatureCollection', features: [] });
    map.getSource('lh').setData({
      type: 'FeatureCollection',
      features: S.terrLH.map(r => ({ type: 'Feature', properties: { idx: r.idx, nom: lhName(r), sel: r === S.lh }, geometry: { type: 'Point', coordinates: [r.x, r.y] } })),
    });
    map.jumpTo({ center: saved.center, zoom: saved.zoom });
    $('rep-go').disabled = false;
  }
}

