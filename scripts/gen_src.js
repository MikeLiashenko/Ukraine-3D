// ============================================================================ Kharkiv city generator
// Turns one compact vector tile (OSM footprints, roads, areas, trees) into the same mesh arrays the prebuilt Saltivka
// chunks carry (walls with procedural windows, glazing, roofs / balconies / details, ground surfaces, street furniture,
// tree and car instances, a ground-type mask). Port of citygen.py / groundgen.py, plus pitched roofs for houses.
// Runs as a module worker (postMessage {op, buf}) or imported on the main thread.

const FACADE = 0, ROOF = 1, SOLID = 2, GLASS = 3, METAL = 4, WINDOW = 6;
const NOPARAM = [3.0, -1.0, -10.0, 3.0, 0, 0, 0, 0];
const PI = Math.PI, TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------- hashing / random
function hstr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
const h01 = (...a) => hstr(a.join('|')) / 4294967296;
function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const f = () => {
    s = (s + 0x6D2B79F5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.uniform = (a, b) => a + (b - a) * f();
  f.randrange = (n) => Math.floor(f() * n);
  f.randint = (a, b) => a + Math.floor(f() * (b - a + 1));
  f.gauss = (m, sd) => { let u = 0, v = 0; while (u === 0) u = f(); v = f(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
  return f;
}
function wpick(lst, r) {
  let tot = 0; for (const [, w] of lst) tot += w; r *= tot;
  for (const [c, w] of lst) { if (r < w) return c; r -= w; }
  return lst[lst.length - 1][0];
}
const darker = (c, f) => [Math.max(0, Math.min(1, c[0] * f)), Math.max(0, Math.min(1, c[1] * f)), Math.max(0, Math.min(1, c[2] * f))];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------------------- polygons
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function area(p) { let s = 0; for (let i = 0, n = p.length; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
function inside(pt, poly) {
  const x = pt[0], y = pt[1]; let c = false;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
function mainAxis(poly) {
  let best = [1, 0], L = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], l = dist(a, b);
    if (l > L) { L = l; best = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
  }
  const ax = best, ay = [-ax[1], ax[0]];
  let u0 = 1e18, u1 = -1e18, v0 = 1e18, v1 = -1e18;
  for (const p of poly) {
    const u = p[0] * ax[0] + p[1] * ax[1], v = p[0] * ay[0] + p[1] * ay[1];
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  return { ax, ay, u0, u1, v0, v1 };
}
// minimum-area bounding rectangle over the polygon's edge directions
function obb(poly) {
  let best = null;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], l = dist(a, b);
    if (l < 0.3) continue;
    const ax = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], ay = [-ax[1], ax[0]];
    let u0 = 1e18, u1 = -1e18, v0 = 1e18, v1 = -1e18;
    for (const p of poly) {
      const u = p[0] * ax[0] + p[1] * ax[1], v = p[0] * ay[0] + p[1] * ay[1];
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.ar) best = { ar, ax, ay, u0, u1, v0, v1 };
  }
  return best;
}
// triangles [[a, b, c], ...] of a polygon with holes (earcut)
function triangulate(outer, holes = []) {
  const data = [], hi = [];
  for (const p of outer) data.push(p[0], p[1]);
  for (const h of holes) { if (h.length < 3) continue; hi.push(data.length / 2); for (const p of h) data.push(p[0], p[1]); }
  const pts = []; for (let i = 0; i < data.length; i += 2) pts.push([data[i], data[i + 1]]);
  const t = earcut(data, hi.length ? hi : null, 2), out = [];
  for (let i = 0; i < t.length; i += 3) out.push([pts[t[i]], pts[t[i + 1]], pts[t[i + 2]]]);
  return out;
}
function offsetPolyline(pts, off) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = dist(a, b) || 1, d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    out.push([pts[i][0] - d[1] * off, pts[i][1] + d[0] * off]);
  }
  return out;
}
function* walk(pts, step) {
  let sTot = 0, nxt = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = dist(a, b);
    if (L < 1e-6) continue;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    while (nxt <= sTot + L) { const t = nxt - sTot; yield [[a[0] + d[0] * t, a[1] + d[1] * t], d, nxt]; nxt += step; }
    sTot += L;
  }
}
class Hash {
  constructor(cell = 8) { this.c = cell; this.d = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(p, v = null) { const k = this.key(Math.floor(p[0] / this.c), Math.floor(p[1] / this.c)); let l = this.d.get(k); if (!l) this.d.set(k, l = []); l.push([p, v]); }
  any(p, r) {
    const cx = Math.floor(p[0] / this.c), cy = Math.floor(p[1] / this.c), k = Math.floor(r / this.c) + 1;
    for (let i = cx - k; i <= cx + k; i++) for (let j = cy - k; j <= cy + k; j++) {
      const l = this.d.get(this.key(i, j)); if (!l) continue;
      for (const [q] of l) if (dist(p, q) <= r) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------- mesh sinks
const u8 = (x) => Math.round(clamp(x, 0, 1) * 255);
class Sink {
  constructor(bid0 = 0) {
    this.bid0 = bid0; this.cur = -1;
    this.w = { pos: [], uv: [], col: [], p1: [], p2: [], bid: [], ck: [], idx: [] };
    this.r = { pos: [], col: [], bid: [], ck: [], idx: { 1: [], 2: [], 3: [], 4: [] } };
    this.g = { pos: [], uv: [], col: [], wp: [], bid: [], idx: [] };
  }
  gb() { return this.cur >= 0 ? this.cur + this.bid0 : -1; }
  face(pts, mat, col, uv = null, param = NOPARAM, ck = 0) {
    const n = pts.length, gb = this.gb(), c0 = u8(col[0]), c1 = u8(col[1]), c2 = u8(col[2]);
    if (mat === FACADE) {
      const W = this.w, base = W.bid.length;
      for (let k = 0; k < n; k++) {
        const p = pts[k]; W.pos.push(p[0], p[1], p[2]);
        const t = uv ? uv[k] : [0, 0]; W.uv.push(t[0], t[1]); W.col.push(c0, c1, c2);
        W.p1.push(param[0], param[1], param[2], param[3]); W.p2.push(param[4], param[5], gb * 1.37, param[7]);
        W.bid.push(gb); W.ck.push(ck);
      }
      for (let t = 1; t < n - 1; t++) W.idx.push(base, base + t, base + t + 1);
    } else if (mat === WINDOW) {
      const G = this.g, base = G.bid.length;
      for (let k = 0; k < n; k++) {
        const p = pts[k]; G.pos.push(p[0], p[1], p[2]);
        const t = uv ? uv[k] : [0, 0]; G.uv.push(t[0], t[1]); G.col.push(c0, c1, c2);
        G.wp.push(param[0], param[1], param[2], param[3]); G.bid.push(gb);
      }
      for (let t = 1; t < n - 1; t++) G.idx.push(base, base + t, base + t + 1);
    } else {
      const R = this.r, base = R.bid.length, I = R.idx[mat] || R.idx[SOLID];
      for (let k = 0; k < n; k++) { const p = pts[k]; R.pos.push(p[0], p[1], p[2]); R.col.push(c0, c1, c2); R.bid.push(gb); R.ck.push(ck); }
      for (let t = 1; t < n - 1; t++) I.push(base, base + t, base + t + 1);
    }
  }
  box(c, ax, ay, sx, sy, z0, z1, mat, col, top = true, bottom = false, ck = 0) {
    const cs = [];
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cs.push([c[0] + ax[0] * sx * u + ay[0] * sy * v, c[1] + ax[1] * sx * u + ay[1] * sy * v]);
    for (let i = 0; i < 4; i++) {
      const a = cs[i], b = cs[(i + 1) % 4];
      this.face([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], mat, col, null, NOPARAM, ck);
    }
    if (top) this.face(cs.map((p) => [p[0], p[1], z1]), mat, col, null, NOPARAM, ck);
    if (bottom) this.face(cs.slice().reverse().map((p) => [p[0], p[1], z0]), mat, col, null, NOPARAM, ck);
  }
}
// ground surfaces: flat faces bucketed by height (painter's order), each with a base colour and pattern id
const GROUNDFX = 7;
const PAT_ASPHALT = 0, PAT_PAVING = 1, PAT_TURF = 2, PAT_RUBBER = 3, PAT_DIRT = 4, PAT_PAINT = 5, PAT_COURT = 6, PAT_BALLAST = 7;
class Ground {
  constructor() { this.z = new Map(); }
  poly(pts, z, pat, col) {
    let b = this.z.get(z); if (!b) this.z.set(z, b = { pos: [], col: [], pat: [], n: 0, idx: [] });
    const base = b.n, c0 = u8(col[0]), c1 = u8(col[1]), c2 = u8(col[2]);
    for (const p of pts) { b.pos.push(p[0], p[1], z); b.col.push(c0, c1, c2); b.pat.push(pat); b.n++; }
    for (let t = 1; t < pts.length - 1; t++) b.idx.push(base, base + t, base + t + 1);
  }
  quad(a, b, c, d, z, pat, col) { this.poly([a, b, c, d], z, pat, col); }
  fill(outer, holes, z, pat, col) {
    for (let [a, b, c] of triangulate(outer, holes)) { if (area([a, b, c]) < 0) [a, c] = [c, a]; this.poly([a, b, c], z, pat, col); }
  }
  disc(c, r, z, pat, col, n = 12) {
    const pts = []; for (let k = 0; k < n; k++) pts.push([c[0] + r * Math.cos(TAU * k / n), c[1] + r * Math.sin(TAU * k / n)]);
    for (let k = 0; k < n; k++) this.poly([c, pts[k], pts[(k + 1) % n]], z, pat, col);
  }
  ribbon(pts, w, z, pat, col, joints = true) {
    const h = w / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], L = dist(a, b); if (L < 1e-3) continue;
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1] * h, d[0] * h];
      this.quad([a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]], z, pat, col);
    }
    if (joints) for (const p of pts) this.disc(p, h, z, pat, col, w > 6 ? 10 : 8);
  }
  rect(c, ax, ay, hu, hv, z, pat, col) {
    const q = (u, v) => [c[0] + ax[0] * u + ay[0] * v, c[1] + ax[1] * u + ay[1] * v];
    this.quad(q(-hu, -hv), q(hu, -hv), q(hu, hv), q(-hu, hv), z, pat, col);
  }
  line(a, b, w, z, col = [0.92, 0.92, 0.90]) {
    const L = dist(a, b); if (L < 1e-3) return;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1] * w / 2, d[0] * w / 2];
    this.quad([a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] + n[0], a[1] + n[1]], z, PAT_PAINT, col);
  }
  arc(c, r, a0, a1, w, z, col = [0.92, 0.92, 0.90], n = 24) {
    const pts = []; for (let k = 0; k <= n; k++) pts.push([c[0] + r * Math.cos(a0 + (a1 - a0) * k / n), c[1] + r * Math.sin(a0 + (a1 - a0) * k / n)]);
    for (let k = 0; k < n; k++) this.line(pts[k], pts[k + 1], w, z, col);
  }
}

// ---------------------------------------------------------------------------- colours
const SALT_PALETTE = [[[0.67, 0.67, 0.65], 34], [[0.73, 0.72, 0.69], 18], [[0.74, 0.69, 0.61], 16], [[0.80, 0.73, 0.62], 12],
  [[0.78, 0.61, 0.57], 10], [[0.82, 0.78, 0.62], 5], [[0.70, 0.74, 0.76], 5]];
const MID_PALETTE = [[[0.76, 0.75, 0.71], 22], [[0.60, 0.35, 0.27], 13], [[0.85, 0.74, 0.52], 16], [[0.66, 0.66, 0.64], 18],
  [[0.78, 0.71, 0.60], 14], [[0.80, 0.62, 0.56], 8], [[0.70, 0.74, 0.76], 6], [[0.88, 0.85, 0.76], 8]];
const HOUSE_PALETTE = [[[0.86, 0.85, 0.80], 24], [[0.86, 0.80, 0.66], 18], [[0.88, 0.82, 0.58], 9], [[0.78, 0.70, 0.58], 14],
  [[0.62, 0.34, 0.26], 12], [[0.80, 0.79, 0.75], 10], [[0.70, 0.78, 0.72], 5], [[0.82, 0.68, 0.62], 6], [[0.72, 0.76, 0.82], 3]];
const INDUSTRIAL_PALETTE = [[[0.66, 0.66, 0.64], 30], [[0.74, 0.73, 0.70], 20], [[0.62, 0.70, 0.76], 10], [[0.76, 0.72, 0.64], 14], [[0.58, 0.40, 0.32], 8]];
const HOUSE_ROOFS = [[[0.46, 0.24, 0.18], 20, METAL], [[0.56, 0.29, 0.21], 15, SOLID], [[0.22, 0.33, 0.25], 12, METAL], [[0.55, 0.56, 0.55], 24, SOLID],
  [[0.30, 0.30, 0.31], 15, METAL], [[0.26, 0.36, 0.50], 5, METAL], [[0.62, 0.62, 0.60], 9, METAL]];
const BALCONY_COLS = [[[0.42, 0.29, 0.19], 18], [[0.84, 0.84, 0.82], 22], [null, 50], [[0.55, 0.64, 0.72], 3], [[0.56, 0.66, 0.50], 3],
  [[0.80, 0.72, 0.45], 2], [[0.62, 0.36, 0.28], 2]];
const CAR_COLS = [[[0.85, 0.85, 0.84], 24], [[0.62, 0.63, 0.64], 20], [[0.08, 0.08, 0.09], 18], [[0.33, 0.34, 0.36], 12], [[0.45, 0.07, 0.07], 7],
  [[0.10, 0.18, 0.40], 7], [[0.20, 0.28, 0.20], 4], [[0.70, 0.62, 0.45], 4], [[0.85, 0.75, 0.20], 2], [[0.55, 0.22, 0.10], 2]];
const FRAME_COLS = [[[0.88, 0.88, 0.86], 70], [[0.74, 0.72, 0.66], 14], [[0.33, 0.23, 0.16], 10], [[0.55, 0.38, 0.24], 6]];
const NAMED = { white: [0.92, 0.92, 0.90], black: [0.15, 0.15, 0.15], grey: [0.6, 0.6, 0.6], gray: [0.6, 0.6, 0.6], silver: [0.75, 0.75, 0.75],
  red: [0.62, 0.30, 0.25], maroon: [0.45, 0.20, 0.18], brown: [0.48, 0.32, 0.22], orange: [0.85, 0.55, 0.30], yellow: [0.88, 0.80, 0.50],
  beige: [0.82, 0.76, 0.62], tan: [0.80, 0.70, 0.55], green: [0.45, 0.60, 0.45], darkgreen: [0.22, 0.33, 0.25], olive: [0.50, 0.50, 0.30],
  blue: [0.45, 0.55, 0.70], lightblue: [0.65, 0.75, 0.85], navy: [0.20, 0.25, 0.40], pink: [0.85, 0.65, 0.65], purple: [0.55, 0.40, 0.55], cream: [0.90, 0.86, 0.72] };
function parseColour(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  if (/^#[0-9a-f]{3}$/.test(s)) return [1, 2, 3].map((i) => parseInt(s[i] + s[i], 16) / 255);
  return NAMED[s.replace(/[\s_-]/g, '')] || null;
}
const HOUSE_KINDS = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'cabin', 'farm', 'hut', 'residential']);
const INDUSTRIAL_KINDS = new Set(['industrial', 'warehouse', 'manufacture', 'factory', 'hangar', 'storage_tank', 'transformer_tower', 'service', 'barn', 'farm_auxiliary']);
function buildingStyle(b, ovr) {
  const o = ovr && ovr.get(String(b.id));
  if (o) return [o.facade, o.end || darker(o.facade, 0.93), 'user'];
  const kind = b.kind, id = b.id;
  const tag = parseColour(b.colour);
  if (tag) return [tag, darker(tag, 0.93), 'OSM building:colour'];
  if (SPECIAL.has(kind)) { const c = kind === 'tv_tower' ? [0.72, 0.20, 0.16] : [0.70, 0.69, 0.66]; return [c, c, 'type default']; }
  if (kind === 'garage' || kind === 'garages') return [[0.58, 0.56, 0.53], [0.55, 0.53, 0.50], 'type default'];
  if (kind === 'school' || kind === 'kindergarten') { const c = h01(id, 'k') < 0.5 ? [0.84, 0.78, 0.62] : [0.86, 0.84, 0.80]; return [c, c, 'type default']; }
  if (kind === 'church' || kind === 'cathedral' || kind === 'chapel') { const c = h01(id, 'ch') < 0.6 ? [0.92, 0.91, 0.88] : [0.90, 0.82, 0.55]; return [c, c, 'type default']; }
  if (INDUSTRIAL_KINDS.has(kind)) { const c = wpick(INDUSTRIAL_PALETTE, h01(id, 'ind')); return [c, darker(c, 0.94), 'type default']; }
  if (['retail', 'yes', 'service', 'commercial', 'kiosk', 'supermarket'].includes(kind) && b.levels < 4 && !b.house) {
    const c = wpick([[[0.80, 0.78, 0.74], 4], [[0.72, 0.70, 0.66], 3], [[0.86, 0.80, 0.68], 2], [[0.70, 0.50, 0.42], 1]], h01(id, 'r'));
    return [c, c, 'type default'];
  }
  if (b.house) { const c = wpick(HOUSE_PALETTE, h01(id, 'hs')); return [c, darker(c, 0.95), 'estimated (city palette)']; }
  if (b.levels >= 9) {
    const fac = wpick(SALT_PALETTE, h01(id, 'fac'));
    const end = fac[0] === 0.78 && fac[1] === 0.61 ? [0.70, 0.46, 0.43] : darker(fac, 0.92);
    return [fac, end, 'estimated (panel palette)'];
  }
  const fac = wpick(MID_PALETTE, h01(id, 'mid'));
  return [fac, darker(fac, 0.93), 'estimated (city palette)'];
}
// pitched roof for houses: from roof:shape, else hipped / gabled for small near-rectangular house footprints
function roofShape(b) {
  const rs = (b.rs || '').toLowerCase();
  if ((rs === 'dome' || rs === 'onion' || rs === 'round' && b.outer.length > 8) && !b.holes.length) return { shape: rs === 'onion' ? 'onion' : 'dome' };
  if (b.holes.length || b.outer.length > 16) return null;
  let shape = null;
  if (['gabled', 'half-hipped', 'saltbox', 'gambrel', 'mansard', 'skillion', 'round'].includes(rs)) shape = 'gabled';
  else if (rs === 'hipped' || rs === 'side_hipped') shape = 'hipped';
  else if (rs === 'pyramidal' || rs === 'cone') shape = 'pyramidal';
  else if (rs === 'flat') return null;
  else if (b.house && b.levels <= 3) shape = h01(b.id, 'rf') < 0.55 ? 'hipped' : 'gabled';
  if (!shape) return null;
  const o = obb(b.outer);
  if (!o || b.area / o.ar < 0.72 || Math.min(o.u1 - o.u0, o.v1 - o.v0) > 22) return null;
  return { shape, o };
}
function emitPitched(m, b, R, h, fac, rc, rmat) {
  let { ax, ay, u0, u1, v0, v1 } = R.o;
  if (v1 - v0 > u1 - u0) { [ax, ay] = [ay, [-ax[0], -ax[1]]]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }   // u = long side
  const W = v1 - v0, t = Math.tan((R.shape === 'pyramidal' ? 34 : 30 + 8 * h01(b.id, 'pt')) * PI / 180);
  const ov = 0.35, zr = h + Math.min(W / 2 * t, 4.5), tt = (zr - h) / (W / 2);
  const ze = h - ov * tt, vc = (v0 + v1) / 2;
  const P = (u, v, z) => [ax[0] * u + ay[0] * v, ax[1] * u + ay[1] * v, z];
  const U0 = u0 - ov, U1 = u1 + ov, V0 = v0 - ov, V1 = v1 + ov;
  if (R.shape === 'gabled') {
    m.face([P(U0, V0, ze), P(U1, V0, ze), P(U1, vc, zr), P(U0, vc, zr)], rmat, rc);
    m.face([P(U1, V1, ze), P(U0, V1, ze), P(U0, vc, zr), P(U1, vc, zr)], rmat, rc);
    // gable ends in the wall colour, flush with the end walls
    m.face([P(u0, v1, h), P(u0, v0, h), P(u0, vc, zr)], SOLID, fac, null, NOPARAM, 1);
    m.face([P(u1, v0, h), P(u1, v1, h), P(u1, vc, zr)], SOLID, fac, null, NOPARAM, 1);
  } else {
    const hw = Math.min((u1 - u0) / 2, W / 2) * (R.shape === 'pyramidal' ? 1e9 : 1);
    const a = Math.min((U0 + U1) / 2, U0 + hw + ov), c = Math.max((U0 + U1) / 2, U1 - hw - ov);
    m.face([P(U0, V0, ze), P(U1, V0, ze), P(c, vc, zr), P(a, vc, zr)], rmat, rc);
    m.face([P(U1, V1, ze), P(U0, V1, ze), P(a, vc, zr), P(c, vc, zr)], rmat, rc);
    m.face([P(U1, V0, ze), P(U1, V1, ze), P(c, vc, zr)], rmat, rc);
    m.face([P(U0, V1, ze), P(U0, V0, ze), P(a, vc, zr)], rmat, rc);
  }
  // a chimney on most houses
  if (h01(b.id, 'chim') < 0.7) {
    const cu = u0 + (u1 - u0) * (0.25 + 0.5 * h01(b.id, 'cu')), cv = vc + (v1 - v0) * 0.18;
    const zc = zr + 0.6;
    m.box([P(cu, cv, 0)[0], P(cu, cv, 0)[1]], ax, ay, 0.25, 0.25, h, zc, SOLID, h01(b.id, 'cc') < 0.5 ? [0.55, 0.32, 0.25] : [0.62, 0.62, 0.60]);
  }
  return zr;
}

// dome or onion over the footprint; returns the top height
function emitDome(m, b, h, col, mat) {
  const o = b.outer, n = o.length;
  let cx = 0, cy = 0; for (const p of o) { cx += p[0]; cy += p[1]; } cx /= n; cy /= n;
  const r = Math.sqrt(b.area / PI), onion = b.pitched.shape === 'onion';
  const H = b.rh > 0.5 ? b.rh : r * (onion ? 1.6 : 0.95);
  const prof = onion ? [[1.0, 0], [1.12, 0.18], [1.08, 0.38], [0.82, 0.58], [0.45, 0.76], [0.16, 0.9], [0.04, 1.0]]
    : [[1.0, 0], [0.97, 0.25], [0.87, 0.5], [0.7, 0.71], [0.48, 0.87], [0.24, 0.97], [0.0, 1.0]];
  const ringAt = (s, z) => o.map((p) => [cx + (p[0] - cx) * s, cy + (p[1] - cy) * s, z]);
  let prev = ringAt(prof[0][0], h);
  for (let k = 1; k < prof.length; k++) {
    const cur = ringAt(prof[k][0], h + prof[k][1] * H);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.face([prev[i], prev[j], cur[j], cur[i]], mat, col); }
    prev = cur;
  }
  if (onion || r < 6) {                                  // a small cross / spire on top
    m.box([cx, cy], [1, 0], [0, 1], 0.08, 0.08, h + H, h + H + Math.max(1.2, r * 0.5), METAL, [0.80, 0.66, 0.30]);
    m.box([cx, cy], [1, 0], [0, 1], Math.max(0.35, r * 0.18), 0.06, h + H + Math.max(0.8, r * 0.33), h + H + Math.max(0.95, r * 0.38), METAL, [0.80, 0.66, 0.30]);
  }
  return h + H;
}
// cylinder / cone frustum around a centre (outward faces, optional lid)
function frustum(m, c, r0, r1, z0, z1, n, mat, col, lid = true) {
  const P = (r, a, z) => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, z];
  for (let i = 0; i < n; i++) { const a0 = i / n * TAU, a1 = (i + 1) / n * TAU; m.face([P(r0, a0, z0), P(r0, a1, z0), P(r1, a1, z1), P(r1, a0, z1)], mat, col); }
  if (lid && r1 > 0.01) { const top = []; for (let i = 0; i < n; i++) top.push(P(r1, i / n * TAU, z1)); m.face(top, mat, col); }
}
const SPECIAL = new Set(['metro_bridge', 'bridge_pier', 'chimney', 'cooling_tower', 'tv_tower', 'tower', 'water_tower']);
const RED = [0.70, 0.19, 0.15], WHITE2 = [0.90, 0.90, 0.88];
// towers, chimneys, the metro bridge gallery and its piers
function genSpecial(m, b, bi) {
  m.cur = bi;
  const o = b.outer, n = o.length, h = b.h, zb = b.zb || 0, fac = b.style[0];
  let cx = 0, cy = 0; for (const p of o) { cx += p[0]; cy += p[1]; } cx /= n; cy /= n;
  const c = [cx, cy], r = Math.max(1.0, Math.sqrt(b.area / PI));
  if (b.kind === 'metro_bridge') {
    const deck = zb, top = h;
    for (let i = 0; i < n; i++) {
      const p0 = o[i], p1 = o[(i + 1) % n], L = dist(p0, p1); if (L < 0.05) continue;
      const long = i === 0 || i === 2;
      m.face([[p0[0], p0[1], deck], [p1[0], p1[1], deck], [p1[0], p1[1], top], [p0[0], p0[1], top]], SOLID, fac, null, NOPARAM, 1);
      if (long) {                                        // the gallery's continuous window band
        const d = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], nr = [d[1] * 0.06, -d[0] * 0.06];
        m.face([[p0[0] + nr[0], p0[1] + nr[1], deck + 2.4], [p1[0] + nr[0], p1[1] + nr[1], deck + 2.4], [p1[0] + nr[0], p1[1] + nr[1], deck + 4.3], [p0[0] + nr[0], p0[1] + nr[1], deck + 4.3]], GLASS, [0.16, 0.22, 0.26]);
        m.face([[p0[0] + nr[0], p0[1] + nr[1], deck - 0.9], [p1[0] + nr[0], p1[1] + nr[1], deck - 0.9], [p1[0] + nr[0], p1[1] + nr[1], deck + 0.3], [p0[0] + nr[0], p0[1] + nr[1], deck + 0.3]], SOLID, [0.55, 0.54, 0.51]);
      }
    }
    const tri = triangulate(o, []);
    for (let [a, bb, cc] of tri) { if (area([a, bb, cc]) < 0) [a, cc] = [cc, a]; m.face([[a[0], a[1], top], [bb[0], bb[1], top], [cc[0], cc[1], top]], ROOF, b.roofc); m.face([[cc[0], cc[1], deck - 0.9], [bb[0], bb[1], deck - 0.9], [a[0], a[1], deck - 0.9]], SOLID, [0.50, 0.49, 0.47]); }
  } else if (b.kind === 'bridge_pier') {
    for (let i = 0; i < n; i++) { const p0 = o[i], p1 = o[(i + 1) % n]; m.face([[p0[0], p0[1], -0.5], [p1[0], p1[1], -0.5], [p1[0], p1[1], h], [p0[0], p0[1], h]], SOLID, fac); }
  } else if (b.kind === 'chimney') {
    const bands = h > 100 ? 8 : 1;
    for (let k = 0; k < bands; k++) {
      const z0 = h * k / bands, z1 = h * (k + 1) / bands, ra = r * (1 - 0.45 * z0 / h), rb = r * (1 - 0.45 * z1 / h);
      frustum(m, c, ra, rb, z0, z1, 18, SOLID, bands > 1 && k >= bands - 3 ? (k % 2 ? WHITE2 : RED) : fac, false);
    }
    frustum(m, c, r * 0.55, r * 0.5, h, h + 0.3, 18, SOLID, [0.2, 0.2, 0.2]);
  } else if (b.kind === 'cooling_tower') {
    const prof = [[1.0, 0], [0.86, 0.2], [0.74, 0.45], [0.66, 0.7], [0.68, 0.85], [0.73, 1.0]];
    for (let k = 1; k < prof.length; k++) frustum(m, c, r * prof[k - 1][0], r * prof[k][0], h * prof[k - 1][1], h * prof[k][1], 32, SOLID, fac, false);
    frustum(m, c, r * 0.72, r * 0.72, h - 3, h - 2.9, 32, SOLID, [0.12, 0.12, 0.12]);
  } else if (b.kind === 'water_tower') {
    frustum(m, c, r * 0.45, r * 0.4, 0, h * 0.68, 14, SOLID, fac, false);
    frustum(m, c, r * 0.95, r, h * 0.68, h, 18, SOLID, darker(fac, 0.95));
    frustum(m, c, r, 0, h, h + r * 0.35, 18, METAL, [0.35, 0.36, 0.36], false);
  } else if (b.kind === 'tv_tower') {
    // steel lattice: four legs converging, horizontal frames, red / white bands, antenna mast
    const a = Math.max(3, r * 0.75), hl = h * 0.82, w = 0.5;
    const corner = (k, z) => { const s = a * (1 - 0.9 * z / hl), ang = PI / 4 + k * PI / 2; return [cx + Math.cos(ang) * s * Math.SQRT2, cy + Math.sin(ang) * s * Math.SQRT2]; };
    const NB = 9;
    for (let s = 0; s < NB; s++) {
      const z0 = hl * s / NB, z1 = hl * (s + 1) / NB, colr = s % 2 ? WHITE2 : RED;
      for (let k = 0; k < 4; k++) {
        const p0 = corner(k, z0), p1 = corner(k, z1);
        for (const [du, dv] of [[w, 0], [0, w], [-w, 0], [0, -w]]) {
          const e = [du, dv], f = [-dv, du];
          m.face([[p0[0] + e[0], p0[1] + e[1], z0], [p0[0] + f[0], p0[1] + f[1], z0], [p1[0] + f[0], p1[1] + f[1], z1], [p1[0] + e[0], p1[1] + e[1], z1]], METAL, colr);
        }
        const q0 = corner(k, z1), q1 = corner((k + 1) % 4, z1), q2 = corner(k, z0), q3 = corner((k + 1) % 4, z0);
        const bar = (A, Bp, za, zc) => {
          const L = dist(A, Bp) || 1, d = [(Bp[0] - A[0]) / L, (Bp[1] - A[1]) / L], nn = [d[1] * 0.18, -d[0] * 0.18];
          m.face([[A[0] + nn[0], A[1] + nn[1], za], [Bp[0] + nn[0], Bp[1] + nn[1], zc], [Bp[0] + nn[0], Bp[1] + nn[1], zc + 0.35], [A[0] + nn[0], A[1] + nn[1], za + 0.35]], METAL, colr);
          m.face([[Bp[0] - nn[0], Bp[1] - nn[1], zc], [A[0] - nn[0], A[1] - nn[1], za], [A[0] - nn[0], A[1] - nn[1], za + 0.35], [Bp[0] - nn[0], Bp[1] - nn[1], zc + 0.35]], METAL, colr);
        };
        bar(q0, q1, z1, z1); bar(q2, q1, z0, z1); bar(q3, q0, z0, z1);
      }
    }
    m.box(c, [1, 0], [0, 1], 0.9, 0.9, hl, h, METAL, [0.82, 0.82, 0.80]);
    m.box(c, [1, 0], [0, 1], 2.2, 2.2, hl - 1.0, hl + 0.6, METAL, [0.55, 0.55, 0.54]);
  } else {
    frustum(m, c, r, r * 0.8, 0, h, 10, SOLID, fac);
  }
  m.cur = -1;
}

// ---------------------------------------------------------------------------- buildings
function windowRects(L, margin, pitch, cells, lv, fh, wtop, cps, stairSide, wtype) { return []; }  // geometry windows are Blender-only

function genBuilding(m, b, bi) {
  if (SPECIAL.has(b.kind)) { genSpecial(m, b, bi); return; }
  const outer = b.outer, holes = b.holes, lv = b.levels, fh = b.fh, kind = b.kind, zb = b.zb || 0;
  const dome = b.pitched && (b.pitched.shape === 'dome' || b.pitched.shape === 'onion');
  const h = dome && b.rh > 0.5 ? Math.max(zb + 1.0, b.h - b.rh) : b.h;     // height tag counts the dome
  const resid = kind === 'apartments' || kind === 'dormitory' || (lv >= 4 && kind !== 'school' && kind !== 'kindergarten');
  const garage = ['garage', 'garages', 'roof', 'shed', 'carport'].includes(kind);
  const [fac, endc] = b.style;
  m.cur = bi;
  const roofc = b.roofc;
  const pitched = b.pitched;
  const base = zb > 0.05 ? zb : -1.0;
  const parapet = pitched || zb > 0.05 ? 0 : (lv >= 3 ? 0.6 : 0.25);
  const top = h + parapet;
  const pitch = resid ? 3.0 : (b.house ? 3.6 : 4.2);
  const wtype = garage ? 0 : (resid ? 1 : 2);
  const winTop = garage ? -10 : (zb > 0.05 ? h - 0.6 : 1.0 + lv * fh - 0.15);
  const { ax, ay, u0, u1, v0, v1 } = mainAxis(outer);
  const longLen = u1 - u0;
  const entrSign = ((ay[1] >= 0) !== (h01(b.id, 'entr') < 0.3)) ? 1 : -1;
  const secLen = lv >= 9 ? 25.0 : 22.0;
  const nSec = Math.max(1, Math.round(longLen / secLen));
  const rnd = rng(hstr(b.id + '|seed'));
  const balcOk = resid && lv >= 4 && zb < 0.05;
  const rings = [outer, ...holes];
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri], n = ring.length;
    for (let i = 0; i < n; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % n], L = dist(p0, p1);
      if (L < 0.05) continue;
      const d = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L];
      let nrm = [d[1], -d[0]];
      if (ri > 0) nrm = [-nrm[0], -nrm[1]];
      const cells = Math.floor(L / pitch), margin = (L - cells * pitch) / 2;
      const isLong = L > 11.5, alongMain = Math.abs(d[0] * ax[0] + d[1] * ax[1]) > 0.8;
      const blank = resid && !isLong && longLen > 25;
      const span = wtype && cells > 0 && !blank ? cells * pitch : -1;
      const entrSide = resid && zb < 0.05 && isLong && alongMain && (nrm[0] * ay[0] + nrm[1] * ay[1]) * entrSign > 0;
      let cps = 0;
      if (resid && isLong && cells >= 5) { const k = Math.max(1, Math.round(L / secLen)); cps = Math.max(5, Math.round(cells / k)); }
      const col = blank ? endc : fac;
      const param = [fh, span, winTop, pitch, cps, entrSide ? 1 : 0, 0, wtype];
      m.face([[p0[0], p0[1], base], [p1[0], p1[1], base], [p1[0], p1[1], top], [p0[0], p0[1], top]], FACADE, col,
        [[-margin, base], [L - margin, base], [L - margin, top], [-margin, top]], param, blank ? 2 : 1);
      if (lv >= 2 && !pitched) {
        const q0 = [p0[0] - nrm[0] * 0.25, p0[1] - nrm[1] * 0.25], q1 = [p1[0] - nrm[0] * 0.25, p1[1] - nrm[1] * 0.25];
        m.face([[q1[0], q1[1], h], [q0[0], q0[1], h], [q0[0], q0[1], top], [q1[0], q1[1], top]], SOLID, darker(fac, 0.85), null, NOPARAM, 3);
        m.face([[p0[0], p0[1], top], [p1[0], p1[1], top], [q1[0], q1[1], top], [q0[0], q0[1], top]], SOLID, [0.55, 0.55, 0.54]);
      }
      if (!cps) continue;
      for (let c = 0; c < cells; c++) {
        const m_ = c % cps, uc = margin + (c + 0.5) * pitch;
        const cx = p0[0] + d[0] * uc, cy = p0[1] + d[1] * uc;
        if (entrSide && m_ === Math.floor(cps / 2)) {
          const ox = cx + nrm[0] * 0.8, oy = cy + nrm[1] * 0.8;
          m.box([ox, oy], d, nrm, 1.4, 0.8, 2.45, 2.62, SOLID, [0.60, 0.60, 0.58], true, true);
          const dx = cx + nrm[0] * 0.04, dy = cy + nrm[1] * 0.04;
          m.face([[dx - d[0] * 0.75, dy - d[1] * 0.75, base + 1.0], [dx + d[0] * 0.75, dy + d[1] * 0.75, base + 1.0],
            [dx + d[0] * 0.75, dy + d[1] * 0.75, 2.3], [dx - d[0] * 0.75, dy - d[1] * 0.75, 2.3]], METAL, [0.20, 0.17, 0.14]);
          continue;
        }
        if (!balcOk) continue;
        if (!(m_ === 1 || m_ === cps - 2 || (m_ === 3 && cps >= 8 && !entrSide))) continue;
        const Q = (u, v) => [cx + d[0] * u + nrm[0] * v, cy + d[1] * u + nrm[1] * v];
        const wallq = (pa, pb, za, zb, mat, colr, ck = 0) => m.face([[pa[0], pa[1], za], [pb[0], pb[1], za], [pb[0], pb[1], zb], [pa[0], pa[1], zb]], mat, colr, null, NOPARAM, ck);
        for (let f = 1; f < Math.floor(lv); f++) {
          const z0 = 1.0 + f * fh - 0.05;
          const rr = rng(hstr(`${b.id}|${i}|${c}|${f}|${ri}`));
          const bc0 = wpick(BALCONY_COLS, rr()), bc = bc0 || darker(fac, 0.97);
          const w2 = pitch / 2 - 0.06, depth = 1.05;
          const W2 = w2 + 0.04, Dd = depth + 0.02, sc_ = [0.58, 0.58, 0.56];
          const za = z0 - 0.02, zb = z0 + 0.14;
          const qa = Q(-W2, 0), qb = Q(W2, 0), qc = Q(W2, Dd), qd = Q(-W2, Dd);
          m.face([[qd[0], qd[1], zb], [qc[0], qc[1], zb], [qb[0], qb[1], zb], [qa[0], qa[1], zb]], SOLID, sc_);
          m.face([[qa[0], qa[1], za], [qb[0], qb[1], za], [qc[0], qc[1], za], [qd[0], qd[1], za]], SOLID, darker(sc_, 0.8));
          wallq(qd, qc, za, zb, SOLID, sc_); wallq(qa, qd, za, zb, SOLID, sc_); wallq(qc, qb, za, zb, SOLID, sc_);
          const pz0 = z0 + 0.14, pz1 = z0 + 1.08, t = 0.06, ckp = bc0 ? 0 : 4;
          wallq(Q(-w2, depth), Q(w2, depth), pz0, pz1, SOLID, bc, ckp);
          wallq(Q(w2, depth - t), Q(-w2, depth - t), pz0, pz1, SOLID, darker(bc, 0.9), ckp);
          wallq(Q(-w2, 0), Q(-w2, depth), pz0, pz1, SOLID, bc, ckp);
          wallq(Q(w2, depth), Q(w2, 0), pz0, pz1, SOLID, bc, ckp);
          wallq(Q(-w2 + t, depth - t), Q(-w2 + t, 0), pz0, pz1, SOLID, darker(bc, 0.9), ckp);
          wallq(Q(w2 - t, 0), Q(w2 - t, depth - t), pz0, pz1, SOLID, darker(bc, 0.9), ckp);
          { const a = Q(-w2, 0), b_ = Q(-w2, depth), c_ = Q(w2, depth), d_ = Q(w2, 0);
            m.face([[a[0], a[1], pz1], [b_[0], b_[1], pz1], [c_[0], c_[1], pz1], [d_[0], d_[1], pz1]], SOLID, darker(bc, 1.05), null, NOPARAM, ckp); }
          if ((c + i) % 2 === 0) {
            for (const sgn of [-1, 1]) {
              const u_ = sgn * (w2 + 0.02);
              wallq(Q(u_, 0), Q(u_, depth), pz1, z0 + fh - 0.02, SOLID, darker(fac, 0.95), 4);
              wallq(Q(u_, depth), Q(u_, 0), pz1, z0 + fh - 0.02, SOLID, darker(fac, 0.95), 4);
            }
          }
          if (rr() < 0.62) {
            const z1 = z0 + 1.08, z2 = z0 + fh - 0.05, hh = z2 - z1;
            const kindW = rr() < 0.7 ? 2.0 : 3.0;
            const fcol = kindW === 2.0 ? [0.90, 0.90, 0.88] : wpick([[[0.36, 0.25, 0.17], 3], [[0.70, 0.68, 0.62], 2]], rr());
            const prm = (w) => [w, hh, rr(), kindW, 0, 0, 0, 0];
            const fx0 = [cx + nrm[0] * (depth - 0.04) - d[0] * w2, cy + nrm[1] * (depth - 0.04) - d[1] * w2];
            const fx1 = [cx + nrm[0] * (depth - 0.04) + d[0] * w2, cy + nrm[1] * (depth - 0.04) + d[1] * w2];
            const W = 2 * w2;
            m.face([[fx0[0], fx0[1], z1], [fx1[0], fx1[1], z1], [fx1[0], fx1[1], z2], [fx0[0], fx0[1], z2]], WINDOW, fcol, [[0, 0], [W, 0], [W, hh], [0, hh]], prm(W));
            for (const [sgn, a0] of [[-1, fx0], [1, fx1]]) {
              const back = [a0[0] - nrm[0] * (depth - 0.06), a0[1] - nrm[1] * (depth - 0.06)];
              const q = sgn < 0 ? [back, a0] : [a0, back], Dp = depth - 0.06;
              m.face([[q[0][0], q[0][1], z1], [q[1][0], q[1][1], z1], [q[1][0], q[1][1], z2], [q[0][0], q[0][1], z2]], WINDOW, fcol, [[0, 0], [Dp, 0], [Dp, hh], [0, hh]], prm(Dp));
            }
            if (f === Math.floor(lv) - 1) {
              const ox = cx + nrm[0] * depth / 2, oy = cy + nrm[1] * depth / 2;
              m.box([ox, oy], d, nrm, w2 + 0.04, depth / 2 + 0.02, z0 + fh - 0.05, z0 + fh + 0.05, METAL, [0.45, 0.45, 0.44]);
            }
          }
        }
      }
    }
  }
  if (dome) emitDome(m, b, h, b.roofPitch[0], b.roofPitch[1]);
  else if (pitched) emitPitched(m, b, pitched, h, fac, b.roofPitch[0], b.roofPitch[1]);
  else for (let [a, bb, c] of triangulate(outer, holes)) { if (area([a, bb, c]) < 0) [a, c] = [c, a]; m.face([[a[0], a[1], h], [bb[0], bb[1], h], [c[0], c[1], h]], ROOF, roofc); }
  if (zb > 0.05) for (let [a, bb, c] of triangulate(outer, holes)) { if (area([a, bb, c]) > 0) [a, c] = [c, a]; m.face([[a[0], a[1], zb], [bb[0], bb[1], zb], [c[0], c[1], zb]], SOLID, darker(fac, 0.7)); }   // underside of a raised part
  if (resid && lv >= 5 && zb < 0.05) {
    for (let s = 0; s < nSec; s++) {
      const uc = u0 + (s + 0.5) * (u1 - u0) / nSec, vc = (v0 + v1) / 2;
      const pt = [ax[0] * uc + ay[0] * vc, ax[1] * uc + ay[1] * vc];
      if (!inside(pt, outer)) continue;
      const hb = lv >= 9 ? 2.6 : 1.4;
      m.box(pt, ax, ay, 2.2, 3.0, h, h + hb, SOLID, darker(fac, 0.82));
      m.box(pt, ax, ay, 2.35, 3.15, h + hb, h + hb + 0.12, METAL, [0.40, 0.40, 0.39]);
      const vp = [pt[0] + ax[0] * 4.2, pt[1] + ax[1] * 4.2];
      if (inside(vp, outer)) m.box(vp, ax, ay, 0.6, 0.6, h, h + 1.1, SOLID, [0.50, 0.48, 0.46]);
    }
  }
  if (resid && lv >= 5 && zb < 0.05 && rnd() < 0.7) {
    const k = rnd.randint(1, 3);
    for (let j = 0; j < k; j++) {
      const uc = rnd.uniform(u0 + 3, u1 - 3), vc = rnd.uniform(v0 + 2, v1 - 2);
      const pt = [ax[0] * uc + ay[0] * vc, ax[1] * uc + ay[1] * vc];
      if (inside(pt, outer)) {
        m.box(pt, ax, ay, 0.04, 0.04, h, h + 3.5, METAL, [0.35, 0.35, 0.35]);
        m.box(pt, ax, ay, 0.8, 0.03, h + 3.0, h + 3.06, METAL, [0.35, 0.35, 0.35]);
      }
    }
  }
  m.cur = -1;
}
// per-building derived data shared by the full model and the overview prism
function prepareBuilding(b, ovr) {
  const k = b.kind;
  b.house = HOUSE_KINDS.has(k) && b.levels <= 3 || ((k === 'yes') && b.levels <= 2 && b.area < 260 && b.area > 30);
  b.style = buildingStyle(b, ovr);
  const rt = parseColour(b.rcol);
  const v = 0.03 * (h01(b.id, 'rv') - 0.5);
  b.roofc = rt ? rt : [0.2375 + v, 0.233 + v, 0.227 + v];
  b.pitched = SPECIAL.has(k) ? null : roofShape(b);
  if (b.pitched && (b.pitched.shape === 'dome' || b.pitched.shape === 'onion')) {
    const dc = wpick([[[0.80, 0.64, 0.28], 5], [[0.22, 0.40, 0.30], 3], [[0.62, 0.64, 0.66], 3], [[0.20, 0.30, 0.52], 1]], h01(b.id, 'dome'));
    b.roofPitch = [rt || dc, METAL];
  } else if (b.pitched) {
    const rp = HOUSE_ROOFS.map(([c, w, m]) => [[c, m], w]);
    const [c, m] = wpick(rp, h01(b.id, 'roofc'));
    b.roofPitch = [rt || c, m];
  }
  return b;
}

// ---------------------------------------------------------------------------- cars
const CAR_SPECS = [
  { L: 4.12, W: 1.62 }, { L: 4.00, W: 1.68 }, { L: 4.55, W: 1.78 }, { L: 4.45, W: 1.84 }, { L: 4.70, W: 1.88 }];
function obbPts(c, ang, L, W) {
  const ca = Math.cos(ang), sa = Math.sin(ang), hx = L / 2, hy = W / 2;
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => [c[0] + ca * u - sa * v, c[1] + sa * u + ca * v]);
}
function sat(a, b) {
  for (const poly of [a, b]) for (let i = 0; i < 4; i++) {
    const p = poly[i], q = poly[(i + 1) % 4], n = [q[1] - p[1], p[0] - q[0]];
    let amin = 1e18, amax = -1e18, bmin = 1e18, bmax = -1e18;
    for (const [x, y] of a) { const t = n[0] * x + n[1] * y; if (t < amin) amin = t; if (t > amax) amax = t; }
    for (const [x, y] of b) { const t = n[0] * x + n[1] * y; if (t < bmin) bmin = t; if (t > bmax) bmax = t; }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}
function genCars(S, seed) {
  const rnd = rng(seed), cell = 10;
  const key = (x, y) => Math.floor(x / cell) * 100003 + Math.floor(y / cell);
  const grid = new Map(), bgrid = new Map(), tgrid = new Map();
  const reg = (poly) => {
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    for (const p of poly) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
      const k = i * 100003 + j; let l = bgrid.get(k); if (!l) bgrid.set(k, l = []); l.push(poly);
    }
  };
  for (const b of S.buildings) reg(b.outer);
  for (const o of S.obstacles) reg(o);
  for (const p of [...S.pitches, ...S.playgrounds, ...S.water]) reg(p.outer);
  for (const t of S.treesLocal) { const k = key(t[0], t[1]); let l = tgrid.get(k); if (!l) tgrid.set(k, l = []); l.push(t); }
  const [x0, y0, x1, y1] = S.ground;
  const cars = [], pockets = [];
  const free = (c, ang, v, pad, trees) => {
    if (!(x0 + 5 < c[0] && c[0] < x1 - 5 && y0 + 5 < c[1] && c[1] < y1 - 5)) return false;
    const sp = CAR_SPECS[v], box = obbPts(c, ang, sp.L + 2 * pad, sp.W + 2 * pad);
    const kx = Math.floor(c[0] / cell), ky = Math.floor(c[1] / cell);
    for (let i = kx - 1; i <= kx + 1; i++) for (let j = ky - 1; j <= ky + 1; j++) {
      for (const [oc, oang, ov] of grid.get(i * 100003 + j) || []) {
        if (dist(c, oc) < 7 && sat(box, obbPts(oc, oang, CAR_SPECS[ov].L, CAR_SPECS[ov].W))) return false;
      }
    }
    for (const poly of bgrid.get(kx * 100003 + ky) || []) {
      if (inside(c, poly)) return false;
      for (const p of box) if (inside(p, poly)) return false;
    }
    if (trees) {
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      for (let i = kx - 1; i <= kx + 1; i++) for (let j = ky - 1; j <= ky + 1; j++) {
        for (const tp of tgrid.get(i * 100003 + j) || []) {
          const dx = tp[0] - c[0], dy = tp[1] - c[1], u = ca * dx - sa * dy, w = sa * dx + ca * dy;
          if (Math.abs(u) < sp.L / 2 + 0.5 && Math.abs(w) < sp.W / 2 + 0.5) return false;
        }
      }
    }
    return true;
  };
  const pickVariant = () => wpick([[0, 18], [1, 26], [2, 30], [3, 18], [4, 8]], rnd());
  const add = (c, ang, v, pad = 0.35, trees = true) => {
    if (!free(c, ang, v, pad, trees)) return false;
    const k = key(c[0], c[1]); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push([c, ang, v]);
    cars.push([c[0], c[1], ang, wpick(CAR_COLS, rnd()), v]);
    return true;
  };
  for (const rd of S.roads) {
    const kind = rd.kind, pts = rd.pts, w = rd.width;
    if (['footway', 'path', 'steps', 'track', 'cycleway', 'pedestrian'].includes(kind) || rd.tunnel || rd.bridge) continue;
    const moving = ['primary', 'secondary', 'tertiary', 'primary_link'].includes(kind);
    let lanes = parseInt(rd.lanes, 10);
    if (!(lanes > 0)) lanes = rd.oneway ? Math.max(1, Math.round(w / 3.4)) : Math.max(2, 2 * Math.round(w / 6.8));
    const lw = w / lanes;
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s], b = pts[s + 1], L = dist(a, b);
      if (L < 1) continue;
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], nl = [-d[1], d[0]], ang = Math.atan2(d[1], d[0]);
      if (moving) {
        for (let k = 0; k < lanes; k++) {
          const off = -w / 2 + (k + 0.5) * lw, fwd = rd.oneway || off < 0;
          let t = rnd.uniform(0, 25);
          while (t < L - 2) {
            add([a[0] + d[0] * t + nl[0] * off, a[1] + d[1] * t + nl[1] * off], fwd ? ang : ang + PI, pickVariant(), 1.2, false);
            t += rnd.uniform(20, 75);
          }
        }
      } else if (['service', 'residential', 'unclassified', 'living_street'].includes(kind)) {
        const wide = w >= 6;
        for (const side of [-1, 1]) {
          let t = rnd.uniform(2, 6);
          while (t < L - 2.5) {
            if (rnd() < (wide ? 0.40 : 0.30)) {
              const v = pickVariant(), off = side * (wide ? w / 2 - 1.05 : w / 2 + 1.25);
              const c = [a[0] + d[0] * t + nl[0] * off, a[1] + d[1] * t + nl[1] * off];
              let hd = side < 0 ? ang : ang + PI;
              if (rnd() < 0.2) hd += PI;
              if (add(c, hd, v) && !wide) pockets.push([c, d, nl, CAR_SPECS[v].L / 2 + 0.5, 1.3]);
            }
            t += 5.6;
          }
        }
      }
    }
  }
  for (const pv of S.paved) {
    if (pv.sq) continue;                             // pedestrian squares: no parked cars
    const poly = pv.outer, { ax, ay, u0, u1, v0, v1 } = mainAxis(poly), ang = Math.atan2(ay[1], ay[0]);
    for (let u = u0 + 1.4; u < u1 - 1.2; u += 2.6) for (let v = v0 + 2.6; v < v1 - 2.4; v += 5.6) {
      const pt = [ax[0] * u + ay[0] * v, ax[1] * u + ay[1] * v];
      if (inside(pt, poly) && rnd() < 0.65) add(pt, ang + (rnd() < 0.5 ? 0 : PI), pickVariant(), 0.15);
    }
  }
  return [cars, pockets];
}

// ---------------------------------------------------------------------------- ground (groundgen port)
const ROAD_Z = { footway: 0.020, path: 0.018, steps: 0.022, track: 0.018, cycleway: 0.02, pedestrian: 0.026, service: 0.032, unclassified: 0.036,
  residential: 0.038, living_street: 0.036, tertiary: 0.044, secondary: 0.048, secondary_link: 0.046, primary: 0.052, primary_link: 0.050 };
const MAJOR = ['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary'];
const CARRIAGE = [...MAJOR, 'residential', 'unclassified', 'living_street', 'service'];
const roadLanes = (rd) => { let n = parseInt(rd.lanes, 10); if (!(n > 0)) n = rd.oneway ? Math.max(1, Math.round(rd.width / 3.4)) : Math.max(2, 2 * Math.round(rd.width / 6.8)); return Math.max(1, n); };

function genRoads(g, props, S, junc) {
  const [x0, y0, x1, y1] = S.ground;
  const inb = (p) => x0 - 30 < p[0] && p[0] < x1 + 30 && y0 - 30 < p[1] && p[1] < y1 + 30;
  const roads = [...S.roads].sort((a, b) => (ROAD_Z[a.kind] || 0.02) - (ROAD_Z[b.kind] || 0.02));
  for (const rd of roads) {
    const kind = rd.kind;
    if (rd.tunnel === 'yes' || rd.tunnel === 'building_passage' || rd.tunnel === 'tunnel') continue;
    const pts = rd.pts;
    if (!pts.some(inb)) continue;
    const z = (ROAD_Z[kind] || 0.02) + (rd.bridge ? 0.12 : 0), w = rd.width, r = h01(rd.id, 'tone');
    if (['footway', 'cycleway', 'pedestrian', 'steps'].includes(kind)) {
      if (rd.crossing) continue;
      const surf = rd.surface || 'asphalt';
      if (['paving_stones', 'sett', 'concrete', 'concrete:plates'].includes(surf)) g.ribbon(pts, w, z, PAT_PAVING, [0.60 + 0.05 * r, 0.58 + 0.05 * r, 0.55 + 0.05 * r]);
      else if (['ground', 'dirt', 'unpaved', 'grass', 'compacted', 'gravel', 'fine_gravel', 'earth', 'sand'].includes(surf)) g.ribbon(pts, w * 0.9, z, PAT_DIRT, [0.52, 0.46, 0.37]);
      else g.ribbon(pts, w, z, PAT_ASPHALT, [0.40 + 0.05 * r, 0.40 + 0.05 * r, 0.39 + 0.05 * r]);
      continue;
    }
    if (kind === 'path' || kind === 'track') { g.ribbon(pts, w * 0.8, z, PAT_DIRT, [0.50, 0.44, 0.35]); continue; }
    const unpaved = ['ground', 'dirt', 'unpaved', 'gravel', 'compacted', 'earth', 'sand', 'grass'].includes(rd.surface);
    const tone = ({ primary: 0.20, primary_link: 0.21, secondary: 0.22, tertiary: 0.24 }[kind] || 0.27) + 0.04 * r;
    if (unpaved) { g.ribbon(pts, w, z, PAT_DIRT, [0.50, 0.45, 0.37]); continue; }
    g.ribbon(pts, w, z, PAT_ASPHALT, [tone, tone, tone * 0.98]);
    if (!CARRIAGE.includes(kind) || rd.bridge) continue;
    if (MAJOR.includes(kind) || kind === 'residential') {
      const jr = (p) => junc.any(p, w / 2 + 9);
      for (const side of [-1, 1]) {
        const edge = offsetPolyline(pts, side * (w / 2 + 0.1));
        for (let e = 0; e + 1 < edge.length; e++) {
          const a = edge[e], b = edge[e + 1], L = dist(a, b);
          if (L < 0.5) continue;
          const n_ = Math.max(1, Math.floor(L / 4));
          for (let k = 0; k < n_; k++) {
            const p0 = [a[0] + (b[0] - a[0]) * k / n_, a[1] + (b[1] - a[1]) * k / n_];
            const p1 = [a[0] + (b[0] - a[0]) * (k + 1) / n_, a[1] + (b[1] - a[1]) * (k + 1) / n_];
            if (jr(p0) || jr(p1)) continue;
            const Ld = dist(p0, p1), d = [(p1[0] - p0[0]) / Ld, (p1[1] - p0[1]) / Ld], nn = [-d[1] * side, d[0] * side];
            const q0 = [p0[0] + nn[0] * 0.2, p0[1] + nn[1] * 0.2], q1 = [p1[0] + nn[0] * 0.2, p1[1] + nn[1] * 0.2];
            let f1 = [[p0[0], p0[1], z], [p1[0], p1[1], z], [p1[0], p1[1], 0.16], [p0[0], p0[1], 0.16]];
            let f2 = [[p0[0], p0[1], 0.16], [p1[0], p1[1], 0.16], [q1[0], q1[1], 0.16], [q0[0], q0[1], 0.16]];
            if (side < 0) { f1 = f1.reverse(); f2 = f2.reverse(); }
            props.face(f1, SOLID, [0.66, 0.66, 0.64]); props.face(f2, SOLID, [0.70, 0.70, 0.68]);
            if (MAJOR.includes(kind)) {
              const s0 = [q0[0] + nn[0] * 2.8, q0[1] + nn[1] * 2.8], s1 = [q1[0] + nn[0] * 2.8, q1[1] + nn[1] * 2.8];
              g.quad(q0, q1, s1, s0, 0.15, kind === 'primary' ? PAT_PAVING : PAT_ASPHALT, [0.52, 0.51, 0.49]);
            }
          }
        }
      }
    }
    if (MAJOR.includes(kind)) {
      const n = roadLanes(rd), lw = w / n;
      const ok = (p) => !junc.any(p, w / 2 + 7);
      for (let k = 1; k < n; k++) {
        const off = -w / 2 + k * lw, centre = !rd.oneway && k === Math.floor(n / 2) && n % 2 === 0;
        if (centre && n >= 4) {
          for (const dd of [-0.12, 0.12]) for (const [p, d] of walk(offsetPolyline(pts, off + dd), 1.5)) if (ok(p)) g.line(p, [p[0] + d[0] * 1.5, p[1] + d[1] * 1.5], 0.12, z + 0.012);
        } else {
          for (const [p, d] of walk(offsetPolyline(pts, off), 12.0)) if (ok(p)) g.line(p, [p[0] + d[0] * 3.0, p[1] + d[1] * 3.0], 0.12, z + 0.012);
        }
      }
      if (kind === 'primary') {
        for (const side of [-1, 1]) for (const [p, d] of walk(offsetPolyline(pts, side * (w / 2 - 0.35)), 1.5)) if (ok(p)) g.line(p, [p[0] + d[0] * 1.5, p[1] + d[1] * 1.5], 0.15, z + 0.012);
      }
    }
  }
  for (const rd of S.roads) {
    if (!rd.crossing) continue;
    const pts = rd.pts; if (pts.length < 2) continue;
    const a = pts[0], b = pts[pts.length - 1], L = dist(a, b);
    if (L < 3 || L > 40) continue;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1], d[0]];
    for (let s = 0.4; s < L - 0.4; s += 1.0) g.rect([a[0] + d[0] * s, a[1] + d[1] * s], d, n, 0.25, 2.0, 0.07, PAT_PAINT, [0.93, 0.93, 0.90]);
  }
}
function genParking(g, S) {
  for (const pv of S.paved) {
    if (pv.sq) { g.fill(pv.outer, pv.holes, 0.030, PAT_PAVING, [0.60, 0.58, 0.55]); continue; }   // pedestrian squares: stone paving, no bays
    g.fill(pv.outer, pv.holes, 0.030, PAT_ASPHALT, [0.29, 0.29, 0.285]);
    const poly = pv.outer, { ax, ay, u0, u1, v0, v1 } = mainAxis(poly);
    if ((u1 - u0) * (v1 - v0) > 40000) continue;
    for (let u = u0 + 0.1; u < u1; u += 2.6) for (let v = v0 + 0.2; v < v1 - 5.0; v += 5.6) {
      const pa = [ax[0] * u + ay[0] * v, ax[1] * u + ay[1] * v], pb = [ax[0] * u + ay[0] * (v + 4.8), ax[1] * u + ay[1] * (v + 4.8)];
      if (inside(pa, poly) && inside(pb, poly)) g.line(pa, pb, 0.10, 0.042, [0.86, 0.86, 0.84]);
    }
  }
}
function genTram(g, props, S) {
  const [x0, y0, x1, y1] = S.ground;
  for (const tr of S.tram) {
    const pts = tr.pts.filter((p) => x0 - 20 < p[0] && p[0] < x1 + 20 && y0 - 20 < p[1] && p[1] < y1 + 20);
    if (pts.length < 2) continue;
    g.ribbon(pts, tr.rail ? 3.6 : 2.9, 0.06, PAT_BALLAST, tr.rail ? [0.42, 0.39, 0.35] : [0.40, 0.38, 0.35]);
    for (const off of [-0.76, 0.76]) {
      const rail = offsetPolyline(pts, off);
      for (let i = 0; i + 1 < rail.length; i++) {
        const a = rail[i], b = rail[i + 1], L = dist(a, b); if (L < 1e-3) continue;
        const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1] * 0.04, d[0] * 0.04];
        props.face([[a[0] - n[0], a[1] - n[1], 0.16], [b[0] - n[0], b[1] - n[1], 0.16], [b[0] + n[0], b[1] + n[1], 0.16], [a[0] + n[0], a[1] + n[1], 0.16]], METAL, [0.62, 0.60, 0.58]);
        props.face([[a[0] - n[0], a[1] - n[1], 0.06], [b[0] - n[0], b[1] - n[1], 0.06], [b[0] - n[0], b[1] - n[1], 0.16], [a[0] - n[0], a[1] - n[1], 0.16]], METAL, [0.30, 0.22, 0.17]);
      }
    }
    if (tr.rail) {                                          // sleepers
      for (const [p, d] of walk(pts, 0.75)) {
        const n = [-d[1], d[0]];
        props.box(p, n, d, 1.25, 0.11, 0.06, 0.11, SOLID, [0.36, 0.32, 0.28], true);
      }
    }
  }
}
function post(m, p, r, z0, z1, col, mat = METAL, n = 6) {
  const pts = []; for (let k = 0; k < n; k++) pts.push([p[0] + r * Math.cos(TAU * k / n), p[1] + r * Math.sin(TAU * k / n)]);
  for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % n]; m.face([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], mat, col); }
  m.face(pts.map(([x, y]) => [x, y, z1]), mat, col);
}
function bar(m, a, b, r, col, mat = METAL) {
  let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const L = Math.hypot(d[0], d[1], d[2]) || 1e-6; d = d.map((x) => x / L);
  const up = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]; const lu = Math.hypot(...u); u = u.map((x) => x / lu * r);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const cs = [[u[0] + v[0], u[1] + v[1], u[2] + v[2]], [-u[0] + v[0], -u[1] + v[1], -u[2] + v[2]], [-u[0] - v[0], -u[1] - v[1], -u[2] - v[2]], [u[0] - v[0], u[1] - v[1], u[2] - v[2]]];
  for (let k = 0; k < 4; k++) {
    const c0 = cs[k], c1 = cs[(k + 1) % 4];
    m.face([[a[0] + c0[0], a[1] + c0[1], a[2] + c0[2]], [b[0] + c0[0], b[1] + c0[1], b[2] + c0[2]], [b[0] + c1[0], b[1] + c1[1], b[2] + c1[2]], [a[0] + c1[0], a[1] + c1[1], a[2] + c1[2]]], mat, col);
  }
}
const L2W = (c, ax, ay) => (u, v) => [c[0] + ax[0] * u + ay[0] * v, c[1] + ax[1] * u + ay[1] * v];
const P3 = (p, z) => [p[0], p[1], z];
const WHITE = [0.93, 0.93, 0.91];
function goal(m, q, u, halfW, h, depth, col = WHITE) {
  const s = u > 0 ? 1 : -1;
  for (const v of [-halfW, halfW]) {
    bar(m, P3(q(u, v), 0), P3(q(u, v), h), 0.06, col);
    bar(m, P3(q(u, v), h), P3(q(u + s * depth, v), h * 0.75), 0.03, [0.75, 0.75, 0.75]);
    bar(m, P3(q(u + s * depth, v), 0), P3(q(u + s * depth, v), h * 0.75), 0.03, [0.75, 0.75, 0.75]);
  }
  bar(m, P3(q(u, -halfW), h), P3(q(u, halfW), h), 0.06, col);
  bar(m, P3(q(u + s * depth, -halfW), h * 0.75), P3(q(u + s * depth, halfW), h * 0.75), 0.03, [0.75, 0.75, 0.75]);
}
function fence(m, poly, h, col = [0.16, 0.26, 0.20], step = 3.0, rail = true) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], L = dist(a, b), k = Math.max(1, Math.floor(L / step));
    for (let j = 0; j < k; j++) post(m, [a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k], 0.04, 0, h, col, METAL, 4);
    if (rail) for (const zz of [h, h * 0.5, 0.15]) bar(m, [a[0], a[1], zz], [b[0], b[1], zz], 0.025, col);
  }
}
function pitchFrame(pt) {
  const { ax, ay, u0, u1, v0, v1 } = mainAxis(pt.outer), uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  return [[ax[0] * uc + ay[0] * vc, ax[1] * uc + ay[1] * vc], ax, ay, (u1 - u0) / 2, (v1 - v0) / 2];
}
function genPitches(g, props, S) {
  for (const pt of S.pitches) {
    const sport = (pt.sport || '').split(';')[0], surf = pt.surface || '';
    const [c, ax, ay, hu, hv] = pitchFrame(pt), q = L2W(c, ax, ay), big = hu * hv * 4, z = 0.06;
    if (big > 30000) { g.fill(pt.outer, pt.holes, 0.04, PAT_TURF, [0.20, 0.38, 0.17]); continue; }   // stadium-sized: just turf
    if (!sport && big > 3000) { g.fill(pt.outer, pt.holes, 0.04, PAT_DIRT, [0.66, 0.58, 0.45]); continue; }
    if (sport === 'soccer' || (!sport && big > 250)) {
      if (!['ground', 'dirt', 'sand'].includes(surf)) g.fill(pt.outer, pt.holes, z, PAT_TURF, [0.16, 0.36, 0.15]);
      else g.fill(pt.outer, pt.holes, z, PAT_DIRT, [0.58, 0.50, 0.38]);
      const lw = 0.10, zl = z + 0.01, U = hu - 0.6, V = hv - 0.6;
      const cs = [q(-U, -V), q(U, -V), q(U, V), q(-U, V)];
      for (let i = 0; i < 4; i++) g.line(cs[i], cs[(i + 1) % 4], lw, zl);
      g.line(q(0, -V), q(0, V), lw, zl);
      g.arc(q(0, 0), Math.min(9.15, V * 0.28), 0, TAU, lw, zl);
      const pd = Math.min(16.5, U * 0.3), pw = Math.min(20.15, V * 0.6), gd = pd * 0.33, gw = pw * 0.45;
      for (const s of [-1, 1]) {
        for (const [dd, ww] of [[pd, pw], [gd, gw]]) {
          const a1 = q(s * U, -ww), a2 = q(s * (U - dd), -ww), a3 = q(s * (U - dd), ww), a4 = q(s * U, ww);
          g.line(a1, a2, lw, zl); g.line(a2, a3, lw, zl); g.line(a3, a4, lw, zl);
        }
        const small = U < 30;
        goal(props, q, s * U, small ? 1.5 : 3.66, small ? 2.0 : 2.44, small ? 1.0 : 1.8);
      }
      if (big < 12000) fence(props, pt.outer, big < 3000 ? 4.0 : 5.0);
    } else if (sport === 'basketball') {
      g.fill(pt.outer, pt.holes, z, PAT_COURT, [0.32, 0.40, 0.50]);
      const U = hu - 0.8, V = hv - 0.8, lw = 0.07, zl = z + 0.01;
      const cs = [q(-U, -V), q(U, -V), q(U, V), q(-U, V)];
      for (let i = 0; i < 4; i++) g.line(cs[i], cs[(i + 1) % 4], lw, zl);
      g.line(q(0, -V), q(0, V), lw, zl); g.arc(q(0, 0), 1.8, 0, TAU, lw, zl);
      for (const s of [-1, 1]) {
        const kx = Math.min(5.8, U * 0.4);
        g.rect(q(s * (U - kx / 2), 0), ax, ay, kx / 2, 2.45, z + 0.005, PAT_COURT, [0.55, 0.30, 0.24]);
        const ac = Math.atan2(-s * ax[1], -s * ax[0]);
        g.arc(q(s * (U - 1.2), 0), Math.min(6.75, V * 0.85), ac - PI / 2, ac + PI / 2, lw, zl);
        const bp = q(s * (U + 0.4), 0);
        post(props, bp, 0.08, 0, 3.4, [0.20, 0.30, 0.45], METAL, 6);
        bar(props, P3(bp, 3.3), P3(q(s * (U - 0.9), 0), 3.3), 0.05, [0.20, 0.30, 0.45]);
        props.box(q(s * (U - 0.95), 0), ax, ay, 0.03, 0.9, 2.9, 3.95, SOLID, [0.92, 0.92, 0.90]);
        const rc = q(s * (U - 1.2), 0);
        for (let k = 0; k < 8; k++) {
          const a0 = TAU * k / 8, a1 = TAU * (k + 1) / 8;
          bar(props, [rc[0] + 0.23 * Math.cos(a0), rc[1] + 0.23 * Math.sin(a0), 3.05], [rc[0] + 0.23 * Math.cos(a1), rc[1] + 0.23 * Math.sin(a1), 3.05], 0.012, [0.85, 0.35, 0.10]);
        }
      }
      fence(props, pt.outer, 3.0);
    } else if (sport === 'tennis') {
      g.fill(pt.outer, pt.holes, z, PAT_COURT, [0.55, 0.33, 0.26]);
      const U = Math.min(hu - 1.0, 11.9), V = Math.min(hv - 1.0, 5.5);
      g.rect(c, ax, ay, U, V, z + 0.004, PAT_COURT, [0.24, 0.44, 0.32]);
      const lw = 0.06, zl = z + 0.01, cs = [q(-U, -V), q(U, -V), q(U, V), q(-U, V)];
      for (let i = 0; i < 4; i++) g.line(cs[i], cs[(i + 1) % 4], lw, zl);
      for (const s of [-1, 1]) { g.line(q(-U, s * V * 0.75), q(U, s * V * 0.75), lw, zl); g.line(q(s * U * 0.54, -V * 0.75), q(s * U * 0.54, V * 0.75), lw, zl); }
      g.line(q(-U * 0.54, 0), q(U * 0.54, 0), lw, zl);
      for (const v of [-V - 0.5, V + 0.5]) post(props, q(0, v), 0.04, 0, 1.07, [0.15, 0.15, 0.15], METAL, 4);
      props.face([P3(q(0, -V - 0.5), 0), P3(q(0, V + 0.5), 0), P3(q(0, V + 0.5), 0.92), P3(q(0, -V - 0.5), 0.92)], SOLID, [0.06, 0.06, 0.06]);
      props.face([P3(q(0, V + 0.5), 0), P3(q(0, -V - 0.5), 0), P3(q(0, -V - 0.5), 0.92), P3(q(0, V + 0.5), 0.92)], SOLID, [0.06, 0.06, 0.06]);
      fence(props, pt.outer, 3.5);
    } else {
      g.fill(pt.outer, pt.holes, z, PAT_RUBBER, h01(pt.id, 'c') < 0.5 ? [0.50, 0.26, 0.22] : [0.26, 0.44, 0.30]);
      if (big < 1500) { const U = hu - 0.5; for (const s of [-1, 1]) goal(props, q, s * U, 1.0, 1.2, 0.7); }
      fence(props, pt.outer, 1.2, [0.35, 0.45, 0.30], 2.5);
    }
  }
}
const PLAY_COLS = [[0.85, 0.18, 0.12], [0.95, 0.75, 0.10], [0.12, 0.40, 0.75], [0.20, 0.62, 0.25], [0.90, 0.45, 0.10], [0.55, 0.20, 0.60]];
function swings(m, c, ax, ay, col, rr) {
  const q = L2W(c, ax, ay), H = 2.3;
  for (const u of [-1.6, 1.6]) { bar(m, P3(q(u, -0.9), 0), P3(q(u, 0), H), 0.04, col); bar(m, P3(q(u, 0.9), 0), P3(q(u, 0), H), 0.04, col); }
  bar(m, P3(q(-1.6, 0), H), P3(q(1.6, 0), H), 0.045, col);
  for (const u of [-0.75, 0.75]) {
    for (const du of [-0.22, 0.22]) bar(m, P3(q(u + du, 0), H), P3(q(u + du, 0), 0.45), 0.008, [0.55, 0.55, 0.55]);
    m.box(q(u, 0), ax, ay, 0.24, 0.12, 0.40, 0.45, SOLID, PLAY_COLS[rr.randrange(PLAY_COLS.length)]);
  }
}
function slide(m, c, ax, ay, col, rr) {
  const q = L2W(c, ax, ay);
  for (const [u, v] of [[-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]) bar(m, P3(q(u, v), 0), P3(q(u, v), 2.7), 0.05, col);
  m.box(q(0, 0), ax, ay, 0.75, 0.75, 1.15, 1.25, SOLID, [0.55, 0.38, 0.22]);
  const rc = PLAY_COLS[rr.randrange(PLAY_COLS.length)];
  const R0 = [[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]];
  for (let k = 0; k < 4; k++) m.face([P3(q(...R0[k]), 2.6), P3(q(...R0[(k + 1) % 4]), 2.6), P3(q(0, 0), 3.4)], SOLID, rc);
  for (const zz of [1.55, 1.95]) for (const [a, b] of [[[-0.7, -0.7], [0.7, -0.7]], [[0.7, 0.7], [-0.7, 0.7]], [[-0.7, 0.7], [-0.7, -0.7]]]) bar(m, P3(q(...a), zz), P3(q(...b), zz), 0.02, col);
  const sc = PLAY_COLS[rr.randrange(PLAY_COLS.length)];
  m.face([P3(q(0.75, -0.3), 1.25), P3(q(3.2, -0.3), 0.30), P3(q(3.2, 0.3), 0.30), P3(q(0.75, 0.3), 1.25)], SOLID, sc);
  m.face([P3(q(0.75, 0.3), 1.22), P3(q(3.2, 0.3), 0.27), P3(q(3.2, -0.3), 0.27), P3(q(0.75, -0.3), 1.22)], SOLID, sc);
  for (const v of [-0.32, 0.32]) m.face([P3(q(0.75, v), 1.25), P3(q(3.2, v), 0.30), P3(q(3.2, v), 0.45), P3(q(0.75, v), 1.45)], SOLID, sc);
  for (const v of [-0.3, 0.3]) bar(m, P3(q(-0.75, v), 1.2), P3(q(-1.6, v), 0), 0.03, col);
  for (let k = 1; k < 5; k++) { const t = k / 5; bar(m, P3(q(-0.75 - 0.85 * t, -0.3), 1.2 * (1 - t)), P3(q(-0.75 - 0.85 * t, 0.3), 1.2 * (1 - t)), 0.02, col); }
}
function sandbox(m, c, ax, ay, col, rr, g) {
  g.rect(c, ax, ay, 1.4, 1.4, 0.10, PAT_DIRT, [0.82, 0.74, 0.55]);
  const wood = [0.62, 0.42, 0.24], q = L2W(c, ax, ay);
  for (const [u, v, hu, hv] of [[0, -1.45, 1.55, 0.1], [0, 1.45, 1.55, 0.1], [-1.45, 0, 0.1, 1.35], [1.45, 0, 0.1, 1.35]]) m.box(q(u, v), ax, ay, hu, hv, 0, 0.32, SOLID, wood);
  post(m, q(0, 0), 0.05, 0, 2.0, col);
  const pc = PLAY_COLS[rr.randrange(PLAY_COLS.length)];
  const pts = []; for (let k = 0; k < 8; k++) pts.push(q(1.3 * Math.cos(TAU * k / 8), 1.3 * Math.sin(TAU * k / 8)));
  for (let k = 0; k < 8; k++) m.face([P3(pts[k], 1.85), P3(pts[(k + 1) % 8], 1.85), P3(q(0, 0), 2.3)], SOLID, pc);
}
function carousel(m, c, ax, ay, col, rr) {
  const n = 12, pc = PLAY_COLS[rr.randrange(PLAY_COLS.length)];
  const pts = []; for (let k = 0; k < n; k++) pts.push([c[0] + Math.cos(TAU * k / n), c[1] + Math.sin(TAU * k / n)]);
  for (let k = 0; k < n; k++) {
    m.face([P3(c, 0.32), P3(pts[k], 0.32), P3(pts[(k + 1) % n], 0.32)], SOLID, pc);
    m.face([P3(pts[k], 0.22), P3(pts[(k + 1) % n], 0.22), P3(pts[(k + 1) % n], 0.32), P3(pts[k], 0.32)], SOLID, pc);
  }
  post(m, c, 0.05, 0.3, 0.95, col);
  for (let k = 0; k < 4; k++) {
    const a = PI / 2 * k, p = [c[0] + 0.8 * Math.cos(a), c[1] + 0.8 * Math.sin(a)];
    bar(m, P3(p, 0.32), P3(p, 0.9), 0.02, col); bar(m, P3(p, 0.9), P3(c, 0.95), 0.02, col);
  }
}
function climber(m, c, ax, ay, col, rr) {
  const q = L2W(c, ax, ay);
  for (let k = 0; k < 5; k++) {
    const u = -1.6 + 0.8 * k; let prev = null;
    for (let j = 0; j < 9; j++) { const a = PI * j / 8, p = P3(q(u, -Math.cos(a)), 1.6 * Math.sin(a)); if (prev) bar(m, prev, p, 0.025, col); prev = p; }
  }
  for (let j = 1; j < 8; j++) {
    const a = PI * j / 8;
    bar(m, P3(q(-1.6, -Math.cos(a)), 1.6 * Math.sin(a)), P3(q(1.6, -Math.cos(a)), 1.6 * Math.sin(a)), 0.02, PLAY_COLS[(j + rr.randrange(3)) % PLAY_COLS.length]);
  }
}
function bench(m, c, ax, ay) {
  const q = L2W(c, ax, ay), wood = [0.55, 0.36, 0.20];
  for (const u of [-0.75, 0.75]) m.box(q(u, 0), ax, ay, 0.05, 0.22, 0, 0.42, METAL, [0.15, 0.15, 0.15]);
  m.box(q(0, 0), ax, ay, 0.95, 0.22, 0.42, 0.47, SOLID, wood);
  m.box(q(0, -0.2), ax, ay, 0.95, 0.03, 0.55, 0.85, SOLID, wood);
}
function springRider(m, c, ax, ay, col, rr) {
  const pc = PLAY_COLS[rr.randrange(PLAY_COLS.length)];
  post(m, c, 0.05, 0, 0.45, [0.2, 0.2, 0.2]);
  m.box(c, ax, ay, 0.45, 0.14, 0.45, 0.85, SOLID, pc);
  m.box([c[0] + ax[0] * 0.38, c[1] + ax[1] * 0.38], ax, ay, 0.12, 0.12, 0.85, 1.05, SOLID, pc);
}
const ITEMS = { swings: [2.3, 1.4], slide: [2.6, 1.3], sandbox: [1.8, 1.8], carousel: [1.5, 1.5], climber: [2.0, 1.4], spring: [0.8, 0.6] };
function genPlaygrounds(g, props, S) {
  for (const pg of S.playgrounds) {
    const rr = rng(hstr(pg.id + '|pg')), poly = pg.outer;
    if (Math.abs(area(poly)) > 6000) { g.fill(poly, pg.holes, 0.05, PAT_DIRT, [0.70, 0.62, 0.48]); continue; }
    const rubber = rr() < 0.55;
    g.fill(poly, pg.holes, 0.05, rubber ? PAT_RUBBER : PAT_DIRT, rubber && rr() < 0.6 ? [0.52, 0.25, 0.20] : rubber ? [0.24, 0.45, 0.30] : [0.70, 0.62, 0.48]);
    const { ax, ay, u0, u1, v0, v1 } = mainAxis(poly);
    const placed = [];
    const frame = rr() < 0.5 ? [0.15, 0.35, 0.65] : [0.80, 0.15, 0.10];
    const order = ['slide', 'swings', 'sandbox', 'carousel', 'climber', 'swings', 'spring', 'spring', 'slide', 'sandbox', 'spring'];
    const nItems = Math.max(3, Math.min(order.length, Math.floor((u1 - u0) * (v1 - v0) / 70)));
    for (const name of order.slice(0, nItems)) {
      const [hu, hv] = ITEMS[name];
      for (let tr = 0; tr < 60; tr++) {
        if (u0 + hu + 1 > u1 - hu - 1 || v0 + hv + 1 > v1 - hv - 1) break;
        const u = rr.uniform(u0 + hu + 1, u1 - hu - 1), v = rr.uniform(v0 + hv + 1, v1 - hv - 1);
        const c = [ax[0] * u + ay[0] * v, ax[1] * u + ay[1] * v];
        let ok = inside(c, poly);
        for (const su of [-1, 1]) for (const sv of [-1, 1]) if (ok && !inside([ax[0] * (u + su * hu) + ay[0] * (v + sv * hv), ax[1] * (u + su * hu) + ay[1] * (v + sv * hv)], poly)) ok = false;
        if (!ok) continue;
        if (placed.some(([pu, pv, phu, phv]) => Math.abs(u - pu) < hu + phu + 1.2 && Math.abs(v - pv) < hv + phv + 1.2)) continue;
        placed.push([u, v, hu, hv]);
        const col = rr() < 0.5 ? PLAY_COLS[rr.randrange(PLAY_COLS.length)] : frame;
        if (name === 'swings') swings(props, c, ax, ay, col, rr);
        else if (name === 'slide') slide(props, c, ax, ay, col, rr);
        else if (name === 'sandbox') sandbox(props, c, ax, ay, col, rr, g);
        else if (name === 'carousel') carousel(props, c, ax, ay, col, rr);
        else if (name === 'climber') climber(props, c, ax, ay, col, rr);
        else springRider(props, c, ax, ay, col, rr);
        break;
      }
    }
    for (const side of [-1, 1]) {
      const v = side < 0 ? v0 + 0.8 : v1 - 0.8;
      for (let u = u0 + 3; u < u1 - 3; u += rr.uniform(7, 12)) {
        const c = [ax[0] * u + ay[0] * v, ax[1] * u + ay[1] * v];
        if (inside(c, poly) && !placed.some(([pu, pv, phu, phv]) => Math.abs(u - pu) < phu + 1.5 && Math.abs(v - pv) < phv + 1.5)) bench(props, c, ax, [ay[0] * -side, ay[1] * -side]);
      }
    }
    fence(props, poly, 0.6, [0.20, 0.45, 0.25], 2.0);
  }
}
function genLandcover(g, props, S) {
  for (const a of S.areas) {
    if (a.kind === 'hard') g.fill(a.outer, a.holes, 0.008, PAT_ASPHALT, [0.36, 0.36, 0.35]);
    else if (a.kind === 'island') g.fill(a.outer, a.holes, 0.06, PAT_PAVING, [0.55, 0.54, 0.52]);
  }
  for (const b of S.buildings) {
    const o = b.outer, n = o.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = o[i], c = o[(i + 1) % n], L = dist(a, c);
      if (L < 0.2) continue;
      const d = [(c[0] - a[0]) / L, (c[1] - a[1]) / L], nr = [d[1] * 0.9, -d[0] * 0.9];
      g.quad(a, c, [c[0] + nr[0], c[1] + nr[1]], [a[0] + nr[0], a[1] + nr[1]], 0.012, b.house || (b.kind === 'yes' && b.levels < 3) ? PAT_PAVING : PAT_ASPHALT, [0.56, 0.55, 0.53]);
      g.disc(c, 0.9, 0.011, PAT_ASPHALT, [0.56, 0.55, 0.53], 6);
    }
  }
  for (const f of S.fences) {
    const pts = f.pts, wall = f.kind === 'wall', col = wall ? [0.62, 0.60, 0.56] : [0.20, 0.30, 0.24];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], c = pts[i + 1], L = dist(a, c);
      if (wall) {
        const d = [(c[0] - a[0]) / Math.max(L, 1e-6), (c[1] - a[1]) / Math.max(L, 1e-6)];
        props.box([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], d, [-d[1], d[0]], L / 2, 0.12, 0, 2.0, SOLID, col);
        continue;
      }
      const k = Math.max(1, Math.floor(L / 2.5));
      for (let j = 0; j <= k; j++) post(props, [a[0] + (c[0] - a[0]) * j / k, a[1] + (c[1] - a[1]) * j / k], 0.03, 0, 1.6, col, METAL, 4);
      for (const zz of [1.55, 0.9, 0.2]) bar(props, [a[0], a[1], zz], [c[0], c[1], zz], 0.02, col);
    }
  }
}
function junctions(S) {
  const cnt = new Map();
  for (const rd of S.roads) {
    if (!CARRIAGE.includes(rd.kind)) continue;
    for (const p of rd.pts) {
      const k = `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
      let s = cnt.get(k); if (!s) cnt.set(k, s = { p, ids: new Set() }); s.ids.add(rd.id);
    }
  }
  const h = new Hash(12);
  for (const { p, ids } of cnt.values()) if (ids.size >= 2) h.add(p);
  return h;
}

// ---------------------------------------------------------------------------- ground-type mask (R bare ground, G hard surface, B lawn)
function raster(W, H, x0, y1, px) {
  const a = new Uint8Array(W * H);
  const toU = (x) => (x - x0) / px, toV = (y) => (y1 - y) / px;
  // even-odd scanline fill of a polygon with holes; value is max-combined
  a.fill_ = (rings, val) => {
    let vmin = 1e9, vmax = -1e9;
    const R = rings.map((r) => r.map((p) => [toU(p[0]), toV(p[1])]));
    for (const r of R) for (const p of r) { if (p[1] < vmin) vmin = p[1]; if (p[1] > vmax) vmax = p[1]; }
    const j0 = Math.max(0, Math.floor(vmin)), j1 = Math.min(H - 1, Math.ceil(vmax));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const yc = j + 0.5; xs.length = 0;
      for (const r of R) for (let i = 0, n = r.length; i < n; i++) {
        const p = r[i], q = r[(i + 1) % n];
        if ((p[1] > yc) !== (q[1] > yc)) xs.push(p[0] + (yc - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let i = i0; i <= i1; i++) if (a[j * W + i] < val) a[j * W + i] = val;
      }
    }
  };
  a.set_ = (rings, val) => {               // same scanline fill, overwriting (later polygons win)
    const R = rings.map((r) => r.map((p) => [toU(p[0]), toV(p[1])]));
    let vmin = 1e9, vmax = -1e9;
    for (const r of R) for (const p of r) { if (p[1] < vmin) vmin = p[1]; if (p[1] > vmax) vmax = p[1]; }
    const j0 = Math.max(0, Math.floor(vmin)), j1 = Math.min(H - 1, Math.ceil(vmax)), xs = [];
    for (let j = j0; j <= j1; j++) {
      const yc = j + 0.5; xs.length = 0;
      for (const r of R) for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; if ((p[1] > yc) !== (q[1] > yc)) xs.push(p[0] + (yc - p[1]) * (q[0] - p[0]) / (q[1] - p[1])); }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) { const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); for (let i = i0; i <= i1; i++) a[j * W + i] = val; }
    }
  };
  a.line_ = (pts, w, val) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1], L = dist(p, q); if (L < 1e-3) continue;
      const n = [-(q[1] - p[1]) / L * w / 2, (q[0] - p[0]) / L * w / 2];
      a.fill_([[[p[0] - n[0], p[1] - n[1]], [q[0] - n[0], q[1] - n[1]], [q[0] + n[0], q[1] + n[1]], [p[0] + n[0], p[1] + n[1]]]], val);
    }
  };
  return a;
}
function blur(a, W, H, passes = 2) {
  const t = new Uint8Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = j * W + i, l = i > 0 ? a[o - 1] : a[o], r = i < W - 1 ? a[o + 1] : a[o];
      t[o] = (l + 2 * a[o] + r + 2) >> 2;
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = j * W + i, u = j > 0 ? t[o - W] : t[o], d = j < H - 1 ? t[o + W] : t[o];
      a[o] = (u + 2 * t[o] + d + 2) >> 2;
    }
  }
}
function vnoise2(seed) {
  const hash = (i, j) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
function dilate(a, W, H, r) {                 // square max filter, radius r cells
  const t = new Uint8Array(a.length);
  for (let j = 0; j < H; j++) { const o = j * W; for (let i = 0; i < W; i++) { let m = 0; for (let d = Math.max(0, i - r), e = Math.min(W - 1, i + r); d <= e; d++) if (a[o + d] > m) { m = a[o + d]; break; } t[o + i] = m; } }
  const u = new Uint8Array(a.length);
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) { let m = 0; for (let d = Math.max(0, j - r), e = Math.min(H - 1, j + r); d <= e; d++) if (t[d * W + i]) { m = 255; break; } u[j * W + i] = m; }
  return u;
}
function treeField(S, k) {
  const x0 = S.ground[0] + 3, y0 = S.ground[1] + 3, x1 = S.ground[2] - 3, y1 = S.ground[3] - 3;
  const G = 2, W = Math.round((x1 - x0) / G), H = Math.round((y1 - y0) / G), r = rng(7000 + k * 7919);
  const C = raster(W, H, x0, y1, G); C.fill(1);
  const order = [['resid', 2], ['school', 2], ['hard', 3], ['dirt', 3], ['field', 9], ['meadow', 1], ['park', 4], ['garden', 5], ['orchard', 5],
    ['scrub', 7], ['cemetery', 6], ['wood', 7], ['lawn', 8]];
  for (const [kind, val] of order) for (const a of S.areas) if (a.kind === kind) { C.set_([a.outer], val); for (const h of a.holes) C.set_([h], 1); }
  const E = raster(W, H, x0, y1, G), A = raster(W, H, x0, y1, G), Hs = raster(W, H, x0, y1, G);
  for (const b of [...S.buildings, ...S.obstacles.map((o) => ({ outer: o, levels: 1, area: Math.abs(area(o)) }))]) {
    E.fill_([b.outer], 255); E.line_([...b.outer, b.outer[0]], 6, 255);
    if (b.levels >= 4) A.fill_([b.outer], 255); else if (b.area < 400) Hs.fill_([b.outer], 255);
  }
  for (const w of S.water) E.fill_([w.outer], 255);
  for (const a of S.areas) if (a.kind === 'hard' || a.kind === 'island') E.fill_([a.outer], 255);
  for (const p of [...S.paved, ...S.pitches, ...S.playgrounds]) E.fill_([p.outer], 255);
  for (const rd of S.roads) if (!rd.tunnel) E.line_(rd.pts, rd.width + 3, 255);
  for (const t of S.tram) E.line_(t.pts, t.rail ? 6 : 3.5, 255);
  const nearApt = dilate(A, W, H, 20), nearHouse = dilate(Hs, W, H, 7);
  const P = new Float32Array(W * H), PV = [0, 0.07, 0.12, 0.035, 0.55, 0.42, 0.62, 0.85, 0.12, 0];
  const nz = vnoise2(k * 31 + 5);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = j * W + i, c = C[o]; let p = PV[c];
    const yard = nearApt[o] && (c === 1 || c === 2 || c === 8), priv = nearHouse[o] && !nearApt[o] && (c === 1 || c === 2 || c === 5);
    if (yard) p = 0.36;
    if (priv) p = Math.max(p, 0.30);
    const x = x0 + (i + 0.5) * G, y = y1 - (j + 0.5) * G;
    p *= 0.35 + 1.1 * nz((x + S.off[0]) / 32, (y + S.off[1]) / 32);
    P[o] = E[o] ? 0 : p; if (priv) C[o] |= 16;
  }
  const out = [], put = (x, y, h) => out.push([x, y, h, r.randrange(65536)]);
  for (const [step, forest] of [[9.0, true], [7.5, false]]) {
    const nx = Math.floor((x1 - x0) / step), ny = Math.floor((y1 - y0) / step);
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
      const x = x0 + (a + r()) * step, y = y0 + (b + r()) * step, u = Math.floor((x - x0) / G), v = Math.floor((y1 - y) / G);
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      const o = v * W + u, c = C[o] & 15;
      if ((c === 7) !== forest) continue;
      const p = P[o]; if (p <= 0 || r() >= p) continue;
      put(x, y, c === 7 ? r.uniform(13, 23) : c === 4 || c === 6 ? r.uniform(10, 20) : C[o] & 16 ? r.uniform(5, 10) : r.uniform(8.5, 17));
    }
  }
  for (const rd of S.roads) {                                  // street rows
    if (!['residential', 'tertiary', 'secondary', 'primary', 'living_street'].includes(rd.kind)) continue;
    for (const side of [-1, 1]) {
      const off = side * (rd.width / 2 + r.uniform(2.3, 3.8)); let s = r.uniform(0, 9);
      for (let i = 0; i + 1 < rd.pts.length; i++) {
        const p0 = rd.pts[i], p1 = rd.pts[i + 1], L = dist(p0, p1); if (L < 1) continue;
        const dx = (p1[0] - p0[0]) / L, dy = (p1[1] - p0[1]) / L;
        while (s < L) {
          const x = p0[0] + dx * s - dy * off, y = p0[1] + dy * s + dx * off, u = Math.floor((x - x0) / G), v = Math.floor((y1 - y) / G);
          if (u >= 0 && v >= 0 && u < W && v < H && !E[v * W + u] && ![3, 9].includes(C[v * W + u] & 15) && r() < 0.42) put(x, y, r.uniform(9, 15));
          s += r.uniform(7.5, 10.5);
        }
        s -= L;
      }
    }
  }
  if (S.treesLocal.length) {                                  // mapped trees win
    const g = new Map(); for (const t of S.treesLocal) { const key = Math.floor(t[0] / 4) * 100003 + Math.floor(t[1] / 4); (g.get(key) || g.set(key, []).get(key)).push(t); }
    const clash = (t) => { const i = Math.floor(t[0] / 4), j = Math.floor(t[1] / 4); for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) for (const o of g.get(a * 100003 + b) || []) if (dist(t, o) < 4) return true; return false; };
    return out.filter((t) => !clash(t)).concat(S.treesLocal);
  }
  return out;
}
function genMask(S, x0, y0, x1, y1, N, seed) {
  const px = (x1 - x0) / N, W = N, H = N;
  const R = raster(W, H, x0, y1, px), G = raster(W, H, x0, y1, px), B = raster(W, H, x0, y1, px), X = raster(W, H, x0, y1, px);
  for (const a of S.areas) {
    const rings = [a.outer, ...a.holes];
    if (a.kind === 'hard') G.fill_(rings, 255);
    else if (a.kind === 'dirt') R.fill_(rings, 235);
    else if (a.kind === 'field') R.fill_(rings, 150);
    else if (['lawn', 'park', 'garden', 'wood', 'scrub', 'cemetery', 'orchard', 'island', 'meadow'].includes(a.kind)) B.fill_(rings, 255);
  }
  // trampled edges along footpaths, bare soil of private vegetable gardens
  for (const rd of S.roads) {
    if (['footway', 'path', 'track'].includes(rd.kind)) R.line_(rd.pts, rd.width + 2.4, rd.kind === 'footway' ? 90 : 150);
  }
  for (const b of S.buildings) if (b.house) R.line_([...b.outer, b.outer[0]], 14, 95);
  for (const pg of S.playgrounds) R.line_([...pg.outer, pg.outer[0]], 3, 140);
  for (const b of S.buildings) X.fill_([b.outer], 255);
  const nz = vnoise2(seed), nz2 = vnoise2(seed + 17);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = j * W + i, x = x0 + (i + 0.5) * px, y = y1 - (j + 0.5) * px;
    const n = nz(x / 38, y / 38) * 0.65 + nz2(x / 11, y / 11) * 0.35;
    let r = R[o] * (0.55 + 0.75 * n);
    if (!B[o]) r = Math.max(r, 255 * clamp((n - 0.62) * 2.4, 0, 0.7));   // random worn patches in unmapped yards
    if (G[o] > 128 || B[o] > 128 && R[o] < 200) r *= 0.25;
    if (X[o]) { r = 0; G[o] = 0; }
    R[o] = clamp(r, 0, 255);
  }
  blur(R, W, H, 2); blur(G, W, H, 1); blur(B, W, H, 2);
  const out = new Uint8Array(W * H * 4);                     // rows south -> north (texture v = 0 at the south edge)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = j * W + i, q = ((H - 1 - j) * W + i) * 4;
    out[q] = R[o]; out[q + 1] = G[o]; out[q + 2] = B[o]; out[q + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------- tile decoding
function parsePack(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true);
  const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const base = 4 + hl;
  const TY = { int16: Int16Array, uint16: Uint16Array, uint32: Uint32Array, uint8: Uint8Array, float32: Float32Array, int64: Float64Array };
  const A = (n) => { const h = H[n]; return new TY[h.dtype](buf, base + h.offset, h.count); };
  return { H, A };
}
function decodeRings(A, name, Q) {
  const v = A(name + '_v'), r = A(name + '_r'), p = A(name + '_p'), out = [];
  for (let k = 0; k + 1 < p.length; k++) {
    const rings = [];
    for (let ri = p[k]; ri < p[k + 1]; ri++) {
      const ring = []; for (let i = r[ri]; i < r[ri + 1]; i++) ring.push([v[i * 2] * Q, v[i * 2 + 1] * Q]);
      rings.push(ring);
    }
    out.push({ outer: rings[0] || [], holes: rings.slice(1) });
  }
  return out;
}
function decodeLines(A, name, Q) {
  const v = A(name + '_v'), l = A(name + '_l'), out = [];
  for (let k = 0; k + 1 < l.length; k++) { const pts = []; for (let i = l[k]; i < l[k + 1]; i++) pts.push([v[i * 2] * Q, v[i * 2 + 1] * Q]); out.push(pts); }
  return out;
}
const SPECIES = ['linden', 'maple', 'chestnut', 'poplar', 'birch'];
const SP_W = [26, 20, 18, 14, 22];

function decodeTile(buf) {
  const { H, A } = parsePack(buf), Q = H.Q;
  const S = { H, off: H.off, k: H.k };
  const bm = H.b;
  S.buildings = decodeRings(A, 'b', Q).map((g, i) => {
    const b = { outer: g.outer, holes: g.holes, id: bm.id[i], kind: bm.kind[i] || 'yes', h: bm.h[i], levels: bm.lv[i], lt: bm.lt[i], fh: bm.fh[i],
      street: bm.st[i], num: bm.num[i], rs: bm.rs[i], colour: bm.col[i], rcol: bm.rcol[i], zb: bm.zb ? bm.zb[i] : 0, rh: bm.rh ? bm.rh[i] : 0 };
    b.area = Math.abs(area(b.outer)); return b;
  });
  S.obstacles = decodeRings(A, 'o', Q).map((g) => g.outer);
  const R = H.r;
  S.roads = decodeLines(A, 'r', Q).map((pts, i) => ({ pts, kind: R.kind[i], width: R.w[i], surface: R.surf[i], oneway: !!R.ow[i], lanes: R.lanes[i],
    crossing: !!R.cr[i], bridge: R.br[i] && R.br[i] !== 'no' ? R.br[i] : '', tunnel: R.tu[i] && R.tu[i] !== 'no' ? R.tu[i] : '', id: R.id[i] }));
  S.tram = decodeLines(A, 't', Q).map((pts, i) => ({ pts, rail: !!H.t.rail[i] }));
  S.fences = decodeLines(A, 'f', Q).map((pts, i) => ({ pts, kind: H.f.kind[i] }));
  S.paved = decodeRings(A, 'paved', Q).map((g, i) => ({ ...g, sq: !!(H.paved && H.paved.sq[i]) }));
  S.water = decodeRings(A, 'water', Q);
  S.pitches = decodeRings(A, 'pitches', Q).map((g, i) => ({ ...g, sport: H.pitches.sport[i], surface: H.pitches.surf[i], id: H.pitches.id[i] }));
  S.playgrounds = decodeRings(A, 'playgrounds', Q).map((g, i) => ({ ...g, id: H.playgrounds.id[i] }));
  S.areas = decodeRings(A, 'areas', Q).map((g, i) => ({ ...g, kind: H.areas.kind[i] }));
  const tv = A('tree_v'), th = A('tree_h'), ts = A('tree_s'), trees = [];
  for (let i = 0; i < th.length; i++) trees.push([tv[i * 2] * Q, tv[i * 2 + 1] * Q, th[i] / 10, ts[i]]);
  S.treesLocal = trees;
  const c = A('cells'), cells = [];
  for (let i = 0; i < c.length; i += 4) cells.push([c[i] * Q, c[i + 1] * Q, c[i + 2] * Q, c[i + 3] * Q]);
  S.cells = cells;
  const [bx0, by0, bx1, by1] = H.bbox, [ox, oy] = H.off;
  S.ground = [bx0 - ox - 3, by0 - oy - 3, bx1 - ox + 3, by1 - oy + 3];
  return S;
}

// ---------------------------------------------------------------------------- one tile -> chunk arrays
function concat(lists, T) { let n = 0; for (const l of lists) n += l.length; const out = new T(n); let o = 0; for (const l of lists) { out.set(l, o); o += l.length; } return out; }
function generateTile(buf, opts = {}) {
  const t0 = Date.now();
  const S = decodeTile(buf), H = S.H, [ox, oy] = S.off;
  if (H.grow) S.treesLocal = treeField(S, S.k);
  const ovr = new Map(Object.entries(opts.colours || {}));
  for (const b of S.buildings) prepareBuilding(b, ovr);
  const m = new Sink(H.bid0);
  const meta = [];
  S.buildings.forEach((b, i) => {
    genBuilding(m, b, i);
    let cx = 0, cy = 0; for (const p of b.outer) { cx += p[0]; cy += p[1]; } cx /= b.outer.length; cy /= b.outer.length;
    meta.push({ i: H.bid0 + i, id: b.id, kind: b.kind, lv: b.lt, lvEst: b.levels, h: b.h, street: b.street, num: b.num, c: [cx + ox, cy + oy],
      facade: b.style[0], end: b.style[1], src: b.style[2] });
  });
  const out = {};
  const W = m.w;
  out.wall_pos = new Float32Array(W.pos); out.wall_uv = new Float32Array(W.uv); out.wall_col = new Uint8Array(W.col);
  out.wall_p1 = new Float32Array(W.p1); out.wall_p2 = new Float32Array(W.p2); out.wall_bid = new Float32Array(W.bid);
  out.wall_ck = new Uint8Array(W.ck); out.wall_idx = new Uint32Array(W.idx);
  const groupsOf = (sink, prefix) => {
    const R = sink.r, groups = [], lists = [];
    let start = 0;
    for (const mat of [ROOF, SOLID, GLASS, METAL]) { const l = R.idx[mat]; groups.push({ mat, start, count: l.length }); start += l.length; lists.push(l); }
    out[prefix + '_pos'] = new Float32Array(R.pos); out[prefix + '_col'] = new Uint8Array(R.col); out[prefix + '_idx'] = concat(lists, Uint32Array);
    return [groups, R];
  };
  const [rg, RR] = groupsOf(m, 'rest');
  out.rest_bid = new Float32Array(RR.bid); out.rest_ck = new Uint8Array(RR.ck);
  const G = m.g;
  out.win_pos = new Float32Array(G.pos); out.win_uv = new Float32Array(G.uv); out.win_col = new Uint8Array(G.col); out.win_wp = new Float32Array(G.wp);
  out.win_bid = new Float32Array(G.bid); out.win_idx = new Uint32Array(G.idx);
  // water
  const wp = [];
  for (const w of S.water) for (let [a, b, c] of triangulate(w.outer, w.holes)) { if (area([a, b, c]) < 0) [a, c] = [c, a]; wp.push(a[0], a[1], 0.06, b[0], b[1], 0.06, c[0], c[1], 0.06); }
  out.water_pos = new Float32Array(wp);
  // trees: instances in the global frame
  const inst = [];
  for (const t of S.treesLocal) {
    const r = rng(t[3] * 2654435761 + 12345 + S.k);
    const si = wpick(SPECIES.map((s, i) => [i, SP_W[i]]), r());
    const h = t[2] * r.uniform(0.85, 1.0) * (si === 3 ? 1.25 : 1.0);
    inst.push(t[0] + ox, t[1] + oy, h / 15, r.uniform(0, 6.283), si, r());
  }
  out.trees = new Float32Array(inst);
  // cars
  const [cars, pockets] = genCars(S, 603 + S.k);
  const ca = [];
  for (const c of cars) ca.push(c[0] + ox, c[1] + oy, c[2], c[4], c[3][0], c[3][1], c[3][2]);
  out.cars = new Float32Array(ca);
  // ground
  const g = new Ground(), props = new Sink(0);
  const junc = junctions(S);
  genParking(g, S);
  genLandcover(g, props, S);
  for (const [c, ax, ay, hu, hv] of pockets) {
    const r = h01(Math.round(c[0] * 10), Math.round(c[1] * 10)), t = 0.30 + 0.05 * r;
    g.rect(c, ax, ay, hu, hv, 0.028, r < 0.75 ? PAT_ASPHALT : PAT_DIRT, r < 0.75 ? [t, t, t * 0.98] : [0.45, 0.41, 0.34]);
  }
  genRoads(g, props, S, junc);
  genTram(g, props, S);
  genPitches(g, props, S);
  genPlaygrounds(g, props, S);
  const zs = [...g.z.keys()].sort((a, b) => a - b);
  const gp = [], gc = [], gpat = [], gi = [];
  let base = 0;
  for (const z of zs) {
    const b = g.z.get(z);
    for (let i = 0; i < b.pos.length; i++) gp.push(b.pos[i]);
    for (let i = 0; i < b.col.length; i++) gc.push(b.col[i]);
    for (let i = 0; i < b.pat.length; i++) gpat.push(b.pat[i]);
    for (let i = 0; i < b.idx.length; i++) gi.push(b.idx[i] + base);
    base += b.n;
  }
  out.gnd_pos = new Float32Array(gp); out.gnd_col = new Uint8Array(gc); out.gnd_pat = new Uint8Array(gpat); out.gnd_idx = new Uint32Array(gi);
  const [pg] = groupsOf(props, 'prop');
  // owned ground cells
  const cp = [], ci = [];
  for (const [a, b, c, d] of S.cells) { const k = cp.length / 3; cp.push(a, b, 0, c, b, 0, c, d, 0, a, d, 0); ci.push(k, k + 1, k + 2, k, k + 2, k + 3); }
  out.cell_pos = new Float32Array(cp); out.cell_idx = new Uint32Array(ci);
  // mask over the tile (+20 m)
  const [bx0, by0, bx1, by1] = H.bbox, N = opts.maskN || 768;
  const mx0 = bx0 - ox - 20, my0 = by0 - oy - 20, mx1 = bx1 - ox + 20, my1 = by1 - oy + 20;
  out.mask = genMask(S, mx0, my0, mx1, my1, N, 1000 + S.k);
  const M = { off: [ox, oy], ground: [bx0, by0, bx1, by1], mask: [mx0 + ox, my0 + oy, mx1 + ox, my1 + oy], maskN: N, buildings: meta,
    header: { rest_groups: rg, prop_groups: pg, rest_q: 1 }, counts: { buildings: meta.length, trees: inst.length / 6, cars: ca.length / 7 }, ms: Date.now() - t0 };
  return { M, out };
}

// ---------------------------------------------------------------------------- overview layer (all tiles)
function generateCtx(buf, tiles, T, gx0, gy0) {
  const { H, A } = parsePack(buf), Q = H.Q;
  const bv = A('b_v'), br = A('b_r'), bp = A('b_p'), bh = A('b_h'), blv = A('b_lv'), bk = A('b_k'), bs = A('b_s'), bt = A('b_t');
  const kinds = H.kinds, cols = H.cols || [''];
  const bz = A('b_z'), bc = A('b_c'), brc = A('b_rc');
  const centre = H.pc ? () => H.pc : (k) => { const [i, j] = tiles[k].ij; return [gx0 + (i + 0.5) * T, gy0 + (j + 0.5) * T]; };
  // blocks of 3x3 tiles: one mesh each (frustum culling, few draw calls); vertices know their tile for hiding
  const blocks = new Map();
  const blk = (k) => {
    const [i, j] = k >= 0 && tiles && tiles[k] ? tiles[k].ij : [-9, -9], key = Math.floor(i / 3) * 1000 + Math.floor(j / 3);
    let b = blocks.get(key);
    if (!b) blocks.set(key, b = { key, pos: [], col: [], own: [], wk: [], nrm: [], idx: [], rpos: [], rown: [], ridx: [], wpos: [], wown: [], tr: [] });
    return b;
  };
  const push = (B, p, c, own, wk, n) => { B.pos.push(p[0], p[2], -p[1]); B.col.push(c[0], c[1], c[2]); B.own.push(own); B.wk.push(wk); B.nrm.push(n[0], n[2], -n[1]); };
  for (let k = 0; k + 1 < bp.length; k++) {
    const t = bt[k], [ox, oy] = centre(t), B = blk(t), own = 100 + t;
    const ring = []; for (let i = br[bp[k]]; i < br[bp[k] + 1]; i++) ring.push([bv[i * 2] * Q + ox, bv[i * 2 + 1] * Q + oy]);
    if (ring.length < 3) continue;
    const b = { id: bs[k], kind: kinds[bk[k]], levels: blv[k] / 2, h: bh[k] / 10, outer: ring, holes: [], area: Math.abs(area(ring)), rs: '',
      colour: bc ? cols[bc[k]] : '', rcol: brc ? cols[brc[k]] : '', zb: bz ? bz[k] / 10 : 0 };
    b.house = HOUSE_KINDS.has(b.kind) && b.levels <= 3 || (b.kind === 'yes' && b.levels <= 2 && b.area < 260 && b.area > 30);
    const [fac] = buildingStyle(b, null);
    const z0 = b.zb > 0.05 ? b.zb : 0, spec = SPECIAL.has(b.kind);
    const pit = spec || z0 > 0 ? null : roofShape(b);
    const fc = fac.map(u8);
    const h = b.h + (pit || spec || z0 > 0 ? 0 : b.levels >= 3 ? 0.6 : 0.25);
    const wk = !spec && b.levels >= 3 && !['garage', 'garages', 'industrial', 'warehouse'].includes(b.kind) ? 2 : 1;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], c = ring[(i + 1) % n], L = dist(a, c); if (L < 0.05) continue;
      const nr = [(c[1] - a[1]) / L, -(c[0] - a[0]) / L, 0], v0 = B.own.length;
      push(B, [a[0], a[1], z0], fc, own, wk, nr); push(B, [c[0], c[1], z0], fc, own, wk, nr); push(B, [c[0], c[1], h], fc, own, wk, nr); push(B, [a[0], a[1], h], fc, own, wk, nr);
      B.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }
    if (pit) {
      // simple pitched roof over the rectangle (same rule as the full model)
      const v = 0, sink = { face: (pts, mat, col) => {
        const cc = col.map(u8), a = pts[0], b2 = pts[1], c2 = pts[2];
        const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2], vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        const v0 = B.own.length;
        for (const p of pts) push(B, p, cc, own, 0, [nx, ny, nz]);
        for (let t2 = 1; t2 < pts.length - 1; t2++) B.idx.push(v0, v0 + t2, v0 + t2 + 1);
      }, box() {} };
      const rp = HOUSE_ROOFS.map(([c, w, m]) => [[c, m], w]);
      const [rc] = wpick(rp, h01(b.id, 'roofc'));
      emitPitched(sink, b, pit, b.h, fac, rc, SOLID);
    } else {
      const rv = 0.03 * (h01(b.id, 'rv') - 0.5), rt = parseColour(b.rcol), rc = (rt || [0.2375 + rv, 0.233 + rv, 0.227 + rv].map((x) => x * 1.25)).map(u8);
      const v0 = B.own.length;
      for (const p of ring) push(B, [p[0], p[1], h], rc, own, 0, [0, 0, 1]);
      const tri = earcut(ring.flatMap((p) => p), null, 2);
      for (let i = 0; i < tri.length; i += 3) B.idx.push(v0 + tri[i], v0 + tri[i + 1], v0 + tri[i + 2]);
    }
  }
  // main roads: flat asphalt ribbons
  const rv = A('r_v'), rl = A('r_l'), rw = A('r_w'), rt = A('r_t');
  for (let k = 0; k + 1 < rl.length; k++) {
    const t = rt[k], [ox, oy] = centre(t), B = blk(t), w = rw[k] / 4 / 2, own = 100 + t;
    const pts = []; for (let i = rl[k]; i < rl[k + 1]; i++) pts.push([rv[i * 2] * Q + ox, rv[i * 2 + 1] * Q + oy]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], c = pts[i + 1], L = dist(a, c); if (L < 0.1) continue;
      const nx = -(c[1] - a[1]) / L * w, ny = (c[0] - a[0]) / L * w, v0 = B.rown.length;
      for (const p of [[a[0] - nx, a[1] - ny], [c[0] - nx, c[1] - ny], [c[0] + nx, c[1] + ny], [a[0] + nx, a[1] + ny]]) { B.rpos.push(p[0], 0.03, -p[1]); B.rown.push(own); }
      B.ridx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }
  }
  // water
  const wv = A('w_v'), wr = A('w_r'), wpp = A('w_p'), wt = A('w_t');
  for (let k = 0; k + 1 < wpp.length; k++) {
    const t = wt[k], [ox, oy] = centre(t), B = blk(t), own = 100 + t;
    const rings = [];
    for (let ri = wpp[k]; ri < wpp[k + 1]; ri++) { const ring = []; for (let i = wr[ri]; i < wr[ri + 1]; i++) ring.push([wv[i * 2] * Q + ox, wv[i * 2 + 1] * Q + oy]); rings.push(ring); }
    if (!rings.length || rings[0].length < 3) continue;
    for (const [a, b, c] of triangulate(rings[0], rings.slice(1))) {
      const tri = area([a, b, c]) < 0 ? [a, c, b] : [a, b, c];
      for (const p of tri) { B.wpos.push(p[0], 0.06, -p[1]); B.wown.push(own); }
    }
  }
  // tree blobs
  const tv = A('t_v'), th = A('t_h'), tt = A('t_t');
  for (let k = 0; k < th.length; k++) {
    const t = tt[k], [ox, oy] = centre(t), B = blk(t);
    B.tr.push(tv[k * 2] * Q + ox, tv[k * 2 + 1] * Q + oy, th[k] / 10, h01(k, t), 100 + t);
  }
  const res = [];
  for (const B of blocks.values()) {
    res.push({ key: B.key, pos: new Float32Array(B.pos), col: new Uint8Array(B.col), own: new Float32Array(B.own), wk: new Float32Array(B.wk),
      nrm: new Int8Array(B.nrm.map((x) => Math.round(x * 127))), idx: new Uint32Array(B.idx),
      rpos: new Float32Array(B.rpos), rown: new Float32Array(B.rown), ridx: new Uint32Array(B.ridx),
      wpos: new Float32Array(B.wpos), wown: new Float32Array(B.wown), tr: new Float32Array(B.tr) });
  }
  return res;
}

// ---------------------------------------------------------------------------- worker / module entry
async function gunzip(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x1f || u[1] !== 0x8b) return buf;
  return await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
const transferList = (o) => { const l = []; for (const v of Object.values(o)) if (v && v.buffer instanceof ArrayBuffer) l.push(v.buffer); return l; };
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (e) => {
    const { id, op, url, opts } = e.data;
    if (op === 'ping') { self.postMessage({ ready: true }); return; }
    try {
      let raw = e.data.buf;
      if (!raw) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); raw = await r.arrayBuffer(); }
      const buf = await gunzip(raw);
      if (op === 'tile') {
        const { M, out } = generateTile(buf, opts);
        self.postMessage({ id, ok: true, M, out }, transferList(out));
      } else if (op === 'ctx') {
        const res = generateCtx(buf, opts.tiles, opts.T, opts.gx0, opts.gy0);
        const tl = []; for (const b of res) tl.push(...transferList(b));
        self.postMessage({ id, ok: true, res }, tl);
      }
    } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.stack || err) }); }
  };
}
export { generateTile, generateCtx, decodeTile, gunzip };
