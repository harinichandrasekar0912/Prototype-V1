// Design frame + design grid.
//
// The frame is a rotation of world space aligned to the frontage: s runs along the street, t runs
// into the site (depth). Building geometry (footprints, rooms) is orthogonal to this frame, which is
// how houses are normally set out against a street, even on skewed plots.
//
// The grid (default 0.5 m) carries the site's "influence fields" (noise, privacy, view, depth…) and
// the masks used for hard constraints. Masks are conservative: a cell counts as buildable only when
// it lies entirely inside the allowed region, so anything built on buildable cells is compliant.

import { sub, dot, add, mul, norm, leftNormal, pointInPolygon } from './polygon.js';

export function makeFrame(sitePts, frontEdge) {
  const a = sitePts[frontEdge], b = sitePts[(frontEdge + 1) % sitePts.length];
  const u = norm(sub(b, a));
  const v = leftNormal(u); // into the site for a CCW polygon
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const p of sitePts) {
    const d = sub(p, a);
    const s = dot(d, u), t = dot(d, v);
    sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  const o = add(a, add(mul(u, sMin), mul(v, tMin)));
  const frame = {
    o, u, v, S: sMax - sMin, T: tMax - tMin,
    frontT: -tMin, // t of the frontage line
    toLocal: (p) => { const d = sub(p, o); return [dot(d, u), dot(d, v)]; },
    toWorld: (s, t) => [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t],
    angleDeg: (Math.atan2(u[1], u[0]) * 180) / Math.PI,
  };
  frame.rectWorld = (r) => [
    frame.toWorld(r.s0, r.t0), frame.toWorld(r.s1, r.t0),
    frame.toWorld(r.s1, r.t1), frame.toWorld(r.s0, r.t1),
  ];
  // Directions in the frame, for language: "front" = towards the street.
  frame.localDir = (vec) => [dot(vec, u), dot(vec, v)];
  return frame;
}

export class Grid {
  constructor(frame, cell = 0.5, pad = 0) {
    this.frame = frame;
    this.c = cell;
    this.pad = pad; // cells of padding around the site extents (for fields drawn beyond the plot)
    this.nx = Math.ceil(frame.S / cell - 1e-9) + 2 * pad;
    this.ny = Math.ceil(frame.T / cell - 1e-9) + 2 * pad;
    this.n = this.nx * this.ny;
  }
  idx(i, j) { return j * this.nx + i; }
  inBounds(i, j) { return i >= 0 && j >= 0 && i < this.nx && j < this.ny; }
  // local coordinates of a cell's lower corner / centre
  s0(i) { return (i - this.pad) * this.c; }
  t0(j) { return (j - this.pad) * this.c; }
  centerLocal(i, j) { return [this.s0(i) + this.c / 2, this.t0(j) + this.c / 2]; }
  centerWorld(i, j) { const [s, t] = this.centerLocal(i, j); return this.frame.toWorld(s, t); }
  cornersWorld(i, j) {
    const s = this.s0(i), t = this.t0(j), c = this.c, f = this.frame;
    return [f.toWorld(s, t), f.toWorld(s + c, t), f.toWorld(s + c, t + c), f.toWorld(s, t + c)];
  }
  cellOf(sLocal, tLocal) {
    return [Math.floor(sLocal / this.c) + this.pad, Math.floor(tLocal / this.c) + this.pad];
  }
  cellOfWorld(p) { const [s, t] = this.frame.toLocal(p); return this.cellOf(s, t); }
  // rect in local metres -> cell index range [i0,i1) x [j0,j1)
  rectCells(r) {
    return {
      i0: Math.round(r.s0 / this.c) + this.pad, i1: Math.round(r.s1 / this.c) + this.pad,
      j0: Math.round(r.t0 / this.c) + this.pad, j1: Math.round(r.t1 / this.c) + this.pad,
    };
  }
  mask(pred) {
    const m = new Uint8Array(this.n);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) m[j * this.nx + i] = pred(i, j) ? 1 : 0;
    return m;
  }
  field(fn) {
    const f = new Float32Array(this.n);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) f[j * this.nx + i] = fn(i, j);
    return f;
  }
}

// --- mask algebra -------------------------------------------------------------------------------
export const maskAnd = (a, b) => a.map((v, k) => (v && b[k] ? 1 : 0));
export const maskOr = (a, b) => a.map((v, k) => (v || b[k] ? 1 : 0));
export const maskMinus = (a, b) => a.map((v, k) => (v && !b[k] ? 1 : 0));
export const maskCount = (m) => { let c = 0; for (let k = 0; k < m.length; k++) c += m[k] ? 1 : 0; return c; };

export function fillRect(grid, m, r, val = 1) {
  const { i0, i1, j0, j1 } = grid.rectCells(r);
  for (let j = Math.max(0, j0); j < Math.min(grid.ny, j1); j++)
    for (let i = Math.max(0, i0); i < Math.min(grid.nx, i1); i++) m[j * grid.nx + i] = val;
  return m;
}

// Summed-area table so "is this whole rectangle buildable?" is O(1).
export function prefixSum(grid, m) {
  const W = grid.nx + 1, P = new Int32Array(W * (grid.ny + 1));
  for (let j = 0; j < grid.ny; j++) {
    let row = 0;
    for (let i = 0; i < grid.nx; i++) {
      row += m[j * grid.nx + i] ? 1 : 0;
      P[(j + 1) * W + i + 1] = P[j * W + i + 1] + row;
    }
  }
  return { P, W };
}
export function rectSum({ P, W }, i0, j0, i1, j1) {
  return P[j1 * W + i1] - P[j0 * W + i1] - P[j1 * W + i0] + P[j0 * W + i0];
}

// Exact Euclidean distance transform (Felzenszwalb–Huttenlocher), in metres from each cell centre to
// the nearest cell where mask == 0.
export function distanceInside(grid, m) {
  const INF = 1e12, { nx, ny, c } = grid;
  const f = new Float64Array(grid.n);
  for (let k = 0; k < grid.n; k++) f[k] = m[k] ? INF : 0;
  const dt1 = (get, set, n) => {
    const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n);
    for (let q = 0; q < n; q++) g[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + g[v[k]]; }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let i = 0; i < nx; i++) dt1((q) => f[q * nx + i], (q, val) => (f[q * nx + i] = val), ny);
  for (let j = 0; j < ny; j++) dt1((q) => f[j * nx + q], (q, val) => (f[j * nx + q] = val), nx);
  const out = new Float32Array(grid.n);
  for (let k = 0; k < grid.n; k++) out[k] = Math.sqrt(f[k]) * c;
  return out;
}

// Geodesic (walking) distance inside a mask from seed cells, 8-connected, in metres.
export function geodesic(grid, m, seeds) {
  const { nx, ny, c } = grid;
  const d = new Float32Array(grid.n).fill(Infinity);
  // Dijkstra with a simple binary heap
  const heap = [];
  const push = (k, v) => {
    heap.push([v, k]);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]]; i = s;
      }
    }
    return top;
  };
  for (const k of seeds) if (m[k]) { d[k] = 0; push(k, 0); }
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const [dv, k] = pop();
    if (dv > d[k]) continue;
    const i = k % nx, j = (k - i) / nx;
    for (const [di, dj, w] of steps) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const kk = b * nx + a;
      if (!m[kk]) continue;
      if (di && dj && (!m[j * nx + a] || !m[b * nx + i])) continue; // no corner cutting
      const nd = dv + w * c;
      if (nd < d[kk]) { d[kk] = nd; push(kk, nd); }
    }
  }
  return d;
}

// 4-connected component labelling. Returns {labels (0 = none), comps:[{id, cells:[k], size}]}
export function components(grid, m) {
  const { nx, ny } = grid;
  const labels = new Int32Array(grid.n);
  const comps = [];
  let next = 1;
  for (let k0 = 0; k0 < grid.n; k0++) {
    if (!m[k0] || labels[k0]) continue;
    const cells = [], stack = [k0];
    labels[k0] = next;
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const i = k % nx, j = (k - i) / nx;
      const nb = [];
      if (i > 0) nb.push(k - 1);
      if (i < nx - 1) nb.push(k + 1);
      if (j > 0) nb.push(k - nx);
      if (j < ny - 1) nb.push(k + nx);
      for (const kk of nb) if (m[kk] && !labels[kk]) { labels[kk] = next; stack.push(kk); }
    }
    comps.push({ id: next, cells, size: cells.length });
    next++;
  }
  return { labels, comps };
}

// Morphological opening with a square of side `w` cells: removes parts narrower than w.
export function opening(grid, m, w) {
  if (w <= 1) return m.slice();
  const { nx, ny } = grid;
  const { P, W } = prefixSum(grid, m);
  // erosion: top-left anchored windows fully inside
  const er = new Uint8Array(grid.n);
  for (let j = 0; j + w <= ny; j++)
    for (let i = 0; i + w <= nx; i++)
      if (rectSum({ P, W }, i, j, i + w, j + w) === w * w) er[j * nx + i] = 1;
  // dilation of anchors back to full squares
  const out = new Uint8Array(grid.n);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (er[j * nx + i]) for (let b = j; b < j + w; b++) for (let a = i; a < i + w; a++) out[b * nx + a] = 1;
  return out;
}

// Outline loops of a mask in local metres (interior on the left). Used to draw footprints/regions.
export function maskOutlines(grid, m) {
  const { nx, ny, c } = grid;
  const key = (x, y) => `${x},${y}`;
  const edges = new Map(); // start vertex -> list of end vertices
  const addE = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([x1, y1]);
  };
  const at = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && m[j * nx + i];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) addE(i, j, i + 1, j);
      if (!at(i + 1, j)) addE(i + 1, j, i + 1, j + 1);
      if (!at(i, j + 1)) addE(i + 1, j + 1, i, j + 1);
      if (!at(i - 1, j)) addE(i, j + 1, i, j);
    }
  const loops = [];
  while (edges.size) {
    const [startK, ends] = edges.entries().next().value;
    let [x, y] = startK.split(',').map(Number);
    const loop = [[x, y]];
    let guard = 0;
    for (;;) {
      const k = key(x, y);
      const list = edges.get(k);
      if (!list || !list.length) break;
      const [nx1, ny1] = list.shift();
      if (!list.length) edges.delete(k);
      x = nx1; y = ny1;
      if (key(x, y) === startK) break;
      loop.push([x, y]);
      if (++guard > 1e6) break;
    }
    // drop collinear vertices
    const simp = loop.filter((p, idx) => {
      const a = loop[(idx - 1 + loop.length) % loop.length], b = loop[(idx + 1) % loop.length];
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) !== 0;
    });
    loops.push(simp.map(([gi, gj]) => [(gi - grid.pad) * c, (gj - grid.pad) * c]));
    void ends;
  }
  return loops;
}

export function cellInsidePolygonStrict(grid, i, j, poly) {
  const cs = grid.cornersWorld(i, j);
  for (const p of cs) if (!pointInPolygon(p, poly)) return false;
  // a polygon vertex strictly inside the cell would also cut it
  const [s0, t0] = [grid.s0(i), grid.t0(j)];
  for (const p of poly) {
    const [s, t] = grid.frame.toLocal(p);
    if (s > s0 + 1e-9 && s < s0 + grid.c - 1e-9 && t > t0 + 1e-9 && t < t0 + grid.c - 1e-9) return false;
  }
  return true;
}
