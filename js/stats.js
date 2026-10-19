// Calculs statistiques : séries de feux (MRC ou zone libre) et zones tampons communautés
import { PROJ_LCC, YEAR_END } from './config.js';
import { loadPoints, loadGridFuel, loadGridBurn, loadRings } from './data.js';

const toLcc = (() => { let t; return () => (t ??= proj4('EPSG:4326', PROJ_LCC)); })();

// ── Géométrie ──────────────────────────────────────────────────────────────

/** Densifie un anneau [lon,lat] puis le projette en Lambert (les arêtes Mercator ne sont pas droites en Lambert). */
export function ringToLcc(ring, step = 0.05) {
  const t = toLcc(), out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step));
    for (let k = 0; k < n; k++) out.push(t.forward([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]));
  }
  out.push(out[0]);
  return out;
}

/** Douglas-Peucker (itératif) sur un anneau en mètres. */
function simplifyRing(ring, tol) {
  const n = ring.length;
  if (n < 8 || !tol) return ring;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]], t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let best = -1, dmax = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (!L) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > dmax) { dmax = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

/**
 * Polygones GeoJSON (Polygon / MultiPolygon / FeatureCollection) → liste de polygones Lambert [[anneaux]].
 * `tol` (m) : simplification optionnelle (géométries importées très détaillées).
 */
export function geomToLccPolys(geom, tol = 0) {
  const polys = [];
  const ring = (r) => simplifyRing(ringToLcc(r), tol);
  const add = (g) => {
    if (!g) return;
    if (g.type === 'Feature') return add(g.geometry);
    if (g.type === 'FeatureCollection') return g.features.forEach(add);
    if (g.type === 'GeometryCollection') return g.geometries.forEach(add);
    if (g.type === 'Polygon') polys.push(g.coordinates.map(ring));
    if (g.type === 'MultiPolygon') g.coordinates.forEach(p => polys.push(p.map(ring)));
  };
  add(geom);
  return polys;
}

/**
 * Cellules d'une grille dont le centre est dans les polygones (balayage par ligne, règle pair-impair).
 * Retourne les index de cellules (row * ncols + col).
 */
function cellsInPolys(polys, { x0, y0, res, ncols, nrows }) {
  const [bx0, by0, bx1, by1] = polysBBox(polys);
  const r0 = Math.max(0, Math.floor((y0 - by1) / res)), r1 = Math.min(nrows - 1, Math.floor((y0 - by0) / res));
  const edges = [];
  for (const p of polys) for (const ring of p) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xa, ya] = ring[j], [xb, yb] = ring[i];
      if (ya !== yb) edges.push(ya < yb ? [ya, yb, xa, (xb - xa) / (yb - ya)] : [yb, ya, xb, (xa - xb) / (ya - yb)]);
    }
  }
  edges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let active = [], k = 0;
  for (let r = r1; r >= r0; r--) {            // y croissant
    const cy = y0 - (r + 0.5) * res;
    while (k < edges.length && edges[k][0] <= cy) active.push(edges[k++]);
    active = active.filter(e => e[1] > cy);
    const xs = active.map(e => e[2] + (cy - e[0]) * e[3]).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] - x0) / res - 0.5));
      const c1 = Math.min(ncols - 1, Math.floor((xs[i + 1] - x0) / res - 0.5));
      for (let c = c0; c <= c1; c++) out.push(r * ncols + c);
    }
  }
  return out;
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyContains(poly, x, y) {
  if (!ringContains(poly[0], x, y)) return false;
  for (let h = 1; h < poly.length; h++) if (ringContains(poly[h], x, y)) return false;
  return true;
}

export function polysBBox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function makeContains(polys) {
  const boxes = polys.map(p => polysBBox([p]));
  return (x, y) => {
    for (let i = 0; i < polys.length; i++) {
      const b = boxes[i];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (polyContains(polys[i], x, y)) return true;
    }
    return false;
  };
}

// ── Séries « INFO-MRC » ────────────────────────────────────────────────────

/** Série précalculée (exacte) d'une unité MRC. */
export function unitSeries(core, unitId) {
  const s = core.unitStats[unitId];
  const feat = core.units.features.find(f => f.properties.id === unitId);
  if (!s) return null;
  return finalizeSeries({
    y0: s.y0, h: s.h, f: s.f, sup: s.sup,
    fuelHa: core.unitFuel[unitId] || 0,
    long: !!(feat && feat.properties.lr),
    areaHa: feat ? feat.properties.ha : null,
  });
}

let regimeMask = null;      // cellules 1 km situées dans une zone de régime de feux

/** Série calculée à la volée pour une zone libre (polygones Lambert). */
export async function zoneSeries(core, polys) {
  const [pts, gf, gb] = await Promise.all([loadPoints(), loadGridFuel(), loadGridBurn()]);
  if (!regimeMask) {
    regimeMask = new Uint8Array(gf.ncols * gf.nrows);
    for (const i of cellsInPolys(geomToLccPolys(core.regime, 100), gf)) regimeMask[i] = 1;
  }
  const inZone = makeContains(polys);
  const [bx0, by0, bx1, by1] = polysBBox(polys);

  // 1. Cellules 1 km dont le centre est dans la zone
  const { res } = gf;
  const cells = cellsInPolys(polys, gf);
  let fuelPx = 0, nRegime = 0;
  for (const idx of cells) { fuelPx += gf.fuel[idx]; nRegime += regimeMask[idx]; }
  const nCells = cells.length;
  if (!nCells) return null;

  // 2. Superficies brûlées (recherche binaire dans la liste triée par cellule)
  const supByYear = new Map();
  let yMin = Infinity;
  const C = gb.cells;
  for (const idx of cells) {
    let lo = 0, hi = C.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (C[m] < idx) lo = m + 1; else hi = m; }
    for (let k = lo; k < C.length && C[k] === idx; k++) {
      const yr = gb.year0 + gb.years[k];
      supByYear.set(yr, (supByYear.get(yr) || 0) + gb.ha10[k] / 10);
      if (yr < yMin) yMin = yr;
    }
  }

  // 3. Points d'origine dans la zone
  const t = toLcc();
  const occ = new Map();
  for (let i = 0; i < pts.n; i++) {
    const [px, py] = t.forward([pts.x[i], pts.y[i]]);
    if (px < bx0 || px > bx1 || py < by0 || py > by1 || !inZone(px, py)) continue;
    const key = pts.an[i] * 2 + pts.c[i];
    occ.set(key, (occ.get(key) || 0) + 1);
  }

  // Séries longues : dès que la zone touche un régime de feux (choix : privilégier la série longue)
  const long = nRegime > 0;
  const ys = long && yMin < 1972 ? yMin : 1972;      // points d'origine dès 1972
  const n = YEAR_END - ys + 1;
  const h = new Array(n), f = new Array(n), sup = new Array(n);
  for (let i = 0; i < n; i++) {
    const yr = ys + i;
    h[i] = occ.get(yr * 2) || 0;
    f[i] = occ.get(yr * 2 + 1) || 0;
    sup[i] = supByYear.get(yr) || 0;
  }
  return finalizeSeries({
    y0: ys, h, f, sup, fuelHa: fuelPx * gf.px_ha, long,
    areaHa: nCells * (res * res) / 1e4, regimeFrac: nRegime / nCells,
  });
}

function meanSd(arr) {
  const v = arr.filter(x => x > 0);
  if (!v.length) return { mean: 0, sd: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, sd };
}

function finalizeSeries(s) {
  const n = s.sup.length;
  s.years = Array.from({ length: n }, (_, i) => s.y0 + i);
  s.tot = s.h.map((v, i) => v + s.f[i]);
  // Comme les fiches R : moyennes et écarts-types sur les années avec feux
  s.occStats = meanSd(s.tot.slice(Math.max(0, 1972 - s.y0)));
  s.supStats = meanSd(s.sup);
  s.totOcc = s.tot.reduce((a, b) => a + b, 0);
  s.totSup = s.sup.reduce((a, b) => a + b, 0);
  s.totH = s.h.reduce((a, b) => a + b, 0);
  s.totF = s.f.reduce((a, b) => a + b, 0);
  return s;
}

// ── Zones tampons des communautés ──────────────────────────────────────────

/** Superficie (ha) par classe dans un rayon de `km` autour du lieu habité d'index `i`. */
export async function bufferStats(i, km) {
  const R = await loadRings();
  const sum = (arr, nk) => {
    const out = new Float64Array(nk);
    const base = i * R.nr * nk;
    const nr = Math.min(km, R.nr);
    for (let r = 0; r < nr; r++) for (let k = 0; k < nk; k++) out[k] += arr[base + r * nk + k];
    return Array.from(out, v => v * R.px_ha);
  };
  return { comb: sum(R.comb, R.nc), pot: sum(R.pot, R.np) };
}

export { makeContains };
