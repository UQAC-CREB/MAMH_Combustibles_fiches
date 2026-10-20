// Lecture de la classe d'un pixel raster (combustibles, potentiel) sous le curseur.
// Les tuiles PMTiles sont des PNG à palette dont l'index de chaque pixel = code de classe
// (255 = transparent) : on décode le PNG pour lire l'index (les couleurs ne sont pas uniques).

const TILE = 256, MAX_Z = 12, CACHE_MAX = 48;

/** PNG à palette → Uint8Array des index (w × h). */
async function decodePalettePNG(buf) {
  const dv = new DataView(buf);
  let off = 8, w = 0, h = 0, bit = 8;
  const idat = [];
  while (off < buf.byteLength) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...new Uint8Array(buf, off + 4, 4));
    if (type === 'IHDR') { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); bit = dv.getUint8(off + 16); }
    else if (type === 'IDAT') idat.push(new Uint8Array(buf, off + 8, len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = Math.ceil((w * bit) / 8);
  const out = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.slice(p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {          // filtres PNG (1 octet par pixel ou moins)
      const a = i > 0 ? line[i - 1] : 0, b = prev[i], c = i > 0 ? prev[i - 1] : 0;
      if (f === 1) line[i] = (line[i] + a) & 255;
      else if (f === 2) line[i] = (line[i] + b) & 255;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    if (bit === 8) out.set(line, y * w);
    else {
      const per = 8 / bit, mask = (1 << bit) - 1;
      for (let x = 0; x < w; x++) out[y * w + x] = (line[Math.floor(x / per)] >> ((per - 1 - (x % per)) * bit)) & mask;
    }
    prev = line;
  }
  return out;
}

export class RasterPicker {
  constructor(url) {
    this.pm = new pmtiles.PMTiles(url);
    this.cache = new Map();      // clé z/x/y → Promise<Uint8Array|null>
  }

  _tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.pm.getZxy(z, x, y)
        .then(r => (r && r.data ? decodePalettePNG(r.data) : null))
        .catch(() => null);
      this.cache.set(key, p);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return p;
  }

  /** Code de classe au point [lon, lat] (null si transparent / hors données). */
  async valueAt(lon, lat, mapZoom) {
    const z = Math.max(5, Math.min(MAX_Z, Math.ceil(mapZoom)));
    const n = 2 ** z;
    const fx = ((lon + 180) / 360) * n;
    const s = Math.sin((lat * Math.PI) / 180);
    const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const idx = await this._tile(z, tx, ty);
    if (!idx) return null;
    const px = Math.min(TILE - 1, Math.floor((fx - tx) * TILE)), py = Math.min(TILE - 1, Math.floor((fy - ty) * TILE));
    const v = idx[py * TILE + px];
    return v === 255 ? null : v;
  }
}
