// Small shared helpers. Pure functions only (no DOM) so the engine runs in Node tests.

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);
export const round = (v, d = 2) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};
export const snap = (v, step) => Math.round(v / step) * step;
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export const M2_TO_FT2 = 10.7639;
export const fmtArea = (m2, d = 1) => `${round(m2, d).toFixed(d)} m²`;
export const fmtFt2 = (m2) => `${Math.round(m2 * M2_TO_FT2).toLocaleString('en-IN')} ft²`;
export const fmtM = (m, d = 1) => `${round(m, d).toFixed(d)} m`;
export const pct = (v, d = 0) => `${round(v * 100, d).toFixed(d)}%`;

let uidCounter = 0;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// FNV-1a over a stable JSON string; used to detect when upstream inputs change (stale stages).
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
export function hash(v) {
  const s = typeof v === 'string' ? v : stableStringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function sortBy(arr, f, dir = 1) {
  return [...arr].sort((a, b) => (f(a) < f(b) ? -dir : f(a) > f(b) ? dir : 0));
}
export function argmax(arr, f) {
  let best = -1, bv = -Infinity;
  arr.forEach((x, i) => {
    const v = f(x, i);
    if (v > bv) { bv = v; best = i; }
  });
  return best;
}
export function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// Spearman rank correlation, used for "privacy gradient" scoring.
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

export const titleCase = (s) => s.replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());
export const plural = (n, word, pl = `${word}s`) => `${n} ${n === 1 ? word : pl}`;
export const listJoin = (arr) =>
  arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
