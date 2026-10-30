// Stage 04 — footprint & ground zoning (spec §28–45).
//
// A footprint is a union of orthogonal rectangles ("wings") on the design grid. Candidates come from
// architectural archetypes — bar, compact block, L, U, courtyard, twin pavilions — and from
// tree-anchored variants that wrap or enclose a preserved tree. Hundreds are generated, hard
// constraints filter them (inside the buildable region, clear of trees and the drive, area within
// tolerance), and each survivor is scored on explicit components. Three options from *different*
// families are returned (spec §90), each with reasons computed from its own metrics.

import { prefixSum, rectSum, components, opening, geodesic } from '../geometry/grid.js';
import { bearingOf, compass8, COMPASS_NAMES, dist } from '../geometry/polygon.js';
import { facadeExposure } from '../analysis/sun.js';
import { makeRng } from '../core/rng.js';
import { clamp, round, mean } from '../core/util.js';
import { DESIGN } from '../rules/assumptions.js';

const FAMILIES = {
  bar: 'Linear bar', compact: 'Compact block', L: 'L-shaped house', U: 'U-shaped house',
  court: 'Courtyard house', pavilion: 'Twin pavilions',
};

export function footprintTargets(brief, access) {
  const floors = Math.max(1, brief.floors || 1);
  const stilt = access?.parking?.type === 'stilt';
  const resFloors = Math.max(1, floors - (stilt ? 1 : 0));
  const target = (brief.targetBUA || 200) / resFloors;
  const court = (brief.openSpaces || []).find((o) => o.type === 'courtyard');
  return { target, resFloors, stilt, courtArea: court ? court.area || 20 : 0 };
}

export function footprintMask(grid, rects, roles = null) {
  const m = new Uint8Array(grid.n);
  for (const r of rects) {
    if (roles && !roles.includes(r.role)) continue;
    const rc = grid.rectCells(r);
    for (let j = Math.max(0, rc.j0); j < Math.min(grid.ny, rc.j1); j++)
      for (let i = Math.max(0, rc.i0); i < Math.min(grid.nx, rc.i1); i++) m[j * grid.nx + i] = 1;
  }
  return m;
}

export function generateFootprints(ctx, seed = 1) {
  const { A, F, masks, access, brief, priorities, preserved } = ctx;
  const g = F.grid, c = g.c;
  const rng = makeRng(`fp-${seed}`);
  const T = footprintTargets(brief, access);
  const allowed = masks.buildable.map((v, k) => (v || masks.fixed[k] ? 1 : 0));
  const PS = prefixSum(g, allowed);
  const fixedRect = access?.fixedRect || null;
  const fixedCells = fixedRect ? g.rectCells(fixedRect) : null;
  const toC = (m) => Math.max(1, Math.round(m / c));
  const targetCells = T.target / (c * c);
  const trees = A.trees.filter((t) => t.inside && preserved.has(t.id));

  // bounds of allowed region
  let bi0 = g.nx, bi1 = 0, bj0 = g.ny, bj1 = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (allowed[j * g.nx + i]) {
    bi0 = Math.min(bi0, i); bi1 = Math.max(bi1, i + 1); bj0 = Math.min(bj0, j); bj1 = Math.max(bj1, j + 1);
  }
  const BW = bi1 - bi0, BD = bj1 - bj0;
  if (BW <= 0 || BD <= 0) return { options: [], reason: 'No buildable area remains after setbacks, trees and the drive.' };

  const valid = (rc) => rc.i0 >= 0 && rc.j0 >= 0 && rc.i1 <= g.nx && rc.j1 <= g.ny && rc.i1 > rc.i0 && rc.j1 > rc.j0 &&
    rectSum(PS, rc.i0, rc.j0, rc.i1, rc.j1) === (rc.i1 - rc.i0) * (rc.j1 - rc.j0);
  const overlapsFixed = (rc) => fixedCells && rc.i0 < fixedCells.i1 && rc.i1 > fixedCells.i0 && rc.j0 < fixedCells.j1 && rc.j1 > fixedCells.j0;

  // ---- adaptive shape growth ---------------------------------------------------------------------
  // Wings are grown from anchor points until they reach their intended length or meet an obstacle
  // (setback line, tree square, the drive), so the archetypes bend to irregular, constrained plots
  // instead of being stamped at fixed sizes. Shapes are built in a "view" whose main axis runs along
  // i; the transposed view gives the same families turned 90°.
  const R = (i0, j0, i1, j1, role = 'wing') => ({ i0, j0, i1, j1, role });
  const N = targetCells;
  const cellsOf = (r) => Math.max(0, r.i1 - r.i0) * Math.max(0, r.j1 - r.j0);
  const areaOf = (rs) => rs.reduce((a, r) => a + cellsOf(r), 0);
  const overlapsAny = (r, rs) => rs.some((q) => r.i0 < q.i1 && r.i1 > q.i0 && r.j0 < q.j1 && r.j1 > q.j0);
  const candidates = [];
  const seen = new Set();
  const accept = (family, rects, meta, placement) => {
    if (rects.some((r) => r.i1 - r.i0 < 1 || r.j1 - r.j0 < 1)) return false;
    for (const r of rects) if (!valid(r) || overlapsFixed(r)) return false;
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) if (overlapsAny(rects[a], [rects[b]])) return false;
    for (const r of rects) {
      const minDim = Math.min(r.i1 - r.i0, r.j1 - r.j0) * c;
      if (minDim < (r.role === 'link' ? 2.4 : DESIGN.minWing)) return false;
    }
    // wings must form one connected house
    const conn = new Set([0]);
    for (let changed = true; changed;) {
      changed = false;
      rects.forEach((r, idx) => { if (!conn.has(idx) && [...conn].some((q) => touchLen(rects[q], r) >= 4)) { conn.add(idx); changed = true; } });
    }
    if (conn.size !== rects.length) return false;
    const areaCells = areaOf(rects);
    if (areaCells < N * 0.86 || areaCells > N * 1.14) return false;
    const all = rects.map((r) => ({ ...r }));
    if (fixedCells) {
      const fr = { ...fixedCells, role: fixedRect.role };
      if (!all.some((r) => touchLen(r, fr) >= 4)) return false; // garage/stilt must abut the house
      all.push(fr);
    }
    const key = all.map((r) => `${r.i0},${r.j0},${r.i1},${r.j1}`).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    candidates.push({ family, meta, placement, cellRects: all, areaCells });
    return true;
  };

  const makeView = (Tp) => {
    const tr = (r) => (Tp ? { ...r, i0: r.j0, i1: r.j1, j0: r.i0, j1: r.i1 } : { ...r });
    const free = (r, rs) => {
      const w = tr(r);
      return valid(w) && !overlapsFixed(w) && !overlapsAny(r, rs);
    };
    const step = (r, dir) => (dir === '+i' ? { ...r, i1: r.i1 + 1 } : dir === '-i' ? { ...r, i0: r.i0 - 1 } : dir === '+j' ? { ...r, j1: r.j1 + 1 } : { ...r, j0: r.j0 - 1 });
    const strip = (r, dir) => (dir === '+i' ? { ...r, i0: r.i1, i1: r.i1 + 1 } : dir === '-i' ? { ...r, i1: r.i0, i0: r.i0 - 1 } : dir === '+j' ? { ...r, j0: r.j1, j1: r.j1 + 1 } : { ...r, j1: r.j0, j0: r.j0 - 1 });
    const grow = (r, dir, n, rs) => {
      let cur = r;
      for (let k = 0; k < n; k++) { if (!free(strip(cur, dir), rs)) break; cur = step(cur, dir); }
      return cur;
    };
    const lenI = (r) => r.i1 - r.i0, lenJ = (r) => r.j1 - r.j0;
    // main wing: depth d along j, grown along i from an anchor towards `len`
    const wing = (ai, aj, d, len, rs = []) => {
      // the depth shrinks (down to the minimum wing) when the anchor sits in a tight band
      let r = null;
      for (let dd = d; dd >= toC(DESIGN.minWing); dd--) {
        const tryR = R(ai, aj, ai + 1, aj + dd);
        if (free(tryR, rs)) { r = tryR; break; }
      }
      if (!r) return null;
      len = Math.round((len * d) / (r.j1 - r.j0));
      const bias = rng.next();
      r = grow(r, '+i', Math.round((len - 1) * bias), rs);
      r = grow(r, '-i', len - lenI(r), rs);
      r = grow(r, '+i', len - lenI(r), rs);
      return r;
    };
    // perpendicular wing flush with one end of `main`, growing away on `side`
    const branch = (main, end, side, d, len, rs) => {
      if (lenI(main) < d) return null;
      const i0 = end === 'lo' ? main.i0 : main.i1 - d;
      const r = side === '+j' ? R(i0, main.j1, i0 + d, main.j1 + 1) : R(i0, main.j0 - 1, i0 + d, main.j0);
      if (!free(r, rs)) return null;
      return grow(r, side, len - 1, rs);
    };
    const out = (family, rects, meta, placement) => accept(family, rects.map(tr), meta, placement);
    const anchors = [];
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (allowed[j * g.nx + i]) anchors.push(Tp ? [j, i] : [i, j]);
    const treeSq = trees.map((t) => {
      const q = g.rectCells({ s0: Math.floor(t.rect.s0 / c) * c, t0: Math.floor(t.rect.t0 / c) * c, s1: Math.ceil(t.rect.s1 / c) * c, t1: Math.ceil(t.rect.t1 / c) * c });
      return { t, q: Tp ? { i0: q.j0, i1: q.j1, j0: q.i0, j1: q.i1 } : q };
    });
    return { free, grow, wing, branch, out, anchors, lenI, lenJ, treeSq };
  };

  // extend the main wing at ends that carry no branch, towards the target area
  const topUp = (V, rs, mainIdx, ends) => {
    let need = N - areaOf(rs);
    if (need <= 0) return rs;
    const main = rs[mainIdx], d = V.lenJ(main);
    const others = rs.filter((_, k) => k !== mainIdx);
    let m = main;
    for (const dir of ends) {
      if (need <= 0) break;
      const m2 = V.grow(m, dir, Math.ceil(need / d), others);
      need -= (V.lenI(m2) - V.lenI(m)) * d;
      m = m2;
    }
    const outRs = [...rs];
    outRs[mainIdx] = m;
    return outRs;
  };
  // shorten branches from their free ends until the area is near the target
  const trimBranches = (V, rs, idxs, sides) => {
    let over = areaOf(rs) - N * 1.04;
    const outRs = rs.map((r) => ({ ...r }));
    for (let guard = 0; over > 0 && guard < 200; guard++) {
      let changed = false;
      for (const k of idxs) {
        const r = outRs[k];
        if (V.lenJ(r) <= toC(3)) continue;
        if (sides[k] === '+j') r.j1--; else r.j0++;
        over -= V.lenI(r);
        changed = true;
        if (over <= 0) break;
      }
      if (!changed) break;
    }
    return outRs;
  };

  for (const Tp of [false, true]) {
    const V = makeView(Tp);
    if (!V.anchors.length) continue;
    for (let k = 0; k < 260; k++) {
      const [ai, aj] = rng.pick(V.anchors);
      const fam = rng.pick(['bar', 'bar', 'compact', 'L', 'L', 'U', 'U', 'court', 'court', 'pavilion']);
      if (fam === 'bar' || fam === 'compact') {
        const d = fam === 'bar' ? toC(rng.range(6.5, 10)) : Math.round(Math.sqrt(N) * rng.range(0.85, 1.1));
        const m = V.wing(ai, aj, d, Math.round(N / d));
        if (m) V.out(fam, [m], { orient: Tp ? 'deep' : 'along' }, 'grown');
      } else if (fam === 'L') {
        const d1 = toC(rng.range(5, 8)), d2 = toC(rng.range(4.5, 7));
        const m = V.wing(ai, aj, d1, Math.round((rng.range(0.5, 0.7) * N) / d1));
        if (!m) continue;
        const end = rng.chance(0.5) ? 'lo' : 'hi', side = rng.chance(0.5) ? '+j' : '-j';
        const b = V.branch(m, end, side, d2, Math.round((N - V.lenI(m) * d1) / d2), [m]);
        if (!b) continue;
        let rs = topUp(V, [m, b], 0, [end === 'lo' ? '+i' : '-i']);
        rs = trimBranches(V, rs, [1], { 1: side });
        V.out('L', rs, {}, 'grown');
      } else if (fam === 'U' || fam === 'court') {
        const d1 = toC(rng.range(4.5, 6.5)), d2 = toC(rng.range(4, 6));
        const cw = toC(Math.max(DESIGN.courtMin, rng.range(3.5, 7)));
        const m = V.wing(ai, aj, d1, 2 * d2 + cw + rng.int(0, 6));
        if (!m || V.lenI(m) < 2 * d2 + toC(DESIGN.courtMin)) continue;
        const side = rng.chance(0.5) ? '+j' : '-j';
        if (fam === 'U') {
          const l = Math.round((N - V.lenI(m) * d1) / (2 * d2));
          const b1 = V.branch(m, 'lo', side, d2, l, [m]);
          const b2 = b1 && V.branch(m, 'hi', side, d2, l, [m, b1]);
          if (!b1 || !b2) continue;
          const L = Math.min(V.lenJ(b1), V.lenJ(b2));
          for (const b of [b1, b2]) { if (side === '+j') b.j1 = b.j0 + L; else b.j0 = b.j1 - L; }
          const rs = trimBranches(V, [m, b1, b2], [1, 2], { 1: side, 2: side });
          V.out('U', rs, {}, 'grown');
        } else {
          const cd = toC(Math.max(DESIGN.courtMin, Math.sqrt(T.courtArea || 12) + rng.range(0, 2.5)));
          const b1 = V.branch(m, 'lo', side, d2, cd, [m]);
          const b2 = b1 && V.branch(m, 'hi', side, d2, cd, [m, b1]);
          if (!b1 || !b2 || V.lenJ(b1) < cd || V.lenJ(b2) < cd) continue;
          const d4 = toC(rng.range(4, 6));
          const j0 = side === '+j' ? b1.j1 : b1.j0 - d4;
          const close = R(m.i0, j0, m.i1, j0 + d4);
          if (!V.free(close, [m, b1, b2])) continue;
          V.out('court', [m, b1, b2, close], {}, 'grown');
        }
      } else if (fam === 'pavilion') {
        const d1 = toC(rng.range(5, 7.5)), d2 = toC(rng.range(5, 7.5)), gap = toC(rng.range(3.5, 7)), lw = toC(rng.range(2.4, 3));
        const len = Math.round((N - gap * lw) / (d1 + d2));
        const m = V.wing(ai, aj, d1, len);
        if (!m) continue;
        const side = rng.chance(0.5) ? '+j' : '-j';
        const aj2 = side === '+j' ? m.j1 + gap : m.j0 - gap - d2;
        const m2 = V.wing(Math.round((m.i0 + m.i1) / 2), aj2, d2, len, [m]);
        if (!m2) continue;
        const lo = Math.max(m.i0, m2.i0), hi = Math.min(m.i1, m2.i1);
        if (hi - lo < lw) continue;
        const li = rng.int(lo, hi - lw);
        const link = side === '+j' ? R(li, m.j1, li + lw, m2.j0, 'link') : R(li, m2.j1, li + lw, m.j0, 'link');
        if (!V.free(link, [m, m2])) continue;
        V.out('pavilion', [m, link, m2], {}, 'grown');
      }
    }
    // tree-anchored: wings set against a preserved tree's exclusion square and wrapped around it
    // Wing depths are taken from the free gap measured on each side of the tree, so a ring fits
    // the actual room around it rather than a random size.
    const minC = toC(DESIGN.minWing);
    const gapOf = (q0, dir) => {
      // measured over the central 60% of the tree's side; strips are trimmed later if a corner is blocked
      const wi = q0.i1 - q0.i0, wj = q0.j1 - q0.j0;
      const q = { i0: q0.i0 + Math.floor(wi * 0.2), i1: q0.i1 - Math.floor(wi * 0.2), j0: q0.j0 + Math.floor(wj * 0.2), j1: q0.j1 - Math.floor(wj * 0.2) };
      if (dir === '-j' || dir === '+j') { q.j0 = q0.j0; q.j1 = q0.j1; } else { q.i0 = q0.i0; q.i1 = q0.i1; }
      let n = 0;
      for (; n < 40; n++) {
        const s = dir === '-j' ? R(q.i0, q.j0 - n - 1, q.i1, q.j0 - n) : dir === '+j' ? R(q.i0, q.j1 + n, q.i1, q.j1 + n + 1)
          : dir === '-i' ? R(q.i0 - n - 1, q.j0, q.i0 - n, q.j1) : R(q.i1 + n, q.j0, q.i1 + n + 1, q.j1);
        if (!V.free(s, [])) break;
      }
      return n;
    };
    const strip = (r, dir) => (dir === '+i' ? { ...r, i0: r.i1, i1: r.i1 + 1 } : dir === '-i' ? { ...r, i1: r.i0, i0: r.i0 - 1 } : dir === '+j' ? { ...r, j0: r.j1, j1: r.j1 + 1 } : { ...r, j1: r.j0, j0: r.j0 - 1 });
    for (const { t, q } of V.treeSq) {
      const gaps = { F: gapOf(q, '-j'), B: gapOf(q, '+j'), L: gapOf(q, '-i'), Rt: gapOf(q, '+i') };
      for (let k = 0; k < 30; k++) {
        const pick = (gp) => (gp >= minC ? Math.min(gp, toC(rng.range(3.5, 6.5))) : 0);
        const d = { F: pick(gaps.F), B: pick(gaps.B), L: pick(gaps.L), Rt: pick(gaps.Rt) };
        const P = {
          F: d.F ? R(q.i0 - d.L, q.j0 - d.F, q.i1 + d.Rt, q.j0) : null,
          B: d.B ? R(q.i0 - d.L, q.j1, q.i1 + d.Rt, q.j1 + d.B) : null,
          L: d.L ? R(q.i0 - d.L, q.j0, q.i0, q.j1) : null,
          Rt: d.Rt ? R(q.i1, q.j0, q.i1 + d.Rt, q.j1) : null,
        };
        // strips that cross a blocked corner are cut back to the tree's span
        for (const key of ['F', 'B']) {
          if (!P[key] || V.free(P[key], [])) continue;
          // a blocked corner: first try a shallower strip, then trim only the blocked side so the
          // strip still meets the arm on the other side
          let found = null;
          for (let dd = d[key]; dd >= minC && !found; dd--) {
            const base = key === 'F' ? { ...P[key], j0: q.j0 - dd } : { ...P[key], j1: q.j1 + dd };
            found = [base, { ...base, i0: q.i0 }, { ...base, i1: q.i1 }, { ...base, i0: q.i0, i1: q.i1 }].find((x) => V.free(x, [])) || null;
          }
          P[key] = found;
        }
        const combos = [
          ['court', ['F', 'B', 'L', 'Rt']], ['U', ['F', 'L', 'Rt']], ['U', ['B', 'L', 'Rt']], ['U', ['F', 'B', 'L']], ['U', ['F', 'B', 'Rt']],
          ['L', ['F', 'L']], ['L', ['F', 'Rt']], ['L', ['B', 'L']], ['L', ['B', 'Rt']],
        ];
        for (const [fam, keys] of combos) {
          if (keys.some((key) => !P[key])) continue;
          let rs = keys.map((key) => ({ ...P[key] }));
          if (rs.some((r) => !V.free(r, rs.filter((x) => x !== r)))) continue;
          // top up towards the target by extending the long strips outwards along i, then arms along j
          for (let guard = 0; guard < 60 && areaOf(rs) < N * 0.97; guard++) {
            let grew = false;
            for (const r of rs) {
              if (areaOf(rs) >= N * 0.97) break;
              const isStrip = r.j1 <= q.j0 || r.j0 >= q.j1;
              const dirs = isStrip ? ['-i', '+i'] : r.i1 <= q.i0 ? ['-j', '+j'] : ['+j', '-j'];
              for (const dir of dirs) {
                const sp = strip(r, dir);
                if (V.free(sp, rs.filter((x) => x !== r))) { Object.assign(r, dir === '+i' ? { i1: r.i1 + 1 } : dir === '-i' ? { i0: r.i0 - 1 } : dir === '+j' ? { j1: r.j1 + 1 } : { j0: r.j0 - 1 }); grew = true; break; }
              }
            }
            if (!grew) break;
          }
          V.out(fam, rs, { tree: t.id }, 'tree');
        }
      }
    }
  }

  if (!candidates.length) {
    return {
      options: [],
      reason: `No footprint of about ${round(T.target)} m² per floor fits the remaining buildable area. Reduce the target area, add a floor, or revisit tree/access decisions.`,
    };
  }

  // ---- evaluation ---------------------------------------------------------------------------------
  const ev = makeEvaluator(ctx, T);
  for (const cand of candidates) ev(cand);
  const W = weights(priorities);
  for (const cand of candidates) {
    let s = 0, ws = 0;
    for (const k in W) { s += W[k] * (cand.scores[k] ?? 0.5); ws += W[k]; }
    cand.total = s / ws;
  }

  // ---- diverse selection -----------------------------------------------------------------------------
  const sorted = [...candidates].sort((a, b) => b.total - a.total);
  const chosen = [];
  const iou = (a, b) => {
    let inter = 0, uni = 0;
    for (let k = 0; k < a.mask.length; k++) { if (a.mask[k] && b.mask[k]) inter++; if (a.mask[k] || b.mask[k]) uni++; }
    return uni ? inter / uni : 0;
  };
  // Options shown earlier ("generate three more") are excluded as near-duplicates.
  const excluded = (ctx.exclude || []).map((rects) => ({ mask: footprintMask(g, rects) }));
  const fresh = sorted.filter((cand) => !excluded.some((x) => iou(x, cand) > 0.8));
  const pool = fresh.length >= 3 ? fresh : sorted;
  // Different families first (a closed court and a U are different decisions even around the same
  // tree); overlap only screens out near-duplicates, then tightens as the list fills.
  for (const pass of [{ fam: true, iou: 0.85 }, { fam: false, iou: 0.6 }, { fam: false, iou: 0.8 }]) {
    for (const cand of pool) {
      if (chosen.length >= 3) break;
      if (chosen.includes(cand)) continue;
      if (pass.fam && chosen.some((x) => x.family === cand.family)) continue;
      if (chosen.some((x) => iou(x, cand) > pass.iou)) continue;
      chosen.push(cand);
    }
  }
  // weaknesses every option shares are reported once, not as a reason to prefer one option
  const sharedKeys = chosen.length > 1 ? Object.keys(chosen[0].scores).filter((k) => k !== 'fit' && chosen.every((cnd) => cnd.scores[k] <= 0.35)) : [];
  const options = chosen.map((cand, i) => finish(cand, i, ctx, T, chosen, sharedKeys));
  const best = options.reduce((a, b) => (b.total > a.total ? b : a), options[0]);
  if (best) best.recommended = true;
  const sharedNotes = sharedKeys.map((k) => SHARED_NOTE[k]).filter(Boolean);
  return { options, evaluated: candidates.length, target: T, sharedNotes };
}

function touchLen(a, b) {
  // shared edge length (cells) between two cell rects
  if (a.i1 === b.i0 || b.i1 === a.i0) return Math.max(0, Math.min(a.j1, b.j1) - Math.max(a.j0, b.j0));
  if (a.j1 === b.j0 || b.j1 === a.j0) return Math.max(0, Math.min(a.i1, b.i1) - Math.max(a.i0, b.i0));
  return 0;
}

export function weights(p) {
  const P = (k) => (p && p[k] != null ? p[k] : 1);
  return {
    fit: 2,
    privacy: P('privacy'), depth: 0.5 * P('privacy'),
    trees: P('trees'), court: P('courtyard'), ventilation: P('ventilation'), solar: P('climate'),
    views: P('views'), garden: P('garden'), noise: P('noise'), compactness: P('compactness'), arrival: P('procession'),
  };
}

// Builds the scoring closure (precomputes what all candidates share).
function makeEvaluator(ctx, T) {
  const { A, F, masks, access, brief, preserved } = ctx;
  const g = F.grid, { nx, ny, c } = g;
  const trees = A.trees.filter((t) => t.inside && preserved.has(t.id));
  const lat = A.lat;
  const u = g.frame.u, v = g.frame.v;
  const dirBearing = (ds, dt) => bearingOf([u[0] * ds + v[0] * dt, u[1] * ds + v[1] * dt], A.northDeg);
  const EXPO = { '1,0': facadeExposure(lat, dirBearing(1, 0)), '-1,0': facadeExposure(lat, dirBearing(-1, 0)), '0,1': facadeExposure(lat, dirBearing(0, 1)), '0,-1': facadeExposure(lat, dirBearing(0, -1)) };
  const BEAR = { '1,0': dirBearing(1, 0), '-1,0': dirBearing(-1, 0), '0,1': dirBearing(0, 1), '0,-1': dirBearing(0, -1) };
  // road edges -> nearest axis direction in the frame (towards the road)
  const roadDirs = A.roads.map((r) => {
    const [ds, dt] = g.frame.localDir(r.edge.out);
    return { w: r.width, d: Math.abs(ds) > Math.abs(dt) ? [Math.sign(ds), 0] : [0, Math.sign(dt)] };
  });
  const open0 = F.inSite.map((x, k) => (x && !masks.corridor[k] ? 1 : 0));
  const arrival = access?.arrival ? g.frame.toLocal(access.arrival) : [g.frame.S / 2, g.frame.frontT];
  const desirable = A.views.filter((vw) => vw.kind !== 'undesirable');
  const gardenWanted = (brief.openSpaces || []).filter((o) => o.type !== 'courtyard' && o.type !== 'service-yard').reduce((s, o) => s + (o.area || 30), 0) || 40;
  const character = brief.entryCharacter || 'subtle';

  return (cand) => {
    const rects = cand.cellRects;
    const mask = new Uint8Array(g.n);
    const house = rects.filter((r) => r.role !== 'garage');
    for (const r of rects) for (let j = r.j0; j < r.j1; j++) for (let i = r.i0; i < r.i1; i++) mask[j * nx + i] = 1;
    cand.mask = mask;
    const at = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i];
    // facades
    let P = 0, expo = 0, westLen = 0, perimCells = [], privSum = 0, noiseSum = 0, depthSum = 0, cells = 0;
    const faceLen = { '1,0': 0, '-1,0': 0, '0,1': 0, '0,-1': 0 };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!mask[j * nx + i]) continue;
      const k = j * nx + i;
      cells++; noiseSum += F.noise[k]; depthSum += F.depth[k];
      let edge = false;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (at(i + di, j + dj)) continue;
        edge = true; P += c;
        const key = `${di},${dj}`;
        faceLen[key] += c; expo += c * EXPO[key];
        const b = BEAR[key];
        if (b > 225 && b < 315) westLen += c;
      }
      if (edge) { perimCells.push(k); privSum += F.privacy[k]; }
    }
    const areaM = cells * c * c;
    const houseArea = house.reduce((a, r) => a + (r.i1 - r.i0) * (r.j1 - r.j0), 0) * c * c;
    // open space & shielding from roads
    const open = open0.map((x, k) => (x && !mask[k] ? 1 : 0));
    const usable = opening(g, open, Math.round(3 / c));
    const comps = components(g, usable).comps.sort((a, b) => b.size - a.size);
    const largestGarden = comps.length ? comps[0].size * c * c : 0;
    let shielded = 0, shieldW = 0;
    for (const rd of roadDirs) {
      // sweep from the road side inwards: a cell is shielded if the house lies between it and the road
      const [di, dj] = rd.d;
      let hit = 0, tot = 0;
      if (dj !== 0) {
        for (let i = 0; i < nx; i++) {
          let seenHouse = false;
          const js = dj < 0 ? [...Array(ny).keys()] : [...Array(ny).keys()].reverse();
          for (const j of js) {
            const k = j * nx + i;
            if (mask[k]) seenHouse = true;
            else if (usable[k]) { tot++; if (seenHouse) hit++; }
          }
        }
      } else {
        for (let j = 0; j < ny; j++) {
          let seenHouse = false;
          const is = di < 0 ? [...Array(nx).keys()] : [...Array(nx).keys()].reverse();
          for (const i of is) {
            const k = j * nx + i;
            if (mask[k]) seenHouse = true;
            else if (usable[k]) { tot++; if (seenHouse) hit++; }
          }
        }
      }
      shielded += rd.w * (tot ? hit / tot : 0); shieldW += rd.w;
    }
    const shieldRatio = shieldW ? shielded / shieldW : 0;
    // enclosure (courts): open cells with house within 12 m in >= 3 of 4 directions
    // four directional sweeps: distance to the nearest house cell, interrupted by the plot edge
    const reach = Math.round(12 / c);
    const hitsArr = new Uint8Array(g.n);
    for (let j = 0; j < ny; j++) {
      let last = -1;
      for (let i = 0; i < nx; i++) { const k = j * nx + i; if (mask[k]) last = i; else if (!F.inSite[k]) last = -1; else if (last >= 0 && i - last <= reach) hitsArr[k]++; }
      last = -1;
      for (let i = nx - 1; i >= 0; i--) { const k = j * nx + i; if (mask[k]) last = i; else if (!F.inSite[k]) last = -1; else if (last >= 0 && last - i <= reach) hitsArr[k]++; }
    }
    for (let i = 0; i < nx; i++) {
      let last = -1;
      for (let j = 0; j < ny; j++) { const k = j * nx + i; if (mask[k]) last = j; else if (!F.inSite[k]) last = -1; else if (last >= 0 && j - last <= reach) hitsArr[k]++; }
      last = -1;
      for (let j = ny - 1; j >= 0; j--) { const k = j * nx + i; if (mask[k]) last = j; else if (!F.inSite[k]) last = -1; else if (last >= 0 && last - j <= reach) hitsArr[k]++; }
    }
    const enclosed = new Uint8Array(g.n);
    const need = cand.family === 'court' ? 4 : 3;
    for (let k = 0; k < g.n; k++) if (open[k] && hitsArr[k] >= need) enclosed[k] = 1;
    const courtComps = components(g, enclosed).comps.sort((a, b) => b.size - a.size);
    const courtArea = courtComps.length ? courtComps[0].size * c * c : 0;
    // trees embraced
    let treeScore = 0.5;
    const treeHits = [];
    if (trees.length) {
      let s = 0, wsum = 0;
      for (const t of trees) {
        const [ti, tj] = g.cellOf(...g.frame.toLocal([t.x, t.y]));
        const lim = Math.round((t.r + DESIGN.treeBuffer + 4.5) / c);
        let hits = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let st = 1; st <= lim; st++) { if (at(ti + di * st, tj + dj * st)) { hits++; break; } }
        }
        const w = Math.max(1, t.h || 6) * Math.max(1, t.cost || 0);
        s += w * (hits / 4); wsum += w;
        treeHits.push({ id: t.id, hits, w });
      }
      treeScore = s / wsum;
    }
    // views from the house edge
    let viewScore = 0.5;
    if (desirable.length) {
      let s = 0;
      for (const vw of desirable) {
        const dir = g.frame.localDir([vw.to[0] - vw.from[0], vw.to[1] - vw.from[1]]);
        const L = Math.hypot(dir[0], dir[1]) || 1;
        const [fs, ft] = g.frame.toLocal(vw.from);
        let best = 0;
        for (const k of perimCells) {
          const i = k % nx, j = (k - i) / nx;
          const [cs, ct] = g.centerLocal(i, j);
          const d = Math.hypot(cs - fs, ct - ft);
          let facing = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!at(i + di, j + dj)) facing = Math.max(facing, (di * dir[0] + dj * dir[1]) / L);
          if (facing > 0.2) best = Math.max(best, facing * Math.exp(-d / 6));
        }
        s += (vw.weight ?? 1) * best;
      }
      viewScore = clamp(s / desirable.reduce((a, vw) => a + (vw.weight ?? 1), 0));
    }
    // arrival
    let dArr = Infinity, sumS = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (mask[j * nx + i]) {
      const [cs, ct] = g.centerLocal(i, j);
      sumS += cs;
      dArr = Math.min(dArr, Math.hypot(cs - arrival[0], ct - arrival[1]));
    }
    const centS = sumS / Math.max(1, cells);
    const dStar = { subtle: 6, grand: 10, imposing: 4 }[character] ?? 6;
    let arrivalScore = clamp(1 - Math.abs(dArr - dStar) / 10);
    if (character !== 'subtle') arrivalScore = 0.6 * arrivalScore + 0.4 * clamp(1 - Math.abs(centS - arrival[0]) / (g.frame.S / 2));
    const wingDepth = mean(house.map((r) => Math.min(r.i1 - r.i0, r.j1 - r.j0) * c));
    const avgExpo = P ? expo / P : 0.6;
    const compact = P ? areaM / ((P * P) / 16) : 0;
    cand.metrics = {
      area: round(houseArea, 1), groundArea: round(areaM, 1), perimeter: round(P, 1), westFacade: round(westLen, 1),
      avgExposure: round(avgExpo, 2), wingDepth: round(wingDepth, 1), shielded: round(shieldRatio, 2),
      garden: round(largestGarden, 1), court: round(courtArea, 1), noise: round(noiseSum / Math.max(1, cells), 2),
      exposure: round(privSum / Math.max(1, perimCells.length), 2), depth: round(depthSum / Math.max(1, cells), 2),
      arrivalDist: round(dArr, 1), compactness: round(compact, 2), treeHits, faceLen,
    };
    cand.scores = {
      fit: clamp(1 - (3 * Math.abs(houseArea - T.target)) / T.target),
      privacy: clamp(0.45 * (1 - privSum / Math.max(1, perimCells.length)) / 0.6 + 0.55 * shieldRatio),
      depth: clamp(depthSum / Math.max(1, cells) / 0.7),
      trees: treeScore,
      court: T.courtArea ? clamp(courtArea / T.courtArea) : courtArea > 9 ? 0.75 : 0.5,
      ventilation: clamp((12 - wingDepth) / 6 + (courtArea > 9 ? 0.15 : 0)),
      solar: clamp((0.85 - avgExpo) / 0.35),
      views: viewScore,
      garden: clamp(largestGarden / gardenWanted),
      noise: clamp(1 - (noiseSum / Math.max(1, cells)) / 0.6),
      compactness: clamp((compact - 0.45) / 0.5),
      arrival: arrivalScore,
    };
  };
}

const SHARED_NOTE = {
  views: 'None of the options reaches the desirable view from the plot as constrained — consider upper-floor openings or revisiting tree/access decisions.',
  compactness: 'All options have long perimeters for their area — the constraints favour slim wings over a compact block.',
  privacy: 'All options leave the open space exposed to the street — consider a compound wall or planting buffer.',
  noise: 'Every option sits within the road-noise zone; bedrooms should go upstairs or to the quiet side.',
  court: 'No option can enclose the requested courtyard on this plot as constrained.',
  trees: 'No option can wrap the preserved trees — they sit too close to the plot edge.',
  solar: 'All options expose long facades to the west sun — plan deep shading.',
  garden: 'Open space is fragmented in every option.',
};

const SCORE_LABEL = {
  privacy: 'Privacy', depth: 'Set back from street', trees: 'Tree relationship', court: 'Courtyard',
  ventilation: 'Cross-ventilation', solar: 'Solar control', views: 'Views', garden: 'Usable garden',
  noise: 'Quiet', compactness: 'Economy', arrival: 'Arrival', fit: 'Area fit',
};
export { SCORE_LABEL };

function finish(cand, i, ctx, T, chosen, sharedKeys = []) {
  const { A, F } = ctx;
  const g = F.grid, c = g.c;
  const m = cand.metrics, s = cand.scores;
  const rects = cand.cellRects.map((r) => ({ s0: (r.i0 - g.pad) * c, t0: (r.j0 - g.pad) * c, s1: (r.i1 - g.pad) * c, t1: (r.j1 - g.pad) * c, role: r.role }));
  const tree = cand.meta?.tree ? A.trees.find((t) => t.id === cand.meta.tree) : null;
  const treeName = (t) => `${t.species ? `the ${t.species.toLowerCase()} ` : ''}(${t.id})`;
  let title = FAMILIES[cand.family];
  if (tree && cand.family === 'court') title = `Courtyard house around ${treeName(tree)}`;
  else if (tree && cand.family === 'U') title = `U-house embracing ${treeName(tree)}`;
  else if (tree && cand.family === 'L') title = `L-house wrapping ${treeName(tree)}`;
  else if (cand.family === 'bar') title = m.depth > 0.55 ? 'Rear bar with a front garden' : 'Street bar with a rear garden';
  else if (cand.family === 'L') title = m.shielded > 0.5 ? 'L-house shielding the garden' : 'L-house open to the street';
  else if (cand.family === 'U') title = 'U-house around an open court';

  // pros/cons: where this option is strong/weak in absolute terms and against its siblings
  const others = chosen.filter((x) => x !== cand);
  const rel = (k) => others.length ? s[k] - Math.max(...others.map((o) => o.scores[k])) : 0;
  const relMin = (k) => others.length ? s[k] - Math.min(...others.map((o) => o.scores[k])) : 0;
  const westName = m.westFacade;
  const phrases = {
    privacy: [`The mass shields ${Math.round(m.shielded * 100)}% of the open space from the street.`, `Only ${Math.round(m.shielded * 100)}% of the open space is screened from the street.`],
    depth: ['The house sits deep in the plot, away from the road.', 'The house sits close to the road.'],
    trees: [treeTxt(m.treeHits, A, true), treeTxt(m.treeHits, A, false)],
    court: [m.court > 0 ? `Encloses a ${m.court} m² court${T.courtArea ? ` (brief asks ${T.courtArea} m²)` : ''}.` : 'Opens fully to the garden.', T.courtArea ? (m.court > 0 ? `The court is only ${m.court} m² (brief asks ${T.courtArea} m²).` : 'No enclosed courtyard, though the brief asks for one.') : 'No enclosed court.'],
    ventilation: [`Slim wings (~${m.wingDepth} m deep) allow cross-ventilation.`, `Deep plan (~${m.wingDepth} m) limits cross-ventilation.`],
    solar: [`Long faces turn away from the heat; ${westName} m of facade faces west.`, `${westName} m of facade faces the western sun — needs deep shading.`],
    views: ['Main edge faces the desirable view.', 'Turns away from the desirable view.'],
    garden: [`Leaves one usable garden of ~${m.garden} m².`, `Open space is fragmented; the largest usable garden is ~${m.garden} m².`],
    noise: ['Kept away from the noisiest part of the plot.', 'Sits within the road-noise zone.'],
    compactness: [`Compact perimeter (${m.perimeter} m) — economical to build.`, `Long perimeter (${m.perimeter} m) adds envelope cost.`],
    arrival: ['The house meets the arrival point at a comfortable distance.', 'The arrival sequence to the door is awkward.'],
    fit: ['', `Footprint ${m.area} m² vs target ${round(T.target)} m².`],
  };
  const keys = Object.keys(phrases).filter((k) => k !== 'fit');
  const strong = keys.filter((k) => s[k] >= 0.7 || (rel(k) > 0.12 && s[k] >= 0.5)).sort((a, b) => s[b] - s[a]).slice(0, 4);
  const weak = keys.filter((k) => s[k] <= 0.35 || (relMin(k) < -0.15 && s[k] < 0.6)).sort((a, b) => s[a] - s[b]).slice(0, 3);
  const pros = strong.map((k) => phrases[k][0]).filter(Boolean);
  const cons = weak.filter((k) => !strong.includes(k) && !sharedKeys.includes(k)).map((k) => phrases[k][1]).filter(Boolean);
  if (s.fit < 0.8) cons.push(phrases.fit[1]);
  const logic = {
    bar: 'A single slim wing — simple structure and circulation; the open space gathers on one side.',
    compact: 'One compact block — the least envelope and the shortest circulation; open space wraps around it.',
    L: 'Two wings at right angles define a protected outdoor room in the crook of the L.',
    U: 'Three wings hold an open court that can open to the garden or a tree.',
    court: 'Rooms ring an enclosed open-to-sky court — introverted, shaded and ventilated from the centre.',
    pavilion: 'Two separate blocks joined by a link — porous, with garden between public and private.',
  }[cand.family];
  return {
    id: String.fromCharCode(65 + i), family: cand.family, title, logic, placement: cand.placement,
    anchorTree: cand.meta?.tree || null, rects, metrics: m, scores: s, total: cand.total, pros, cons,
  };
}

function treeTxt(hits, A, good) {
  if (!hits || !hits.length) return good ? '' : '';
  const best = [...hits].sort((a, b) => b.hits - a.hits || (b.w || 0) - (a.w || 0))[0];
  const t = A.trees.find((x) => x.id === best.id);
  const nm = `${t.species ? t.species + ' ' : ''}${t.id}`;
  if (good) return best.hits >= 4 ? `Encloses ${nm} — the tree becomes the heart of the plan.` : best.hits >= 2 ? `Wraps ${nm} on ${best.hits} sides; the tree anchors the plan.` : `Faces ${nm}.`;
  const worst = [...hits].sort((a, b) => a.hits - b.hits || (b.w || 0) - (a.w || 0))[0];
  const tw = A.trees.find((x) => x.id === worst.id);
  return `Turns its back on ${tw.species ? tw.species + ' ' : ''}${tw.id}; the tree is left over rather than used.`;
}

// Privacy zoning (spec §43) and open-space reading for a chosen footprint.
export function zoneFootprint(ctx, option) {
  const { F, access, masks } = ctx;
  const g = F.grid, c = g.c, { nx, ny } = g;
  const house = footprintMask(g, option.rects.filter((r) => r.role !== 'garage'));
  const arrival = access?.arrival ? g.frame.toLocal(access.arrival) : [g.frame.S / 2, 0];
  // entrance = house edge cell nearest the arrival point
  let ent = -1, best = Infinity;
  for (let k = 0; k < g.n; k++) if (house[k]) {
    const i = k % nx, j = (k - i) / nx;
    const [s, t] = g.centerLocal(i, j);
    const d = Math.hypot(s - arrival[0], t - arrival[1]);
    if (d < best) { best = d; ent = k; }
  }
  const geo = geodesic(g, house, [ent]);
  let gmax = 0;
  for (let k = 0; k < g.n; k++) if (house[k] && Number.isFinite(geo[k])) gmax = Math.max(gmax, geo[k]);
  const z = new Float32Array(g.n);
  const vals = [];
  for (let k = 0; k < g.n; k++) if (house[k]) {
    z[k] = 0.75 * (Number.isFinite(geo[k]) ? geo[k] / (gmax || 1) : 1) + 0.25 * (1 - F.privacy[k]);
    vals.push(z[k]);
  }
  vals.sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length / 3)] ?? 0.33, q2 = vals[Math.floor((2 * vals.length) / 3)] ?? 0.66;
  const zone = new Uint8Array(g.n); // 1 public, 2 semi, 3 private
  for (let k = 0; k < g.n; k++) if (house[k]) zone[k] = z[k] <= q1 ? 1 : z[k] <= q2 ? 2 : 3;
  // open spaces
  const all = footprintMask(g, option.rects);
  const open = F.inSite.map((x, k) => (x && !all[k] && !masks.corridor[k] ? 1 : 0));
  const usable = opening(g, open, Math.round(2.5 / c));
  const comps = components(g, usable).comps.filter((cc) => cc.size * c * c >= 6);
  let tMin = Infinity, tMax = -Infinity;
  for (let k = 0; k < g.n; k++) if (house[k]) { const j = Math.floor(k / nx); tMin = Math.min(tMin, j); tMax = Math.max(tMax, j); }
  const spaces = comps.map((cc) => {
    let si = 0, sj = 0, touchesEdge = false;
    for (const k of cc.cells) {
      const i = k % nx, j = (k - i) / nx;
      si += i; sj += j;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny || !F.inSite[b * nx + a]) touchesEdge = true;
      }
    }
    si /= cc.size; sj /= cc.size;
    let kind = 'side-garden';
    if (!touchesEdge) kind = 'courtyard';
    else if (sj < tMin) kind = 'front-garden';
    else if (sj > tMax - 1) kind = 'rear-garden';
    const view = mean(cc.cells, (k) => F.view[k]);
    return { kind, area: round(cc.size * c * c, 1), centre: g.centerLocal(Math.round(si), Math.round(sj)), cells: cc.cells, view };
  }).sort((a, b) => b.area - a.area);
  const wantYard = (ctx.brief.openSpaces || []).some((o) => o.type === 'service-yard');
  if (wantYard) {
    // a secondary side/rear space becomes the service yard; the main garden is never sacrificed
    const main = spaces.find((sp) => sp.kind !== 'courtyard');
    const cands = spaces.filter((sp) => sp !== main && (sp.kind === 'side-garden' || sp.kind === 'rear-garden'));
    const yard = cands.sort((a, b) => a.view - b.view || a.area - b.area)[0];
    if (yard) yard.kind = 'service-yard';
  }
  return { zone, entranceCell: ent, geo, spaces, dirName: (b) => COMPASS_NAMES[compass8(b)] };
}

export const FAMILY_LABEL = FAMILIES;
export { dist as _dist };
