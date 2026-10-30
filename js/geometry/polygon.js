// Deterministic 2D geometry on [x, y] points (metres). No AI anywhere near this file:
// areas, offsets, containment and distances are computed, never estimated.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
export const leftNormal = (d) => [-d[1], d[0]];
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function signedArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
export const area = (pts) => Math.abs(signedArea(pts));
export const isCCW = (pts) => signedArea(pts) > 0;

export function perimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += dist(pts[i], pts[(i + 1) % pts.length]);
  return p;
}

export function centroid(pts) {
  const A = signedArea(pts);
  if (Math.abs(A) < 1e-12) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function pointInPolygon(p, pts) {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  const t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return add(a, mul(ab, t));
}
export const distToSegment = (p, a, b) => dist(p, closestOnSegment(p, a, b));

export function distToPolyline(p, line) {
  let d = Infinity;
  for (let i = 0; i < line.length - 1; i++) d = Math.min(d, distToSegment(p, line[i], line[i + 1]));
  return d;
}
export function distToPolygonEdge(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}
// Distance from a point to a filled polygon (0 when inside).
export const distToPolygon = (p, pts) => (pointInPolygon(p, pts) ? 0 : distToPolygonEdge(p, pts));

function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : -1;
}
function onSeg(a, b, p) {
  return Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12;
}
export function segmentsIntersect(p1, p2, q1, q2) {
  const o1 = orient(p1, p2, q1), o2 = orient(p1, p2, q2), o3 = orient(q1, q2, p1), o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, q1)) return true;
  if (o2 === 0 && onSeg(p1, p2, q2)) return true;
  if (o3 === 0 && onSeg(q1, q2, p1)) return true;
  if (o4 === 0 && onSeg(q1, q2, p2)) return true;
  return false;
}

// A polygon is simple when no two non-adjacent edges touch.
export function selfIntersections(pts) {
  const n = pts.length, hits = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) hits.push([i, j]);
    }
  }
  return hits;
}
export const isSimple = (pts) => pts.length >= 3 && selfIntersections(pts).length === 0;

// Intersection of two infinite lines given as point + direction.
export function lineIntersect(p, d, q, e) {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, mul(d, t));
}

// Mitred inward offset of a CCW polygon with a distance per edge — the way setback lines are drawn
// by hand (parallel to each boundary, meeting at sharp corners). Edges that collapse (their offset
// segment flips direction) are removed and the neighbours re-intersected, a one-level
// straight-skeleton step that keeps short irregular edges from producing bow-ties.
export function insetPolygon(pts, dists) {
  let edges = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const dir = norm(sub(b, a));
    return { a, b, dir, d: dists[i], src: i };
  });
  let verts = null;
  for (let guard = 0; guard < pts.length; guard++) {
    if (edges.length < 3) return null;
    const lines = edges.map((e) => ({ p: add(e.a, mul(leftNormal(e.dir), e.d)), d: e.dir }));
    verts = lines.map((L, i) => {
      const P = lines[(i - 1 + lines.length) % lines.length];
      return lineIntersect(P.p, P.d, L.p, L.d) || L.p;
    });
    let worst = -1, worstDot = 1e-9;
    edges.forEach((e, i) => {
      const seg = sub(verts[(i + 1) % verts.length], verts[i]);
      const dd = dot(seg, e.dir);
      if (dd < worstDot) { worstDot = dd; worst = i; }
    });
    if (worst < 0) break;
    edges = edges.filter((_, i) => i !== worst);
  }
  if (!verts || verts.length < 3 || signedArea(verts) <= 1e-6 || !isSimple(verts)) return null;
  return { pts: verts, edgeSource: edges.map((e) => e.src) };
}

// Sutherland–Hodgman: clip any polygon by a convex CCW polygon. Used for exact overlap areas
// (e.g. how much of a tree exclusion square falls inside the setback line).
export function clipByConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length];
    const inside = (p) => cross(sub(B, A), sub(p, A)) >= -1e-12;
    const inter = (p, q) => {
      const d = sub(q, p), e = sub(B, A);
      const den = cross(d, e);
      if (Math.abs(den) < 1e-12) return q;
      const t = cross(sub(A, p), e) / den;
      return add(p, mul(d, t));
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length];
      const pin = inside(P), qin = inside(Q);
      if (pin && qin) out.push(Q);
      else if (pin && !qin) out.push(inter(P, Q));
      else if (!pin && qin) { out.push(inter(P, Q)); out.push(Q); }
    }
  }
  return out;
}

export const rectPoly = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Compass helpers. bearing = degrees clockwise from true north; northDeg = how far true north is
// rotated clockwise from the drawing's +Y axis (0 means "up is north", the spec default).
export function bearingOf(vec, northDeg = 0) {
  const b = (Math.atan2(vec[0], vec[1]) * 180) / Math.PI - northDeg;
  return ((b % 360) + 360) % 360;
}
export function vecFromBearing(bearing, northDeg = 0) {
  const r = ((bearing + northDeg) * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
const COMPASS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass8 = (b) => COMPASS8[Math.round((((b % 360) + 360) % 360) / 45) % 8];
export const COMPASS_NAMES = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };
