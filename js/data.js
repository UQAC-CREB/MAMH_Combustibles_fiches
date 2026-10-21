// Chargement des données (JSON légers au démarrage, binaires à la demande)
import { DATA_VERSION } from './config.js';

const url = (f) => `data/${f}?v=${DATA_VERSION}`;
const once = (fn) => { let p = null; return () => (p ??= fn().catch(e => { p = null; throw e; })); };

async function getJSON(f) {
  const r = await fetch(url(f));
  if (!r.ok) throw new Error(`${f} : HTTP ${r.status}`);
  return r.json();
}

async function getBuffer(f) {
  const r = await fetch(url(f));
  if (!r.ok) throw new Error(`${f} : HTTP ${r.status}`);
  if (!f.endsWith('.gz')) return r.arrayBuffer();
  // Décompression gzip côté client (GitHub Pages ne compresse pas les binaires)
  const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Binaire : [Uint32 longueur][en-tête JSON][bourrage → multiple de 4][données]
function splitHeader(buf) {
  const len = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  const off = 4 + len + ((4 - ((4 + len) % 4)) % 4);
  return { meta, off };
}

// ── Données de base (démarrage) ────────────────────────────────────────────
export async function loadCore() {
  const [units, lh, unitStats, unitFuel, classes, indiceMeta, indice] = await Promise.all([
    getJSON('units.geojson'), getJSON('lh.json'), getJSON('unit_stats.json'),
    getJSON('unit_fuel.json'), getJSON('classes.json'),
    getJSON('indice_meta.json'), loadIndice(),
  ]);
  lh.forEach((r, i) => { r.idx = i; });
  return { units, lh, unitStats, unitFuel, classes, indiceMeta, indice };
}

// ── Indice de prédisposition standardisé (grille 5 km, Float32, NaN = sans donnée)
async function loadIndice() {
  const buf = await getBuffer('indice.bin.gz');
  const { meta, off } = splitHeader(buf);
  return { ...meta, v: new Float32Array(buf, off, meta.ncols * meta.nrows) };
}

// ── Points d'origine (colonnes) ────────────────────────────────────────────
// ── Contour provincial simplifié (carte de localisation du rapport) ────────
export const loadProvince = once(() => getJSON('province.geojson'));

export const loadPoints = once(async () => {
  const p = await getJSON('pts_origine.json');
  return {
    n: p.n, x: Float64Array.from(p.x), y: Float64Array.from(p.y),
    an: Int16Array.from(p.an), c: Uint8Array.from(p.c), j: Uint16Array.from(p.j), ha: Float32Array.from(p.ha),
  };
});

// ── Anneaux combustibles / potentiel par lieu habité ──────────────────────
export const loadRings = once(async () => {
  const buf = await getBuffer('rings.bin.gz');
  const { meta, off } = splitHeader(buf);
  const nC = meta.nlh * meta.nr * meta.nc;
  const nP = meta.nlh * meta.nr * meta.np;
  return {
    ...meta,
    comb: new Uint32Array(buf, off, nC),
    pot: new Uint32Array(buf, off + nC * 4, nP),
  };
});

// ── Grille 1 km : pixels combustibles ─────────────────────────────────────
export const loadGridFuel = once(async () => {
  const buf = await getBuffer('grid_fuel.bin.gz');
  const { meta, off } = splitHeader(buf);
  return { ...meta, fuel: new Uint16Array(buf, off, meta.ncols * meta.nrows) };
});

// ── Grille 1 km : superficies brûlées (triées par cellule) ────────────────
export const loadGridBurn = once(async () => {
  const buf = await getBuffer('grid_burn.bin.gz');
  const { meta, off } = splitHeader(buf);
  const n = meta.n;
  const cells = new Uint32Array(buf, off, n);
  const years = new Uint8Array(buf, off + 4 * n, n);
  const offHa = off + 4 * n + n + ((2 - (n % 2)) % 2);
  const ha10 = new Uint16Array(buf, offHa, n);
  return { ...meta, cells, years, ha10 };
});
