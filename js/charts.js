// Graphiques SVG (affichage à l'écran et export PDF)
import { COLORS } from './config.js';
import { t, loc } from './i18n.js';

const FONT = "'Source Sans 3', Arial, sans-serif";
const GRID = '#e6e9ee', AXIS = '#9aa3ad', TXT = '#374151';

export const fmtInt = (v) => Math.round(v).toLocaleString(loc());
export const fmtHa = (v) => v >= 100 ? fmtInt(v) : v.toLocaleString(loc(), { maximumFractionDigits: 1 });
const pctSp = () => (loc() === 'fr-CA' ? ' %' : '%');
export const fmtPct = (v, d = 1) => `${v.toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d })}${pctSp()}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function niceTicks(max, n = 5) {
  if (max <= 0) return [0, 1];
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => raw <= s);
  const ticks = [];
  for (let v = 0; v <= max * 1.0001 + step * 0.5 && ticks.length < 12; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function text(x, y, s, o = {}) {
  const a = Object.entries({ 'font-family': FONT, 'font-size': 10, fill: TXT, ...o })
    .map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${a}>${esc(s)}</text>`;
}

function xAxis(s, W, H, m, xOf, bw, showLabels) {
  const n = s.years.length;
  const long = s.y0 < 1972;
  const step = long ? (W < 420 ? 20 : 10) : (W < 420 ? 8 : 4);
  let out = '';
  for (const yr of s.years) {
    if ((yr - (long ? 1900 : 1972)) % step !== 0) continue;
    const x = xOf(yr) + bw / 2;
    out += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}" stroke="${GRID}" stroke-width="0.7"/>`;
    if (showLabels) out += text(x, H - m.b + 12, yr, { 'text-anchor': 'middle' });
  }
  if (n) out += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="${AXIS}"/>`;
  return out;
}

function frame(W, H, m) {
  return `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="none" stroke="${AXIS}" stroke-width="0.8"/>`;
}

/** Occurrences annuelles par cause (barres empilées) + taux pour 100 000 ha de combustibles. */
export function occChart(s, { width = 460, height = 200, labels = true, fontScale = 1 } = {}) {
  const W = width, H = height, m = { l: 34, r: 42, t: 8, b: 22 };
  const n = s.years.length, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const band = pw / n, bw = Math.max(1, band * 0.8);
  const xOf = (yr) => m.l + (yr - s.y0) * band + (band - bw) / 2;
  const maxV = Math.max(1, ...s.tot);
  const ticks = niceTicks(maxV, 4), yMax = ticks[ticks.length - 1];
  const yOf = (v) => m.t + ph - (v / yMax) * ph;
  const rate = s.fuelHa > 0 ? 100000 / s.fuelHa : 0;
  let g = '';
  // grille + axes Y
  for (const tk of ticks) {
    const y = yOf(tk);
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="0.7"/>`;
    g += text(m.l - 4, y + 3.5, fmtInt(tk), { 'text-anchor': 'end' });
    if (rate) g += text(W - m.r + 4, y + 3.5, (tk * rate).toLocaleString(loc(), { maximumFractionDigits: tk * rate < 10 ? 2 : 1 }));
  }
  g += xAxis(s, W, H, m, xOf, bw, true);
  // moyenne ± écart-type
  const { mean, sd } = s.occStats;
  if (mean > 0) {
    const yTop = yOf(Math.min(yMax, mean + sd)), yBot = yOf(Math.max(0, mean - sd));
    g += `<rect x="${m.l}" y="${yTop}" width="${pw}" height="${yBot - yTop}" fill="#323232" fill-opacity="0.09"/>`;
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${yOf(mean)}" y2="${yOf(mean)}" stroke="#555" stroke-dasharray="4 3" stroke-width="1"/>`;
  }
  // barres
  for (let i = 0; i < n; i++) {
    const yr = s.years[i], h = s.h[i], f = s.f[i];
    if (!h && !f) continue;
    const x = xOf(yr);
    const tip = `<b>${yr}</b><br>${t('tip.occ', { n: h + f, h, f })}` +
      (rate ? `<br>${t('tip.rate', { r: ((h + f) * rate).toLocaleString(loc(), { maximumFractionDigits: 2 }) })}` : '');
    g += `<g data-tip="${esc(tip)}">`;
    if (h) g += `<rect x="${x}" y="${yOf(h)}" width="${bw}" height="${yOf(0) - yOf(h)}" fill="${COLORS.humain}"/>`;
    if (f) g += `<rect x="${x}" y="${yOf(h + f)}" width="${bw}" height="${yOf(h) - yOf(h + f)}" fill="${COLORS.foudre}"/>`;
    g += `<rect x="${x - (band - bw) / 2}" y="${m.t}" width="${band}" height="${ph}" fill="transparent"/></g>`;
    if (labels && band >= 9) g += text(x + bw / 2, yOf(h + f) - 2, h + f, { 'text-anchor': 'middle', 'font-size': 7.5 * fontScale, 'font-weight': 700 });
  }
  g += frame(W, H, m);
  g += text(9, m.t + ph / 2, t('ax.nFires'), { transform: `rotate(-90 9 ${m.t + ph / 2})`, 'text-anchor': 'middle', 'font-weight': 600 });
  if (rate) g += text(W - 6, m.t + ph / 2, t('ax.rate'), { transform: `rotate(90 ${W - 6} ${m.t + ph / 2})`, 'text-anchor': 'middle', 'font-weight': 600 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">${g}</svg>`;
}

/** Superficies brûlées annuelles (échelle log ou linéaire) + % de la superficie combustible. */
export function supChart(s, { width = 460, height = 190, log = true } = {}) {
  const W = width, H = height, m = { l: 44, r: 42, t: 8, b: 22 };
  const n = s.years.length, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const band = pw / n, bw = Math.max(1, band * 0.8);
  const xOf = (yr) => m.l + (yr - s.y0) * band + (band - bw) / 2;
  const maxV = Math.max(1, ...s.sup);
  let yOf, ticks;
  if (log) {
    const top = Math.max(10, 10 ** Math.ceil(Math.log10(maxV * 1.2)));
    ticks = []; for (let v = 1; v <= top; v *= 10) ticks.push(v);
    const L = Math.log10(top);
    yOf = (v) => m.t + ph - (Math.log10(Math.max(1, v)) / L) * ph;
  } else {
    ticks = niceTicks(maxV, 4);
    const top = ticks[ticks.length - 1];
    yOf = (v) => m.t + ph - (Math.max(0, v) / top) * ph;
  }
  const pct = s.fuelHa > 0 ? 100 / s.fuelHa : 0;
  let g = '';
  for (const tk of ticks) {
    const y = yOf(tk);
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="0.7"/>`;
    g += text(m.l - 4, y + 3.5, log && tk === 1 ? '0' : fmtInt(tk), { 'text-anchor': 'end' });
    if (pct) {
      const p = log && tk === 1 ? 0 : tk * pct;
      g += text(W - m.r + 4, y + 3.5, p === 0 ? '0' : p < 0.01 ? `<${(0.01).toLocaleString(loc())}${pctSp()}` : `${p.toLocaleString(loc(), { maximumFractionDigits: p < 1 ? 2 : 1 })}${pctSp()}`);
    }
  }
  g += xAxis(s, W, H, m, xOf, bw, true);
  const { mean, sd } = s.supStats;
  if (mean > 0) {
    const yTop = yOf(mean + sd), yBot = yOf(Math.max(log ? 1 : 0, mean - sd));
    g += `<rect x="${m.l}" y="${yTop}" width="${pw}" height="${Math.max(0, yBot - yTop)}" fill="#323232" fill-opacity="0.09"/>`;
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${yOf(mean)}" y2="${yOf(mean)}" stroke="#555" stroke-dasharray="4 3" stroke-width="1"/>`;
  }
  for (let i = 0; i < n; i++) {
    const v = s.sup[i];
    if (!(v > 0)) continue;
    const x = xOf(s.years[i]), y = yOf(v);
    const tip = `<b>${s.years[i]}</b><br>${t('tip.burned', { v: fmtHa(v) })}` + (pct ? `<br>${t('tip.pctFuel', { p: fmtPct(v * pct, 2) })}` : '') +
      (s.years[i] < 1976 ? `<br><i>${t('tip.old')}</i>` : '');
    g += `<g data-tip="${esc(tip)}"><rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0.8, yOf(log ? 1 : 0) - y)}" fill="${COLORS.burn}"/>`;
    g += `<rect x="${x - (band - bw) / 2}" y="${m.t}" width="${band}" height="${ph}" fill="transparent"/></g>`;
  }
  g += frame(W, H, m);
  g += text(9, m.t + ph / 2, t('ax.burned'), { transform: `rotate(-90 9 ${m.t + ph / 2})`, 'text-anchor': 'middle', 'font-weight': 600 });
  if (pct) g += text(W - 6, m.t + ph / 2, t('ax.pctFuel'), { transform: `rotate(90 ${W - 6} ${m.t + ph / 2})`, 'text-anchor': 'middle', 'font-weight': 600 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">${g}</svg>`;
}

/**
 * Barres horizontales en % (potentiel I/P ou combustibles).
 * rows : [{ label, ha, color, group? }]
 */
export function hbarChart(rows, { width = 260, rowH = 15, labelW = 74, groupW = 0, fontSize = 10 } = {}) {
  const total = rows.reduce((a, r) => a + r.ha, 0) || 1;
  const m = { l: labelW, r: 46 + groupW, t: 4, b: 20 };
  const W = width, H = m.t + m.b + rows.length * rowH, pw = W - m.l - m.r;
  const xOf = (p) => m.l + (p / 100) * pw;
  let g = '';
  for (const p of [0, 25, 50, 75, 100]) {
    g += `<line x1="${xOf(p)}" x2="${xOf(p)}" y1="${m.t}" y2="${H - m.b}" stroke="${GRID}" stroke-width="0.7"/>`;
    g += text(xOf(p), H - m.b + 12, `${p}${pctSp()}`, { 'text-anchor': 'middle', 'font-size': fontSize - 1 });
  }
  let prevGroup = null, groupStart = 0;
  const flushGroup = (i) => {
    if (!groupW || prevGroup == null) return;
    const yA = m.t + groupStart * rowH, yB = m.t + i * rowH;
    g += text(W - 3, (yA + yB) / 2 + 3.5, prevGroup, { 'text-anchor': 'end', 'font-size': fontSize - 1, fill: '#555', 'font-weight': 600 });
    if (i < rows.length) g += `<line x1="4" x2="${W}" y1="${yB}" y2="${yB}" stroke="#b9c0c8" stroke-dasharray="3 3" stroke-width="0.7"/>`;
  };
  rows.forEach((r, i) => {
    if (groupW && r.group !== prevGroup) { flushGroup(i); prevGroup = r.group; groupStart = i; }
    const p = (r.ha / total) * 100, y = m.t + i * rowH;
    const tip = `<b>${esc(r.title || r.label)}</b><br>${fmtHa(r.ha)} ha — ${fmtPct(p)}`;
    g += `<g data-tip="${esc(tip)}">`;
    g += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>`;
    g += text(m.l - 5, y + rowH / 2 + 3.5, r.label, { 'text-anchor': 'end', 'font-size': fontSize, 'font-weight': 600 });
    if (p > 0) g += `<rect x="${m.l}" y="${y + 2}" width="${Math.max(0.8, xOf(p) - m.l)}" height="${rowH - 4}" fill="${r.color}" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>`;
    if (r.ha > 0) g += text(xOf(p) + 3, y + rowH / 2 + 3.5, fmtPct(p), { 'font-size': fontSize - 1.5 });
    g += '</g>';
  });
  flushGroup(rows.length);
  g += `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${H - m.t - m.b}" fill="none" stroke="${AXIS}" stroke-width="0.8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">${g}</svg>`;
}

/** Infobulles des graphiques (délégation sur les éléments [data-tip]). */
export function bindChartTips(root) {
  const tip = document.getElementById('chart-tip');
  root.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.style.display = 'none'; return; }
    tip.innerHTML = el.dataset.tip;
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  });
  root.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

/** SVG → PNG (dataURL) pour l'export PDF. */
export function svgToPng(svg, scale = 3) {
  return new Promise((resolve, reject) => {
    const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const w = +m[1], h = +m[2];
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve({ data: c.toDataURL('image/png'), w, h });
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
