// Stage 07 — single-line plans (spec §75–83).
//
// Wing-and-spine slicing, guided by the accepted bubble diagram:
//  1. each footprint rectangle is a wing; the stair, double-height voids and the garage are fixed
//     blocks cut out of it, leaving straight segments;
//  2. rooms go to the segment their bubble sits in (capacity-balanced; suites travel together);
//  3. a segment that serves two or more private rooms gets a corridor — single-loaded along the
//     court/garden side (or the outer side), or double-loaded in deep wings;
//  4. rooms are sliced along the segment in the order of their bubbles, so the plan keeps the
//     arrangement the architect approved; small rooms stack, suites carve their bath/dressing;
//  5. walls, open partitions, doors and an access check are derived from the result.
// Everything is rectangles on a 0.1 m snap, so areas are exact and nothing leaves the footprint.

import { LIB } from '../rules/spaces.js';
import { DESIGN } from '../rules/assumptions.js';
import { round, sum, clamp } from '../core/util.js';
import { _sampler as sampler } from './bubbles.js';

const SNAP = 0.1;
const sn = (v) => Math.round(v / SNAP) * SNAP;
const rArea = (r) => Math.max(0, r.s1 - r.s0) * Math.max(0, r.t1 - r.t0);
const overlap = (a, b) => a.s0 < b.s1 - 1e-6 && a.s1 > b.s0 + 1e-6 && a.t0 < b.t1 - 1e-6 && a.t1 > b.t0 + 1e-6;
const HUBS = new Set(['foyer', 'formal_living', 'family_living', 'dining', 'family_lounge', 'verandah', 'ext_stair', 'passage', 'landing']);
const SMALL = (type) => ['bath', 'master_bath', 'guest_bath', 'powder', 'staff_wc', 'store', 'pantry', 'puja', 'motor_room', 'laundry', 'dressing', 'balcony'].includes(type);

export const PLAN_VARIANTS = {
  verandah: { title: 'Court-side verandah', logic: 'Corridors become a verandah facing the court or garden; rooms take the outer walls. Living, dining and family flow together; the kitchen is enclosed.' },
  court: { title: 'Rooms on the court', logic: 'Corridors run along the outer walls so the rooms themselves open onto the court or garden.' },
  open: { title: 'Open-plan living', logic: 'Court-side circulation, with living, dining, family and kitchen as one continuous volume — fewer walls, more cross-ventilation, less separation of smells and noise.' },
};

// Order touching rectangles into the longest simple paths (brute force — a floor has few wings).
function orderPaths(nodes, startPt) {
  const n = nodes.length;
  const adj = nodes.map((A, i) => nodes.map((B, j) => {
    if (i === j) return false;
    const sh = shared(A, B);
    return !!sh && sh.len >= 1.0;
  }));
  const distTo = (k) => {
    const N = nodes[k];
    return Math.hypot(Math.max(N.s0 - startPt[0], 0, startPt[0] - N.s1), Math.max(N.t0 - startPt[1], 0, startPt[1] - N.t1));
  };
  const remaining = new Set(nodes.map((_, i) => i));
  const paths = [];
  while (remaining.size) {
    let best = [];
    const starts = [...remaining].sort((a, b) => distTo(a) - distTo(b));
    for (const st of starts) {
      const used = new Set([st]);
      const dfs = (path) => {
        if (path.length > best.length || (path.length === best.length && distTo(path[0]) < distTo(best[0]))) best = [...path];
        if (best.length === remaining.size) return;
        const last = path[path.length - 1];
        for (const j of remaining) if (!used.has(j) && adj[last][j]) { used.add(j); path.push(j); dfs(path); path.pop(); used.delete(j); }
      };
      dfs([st]);
      if (best.length === remaining.size) break;
    }
    paths.push(best);
    for (const k of best) remaining.delete(k);
  }
  return paths;
}

const floorLabel = (f) => (f === 0 ? 'Ground floor' : `Floor ${f}`);

function subtract(R, B) {
  if (!overlap(R, B)) return [R];
  const out = [];
  if (B.s0 > R.s0) out.push({ ...R, s1: B.s0 });
  if (B.s1 < R.s1) out.push({ ...R, s0: B.s1 });
  const s0 = Math.max(R.s0, B.s0), s1 = Math.min(R.s1, B.s1);
  if (B.t0 > R.t0) out.push({ ...R, s0, s1, t1: B.t0 });
  if (B.t1 < R.t1) out.push({ ...R, s0, s1, t0: B.t1 });
  return out.filter((r) => r.s1 - r.s0 > 0.05 && r.t1 - r.t0 > 0.05);
}

// shared boundary length between two rects (0 when they only meet at a corner)
function shared(a, b) {
  const e = 1e-6;
  if (Math.abs(a.s1 - b.s0) < e || Math.abs(b.s1 - a.s0) < e) {
    const lo = Math.max(a.t0, b.t0), hi = Math.min(a.t1, b.t1);
    if (hi - lo > e) return { len: hi - lo, axis: 't', at: Math.abs(a.s1 - b.s0) < e ? a.s1 : a.s0, lo, hi };
  }
  if (Math.abs(a.t1 - b.t0) < e || Math.abs(b.t1 - a.t0) < e) {
    const lo = Math.max(a.s0, b.s0), hi = Math.min(a.s1, b.s1);
    if (hi - lo > e) return { len: hi - lo, axis: 's', at: Math.abs(a.t1 - b.t0) < e ? a.t1 : a.t0, lo, hi };
  }
  return null;
}

export function generatePlans(X, bubbleOpt, opts = {}) {
  const variants = opts.variants || ['verandah', 'court', 'open'];
  const out = variants.map((v, i) => {
    const plan = buildPlan(X, bubbleOpt, { ...opts, variant: v === 'open' ? 'verandah' : v, openness: v === 'open' ? 'open' : opts.openness || 'semi', label: v });
    plan.id = String.fromCharCode(65 + i);
    return plan;
  });
  const best = out.reduce((a, b) => (b.total > a.total ? b : a), out[0]);
  if (best) best.recommended = true;
  return out;
}

export function buildPlan(X, bubbleOpt, { variant = 'verandah', openPairs = [], openness = 'semi', label = null } = {}) {
  const fp = X.footprint;
  const nF = X.nFloors;
  const spaces = X.spaces.map((s) => ({ ...s, floorAuto: bubbleOpt.floorOverride?.[s.id] ?? s.floorAuto ?? 0 }));
  const posOf = new Map();
  for (const fl of bubbleOpt.floors) for (const n of fl.nodes) posOf.set(n.id, [n.x, n.y]);
  const g = X.g;
  const courtD = X.distTo['@courtyard'] ? sampler(g, X.distTo['@courtyard']) : null;
  const gardenD = X.distTo['@garden'] ? sampler(g, X.distTo['@garden']) : null;
  const openSet = new Set(openPairs.map(([a, b]) => [a, b].sort().join('|')));
  const typeOf = new Map(spaces.map((s) => [s.id, s.type]));
  const isOpen = (a, b) => {
    if (openSet.has([a, b].sort().join('|'))) return true;
    const ta = typeOf.get(a), tb = typeOf.get(b);
    const pair = [ta, tb].sort().join('|');
    if (openness === 'enclosed') return false;
    const semi = ['dining|formal_living', 'dining|family_living', 'family_living|formal_living'];
    const open = [...semi, 'dining|kitchen', 'family_living|kitchen'];
    return (openness === 'open' ? open : semi).includes(pair);
  };
  const floors = [];
  const warnings = [];
  let below = null;
  // Stair hall: a 1.2 m landing along the stair side that opens onto the most floor, identical on
  // every level so the stair always arrives in circulation.
  const stairHall = (() => {
    const st = bubbleOpt.stair;
    if (!st) return null;
    const house = fp.rects.filter((r) => r.role !== 'garage');
    const inHouse = (r) => {
      // every 0.25 m sample of r inside some house rect
      for (let a = r.s0 + 0.05; a < r.s1; a += 0.25) for (let b = r.t0 + 0.05; b < r.t1; b += 0.25)
        if (!house.some((q) => a > q.s0 - 1e-6 && a < q.s1 + 1e-6 && b > q.t0 - 1e-6 && b < q.t1 + 1e-6)) return false;
      return true;
    };
    const W = DESIGN.corridor;
    const cands = [
      { s0: st.s0, s1: st.s1, t0: st.t1, t1: st.t1 + W }, { s0: st.s0, s1: st.s1, t0: st.t0 - W, t1: st.t0 },
      { s0: st.s1, s1: st.s1 + W, t0: st.t0, t1: st.t1 }, { s0: st.s0 - W, s1: st.s0, t0: st.t0, t1: st.t1 },
    ].filter(inHouse);
    if (!cands.length) return null;
    // prefer the side with the most house beyond it (it opens onto the plan, not a wall)
    const beyond = (r) => {
      const d = 2.5;
      const probe = r.t0 >= st.t1 ? { ...r, t0: r.t1, t1: r.t1 + d } : r.t1 <= st.t0 ? { ...r, t1: r.t0, t0: r.t0 - d } : r.s0 >= st.s1 ? { ...r, s0: r.s1, s1: r.s1 + d } : { ...r, s1: r.s0, s0: r.s0 - d };
      let n = 0, tot = 0;
      for (let a = probe.s0 + 0.1; a < probe.s1; a += 0.25) for (let b = probe.t0 + 0.1; b < probe.t1; b += 0.25) {
        tot++; if (house.some((q) => a > q.s0 && a < q.s1 && b > q.t0 && b < q.t1)) n++;
      }
      return (tot ? n / tot : 0) + (r.s1 - r.s0 + r.t1 - r.t0) * 0.02;
    };
    return cands.reduce((x, y) => (beyond(y) > beyond(x) ? y : x));
  })();
  for (let f = 0; f < nF; f++) {
    const fl = buildFloor(f);
    floors.push(fl);
    below = fl;
  }

  function buildFloor(f) {
    const rects = fp.rects.filter((r) => (f === 0 ? true : r.role !== 'garage'));
    const blocks = [];
    const regions = [];
    let rid = 0;
    const addRegion = (r) => { r.rid = rid++; regions.push(r); return r; };
    if (f === 0) for (const r of rects.filter((x) => x.role === 'garage' || x.role === 'stilt')) {
      blocks.push(r);
      addRegion({ id: r.role, name: r.role === 'garage' ? 'Garage' : 'Stilt parking', kind: r.role, rects: [{ ...r }], fixed: true });
    }
    if (bubbleOpt.stair) {
      blocks.push(bubbleOpt.stair);
      addRegion({ id: 'stair', name: 'Stair', kind: 'stair', rects: [{ ...bubbleOpt.stair }], fixed: true });
      if (stairHall) {
        blocks.push(stairHall);
        addRegion({ id: `stairhall-${f}`, name: 'Stair hall', kind: 'landing', type: 'landing', rects: [{ ...stairHall }] });
      }
    }
    if (below) for (const rg of below.regions.filter((x) => x.dh)) {
      for (const r of rg.rects) blocks.push(r);
      addRegion({ id: `void-${rg.id}`, name: `Open to ${rg.name.toLowerCase()} below`, kind: 'void', rects: rg.rects.map((r) => ({ ...r })), fixed: true });
    }
    // segments = house rects minus blocks
    let segs = rects.filter((r) => r.role !== 'garage' && !(f === 0 && r.role === 'stilt')).map((r) => ({ ...r }));
    for (const B of blocks) segs = segs.flatMap((S) => subtract(S, B));
    const tiny = segs.filter((s) => Math.min(s.s1 - s.s0, s.t1 - s.t0) < 2.2);
    segs = segs.filter((s) => !tiny.includes(s));
    for (const t of tiny) addRegion({ id: `landing-${f}-${rid}`, name: Math.min(t.s1 - t.s0, t.t1 - t.t0) < 1.6 ? 'Passage' : 'Hall', kind: 'landing', type: 'landing', rects: [t] });
    const fs = spaces.filter((s) => s.floorAuto === f);
    // units: top-level spaces with their attached children
    const units = fs.filter((s) => !s.parent || !fs.some((p) => p.id === s.parent) || s.type === 'balcony').map((s) => {
      const kids = fs.filter((c) => c.parent === s.id && c.type !== 'balcony');
      const p = posOf.get(s.type === 'balcony' && s.parent ? s.parent : s.id) || posOf.get(s.id) || [0, 0];
      return { s, kids, area: s.area + sum(kids, (k) => k.area), pos: s.type === 'balcony' ? [p[0] + 0.01, p[1] + 0.01] : p };
    });
    // Unroll the wings into one path (ring, U, L, bar…), order rooms along it by their bubbles and
    // fill it in sequence. Capacity balances itself and the approved arrangement is kept.
    const hallNode = stairHall && f >= 0 ? { ...stairHall, reserved: true } : null;
    const nodes = [...segs.map((S) => ({ ...S })), ...(hallNode ? [hallNode] : [])];
    const startPt = f === 0 ? X.entLocal : bubbleOpt.stair ? [(bubbleOpt.stair.s0 + bubbleOpt.stair.s1) / 2, (bubbleOpt.stair.t0 + bubbleOpt.stair.t1) / 2] : X.entLocal;
    const paths = orderPaths(nodes, startPt);
    // per node: axis, direction, length, cumulative offset
    let cum = 0;
    const seq = [];
    for (const path of paths) {
      path.forEach((k, idx) => {
        const N = nodes[k];
        const prev = idx > 0 ? nodes[path[idx - 1]] : null, next = idx < path.length - 1 ? nodes[path[idx + 1]] : null;
        const alongS = N.s1 - N.s0 >= N.t1 - N.t0;
        const lo = alongS ? N.s0 : N.t0, hi = alongS ? N.s1 : N.t1;
        const ctr = (R) => (alongS ? (R.s0 + R.s1) / 2 : (R.t0 + R.t1) / 2);
        let dir = 1;
        if (prev) dir = ctr(prev) <= (lo + hi) / 2 ? 1 : -1;
        else if (next) dir = ctr(next) >= (lo + hi) / 2 ? 1 : -1;
        const L = hi - lo, D = alongS ? N.t1 - N.t0 : N.s1 - N.s0;
        seq.push({ k, N, alongS, lo, hi, dir, L, D, cum });
        cum += L;
      });
    }
    const coordOf = (pt) => {
      let best = null;
      for (const sq of seq) {
        const N = sq.N;
        const d = Math.hypot(Math.max(N.s0 - pt[0], 0, pt[0] - N.s1), Math.max(N.t0 - pt[1], 0, pt[1] - N.t1));
        if (!best || d < best.d - 1e-9) best = { d, sq };
      }
      if (!best) return 0;
      const sq = best.sq;
      const x = sq.alongS ? pt[0] : pt[1];
      const local = sq.dir > 0 ? x - sq.lo : sq.hi - x;
      return sq.cum + clamp(local, 0, sq.L);
    };
    for (const u of units) u.pc = coordOf(u.pos);
    units.sort((p, q) => p.pc - q.pc);
    const W = DESIGN.corridor;
    const depthFor = (u, sq) => (HUBS.has(u.s.type) || sq.D < 4.0 ? sq.D : sq.D - W);
    const fill = (scale) => {
      const asg = seq.map(() => []);
      let i = 0, ui = 0, rem = seq.length ? seq[0].L : 0;
      while (ui < units.length && i < seq.length) {
        const sq = seq[i];
        if (sq.N.reserved) { i++; rem = i < seq.length ? seq[i].L : 0; continue; }
        const u = units[ui];
        const L0 = LIB[u.s.type] || LIB.custom;
        const small = u.kids.length === 0 && !HUBS.has(u.s.type) && (u.area * scale) / depthFor(u, sq) < Math.max(L0.minW, 1.5);
        const need = Math.max((u.area * scale) / depthFor(u, sq), small ? 0.8 : Math.max(L0.minW, 2.4));
        if (need <= rem + 0.35 || (rem >= 0.6 * need && rem === sq.L)) { asg[i].push(u); rem -= need; ui++; }
        else { i++; rem = i < seq.length ? seq[i].L : 0; }
      }
      const left = rem + sum(seq.slice(i + 1).filter((q) => !q.N.reserved), (q) => q.L);
      return { asg, placed: ui, left };
    };
    let scale = 1, res = fill(1);
    for (let it = 0; it < 14; it++) {
      if (res.placed < units.length) scale *= 0.94;
      else if (res.left > 0.12 * cum) scale *= 1.05;
      else break;
      res = fill(scale);
    }
    if (res.placed < units.length) warnings.push(`${floorLabel(f)}: ${units.length - res.placed} room(s) did not fit and were squeezed into the last wing.`);
    const segInfo = seq.filter((sq) => !sq.N.reserved).map((sq) => ({ S: sq.N, units: res.asg[seq.indexOf(sq)], dir: sq.dir }));
    if (res.placed < units.length && segInfo.length) segInfo[segInfo.length - 1].units.push(...units.slice(res.placed));
    for (const si of segInfo) sliceSegment(si, f, addRegion);
    if (!segInfo.length && units.length) warnings.push(`No usable segment on ${f === 0 ? 'the ground floor' : `floor ${f}`}.`);
    return finishFloor(f, regions);
  }

  function corridorShare(si) {
    return si.units.filter(needsAccess).length >= 2 ? 0.18 : 0;
  }

  // does this unit need its own door onto circulation (rather than through a hub / service room)?
  function needsAccess(u) {
    const L = LIB[u.s.type] || LIB.custom;
    if (HUBS.has(u.s.type) || u.s.type === 'kitchen') return false;
    return L.access === 'room' || L.access === 'wc';
  }

  function sliceSegment(si, f, addRegion) {
    const S = si.S;
    const alongS = S.s1 - S.s0 >= S.t1 - S.t0;
    const L = alongS ? S.s1 - S.s0 : S.t1 - S.t0;
    const D = alongS ? S.t1 - S.t0 : S.s1 - S.s0;
    const A0 = alongS ? S.s0 : S.t0, B0 = alongS ? S.t0 : S.s0;
    const mk = (a0, a1, b0, b1) => (alongS ? { s0: sn(a0), s1: sn(a1), t0: sn(b0), t1: sn(b1) } : { s0: sn(b0), s1: sn(b1), t0: sn(a0), t1: sn(a1) });
    const along = (u) => (alongS ? u.pos[0] : u.pos[1]);
    const across = (u) => (alongS ? u.pos[1] : u.pos[0]);
    const units = [...si.units].sort((p, q) => (si.dir || 1) * ((p.pc ?? along(p)) - (q.pc ?? along(q))));
    if (!units.length) { addRegion({ id: `hall-${f}-${round(S.s0, 1)}-${round(S.t0, 1)}`, name: 'Hall', kind: 'landing', type: 'landing', rects: [S] }); return; }
    // which long side faces the court / garden?
    const sideVal = (lo) => {
      let v = 99;
      for (let k = 1; k <= 3; k++) {
        const t = k / 4;
        const p = alongS ? [S.s0 + t * (S.s1 - S.s0), lo ? S.t0 - 0.6 : S.t1 + 0.6] : [lo ? S.s0 - 0.6 : S.s1 + 0.6, S.t0 + t * (S.t1 - S.t0)];
        if (courtD) v = Math.min(v, courtD.val(p[0], p[1]));
        if (gardenD) v = Math.min(v, gardenD.val(p[0], p[1]) + 1.5);
      }
      return v;
    };
    const innerLo = sideVal(true) <= sideVal(false);
    const W = DESIGN.corridor;
    const corrLo = variant === 'court' ? !innerLo : innerLo; // court: rooms face the court; else corridor/verandah faces it
    const needs = units.map(needsAccess);
    const nNeed = needs.filter(Boolean).length;
    const hubAt = (i) => i >= 0 && i < units.length && HUBS.has(units[i].s.type);
    const loneOk = nNeed === 1 && (() => { const i = needs.indexOf(true); return hubAt(i - 1) || hubAt(i + 1) || i === 0 || i === units.length - 1; })();
    const passageId = `passage-${f}-${round(S.s0, 1)}-${round(S.t0, 1)}`;

    if (nNeed >= 2 && D >= 8) {
      // double-loaded: central corridor, rooms on both sides
      const d1 = sn((D - W) / 2);
      addRegion({ id: passageId, name: 'Corridor', kind: 'passage', type: 'passage', rects: [mk(A0, A0 + L, B0 + d1, B0 + d1 + W)] });
      const mid = B0 + d1 + W / 2;
      const lo = units.filter((u) => across(u) < mid), hi = units.filter((u) => across(u) >= mid);
      const cap1 = d1 * L, cap2 = (D - d1 - W) * L;
      for (let k = 0; k < 10; k++) {
        const x = sum(lo, (u) => u.area) / cap1, y = sum(hi, (u) => u.area) / cap2;
        if (Math.abs(x - y) < 0.12) break;
        const [from, to] = x > y ? [lo, hi] : [hi, lo];
        if (from.length <= 1) break;
        const m = from.reduce((p, q) => (Math.abs(across(q) - mid) < Math.abs(across(p) - mid) ? q : p));
        from.splice(from.indexOf(m), 1); to.push(m);
      }
      sliceRun(lo.sort((p, q) => along(p) - along(q)), A0, A0 + L, B0, B0 + d1, 'hi', mk, addRegion, innerLo);
      sliceRun(hi.sort((p, q) => along(p) - along(q)), A0, A0 + L, B0 + d1 + W, B0 + D, 'lo', mk, addRegion, innerLo);
      return;
    }
    if (nNeed === 0 || (loneOk && units.length <= 2) || D < 4.0) {
      sliceRun(units, A0, A0 + L, B0, B0 + D, null, mk, addRegion, innerLo);
      return;
    }
    // single-loaded corridor only alongside the run of rooms that need it
    const i0 = needs.indexOf(true), i1 = needs.lastIndexOf(true);
    const pre = units.slice(0, i0), span = units.slice(i0, i1 + 1), post = units.slice(i1 + 1);
    const lenOf = (list, depth) => sum(list, (u) => Math.max(u.area / depth, (LIB[u.s.type] || LIB.custom).minW, 1.2));
    let lp = lenOf(pre, D), ls = lenOf(span, D - W), lq = lenOf(post, D);
    const tot = lp + ls + lq;
    if (tot !== L) {
      const flexPre = pre.some((u) => HUBS.has(u.s.type)) ? 2 : 0.5, flexPost = post.some((u) => HUBS.has(u.s.type)) ? 2 : 0.5, flexSpan = 1;
      const wp = pre.length ? flexPre : 0, wq = post.length ? flexPost : 0;
      const diff = L - tot, ws = wp + wq + flexSpan;
      lp += (diff * wp) / ws; lq += (diff * wq) / ws; ls += (diff * flexSpan) / ws;
    }
    const a1 = A0 + lp, a2 = a1 + ls;
    const [rb0, rb1] = corrLo ? [B0 + W, B0 + D] : [B0, B0 + D - W];
    addRegion({ id: passageId, name: variant === 'verandah' ? 'Verandah corridor' : 'Corridor', kind: 'passage', type: 'passage', rects: [mk(a1, a2, corrLo ? B0 : B0 + D - W, corrLo ? B0 + W : B0 + D)] });
    if (pre.length) sliceRun(pre, A0, a1, B0, B0 + D, null, mk, addRegion, innerLo);
    sliceRun(span, a1, a2, rb0, rb1, corrLo ? 'lo' : 'hi', mk, addRegion, innerLo);
    if (post.length) sliceRun(post, a2, A0 + L, B0, B0 + D, null, mk, addRegion, innerLo);
  }

  // Slice an ordered list of units along [a0, a1] at depth [b0, b1]. access = side the doors are on.
  function sliceRun(unitsIn, a0, a1, b0, b1, access, mk, addRegion, innerLo) {
    const L = a1 - a0, d = b1 - b0;
    if (L <= 0.05) return;
    if (!unitsIn.length) { addRegion({ id: `hall-${round(a0, 1)}-${round(b0, 1)}`, name: 'Hall', kind: 'landing', type: 'landing', rects: [mk(a0, a1, b0, b1)] }); return; }
    const groups = [];
    for (const u of unitsIn) {
      const minLen = (LIB[u.s.type] || LIB.custom).minW;
      const small = u.area / d < Math.max(minLen, 1.5) && u.kids.length === 0 && !HUBS.has(u.s.type);
      const last = groups[groups.length - 1];
      if (small && last && last.stack && sum(last.units, (x) => x.area) / d < 2.4) last.units.push(u);
      else groups.push({ units: [u], stack: small });
    }
    for (const gp of groups) {
      gp.area = sum(gp.units, (u) => u.area);
      gp.min = gp.stack ? 1.2 : Math.max(...gp.units.map((u) => (LIB[u.s.type] || LIB.custom).minW), 2.4);
      gp.len = Math.max(gp.area / d, gp.min);
      gp.flex = gp.units.some((u) => HUBS.has(u.s.type)) ? 2 : gp.stack ? 0.15 : 1;
    }
    let total = sum(groups, (gp) => gp.len);
    let diff = L - total;
    if (diff > 0) {
      // rooms may grow up to their maximum size; whatever is left becomes a hall (circulation)
      for (const gp of groups) gp.room = Math.max(0, sum(gp.units, (u) => (LIB[u.s.type] || LIB.custom).max + sum(u.kids, (k) => (LIB[k.type] || LIB.custom).max)) / d - gp.len) * (gp.stack ? 0.3 : 1);
      const room = sum(groups, (gp) => gp.room);
      const give = Math.min(diff, room);
      for (const gp of groups) gp.len += room > 0 ? (give * gp.room) / room : 0;
      diff -= give;
      if (diff > 0.8) groups.unshift({ hall: true, len: diff, min: 0, flex: 0, units: [] });
      else if (diff > 0) groups[groups.length - 1].len += diff;
      diff = 0;
    } else if (diff < 0) {
      const shrinkable = groups.map((gp) => Math.max(0, gp.len - gp.min));
      const sh = sum(shrinkable, (x) => x);
      for (let i = 0; i < groups.length; i++) groups[i].len -= sh > 0 ? Math.min(shrinkable[i], (-diff * shrinkable[i]) / sh) : -diff / groups.length;
    }
    let a = a0;
    groups.forEach((gp, gi) => {
      const e = gi === groups.length - 1 ? a1 : sn(a + gp.len);
      if (gp.hall) {
        addRegion({ id: `hall-${round(a, 1)}-${round(b0, 1)}`, name: 'Hall', kind: 'landing', type: 'landing', rects: [mk(a, e, b0, b1)] });
      } else if (gp.stack) {
        let b = b0;
        gp.units.forEach((u, ui) => {
          const bb = ui === gp.units.length - 1 ? b1 : sn(b + (u.area / gp.area) * d);
          addRegion(regionOf(u.s, [mk(a, e, b, bb)]));
          b = bb;
        });
      } else {
        for (const u of gp.units) {
          if (!u.kids.length) { addRegion(regionOf(u.s, [mk(a, e, b0, b1)])); continue; }
          // suite: bath/dressing in a wet strip on the door side, balcony carved from the outer side
          const wetKids = u.kids.filter((k) => k.type !== 'balcony');
          const balc = u.kids.find((k) => k.type === 'balcony');
          const len = e - a;
          const accessLo = access ? access === 'lo' : !innerLo;
          const db = clamp(Math.min(2.4, d - 2.7), 1.5, 2.4);
          const wetLen = sum(wetKids, (k) => Math.max((LIB[k.type] || LIB.custom).minW, k.area / db));
          const parts = [];
          let mainRects;
          if (wetKids.length && wetLen <= len - 0.9 && d - db >= 2.7) {
            const atEnd = gi % 2 === 0;
            let x = atEnd ? e : a;
            const [wb0, wb1] = accessLo ? [b0, b0 + db] : [b1 - db, b1];
            for (const k of wetKids) {
              const l = Math.max((LIB[k.type] || LIB.custom).minW, k.area / db);
              parts.push(regionOf(k, [atEnd ? mk(x - l, x, wb0, wb1) : mk(x, x + l, wb0, wb1)], u.s.id));
              x = atEnd ? x - l : x + l;
            }
            const main = accessLo ? mk(a, e, b0 + db, b1) : mk(a, e, b0, b1 - db);
            const nook = atEnd ? mk(a, x, wb0, wb1) : mk(x, e, wb0, wb1);
            mainRects = [main, nook].filter((r) => rArea(r) > 0.05);
          } else if (wetKids.length) {
            let x = e;
            for (const k of wetKids) {
              const l = Math.max((LIB[k.type] || LIB.custom).minW, k.area / d);
              parts.push(regionOf(k, [mk(x - l, x, b0, b1)], u.s.id));
              x -= l;
            }
            mainRects = [mk(a, x, b0, b1)];
          } else mainRects = [mk(a, e, b0, b1)];
          if (balc && mainRects.length) {
            const m = mainRects[0];
            const isS = Math.abs(m.s1 - m.s0 - (e - a)) < 0.11 || false;
            const outerLo = !accessLo;
            const bd = 1.5;
            const spanLen = isS ? m.s1 - m.s0 : m.t1 - m.t0;
            const bl = clamp(balc.area / bd, 1.5, spanLen * 0.6);
            const br = isS
              ? { s0: m.s0, s1: sn(m.s0 + bl), t0: outerLo ? m.t0 : sn(m.t1 - bd), t1: outerLo ? sn(m.t0 + bd) : m.t1 }
              : { t0: m.t0, t1: sn(m.t0 + bl), s0: outerLo ? m.s0 : sn(m.s1 - bd), s1: outerLo ? sn(m.s0 + bd) : m.s1 };
            parts.push(regionOf(balc, [br], u.s.id));
            mainRects = [...subtract(m, br), ...mainRects.slice(1)];
          }
          addRegion(regionOf(u.s, mainRects));
          for (const p of parts) addRegion(p);
        }
      }
      a = e;
    });
  }

  function regionOf(s, rects, parent = null) {
    const Lb = LIB[s.type] || LIB.custom;
    return { id: s.id, name: s.name, kind: 'room', type: s.type, rects, target: s.area, parent: parent || s.parent || null, dh: !!s.dh, zone: s.zone || Lb.zone };
  }

  // ---- walls, doors, access ------------------------------------------------------------------
  function finishFloor(f, regions) {
    for (const r of regions) r.area = round(sum(r.rects, rArea), 2);
    // adjacency between regions
    const adj = new Map();
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
      const segs = [];
      for (const ra of regions[i].rects) for (const rb of regions[j].rects) { const sh = shared(ra, rb); if (sh) segs.push(sh); }
      if (segs.length) adj.set(key(regions[i].rid, regions[j].rid), { a: regions[i], b: regions[j], segs, len: sum(segs, (x) => x.len) });
    }
    const allowed = (A, B) => {
      if (A.kind === 'void' || B.kind === 'void') return false;
      if (A.parent || B.parent) return (A.parent && A.parent === B.id) || (B.parent && B.parent === A.id) || (A.parent && A.parent === B.parent && A.type === 'dressing');
      const ta = A.type || A.kind, tb = B.type || B.kind;
      const hubA = HUBS.has(ta) || A.kind === 'passage' || A.kind === 'landing', hubB = HUBS.has(tb) || B.kind === 'passage' || B.kind === 'landing';
      const stairA = A.kind === 'stair', stairB = B.kind === 'stair';
      if (stairA || stairB) return hubA || hubB;
      if (A.kind === 'garage' || B.kind === 'garage' || A.kind === 'stilt' || B.kind === 'stilt') return true;
      const LA = LIB[ta] || {}, LB = LIB[tb] || {};
      if (LA.access === 'service' || LB.access === 'service') {
        const other = LA.access === 'service' ? tb : ta;
        return ['kitchen', 'utility', 'pantry', 'laundry', 'store', 'passage', 'landing', 'dining', 'staff_room'].includes(other) || HUBS.has(other);
      }
      if (ta === 'kitchen' || tb === 'kitchen') {
        const other = ta === 'kitchen' ? tb : ta;
        return ['dining', 'utility', 'pantry', 'passage', 'landing', 'family_living', 'foyer'].includes(other);
      }
      if (LA.access === 'wc' || LB.access === 'wc') {
        const other = LA.access === 'wc' ? tb : ta;
        return HUBS.has(other) && other !== 'dining';
      }
      return hubA || hubB;
    };
    // entrance region
    let start = null;
    if (f === 0) {
      const ent = X.entLocal;
      const cands = regions.filter((r) => ['foyer', 'verandah'].includes(r.type));
      const pool = cands.length ? cands : regions.filter((r) => HUBS.has(r.type) || r.kind === 'passage');
      start = pool.reduce((a, b) => (a && distR(a, ent) <= distR(b, ent) ? a : b), null);
    } else start = regions.find((r) => r.kind === 'stair');
    const doors = [];
    const opens = [];
    const reached = new Set();
    const queue = start ? [start] : [];
    if (start) reached.add(start.rid);
    if (f === 0) {
      const st = regions.find((r) => r.kind === 'stair');
      if (st && !reached.has(st.rid)) { /* reached through hubs below */ }
    }
    while (queue.length) {
      const A = queue.shift();
      for (const e of adj.values()) {
        const B = e.a === A ? e.b : e.b === A ? e.a : null;
        if (!B || reached.has(B.rid)) continue;
        if (e.len < 0.95 || !allowed(A, B)) continue;
        reached.add(B.rid);
        queue.push(B);
        if (A.kind === 'room' && B.kind === 'room' && isOpen(A.id, B.id)) opens.push(e);
        else if ((A.kind === 'stair' || B.kind === 'stair')) opens.push(e);
        else doors.push(placeDoor(e));
      }
    }
    // extra openings: open-plan pairs that are adjacent but reached otherwise
    for (const e of adj.values()) {
      if (e.a.kind === 'room' && e.b.kind === 'room' && isOpen(e.a.id, e.b.id) && !opens.includes(e)) opens.push(e);
    }
    const unreached = regions.filter((r) => !reached.has(r.rid) && r.kind !== 'void' && r.kind !== 'garage' && r.kind !== 'stilt');
    const through = [];
    // fallback: reach the rest through any neighbour (flagged as a planning issue)
    for (let guard = 0; guard < 20 && unreached.some((r) => !reached.has(r.rid)); guard++) {
      for (const r of unreached) {
        if (reached.has(r.rid)) continue;
        for (const e of adj.values()) {
          const B = e.a === r ? e.b : e.b === r ? e.a : null;
          if (!B || !reached.has(B.rid) || e.len < 0.95 || B.kind === 'void') continue;
          reached.add(r.rid);
          doors.push(placeDoor(e, true));
          through.push({ room: r.name, via: B.name });
          break;
        }
      }
    }
    const isolated = regions.filter((r) => !reached.has(r.rid) && !['void', 'garage', 'stilt'].includes(r.kind));
    // main entrance door on the start region's outside wall nearest the arrival
    let mainDoor = null;
    if (f === 0 && start) mainDoor = exteriorDoor(start, regions, X.entLocal);
    const walls = extractWalls(regions, opens, [...doors, ...(mainDoor ? [mainDoor] : [])]);
    const issues = [];
    for (const t of through) issues.push(`${t.room} is reached through ${t.via}.`);
    for (const r of isolated) issues.push(`${r.name} has no access.`);
    for (const r of regions.filter((x) => x.kind === 'room')) {
      const L = LIB[r.type];
      const big = r.rects.reduce((a, b) => (rArea(b) > rArea(a) ? b : a));
      const minDim = Math.min(big.s1 - big.s0, big.t1 - big.t0);
      if (L && L.minW && minDim < L.minW - 0.05) issues.push(`${r.name} is only ${round(minDim, 1)} m wide (minimum ${L.minW} m).`);
    }
    return { f, regions, doors, mainDoor, opens: opens.map((e) => e.segs).flat(), walls, issues, through, isolated: isolated.map((r) => r.name) };
  }

  function distR(r, p) {
    let d = Infinity;
    for (const q of r.rects) d = Math.min(d, Math.hypot(Math.max(q.s0 - p[0], 0, p[0] - q.s1), Math.max(q.t0 - p[1], 0, p[1] - q.t1)));
    return d;
  }

  function placeDoor(e, through = false) {
    const seg = e.segs.reduce((a, b) => (b.len > a.len ? b : a));
    const w = Math.min(0.9, seg.len - 0.2);
    // near one end of the shared wall (keeps furniture walls free)
    const pos = seg.len > 2.2 ? seg.lo + 0.25 + w / 2 : (seg.lo + seg.hi) / 2;
    return { axis: seg.axis, at: seg.at, c: pos, w, through, between: [e.a.name, e.b.name] };
  }

  function exteriorDoor(region, regions, ent) {
    // longest exposed edge piece of this region, nearest the arrival point
    const others = regions.filter((r) => r !== region).flatMap((r) => r.rects);
    const fpRects = fp.rects;
    let best = null;
    for (const r of region.rects) {
      const sides = [
        { axis: 's', at: r.t0, lo: r.s0, hi: r.s1, out: [0, -1] }, { axis: 's', at: r.t1, lo: r.s0, hi: r.s1, out: [0, 1] },
        { axis: 't', at: r.s0, lo: r.t0, hi: r.t1, out: [-1, 0] }, { axis: 't', at: r.s1, lo: r.t0, hi: r.t1, out: [1, 0] },
      ];
      for (const sd of sides) {
        // sample points along the side; keep those with outside beyond (not covered by footprint)
        for (let x = sd.lo + 0.7; x <= sd.hi - 0.7 + 1e-9; x += 0.1) {
          const p = sd.axis === 's' ? [x, sd.at + sd.out[1] * 0.05] : [sd.at + sd.out[0] * 0.05, x];
          const inside = fpRects.some((q) => p[0] > q.s0 && p[0] < q.s1 && p[1] > q.t0 && p[1] < q.t1) || others.some((q) => p[0] > q.s0 && p[0] < q.s1 && p[1] > q.t0 && p[1] < q.t1);
          if (inside) continue;
          const d = Math.hypot(p[0] - ent[0], p[1] - ent[1]);
          if (!best || d < best.d) best = { d, axis: sd.axis, at: sd.at, c: x, w: 1.2, main: true, out: sd.out };
        }
      }
    }
    return best;
  }

  // walls from a 0.1 m label raster: exterior / interior / open partition, minus door gaps
  function extractWalls(regions, opens, doors) {
    let s0 = Infinity, t0 = Infinity, s1 = -Infinity, t1 = -Infinity;
    for (const r of regions) for (const q of r.rects) { s0 = Math.min(s0, q.s0); t0 = Math.min(t0, q.t0); s1 = Math.max(s1, q.s1); t1 = Math.max(t1, q.t1); }
    if (!Number.isFinite(s0)) return [];
    const nx = Math.round((s1 - s0) / SNAP) + 2, ny = Math.round((t1 - t0) / SNAP) + 2;
    const lab = new Int32Array(nx * ny).fill(-1);
    regions.forEach((r) => {
      for (const q of r.rects) {
        const i0 = Math.round((q.s0 - s0) / SNAP) + 1, i1 = Math.round((q.s1 - s0) / SNAP) + 1;
        const j0 = Math.round((q.t0 - t0) / SNAP) + 1, j1 = Math.round((q.t1 - t0) / SNAP) + 1;
        for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) lab[j * nx + i] = r.rid;
      }
    });
    const byRid = new Map(regions.map((r) => [r.rid, r]));
    const parentOf = (r) => r && (r.parent || r.id);
    const openPair = new Set();
    for (const r of regions) for (const q of regions) if (r !== q && r.kind === 'room' && q.kind === 'room' && isOpen(r.id, q.id)) openPair.add(`${r.rid}|${q.rid}`);
    const kindOf = (a, b) => {
      if (a === b) return null;
      if (a < 0 || b < 0) return 'ext';
      const A = byRid.get(a), B = byRid.get(b);
      if (A.kind === 'stair' || B.kind === 'stair') return 'int';
      if (A.kind === 'void' || B.kind === 'void') return 'void';
      if (openPair.has(`${a}|${b}`)) return 'open';
      // the same room split into rects (L-shapes, nooks) has no wall inside it
      if (A.id === B.id) return null;
      void parentOf;
      return 'int';
    };
    const segs = [];
    // vertical edges (constant s)
    for (let i = 1; i < nx; i++) {
      let run = null;
      for (let j = 0; j <= ny; j++) {
        const a = j < ny ? lab[j * nx + i - 1] : -2, b = j < ny ? lab[j * nx + i] : -2;
        const k = j < ny ? kindOf(a, b) : null;
        if (run && (k !== run.k || j === ny)) { segs.push({ axis: 't', at: s0 + (i - 1) * SNAP, lo: t0 + (run.j - 1) * SNAP, hi: t0 + (j - 1) * SNAP, kind: run.k }); run = null; }
        if (k && !run) run = { j, k };
      }
    }
    for (let j = 1; j < ny; j++) {
      let run = null;
      for (let i = 0; i <= nx; i++) {
        const a = i < nx ? lab[(j - 1) * nx + i] : -2, b = i < nx ? lab[j * nx + i] : -2;
        const k = i < nx ? kindOf(a, b) : null;
        if (run && (k !== run.k || i === nx)) { segs.push({ axis: 's', at: t0 + (j - 1) * SNAP, lo: s0 + (run.i - 1) * SNAP, hi: s0 + (i - 1) * SNAP, kind: run.k }); run = null; }
        if (k && !run) run = { i, k };
      }
    }
    // cut door gaps
    const out = [];
    for (const sg of segs) {
      let pieces = [[sg.lo, sg.hi]];
      for (const d of doors) {
        if (!d || d.axis !== sg.axis || Math.abs(d.at - sg.at) > 0.06) continue;
        const a = d.c - d.w / 2, b = d.c + d.w / 2;
        pieces = pieces.flatMap(([lo, hi]) => (b <= lo || a >= hi ? [[lo, hi]] : [[lo, a], [b, hi]].filter(([x, y]) => y - x > 0.05)));
      }
      for (const [lo, hi] of pieces) out.push({ ...sg, lo, hi });
    }
    return out;
  }

  // ---- metrics ----------------------------------------------------------------------------------
  const rooms = floors.flatMap((fl) => fl.regions.filter((r) => r.kind === 'room'));
  const areaErr = rooms.length ? sum(rooms, (r) => Math.abs(r.area - r.target)) / Math.max(1, sum(rooms, (r) => r.target)) : 0;
  const issues = floors.flatMap((fl) => fl.issues.map((t) => `${fl.f === 0 ? 'GF' : `F${fl.f}`}: ${t}`));
  const corridor = sum(floors.flatMap((fl) => fl.regions.filter((r) => r.kind === 'passage' || r.kind === 'landing')), (r) => r.area);
  const gross = sum(floors.flatMap((fl) => fl.regions.filter((r) => r.kind !== 'void' && r.kind !== 'garage' && r.kind !== 'stilt')), (r) => r.area);
  const through = sum(floors, (fl) => fl.through.length), isolated = sum(floors, (fl) => fl.isolated.length);
  const scores = {
    access: clamp(1 - (through * 0.15 + isolated * 0.4)),
    areas: clamp(1 - areaErr * 2.5),
    circulation: clamp(1 - (corridor / Math.max(1, gross) - 0.08) * 3),
    proportion: clamp(1 - issues.filter((t) => /wide/.test(t)).length * 0.15),
  };
  const total = (scores.access * 3 + scores.areas * 2 + scores.circulation + scores.proportion) / 7;
  const V = PLAN_VARIANTS[label || variant];
  const pros = [], cons = [];
  if (scores.access > 0.95) pros.push('Every room is reached from circulation, not through another room.');
  if (scores.areas > 0.8) pros.push(`Rooms are within ${Math.round(areaErr * 100)}% of their target areas on average.`);
  if (scores.circulation > 0.8) pros.push(`Compact circulation (${round(corridor, 1)} m² of corridor and halls).`);
  if (through) cons.push(`${through} room${through > 1 ? 's are' : ' is'} reached through another room.`);
  if (isolated) cons.push(`${isolated} room${isolated > 1 ? 's have' : ' has'} no access — revise the bubbles or the footprint.`);
  if (scores.areas < 0.7) cons.push(`Room areas drift ${Math.round(areaErr * 100)}% from the programme.`);
  if (scores.circulation < 0.6) cons.push(`Circulation takes ${round(corridor, 1)} m² (${Math.round((corridor / Math.max(1, gross)) * 100)}% of the floor area).`);
  return { variant: label || variant, title: V.title, logic: V.logic, floors, scores, total, pros, cons, issues, metrics: { areaErr: round(areaErr, 3), corridor: round(corridor, 1), gross: round(gross, 1) }, warnings };
}
