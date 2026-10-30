// Stage 06 — spatial organisation as bubble diagrams (spec §56–74).
//
// Each space is a bubble whose area is proportional to its programme area. Bubbles move under
// explicit forces inside the chosen footprint, floor by floor:
//   • relationships (must touch / adjacent / near / visual attract; separated repels)
//   • one *strategy* field that makes the three options genuinely different (spec §69):
//       court    — social spaces wrap the court/garden, private ones sit across it
//       gradient — public → semi-public → private along the walking depth from the entrance
//       view     — rooms that value views/garden take the best edge; service buffers the worst
//   • site fields (noise, overlooking, breeze) weighted by the design intent
//   • containment in the footprint, no overlaps; locked bubbles never move (spec §71)
// Revisions restart the simulation from the selected layout, not from scratch (spec §72).

import { distanceInside, geodesic, maskCount } from '../geometry/grid.js';
import { footprintMask } from './footprint.js';
import { LIB, ZONES } from '../rules/spaces.js';
import { relSatisfaction } from '../rules/relations.js';
import { DESIGN } from '../rules/assumptions.js';
import { makeRng } from '../core/rng.js';
import { clamp, round, spearman, mean, sum } from '../core/util.js';

export const STRATEGIES = {
  court: { title: 'Courtyard-centric', short: 'Court', logic: 'Social spaces wrap the court (or the main garden/tree) so daily life faces inwards; private rooms sit across it.' },
  gradient: { title: 'Linear privacy gradient', short: 'Gradient', logic: 'A clear public → semi-public → private sequence by walking distance from the entrance.' },
  view: { title: 'Landscape / view-oriented', short: 'View', logic: 'Rooms that value views and garden take the best edge; service and stairs buffer the noisy, exposed or hot side.' },
};

const K_AREA = 0.72; // bubbles are drawn slightly smaller than true area so they can sit side by side

// Bubbles are ellipses aligned to the design frame (spec §66): same area as the circle, but
// stretched along a narrow wing so they fit it. a = semi-axis along s, b = along t.
function reshape(n, ff) {
  if (n.fixed && n.kind) return;
  const [sS, sT] = ff.spanAt(n.x, n.y);
  if (!sS || !sT) { n.a = n.b = n.r; return; }
  const r2 = n.r * n.r;
  if (sT <= sS) { n.b = Math.max(0.6, Math.min(n.r, (sT / 2) * 0.92)); n.a = Math.min(r2 / n.b, (sS / 2) * 0.95); }
  else { n.a = Math.max(0.6, Math.min(n.r, (sS / 2) * 0.92)); n.b = Math.min(r2 / n.a, (sT / 2) * 0.95); }
}
// radius of an axis-aligned ellipse in direction (ux, uy)
export const reff = (n, ux, uy) => {
  const a = n.a ?? n.r, b = n.b ?? n.r;
  return (a * b) / Math.sqrt((b * ux) ** 2 + (a * uy) ** 2 || 1e-9);
};

export const spaceRank = (s) => (s.attrs?.privacy ? Math.max(0.92, (LIB[s.type] || LIB.custom).rank) : s.zone ? (ZONES[s.zone]?.rank ?? 0.5) : (LIB[s.type] || LIB.custom).rank);
const noiseSens = (s) => (s.attrs?.noise ? 1 : (LIB[s.type] || LIB.custom).noise);
const viewPri = (s) => (s.attrs?.view ? 1 : (LIB[s.type] || LIB.custom).view);
const isSocial = (s) => ['formal_living', 'family_living', 'dining', 'kitchen', 'family_lounge', 'verandah'].includes(s.type);
const isService = (s) => ['utility', 'laundry', 'store', 'pantry', 'staff_room', 'staff_wc', 'motor_room', 'garage'].includes(s.type);

// ---------------------------------------------------------------------------------------------
export function bubbleContext(base) {
  // base: { A, F, footprint, zoning, brief, spaces, relations, priorities }
  const { F, footprint, zoning, brief } = base;
  const g = F.grid, c = g.c;
  const nFloors = Math.max(1, brief.floors || 1);
  const groundRoles = ['wing', 'link', 'stilt', 'garage'];
  const ground = footprintMask(g, footprint.rects, groundRoles);
  const upper = footprintMask(g, footprint.rects, ['wing', 'link', 'stilt']);
  const fixedGround = footprintMask(g, footprint.rects, ['garage', 'stilt']);
  const openOf = (kind) => {
    const m = new Uint8Array(g.n);
    for (const sp of zoning.spaces) if (sp.kind === kind || (kind === 'garden' && /garden/.test(sp.kind))) for (const k of sp.cells) m[k] = 1;
    return maskCount(m) ? m : null;
  };
  const anchorsOpen = { '@courtyard': openOf('courtyard'), '@garden': openOf('garden'), '@service-yard': openOf('service-yard') };
  const distTo = {};
  for (const [k, m] of Object.entries(anchorsOpen)) if (m) distTo[k] = distanceInside(g, m.map((v) => (v ? 0 : 1)));
  const ent = zoning.entranceCell;
  const entLocal = ent >= 0 ? g.centerLocal(ent % g.nx, Math.floor(ent / g.nx)) : [g.frame.S / 2, 0];
  // view/edge-quality field: desirable view + garden/court adjacency, minus noise & exposure
  const quality = new Float32Array(g.n);
  const dg = distTo['@garden'], dc = distTo['@courtyard'];
  for (let k = 0; k < g.n; k++) {
    const near = Math.max(dg ? Math.exp(-dg[k] / 2.5) : 0, dc ? Math.exp(-dc[k] / 2.5) : 0);
    quality[k] = 0.45 * near + 0.35 * clamp(F.view[k] + 0.5) - 0.2 * F.noise[k] - 0.15 * F.privacy[k];
  }
  return { ...base, g, c, nFloors, ground, upper, fixedGround, anchorsOpen, distTo, entLocal, quality };
}

// --- continuous field sampling on the grid (bilinear over cell centres) -----------------------
function sampler(g, field) {
  const { nx, ny, c } = g;
  const at = (i, j) => field[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
  const val = (s, t) => {
    const x = s / c - 0.5 + g.pad, y = t / c - 0.5 + g.pad;
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const v00 = at(i, j), v10 = at(i + 1, j), v01 = at(i, j + 1), v11 = at(i + 1, j + 1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };
  const grad = (s, t) => [(val(s + c, t) - val(s - c, t)) / (2 * c), (val(s, t + c) - val(s, t - c)) / (2 * c)];
  return { val, grad };
}

function floorFields(X, f, stairRect, voidMask) {
  const g = X.g;
  const base = f === 0 ? X.ground : X.upper;
  const occupied = new Uint8Array(g.n);
  if (f === 0) for (let k = 0; k < g.n; k++) if (X.fixedGround[k]) occupied[k] = 1;
  if (stairRect) for (const k of rectCellsOf(g, stairRect)) occupied[k] = 1;
  if (voidMask) for (let k = 0; k < g.n; k++) if (voidMask[k]) occupied[k] = 1;
  const free = base.map((v, k) => (v && !occupied[k] ? 1 : 0));
  const din = distanceInside(g, free);
  const dout = distanceInside(g, free.map((v) => (v ? 0 : 1)));
  const sd = din.map((v, k) => (free[k] ? v : -dout[k]));
  // walking depth: from the entrance on the ground floor, from the stair landing above
  const seeds = [];
  if (f === 0) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < g.n; k++) if (free[k]) {
      const [s, t] = g.centerLocal(k % g.nx, Math.floor(k / g.nx));
      const d = Math.hypot(s - X.entLocal[0], t - X.entLocal[1]);
      if (d < bd) { bd = d; best = k; }
    }
    if (best >= 0) seeds.push(best);
  } else if (stairRect) {
    for (let k = 0; k < g.n; k++) if (free[k]) {
      const [s, t] = g.centerLocal(k % g.nx, Math.floor(k / g.nx));
      if (s > stairRect.s0 - 0.6 && s < stairRect.s1 + 0.6 && t > stairRect.t0 - 0.6 && t < stairRect.t1 + 0.6) seeds.push(k);
    }
  }
  const geo = geodesic(g, free, seeds);
  let gmax = 0;
  for (let k = 0; k < g.n; k++) if (free[k] && Number.isFinite(geo[k])) gmax = Math.max(gmax, geo[k]);
  const geoN = geo.map((v, k) => (free[k] && Number.isFinite(v) ? v / (gmax || 1) : 1));
  // free run lengths along each frame axis: how long / deep the wing is at each cell
  const spanS = new Float32Array(g.n), spanT = new Float32Array(g.n);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx;) {
    if (!free[j * g.nx + i]) { i++; continue; }
    let e = i; while (e < g.nx && free[j * g.nx + e]) e++;
    for (let a = i; a < e; a++) spanS[j * g.nx + a] = (e - i) * g.c;
    i = e;
  }
  for (let i = 0; i < g.nx; i++) for (let j = 0; j < g.ny;) {
    if (!free[j * g.nx + i]) { j++; continue; }
    let e = j; while (e < g.ny && free[e * g.nx + i]) e++;
    for (let b = j; b < e; b++) spanT[b * g.nx + i] = (e - j) * g.c;
    j = e;
  }
  const spanAt = (x, y) => {
    const [i, j] = g.cellOf(x, y);
    if (!g.inBounds(i, j)) return [0, 0];
    const k = j * g.nx + i;
    return [spanS[k], spanT[k]];
  };
  return { free, sd: sampler(g, sd), geo: sampler(g, geoN), geoRaw: geo, gmax, area: maskCount(free) * g.c * g.c, spanAt };
}

export function rectCellsOf(g, r) {
  const out = [];
  const rc = g.rectCells(r);
  for (let j = Math.max(0, rc.j0); j < Math.min(g.ny, rc.j1); j++) for (let i = Math.max(0, rc.i0); i < Math.min(g.nx, rc.i1); i++) out.push(j * g.nx + i);
  return out;
}

// --- stair placement (same rectangle on every floor) ------------------------------------------
function placeStair(X, strategy, rng) {
  if (X.nFloors < 2) return null;
  const g = X.g, c = g.c;
  const both = X.ground.map((v, k) => (v && X.upper[k] && !X.fixedGround[k] ? 1 : 0));
  const din = distanceInside(g, both);
  const best = { score: -Infinity, rect: null };
  const G0 = floorFields(X, 0, null, null);
  const qS = sampler(g, X.quality), dcS = X.distTo['@courtyard'] ? sampler(g, X.distTo['@courtyard']) : null;
  for (const [w, d] of [[DESIGN.stair.w, DESIGN.stair.d], [DESIGN.stair.d, DESIGN.stair.w]]) {
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const r = { s0: g.s0(i), t0: g.t0(j), s1: g.s0(i) + w, t1: g.t0(j) + d };
      const cells = rectCellsOf(g, r);
      if (cells.length !== Math.round((w / c) * (d / c)) || cells.some((k) => !both[k])) continue;
      const cs = (r.s0 + r.s1) / 2, ct = (r.t0 + r.t1) / 2;
      const dEnt = Math.hypot(cs - X.entLocal[0], ct - X.entLocal[1]);
      const geo = G0.geo.val(cs, ct);
      let sc = 1 - Math.abs(dEnt - 5.5) / 10 - Math.abs(geo - 0.32) * 1.2;
      // along an outside wall (daylight) rather than mid-plan
      const minDin = Math.min(...cells.map((k) => din[k]));
      sc += minDin <= c ? 0.25 : -0.15;
      if (strategy === 'view') sc -= 0.6 * qS.val(cs, ct);
      if (strategy === 'court' && dcS) sc += 0.4 * Math.exp(-dcS.val(cs, ct) / 3);
      sc += rng.next() * 0.08;
      if (sc > best.score) { best.score = sc; best.rect = r; }
    }
  }
  return best.rect;
}

// --- one simulation ------------------------------------------------------------------------------
function simulate(X, floorSpaces, f, strategy, ff, opts) {
  const { rng, init, keep = new Set(), extraRel = [], stairRect, iters = 420, temp = 1, dirTargets = {} } = opts;
  const g = X.g;
  const W = X.priorities || {};
  const P = (k) => (W[k] != null ? W[k] : 1);
  const nodes = floorSpaces.map((s) => ({ s, id: s.id, r: Math.sqrt((Math.max(1, s.area) * K_AREA) / Math.PI), x: 0, y: 0, fixed: !!(s.pinned || keep.has(s.id)) }));
  const fixedNodes = [];
  if (stairRect) fixedNodes.push({ id: '@stair', r: Math.sqrt((DESIGN.stair.w * DESIGN.stair.d * 0.9) / Math.PI), a: (stairRect.s1 - stairRect.s0) / 2, b: (stairRect.t1 - stairRect.t0) / 2, x: (stairRect.s0 + stairRect.s1) / 2, y: (stairRect.t0 + stairRect.t1) / 2, fixed: true, kind: 'stair' });
  for (const v of opts.voids || []) fixedNodes.push({ ...v, fixed: true, kind: 'void' });
  const all = [...nodes, ...fixedNodes];
  const byId = new Map(all.map((n) => [n.id, n]));
  const cells = [];
  for (let k = 0; k < g.n; k++) if (ff.free[k]) cells.push(k);
  if (!cells.length) return { nodes: [], fixedNodes };
  const qS = sampler(g, X.quality), noiseS = sampler(g, X.F.noise), privS = sampler(g, X.F.privacy), breezeS = sampler(g, X.F.breeze);
  const anchorS = Object.fromEntries(Object.entries(X.distTo).map(([k, d]) => [k, sampler(g, d)]));
  const target = (s) => {
    const rank = spaceRank(s);
    return 0.05 + 0.9 * rank;
  };
  // strategy preference value at a point for a space (higher = better)
  const prefer = (s, x, y) => {
    if (strategy === 'gradient') return -Math.abs(ff.geo.val(x, y) - target(s)) * 2;
    if (strategy === 'court') {
      const ds = anchorS['@courtyard'] || anchorS['@garden'];
      const d = ds ? ds.val(x, y) : 0;
      if (isSocial(s)) return -d / 3;
      if (isService(s)) return Math.min(d, 8) / 8 - (anchorS['@service-yard'] ? anchorS['@service-yard'].val(x, y) / 6 : 0);
      return -Math.abs(ff.geo.val(x, y) - target(s)) - d / 10;
    }
    const q = qS.val(x, y);
    return viewPri(s) >= 0.5 ? q * 3 : -q * 2;
  };
  // init
  for (const n of nodes) {
    if (init && init[n.id]) { n.x = init[n.id][0]; n.y = init[n.id][1]; continue; }
    let best = null, bv = -Infinity;
    for (let k = 0; k < 10; k++) {
      const cell = cells[Math.floor(rng.next() * cells.length)];
      const [x, y] = g.centerLocal(cell % g.nx, Math.floor(cell / g.nx));
      const v = prefer(n.s, x, y) + rng.next() * 0.3;
      if (v > bv) { bv = v; best = [x, y]; }
    }
    n.x = best[0] + (rng.next() - 0.5) * 0.5; n.y = best[1] + (rng.next() - 0.5) * 0.5;
  }
  for (const n of nodes) reshape(n, ff);
  const rels = [...(X.relations || []), ...extraRel].filter((r) => {
    const a = byId.has(r.a) || r.a.startsWith('@'), b = byId.has(r.b) || r.b.startsWith('@');
    return a && b && (byId.has(r.a) || byId.has(r.b));
  });
  const pointOf = (id, from) => {
    if (byId.has(id)) { const n = byId.get(id); return { x: n.x, y: n.y, r: n.r }; }
    return null;
  };
  for (let it = 0; it < iters; it++) {
    const T = temp * (1 - it / iters) * 0.9 + 0.1;
    // last phase: tidy up — overlaps and containment dominate so the diagram reads cleanly
    const tidy = it > iters * 0.7;
    const kRel = tidy ? 0.3 : 1, kField = tidy ? 0.2 : 1, kOver = tidy ? 1.7 : 1;
    const fx = new Map(nodes.map((n) => [n.id, [0, 0]]));
    const addF = (n, a, b) => { if (!n.fixed && fx.has(n.id)) { const v = fx.get(n.id); v[0] += a; v[1] += b; } };
    // overlaps
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      let dx = B.x - A.x, dy = B.y - A.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) { dx = rng.next() - 0.5; dy = rng.next() - 0.5; d = Math.hypot(dx, dy); }
      const ux = dx / d, uy = dy / d;
      const min = (reff(A, ux, uy) + reff(B, ux, uy)) * 0.97;
      if (d < min) {
        const push = (min - d) * 0.5 * kOver;
        const wa = A.fixed ? 0 : B.fixed ? 2 : 1, wb = B.fixed ? 0 : A.fixed ? 2 : 1;
        addF(A, -ux * push * wa, -uy * push * wa); addF(B, ux * push * wb, uy * push * wb);
      }
    }
    // relationships
    for (const rel of rels) {
      const w = (rel.strength || 1) / 3;
      const A = byId.get(rel.a), B = byId.get(rel.b);
      if (A && B) {
        const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1e-6, ux = dx / d, uy = dy / d;
        const gap = d - reff(A, ux, uy) - reff(B, ux, uy);
        let k = 0;
        if (rel.type === 'must_touch') k = gap > 0 ? gap * 0.6 : 0;
        else if (rel.type === 'adjacent') k = gap > 0.3 ? (gap - 0.3) * 0.35 : 0;
        else if (rel.type === 'near') k = gap > 2.5 ? (gap - 2.5) * 0.15 : 0;
        else if (rel.type === 'visual') k = gap > 3.5 ? (gap - 3.5) * 0.08 : 0;
        else if (rel.type === 'separated') k = gap < 4 ? -(4 - gap) * 0.3 : 0;
        else if (rel.type === 'must_not_touch') k = gap < 1 ? -(1 - gap) * 0.6 : 0;
        k *= w * kRel;
        addF(A, ux * k, uy * k); addF(B, -ux * k, -uy * k);
      } else {
        // relation to an open-space anchor: climb down its distance field
        const n = A || B, anchor = A ? rel.b : rel.a;
        const S = anchorS[anchor];
        if (!n || !S) continue;
        const d = S.val(n.x, n.y);
        const [gx, gy] = S.grad(n.x, n.y);
        const L = Math.hypot(gx, gy) || 1;
        let k = 0;
        if (['must_touch', 'adjacent'].includes(rel.type)) k = d > n.r * 0.6 ? -(d - n.r * 0.6) * 0.3 : 0;
        else if (['near', 'visual'].includes(rel.type)) k = d > n.r + 2 ? -(d - n.r - 2) * 0.12 : 0;
        else if (rel.type === 'separated') k = d < n.r + 4 ? (n.r + 4 - d) * 0.25 : 0;
        k *= w * kRel;
        addF(n, (gx / L) * k, (gy / L) * k);
      }
    }
    // strategy + site fields
    for (const n of nodes) {
      if (n.fixed) continue;
      const s = n.s, e = 0.25;
      const pv = prefer(s, n.x, n.y);
      const gxp = (prefer(s, n.x + e, n.y) - prefer(s, n.x - e, n.y)) / (2 * e);
      const gyp = (prefer(s, n.x, n.y + e) - prefer(s, n.x, n.y - e)) / (2 * e);
      void pv;
      addF(n, gxp * 0.9 * kField, gyp * 0.9 * kField);
      const [ngx, ngy] = noiseS.grad(n.x, n.y);
      addF(n, -ngx * noiseSens(s) * P('noise') * 1.5, -ngy * noiseSens(s) * P('noise') * 1.5);
      const [pgx, pgy] = privS.grad(n.x, n.y);
      const rk = spaceRank(s);
      addF(n, -pgx * rk * P('privacy') * 1.2, -pgy * rk * P('privacy') * 1.2);
      if (isSocial(s)) { const [bgx, bgy] = breezeS.grad(n.x, n.y); addF(n, bgx * P('ventilation') * 0.6, bgy * P('ventilation') * 0.6); }
      if (dirTargets[n.id]) { const [tx, ty] = dirTargets[n.id]; addF(n, (tx - n.x) * 0.12, (ty - n.y) * 0.12); }
      // containment: the whole ellipse should sit inside (narrow semi-axis from the nearest edge)
      const sd = ff.sd.val(n.x, n.y);
      const need = Math.min(n.a ?? n.r, n.b ?? n.r) * (tidy ? 0.95 : 0.7);
      if (sd < need) {
        const [gx, gy] = ff.sd.grad(n.x, n.y);
        const L = Math.hypot(gx, gy) || 1;
        addF(n, (gx / L) * (need - sd) * 1.5, (gy / L) * (need - sd) * 1.5);
      }
    }
    if (it % 8 === 0) for (const n of nodes) reshape(n, ff);
    const maxStep = 0.6 * T;
    for (const n of nodes) {
      if (n.fixed) continue;
      let [vx, vy] = fx.get(n.id);
      const L = Math.hypot(vx, vy);
      if (L > maxStep) { vx *= maxStep / L; vy *= maxStep / L; }
      n.x += vx + (it < iters * 0.4 ? (rng.next() - 0.5) * 0.08 * T : 0);
      n.y += vy + (it < iters * 0.4 ? (rng.next() - 0.5) * 0.08 * T : 0);
    }
  }
  for (const n of nodes) reshape(n, ff);
  return { nodes, fixedNodes };
}

// --- scoring --------------------------------------------------------------------------------------
function scoreLayout(X, floors, strategy) {
  const W = X.priorities || {};
  const P = (k) => (W[k] != null ? W[k] : 1);
  const g = X.g;
  const noiseS = sampler(g, X.F.noise), privS = sampler(g, X.F.privacy), qS = sampler(g, X.quality);
  const anchorS = Object.fromEntries(Object.entries(X.distTo).map(([k, d]) => [k, sampler(g, d)]));
  const pos = new Map();
  for (const fl of floors) for (const n of [...fl.nodes, ...fl.fixedNodes]) pos.set(`${fl.f}:${n.id}`, { ...n, f: fl.f });
  const find = (id) => { for (const fl of floors) { const n = [...fl.nodes, ...fl.fixedNodes].find((x) => x.id === id); if (n) return { ...n, f: fl.f }; } return null; };
  let att = 0, attW = 0, sep = 0, sepW = 0;
  const relDetail = [];
  for (const rel of X.relations || []) {
    const A = find(rel.a), B = rel.b.startsWith('@') && rel.b !== '@stair' ? null : find(rel.b);
    if (!A) continue;
    let gap;
    if (B) {
      if (A.f !== B.f) continue;
      const d = Math.hypot(A.x - B.x, A.y - B.y) || 1e-6, ux = (B.x - A.x) / d, uy = (B.y - A.y) / d;
      gap = d - reff(A, ux, uy) - reff(B, ux, uy);
    }
    else { const S = anchorS[rel.b]; if (!S) continue; gap = S.val(A.x, A.y) - A.r * 0.6; }
    const sat = relSatisfaction(rel.type, gap);
    const w = rel.strength || 1;
    if (['separated', 'must_not_touch'].includes(rel.type)) { sep += w * sat; sepW += w; } else { att += w * sat; attW += w; }
    relDetail.push({ rel, sat });
  }
  let overlap = 0, total = 0, outside = 0;
  const ranks = [], depths = [];
  let nz = 0, nzW = 0, pz = 0, pzW = 0, vz = 0, vzW = 0, courtz = 0, courtW = 0;
  for (const fl of floors) {
    const all = [...fl.nodes, ...fl.fixedNodes];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j], d = Math.hypot(a.x - b.x, a.y - b.y) || 1e-6;
      const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
      const ra = reff(a, ux, uy), rb = reff(b, ux, uy);
      const o = ra + rb - d;
      if (o > 0.2 * Math.min(ra, rb)) overlap += o;
    }
    for (const n of fl.nodes) {
      const s = n.s;
      total += n.r;
      if (fl.ff.sd.val(n.x, n.y) < Math.min(n.a ?? n.r, n.b ?? n.r) * 0.3) outside += n.r;
      if ((n.a ?? n.r) * (n.b ?? n.r) < n.r * n.r * 0.9) overlap += n.r * 0.3; // squeezed below its area
      ranks.push(spaceRank(s) + fl.f * 0.5); depths.push(fl.ff.geo.val(n.x, n.y) + fl.f);
      const ns = noiseSens(s); nz += ns * (1 - noiseS.val(n.x, n.y)); nzW += ns;
      const rk = spaceRank(s); pz += rk * (1 - privS.val(n.x, n.y)); pzW += rk;
      const vp = viewPri(s); vz += vp * clamp(qS.val(n.x, n.y) + 0.3); vzW += vp;
      const ds = anchorS['@courtyard'] || anchorS['@garden'];
      if (ds && isSocial(s)) { courtz += Math.exp(-Math.max(0, ds.val(n.x, n.y) - n.r) / 3); courtW++; }
    }
  }
  const sc = {
    adjacency: attW ? att / attW : 1,
    separation: sepW ? sep / sepW : 1,
    gradient: clamp((spearman(ranks, depths) + 0.2) / 1.0),
    noise: nzW ? nz / nzW : 1,
    privacy: pzW ? pz / pzW : 1,
    views: vzW ? clamp(vz / vzW) : 0.5,
    court: courtW ? courtz / courtW : 0.5,
    fit: clamp(1 - (overlap / Math.max(1, total)) * 1.5 - (outside / Math.max(1, total)) * 2),
  };
  const w = { adjacency: 3, separation: 1.5, gradient: P('privacy') + 0.5 * P('procession'), noise: P('noise'), privacy: P('privacy'), views: P('views'), court: P('courtyard'), fit: 4 };
  let t = 0, ws = 0;
  for (const k in w) { t += w[k] * sc[k]; ws += w[k]; }
  return { scores: sc, total: t / ws, relDetail };
}

// --- public API -------------------------------------------------------------------------------------
// opts.init: positions of pinned bubbles ({id: [x, y]}); opts.stair keeps an existing stair.
export function generateBubbleOptions(X, seed = 1, strategies = ['court', 'gradient', 'view'], opts = {}) {
  const rng = makeRng(`bub-${seed}`);
  const out = [];
  for (const strategy of strategies) {
    let best = null;
    for (let run = 0; run < 6; run++) {
      const lay = layoutAll(X, strategy, { rng, seed: seed * 100 + run, init: opts.init || null, stairRect: opts.stair });
      const sc = scoreLayout(X, lay.floors, strategy);
      if (!best || sc.total > best.total) best = { ...lay, ...sc, strategy };
    }
    out.push(best);
  }
  const options = out.map((o, i) => serialiseOption(X, o, String.fromCharCode(65 + i), out));
  const top = options.reduce((a, b) => (b.total > a.total ? b : a), options[0]);
  if (top) top.recommended = true;
  return options;
}

function layoutAll(X, strategy, { rng, init = null, keep = new Set(), extraRel = [], stairRect = undefined, iters, temp, dirTargets = {}, floorOverride = {} }) {
  const stair = stairRect !== undefined ? stairRect : placeStair(X, strategy, rng);
  const floors = [];
  let voidsBelow = [];
  const spaces = X.spaces.map((s) => ({ ...s, floorAuto: floorOverride[s.id] ?? s.floorAuto ?? 0 }));
  for (let f = 0; f < X.nFloors; f++) {
    const voidMask = voidsBelow.length ? new Uint8Array(X.g.n) : null;
    if (voidMask) for (const v of voidsBelow) for (let k = 0; k < X.g.n; k++) {
      const [s, t] = X.g.centerLocal(k % X.g.nx, Math.floor(k / X.g.nx));
      if (Math.hypot(s - v.x, t - v.y) < v.r * 0.85) voidMask[k] = 1;
    }
    const ff = floorFields(X, f, stair, voidMask);
    const fs = spaces.filter((s) => (s.floorAuto ?? 0) === f);
    const sim = simulate(X, fs, f, strategy, ff, { rng, init, keep, extraRel, stairRect: stair, voids: voidsBelow, iters, temp, dirTargets });
    floors.push({ f, ff, nodes: sim.nodes, fixedNodes: sim.fixedNodes });
    voidsBelow = sim.nodes.filter((n) => n.s.dh).map((n) => ({ id: `@void-${n.id}`, of: n.id, x: n.x, y: n.y, r: n.r }));
  }
  return { floors, stair };
}

function serialiseOption(X, o, id, siblings) {
  const S = STRATEGIES[o.strategy];
  const floors = o.floors.map((fl) => ({
    f: fl.f,
    nodes: fl.nodes.map((n) => ({ id: n.id, x: round(n.x, 2), y: round(n.y, 2), r: round(n.r, 2), a: round(n.a ?? n.r, 2), b: round(n.b ?? n.r, 2) })),
    fixed: fl.fixedNodes.map((n) => ({ id: n.id, kind: n.kind, of: n.of, x: round(n.x, 2), y: round(n.y, 2), r: round(n.r, 2), a: round(n.a ?? n.r, 2), b: round(n.b ?? n.r, 2) })),
  }));
  const { pros, cons } = explainBubbles(X, o, siblings);
  return { id, strategy: o.strategy, title: S.title, logic: S.logic, stair: o.stair, floors, scores: o.scores, total: o.total, pros, cons };
}

function explainBubbles(X, o, siblings) {
  const s = o.scores, pros = [], cons = [];
  const others = siblings.filter((x) => x !== o);
  const best = (k) => others.every((x) => s[k] >= x.scores[k] - 0.02);
  const worst = (k) => others.every((x) => s[k] <= x.scores[k] + 0.02);
  const nameOf = (id) => (X.spaces.find((x) => x.id === id) || {}).name || id.replace('@', '');
  const failed = o.relDetail.filter((d) => d.sat < 0.4 && (d.rel.strength || 1) >= 2).sort((a, b) => (b.rel.strength || 1) - (a.rel.strength || 1));
  const kept = o.relDetail.filter((d) => d.sat > 0.9 && (d.rel.strength || 1) >= 3 && !d.rel.note?.includes('attached'));
  if (s.adjacency > 0.8) pros.push(`Satisfies ${Math.round(s.adjacency * 100)}% of the weighted adjacencies${kept[0] ? ` (e.g. ${nameOf(kept[0].rel.a)} – ${nameOf(kept[0].rel.b)})` : ''}.`);
  if (s.gradient > 0.7) pros.push('Clear public-to-private sequence from the entrance.');
  if (s.court > 0.65 && (X.distTo['@courtyard'] || X.distTo['@garden'])) pros.push(`Living spaces gather on the ${X.distTo['@courtyard'] ? 'court' : 'garden'}.`);
  if (s.noise > 0.75 && best('noise')) pros.push('Noise-sensitive rooms sit in the quietest part of the plan.');
  if (s.views > 0.6 && best('views')) pros.push('Rooms that value views take the best edges.');
  if (s.privacy > 0.7 && best('privacy')) pros.push('Private rooms are least exposed to the street and neighbours.');
  if (failed.length) cons.push(`${failed.slice(0, 2).map((d) => `${nameOf(d.rel.a)} – ${nameOf(d.rel.b)} (${d.rel.type.replace('_', ' ')})`).join('; ')} not achieved.`);
  if (s.gradient < 0.45) cons.push('Public and private spaces are mixed — visitors pass private rooms.');
  if (worst('noise') && s.noise < 0.7) cons.push('Some sensitive rooms sit in the noisier zone.');
  if (worst('views') && s.views < 0.55) cons.push('The best edges are given to less important rooms.');
  if (s.fit < 0.8) cons.push('Bubbles are crowded — the floor is tight for this programme.');
  return { pros: pros.slice(0, 4), cons: cons.slice(0, 3) };
}

// Hydrate a stored option into the shape layoutAll returns (for scoring/revision).
function hydrate(X, opt) {
  const floors = opt.floors.map((fl) => {
    const voids = fl.fixed.filter((n) => n.kind === 'void');
    const voidMask = voids.length ? new Uint8Array(X.g.n) : null;
    if (voidMask) for (const v of voids) for (let k = 0; k < X.g.n; k++) {
      const [s, t] = X.g.centerLocal(k % X.g.nx, Math.floor(k / X.g.nx));
      if (Math.hypot(s - v.x, t - v.y) < v.r * 0.85) voidMask[k] = 1;
    }
    const ff = floorFields(X, fl.f, opt.stair, voidMask);
    const nodes = fl.nodes.map((n) => ({ ...n, s: X.spaces.find((s) => s.id === n.id) })).filter((n) => n.s);
    return { f: fl.f, ff, nodes, fixedNodes: fl.fixed.map((n) => ({ ...n })) };
  });
  return { floors, stair: opt.stair };
}

export function rescore(X, opt) {
  const lay = hydrate(X, opt);
  return scoreLayout(X, lay.floors, opt.strategy);
}

// Apply interpreted revision commands to the selected option (spec §72): the simulation restarts
// from the current positions; kept/locked bubbles do not move.
export function reviseOption(X, opt, cmds, seed = 7) {
  const rng = makeRng(`rev-${seed}`);
  const init = {};
  for (const fl of opt.floors) for (const n of fl.nodes) init[n.id] = [n.x, n.y];
  const keep = new Set();
  const extraRel = [];
  const dirTargets = {};
  const floorOverride = {};
  const notes = [];
  const g = X.g, fr = g.frame;
  // footprint extremes for directional moves
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (let k = 0; k < g.n; k++) if (X.ground[k]) {
    const [s, t] = g.centerLocal(k % g.nx, Math.floor(k / g.nx));
    sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  const north = X.A.northDeg || 0;
  const compassVec = (name) => {
    const b = { north: 0, east: 90, south: 180, west: 270 }[name];
    const r = ((b + north) * Math.PI) / 180;
    return fr.localDir([Math.sin(r), Math.cos(r)]);
  };
  for (const c of cmds) {
    if (c.kind === 'keep') c.ids.forEach((id) => keep.add(id));
    else if (c.kind === 'attract') extraRel.push({ a: c.a, b: c.b, type: 'adjacent', strength: 5 });
    else if (c.kind === 'repel') extraRel.push({ a: c.a, b: c.b, type: 'separated', strength: 5 });
    else if (c.kind === 'relate') extraRel.push({ a: c.a, b: c.b, type: c.type, strength: 4 });
    else if (c.kind === 'swap') {
      const a = init[c.a], b = init[c.b];
      const sa = X.spaces.find((s) => s.id === c.a), sb = X.spaces.find((s) => s.id === c.b);
      if (a && b) { init[c.a] = b; init[c.b] = a; }
      if (sa && sb && sa.floorAuto !== sb.floorAuto) { floorOverride[c.a] = sb.floorAuto; floorOverride[c.b] = sa.floorAuto; }
      keep.add(c.a); keep.add(c.b);
    } else if (c.kind === 'direction') {
      const cur = init[c.a];
      if (!cur) continue;
      const cs = (sMin + sMax) / 2, ct = (tMin + tMax) / 2;
      let v;
      if (['north', 'south', 'east', 'west'].includes(c.dir)) v = compassVec(c.dir);
      else v = { front: [0, -1], street: [0, -1], rear: [0, 1], left: [-1, 0], right: [1, 0], centre: [cs - cur[0], ct - cur[1]] }[c.dir];
      const L = Math.hypot(v[0], v[1]) || 1;
      const reach = c.dir === 'centre' ? L : Math.max(sMax - sMin, tMax - tMin);
      dirTargets[c.a] = [cur[0] + (v[0] / L) * reach, cur[1] + (v[1] / L) * reach];
    } else if (c.kind === 'floor') {
      const fl = c.floor === 'top' ? X.nFloors - 1 : Math.min(X.nFloors - 1, c.floor);
      floorOverride[c.a] = fl;
      for (const ch of X.spaces.filter((s) => s.parent === c.a)) floorOverride[ch.id] = fl;
      delete init[c.a];
    }
  }
  if (Object.keys(floorOverride).length) X = { ...X, spaces: X.spaces.map((s) => (floorOverride[s.id] != null ? { ...s, floorAuto: floorOverride[s.id] } : s)) };
  const lay = layoutAll(X, opt.strategy, { rng, init, keep, extraRel, stairRect: opt.stair, iters: 220, temp: 0.55, dirTargets });
  const sc = scoreLayout(X, lay.floors, opt.strategy);
  const next = serialiseOption(X, { ...lay, ...sc, strategy: opt.strategy }, opt.id, [{ ...lay, ...sc, strategy: opt.strategy }]);
  // what changed
  const before = new Map();
  for (const fl of opt.floors) for (const n of fl.nodes) before.set(n.id, { ...n, f: fl.f });
  const changed = [];
  for (const fl of next.floors) for (const n of fl.nodes) {
    const b = before.get(n.id);
    if (!b) { changed.push({ id: n.id, moved: null, floorFrom: null, floorTo: fl.f }); continue; }
    const d = Math.hypot(n.x - b.x, n.y - b.y);
    if (b.f !== fl.f || d > 0.75) changed.push({ id: n.id, moved: round(d, 1), floorFrom: b.f, floorTo: fl.f });
  }
  next.revision = { cmds, keep: [...keep], changed, notes };
  next.floorOverride = floorOverride;
  return next;
}

export { sampler as _sampler, floorFields as _floorFields, hydrate as _hydrate, mean as _mean, sum as _sum };
