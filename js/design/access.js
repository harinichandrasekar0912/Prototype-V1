// Stage 03 — access, parking and the reserved circulation zone (spec §33–39).
//
// Gates are generated along every road edge and composed into distinct *strategies* (side entry,
// arrival court, axial entry, split access) rather than near-identical positions. Each option
// records its geometry, metrics and component scores so the explanation can be computed, not
// invented. Traffic flow is evaluated from the driving side and the road's direction (spec §34),
// never from a fixed "entry left of exit" rule.

import { add, sub, mul, dot, dist, pointInPolygon, distToSegment, area, leftNormal } from '../geometry/polygon.js';
import { maskCount } from '../geometry/grid.js';
import { DESIGN } from '../rules/assumptions.js';
import { clamp, round, mean } from '../core/util.js';

const CHARACTER = {
  subtle: { side: 1, split: 0.9, axial: 0.35, through: 0.4 },
  grand: { side: 0.35, split: 0.5, axial: 0.85, through: 1 },
  imposing: { side: 0.25, split: 0.45, axial: 1, through: 0.8 },
};

export function treeMask(F, A, preserved) {
  const g = F.grid;
  const m = new Uint8Array(g.n);
  for (const t of A.trees) {
    if (!preserved.has(t.id) || !t.inside) continue;
    // cells overlapping the exclusion square (aligned to the design frame)
    const i0 = Math.floor(t.rect.s0 / g.c) + g.pad, i1 = Math.ceil(t.rect.s1 / g.c) + g.pad;
    const j0 = Math.floor(t.rect.t0 / g.c) + g.pad, j1 = Math.ceil(t.rect.t1 / g.c) + g.pad;
    for (let j = Math.max(0, j0); j < Math.min(g.ny, j1); j++)
      for (let i = Math.max(0, i0); i < Math.min(g.nx, i1); i++) m[j * g.nx + i] = 1;
  }
  return m;
}

function rasterise(F, polys) {
  const g = F.grid, m = new Uint8Array(g.n);
  if (!polys.length) return m;
  const offs = [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92], [0.5, 0.08], [0.5, 0.92], [0.08, 0.5], [0.92, 0.5]];
  for (const poly of polys) {
    // only visit cells under the polygon's bounding box (in the design frame)
    const loc = poly.map((p) => g.frame.toLocal(p));
    const s0 = Math.min(...loc.map((q) => q[0])), s1 = Math.max(...loc.map((q) => q[0]));
    const t0 = Math.min(...loc.map((q) => q[1])), t1 = Math.max(...loc.map((q) => q[1]));
    const [i0, j0] = g.cellOf(s0, t0), [i1, j1] = g.cellOf(s1, t1);
    for (let j = Math.max(0, j0); j <= Math.min(g.ny - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(g.nx - 1, i1); i++) {
        const k = j * g.nx + i;
        if (m[k]) continue;
        const s = g.s0(i), t = g.t0(j);
        for (const [a, b] of offs) {
          if (pointInPolygon(g.frame.toWorld(s + a * g.c, t + b * g.c), poly)) { m[k] = 1; break; }
        }
      }
  }
  return m;
}

// Rectangle of half-width w around segment p->q (extended by `extEnd` beyond q).
function segRect(p, q, w, extStart = 0, extEnd = 0) {
  const d = sub(q, p), L = Math.hypot(d[0], d[1]) || 1, u = [d[0] / L, d[1] / L], nn = leftNormal(u);
  const a = sub(p, mul(u, extStart)), b = add(q, mul(u, extEnd));
  return [add(a, mul(nn, -w)), add(b, mul(nn, -w)), add(b, mul(nn, w)), add(a, mul(nn, w))];
}

function inSiteish(A, p) {
  if (pointInPolygon(p, A.pts)) return true;
  return A.edges.some((e) => distToSegment(p, e.a, e.b) < 0.02);
}

export function generateAccess(A, F, brief, location, preserved, seed = 0) {
  const parking = brief.parking || { type: 'open', cars: 1 };
  const cars = Math.max(0, parking.cars || 0);
  const ptype = cars === 0 ? 'none' : parking.type;
  const trees = A.trees.filter((t) => t.inside && preserved.has(t.id));
  const tMask = treeMask(F, A, preserved);
  const base = F.setbackMask.map((v, k) => (v && !tMask[k] ? 1 : 0));
  const baseCount = maskCount(base);
  const W = DESIGN.drivewayHalfWidth;
  const roadEdges = A.edges.filter((e) => e.road).sort((p, q) => q.road.width - p.road.width);
  if (!roadEdges.length) return { options: [], note: 'Add a road to the site to generate access options.' };

  // ---------- geometry for one vehicular arrangement --------------------------------------------
  const build = (strategy, e, gates, pedGate) => {
    const nin = mul(e.out, -1);
    const setbackHere = A.setbackDists[e.k];
    const polys = [];
    let path = [], pad = null, fixedRect = null, arrival = null;
    const padD = DESIGN.bayD, padW = Math.max(cars, 1) * DESIGN.bayW;
    if (ptype !== 'none' && gates.length === 1) {
      const g = gates[0].c;
      if (ptype === 'open') {
        const depth = padD;
        path = [g, add(g, mul(nin, depth))];
        polys.push(segRect(path[0], path[1], W, 0, 0));
        const half = Math.max(padW / 2, W);
        // pad centred on the gate, but kept inside the edge
        pad = [add(g, mul(e.dir, -half)), add(g, mul(e.dir, half)), add(add(g, mul(e.dir, half)), mul(nin, padD)), add(add(g, mul(e.dir, -half)), mul(nin, padD))];
        polys.push(pad);
        arrival = add(g, mul(nin, depth));
      } else {
        // garage / stilt: drive to the setback line; the car rectangle becomes part of the footprint
        const depth = setbackHere + 0.01;
        path = [g, add(g, mul(nin, depth))];
        polys.push(segRect(path[0], path[1], W, 0, 0));
        const gw = ptype === 'garage' ? Math.max(cars, 1) * DESIGN.garagePerCar.w : padW;
        const gd = ptype === 'garage' ? DESIGN.garagePerCar.d : padD;
        const p0 = add(path[1], mul(e.dir, -gw / 2)), p1 = add(path[1], mul(e.dir, gw / 2));
        const rectW = [p0, p1, add(p1, mul(nin, gd)), add(p0, mul(nin, gd))];
        const loc = rectW.map((p) => A.frame.toLocal(p));
        const ss = loc.map((q) => q[0]), tt = loc.map((q) => q[1]);
        const sn = (v) => Math.round(v / DESIGN.cell) * DESIGN.cell;
        fixedRect = { s0: sn(Math.min(...ss)), t0: sn(Math.min(...tt)), s1: sn(Math.max(...ss)), t1: sn(Math.max(...tt)), role: ptype };
        arrival = path[1];
      }
    } else if (ptype !== 'none' && gates.length === 2) {
      // arrival court: in through one gate, a drop-off along the house, out through the other
      const d = 6;
      const g1 = gates[0].c, g2 = gates[1].c;
      path = [g1, add(g1, mul(nin, d)), add(g2, mul(nin, d)), g2];
      polys.push(segRect(path[0], path[1], W, 0, W));
      polys.push(segRect(path[1], path[2], W, W, W));
      polys.push(segRect(path[2], path[3], W, W, 0));
      const mid = mul(add(path[1], path[2]), 0.5);
      if (ptype === 'open') {
        const back = add(mid, mul(nin, W));
        pad = [add(back, mul(e.dir, -padW / 2)), add(back, mul(e.dir, padW / 2)), add(add(back, mul(e.dir, padW / 2)), mul(nin, padD)), add(add(back, mul(e.dir, -padW / 2)), mul(nin, padD))];
        polys.push(pad);
      }
      arrival = add(mid, mul(nin, W));
    }
    let pedPath = null;
    if (pedGate) {
      const pe = pedGate.edge, pn = mul(pe.out, -1);
      pedPath = [pedGate.c, add(pedGate.c, mul(pn, A.setbackDists[pe.k] + 0.5))];
      arrival = pedPath[1];
    } else if (!arrival && gates.length) {
      arrival = add(gates[0].c, mul(nin, setbackHere));
    }
    // validity: corridor inside the plot, clear of preserved trunks
    for (const poly of polys) for (const p of poly) if (!inSiteish(A, p)) return null;
    for (const t of trees) {
      const core = 0.35 * t.r + 0.5;
      for (const poly of polys) {
        if (pointInPolygon([t.x, t.y], poly)) return null;
        for (let i = 0; i < poly.length; i++) if (distToSegment([t.x, t.y], poly[i], poly[(i + 1) % poly.length]) < core) return null;
      }
    }
    if (pedGate) for (const t of trees) if (distToSegment([t.x, t.y], pedPath[0], pedPath[1]) < 0.35 * t.r + 0.3) return null;
    const corr = rasterise(F, polys);
    const fixedMask = new Uint8Array(F.grid.n);
    if (fixedRect) {
      const g = F.grid, rc = g.rectCells(fixedRect);
      for (let j = rc.j0; j < rc.j1; j++) for (let i = rc.i0; i < rc.i1; i++) {
        if (!g.inBounds(i, j) || !base[j * g.nx + i]) return null; // garage/stilt must be buildable
        fixedMask[j * g.nx + i] = 1;
      }
    }
    const after = base.map((v, k) => (v && !corr[k] ? 1 : 0));
    const keptCount = maskCount(after);
    const corrArea = polys.reduce((s, p) => s + area(p), 0) - (pad && polys.length > 1 ? Math.min(area(pad), 2 * W * padD) * 0.5 : 0);
    // tree root-zone overlap (soft)
    let rootOverlap = 0;
    for (let k = 0; k < corr.length; k++) if (corr[k] && tMask[k]) rootOverlap++;
    return {
      strategy, edge: e, gates, pedGate, path, pedPath, polys, pad, fixedRect, arrival,
      corridorMask: corr, fixedMask, buildableAfter: after,
      metrics: {
        corridorArea: round(maskCount(corr) * F.grid.c ** 2, 1),
        buildableKept: keptCount / Math.max(1, baseCount),
        buildableAfterArea: round(keptCount * F.grid.c ** 2, 1),
        rootOverlap: round(rootOverlap * F.grid.c ** 2, 1),
        approxPaved: round(corrArea, 1),
      },
    };
  };

  const mkGate = (e, u, width, kind) => {
    const c = add(e.a, mul(e.dir, u));
    return { kind, edge: e, u, width, c, a: add(e.a, mul(e.dir, u - width / 2)), b: add(e.a, mul(e.dir, u + width / 2)) };
  };

  // Near-lane flow along an edge: with left-hand traffic the lane next to the plot runs with the
  // plot on the driver's left. A one-way road overrides that.
  const flowDir = (e) => {
    const left = (location.drivingSide || 'left') === 'left';
    // travelling along e.dir, the plot (inward) is on the left of the driver for a CCW polygon
    let d = left ? e.dir : mul(e.dir, -1);
    if (e.road.oneWay === 'forward') d = e.dir;
    if (e.road.oneWay === 'backward') d = mul(e.dir, -1);
    return d;
  };

  const junctionPenalty = (e, u) => {
    // closeness of the gate to a corner shared with another road edge
    let pen = 0;
    const n = A.edges.length;
    const prev = A.edges[(e.k - 1 + n) % n], next = A.edges[(e.k + 1) % n];
    if (prev.road && u < 6) pen = Math.max(pen, 1 - u / 6);
    if (next.road && e.length - u < 6) pen = Math.max(pen, 1 - (e.length - u) / 6);
    return pen;
  };

  const candidates = [];
  const pedFor = (e, avoidU, mode) => {
    if (!brief.separatePedestrianGate) return null;
    const pw = DESIGN.gatePedestrian;
    const opts = [];
    for (let u = 1; u <= e.length - 1; u += 0.5) {
      if (avoidU !== null && Math.abs(u - avoidU) < 4.5) continue;
      opts.push(u);
    }
    if (!opts.length) return null;
    let u;
    if (mode === 'centre') u = opts.reduce((a, b) => (Math.abs(b - e.length / 2) < Math.abs(a - e.length / 2) ? b : a));
    else if (mode === 'far') u = opts.reduce((a, b) => (Math.abs(b - avoidU) > Math.abs(a - avoidU) ? b : a));
    else u = opts.reduce((a, b) => (Math.abs(b - (avoidU ?? 0)) < Math.abs(a - (avoidU ?? 0)) ? b : a));
    return mkGate(e, u, pw, 'pedestrian');
  };

  const main = roadEdges[0];
  // Single combined gates along every road edge
  for (const e of roadEdges) {
    const gw = DESIGN.gateVehicle;
    for (let u = Math.max(gw / 2 + 0.6, W + 0.1); u <= e.length - Math.max(gw / 2 + 0.6, W + 0.1); u += 0.5) {
      const ratio = u / e.length;
      const isMain = e === main;
      const strat = !isMain ? 'split' : ratio > 0.38 && ratio < 0.62 ? 'axial' : ratio < 0.3 || ratio > 0.7 ? 'side' : null;
      if (!strat) continue;
      const g = mkGate(e, u, gw, 'vehicle');
      const ped = strat === 'split' ? pedFor(main, null, 'centre') : pedFor(e, u, strat === 'axial' ? 'near' : 'far');
      const r = ptype === 'none' ? null : build(strat, e, [g], ped);
      if (r) { r.junction = junctionPenalty(e, u); candidates.push(r); }
    }
  }
  // Arrival court on the main road (drive-through)
  if (ptype !== 'none') {
    const e = main, gw = DESIGN.gateInOut;
    for (let u1 = W + 0.6; u1 <= e.length - W - 0.6; u1 += 1)
      for (let u2 = u1 + 8; u2 <= Math.min(e.length - W - 0.6, u1 + 14); u2 += 1) {
        const flow = flowDir(e);
        // entry upstream of exit relative to near-lane flow
        const forward = dot(flow, e.dir) > 0;
        const [uin, uout] = forward ? [u1, u2] : [u2, u1];
        const gates = [mkGate(e, uin, gw, 'entry'), mkGate(e, uout, gw, 'exit')];
        const ped = pedFor(e, (u1 + u2) / 2, 'near');
        const r = build('through', e, gates, ped && Math.abs(ped.u - u1) > 3 && Math.abs(ped.u - u2) > 3 ? ped : null);
        if (r) { r.junction = Math.max(junctionPenalty(e, u1), junctionPenalty(e, u2)); r.flowOk = true; candidates.push(r); }
      }
  }
  if (ptype === 'none') {
    // pedestrian-only plots: offer gate positions along the main road
    for (const mode of ['far', 'centre', 'near']) {
      const ped = pedFor(main, mode === 'far' ? 0 : mode === 'near' ? main.length : null, mode === 'centre' ? 'centre' : 'near') || mkGate(main, main.length / 2, DESIGN.gatePedestrian, 'pedestrian');
      const r = build(mode === 'centre' ? 'axial' : 'side', main, [], ped);
      if (r) { r.junction = 0; candidates.push(r); }
    }
  }

  // ---------- scoring -------------------------------------------------------------------------
  const ch = CHARACTER[brief.entryCharacter] || CHARACTER.subtle;
  const maxCorr = Math.max(...candidates.map((c) => c.metrics.corridorArea), 1);
  for (const c of candidates) {
    const sc = {
      efficiency: clamp(1 - c.metrics.corridorArea / (maxCorr * 1.15)),
      buildable: clamp((c.metrics.buildableKept - 0.6) / 0.4),
      trees: clamp(1 - c.metrics.rootOverlap / 12),
      safety: clamp(1 - c.junction),
      character: ch[c.strategy] ?? 0.5,
      frontage: frontageFree(c, main),
    };
    const w = { efficiency: 1, buildable: 1.3, trees: 1.4, safety: 0.9, character: 1.2, frontage: 0.8 };
    c.scores = sc;
    c.total = Object.keys(w).reduce((s, k) => s + w[k] * sc[k], 0) / Object.values(w).reduce((a, b) => a + b, 0);
  }

  // best per strategy, then up to three distinct strategies
  const byStrat = {};
  for (const c of candidates) if (!byStrat[c.strategy] || c.total > byStrat[c.strategy].total) byStrat[c.strategy] = c;
  const order = Object.values(byStrat).sort((a, b) => b.total - a.total);
  // ensure "side" always present when available (the economical baseline)
  let chosen = order.slice(0, 3);
  if (byStrat.side && !chosen.includes(byStrat.side)) chosen = [...chosen.slice(0, 2), byStrat.side];
  chosen.sort((a, b) => b.total - a.total);
  const options = chosen.map((c, i) => finishOption(c, i, A, F, brief, ptype, cars, location.drivingSide || 'left'));
  if (options.length) options[0].recommended = true;
  return { options, candidatesEvaluated: candidates.length };
}

function frontageFree(c, main) {
  // share of the main frontage not consumed by gates/paving — land left for a planted edge
  if (c.edge !== main) return 1;
  const used = c.gates.reduce((s, g) => s + Math.max(g.width, 4), 0) + (c.pedGate && c.pedGate.edge === main ? 1.5 : 0);
  const padW = c.pad ? 0 : 0;
  return clamp(1 - (used + padW) / main.length);
}

const TITLES = {
  side: 'Side entry, compact drive',
  through: 'Arrival court (drive-through)',
  axial: 'Axial entry on the main road',
  split: 'Split access across two roads',
};

function finishOption(c, i, A, F, brief, ptype, cars, side) {
  const id = String.fromCharCode(65 + i);
  const e = c.edge;
  const gateTxt = c.gates.map((g) => `${g.kind} gate ${g.width} m`).join(' + ');
  const road = e.road.name || 'the road';
  const pros = [], cons = [];
  const m = c.metrics;
  if (c.scores.efficiency > 0.7) pros.push(`Only ~${m.corridorArea} m² of the plot is given to vehicles.`);
  if (c.scores.efficiency < 0.45) cons.push(`Vehicles take ~${m.corridorArea} m² of the plot.`);
  if (c.scores.buildable > 0.75) pros.push(`Keeps ${Math.round(m.buildableKept * 100)}% of the buildable area free for the house.`);
  else cons.push(`Leaves ${Math.round(m.buildableKept * 100)}% of the buildable area (${m.buildableAfterArea} m²).`);
  if (m.rootOverlap > 1) cons.push(`Paving crosses ${m.rootOverlap} m² of a preserved tree's root zone.`);
  if (c.junction > 0.3) cons.push('The gate is close to the road junction — slower, less safe turning.');
  if (c.strategy === 'through') {
    pros.push('Cars drop off at the door and leave without reversing; entry is placed upstream of the exit for the near-lane traffic (driving on the ' + side + ').');
    cons.push('The forecourt consumes front garden and makes the arrival more formal.');
  }
  if (c.strategy === 'side') pros.push('The drive hugs one side, leaving the rest of the frontage for planting and a quieter threshold.');
  if (c.strategy === 'axial') { pros.push('A centred gate sets up a direct, frontal approach to the house.'); cons.push('The drive splits the front garden in two.'); }
  if (c.strategy === 'split') { pros.push(`Vehicles use ${road}; the main frontage stays for pedestrians and landscape.`); cons.push('Two gates to manage and secure.'); }
  if (c.pedGate) pros.push('A separate pedestrian gate gives visitors their own approach.');
  if (ptype === 'garage') pros.push(`An enclosed garage for ${cars} car${cars > 1 ? 's' : ''} sits at the end of the drive as part of the footprint.`);
  if (ptype === 'stilt') pros.push('Cars park under the building on the stilt level; the residence starts one floor up.');
  const explanation = {
    side: `The gate sits towards one end of ${road} so the drive and ${ptype === 'open' ? 'open parking' : ptype} occupy a single strip.`,
    through: `Two gates on ${road} form an arrival court: in through one, drop off, out through the other.`,
    axial: `A single gate on the axis of ${road} leads straight to the house.`,
    split: `Vehicles enter from ${road}; people arrive from the main road through their own gate.`,
  }[c.strategy];
  return {
    id, strategy: c.strategy, title: TITLES[c.strategy], explanation, gateTxt,
    edgeK: e.k, gates: c.gates.map((g) => ({ kind: g.kind, edgeK: g.edge.k, u: g.u, width: g.width, a: g.a, b: g.b, c: g.c })),
    pedGate: c.pedGate ? { edgeK: c.pedGate.edge.k, u: c.pedGate.u, width: c.pedGate.width, a: c.pedGate.a, b: c.pedGate.b, c: c.pedGate.c } : null,
    path: c.path, pedPath: c.pedPath, polys: c.polys, pad: c.pad, fixedRect: c.fixedRect, arrival: c.arrival,
    parking: { type: ptype, cars },
    metrics: c.metrics, scores: c.scores, total: c.total, pros, cons,
  };
}

// Re-derive the masks for a stored (serialised) access option.
export function accessMasks(A, F, option, preserved) {
  const tMask = treeMask(F, A, preserved);
  const base = F.setbackMask.map((v, k) => (v && !tMask[k] ? 1 : 0));
  const corr = option ? rasterise(F, option.polys || []) : new Uint8Array(F.grid.n);
  const fixed = new Uint8Array(F.grid.n);
  if (option && option.fixedRect) {
    const g = F.grid, rc = g.rectCells(option.fixedRect);
    for (let j = Math.max(0, rc.j0); j < Math.min(g.ny, rc.j1); j++) for (let i = Math.max(0, rc.i0); i < Math.min(g.nx, rc.i1); i++) fixed[j * g.nx + i] = 1;
  }
  const buildable = base.map((v, k) => (v && !corr[k] ? 1 : 0));
  return { tMask, base, corridor: corr, fixed, buildable };
}

export { rasterise as rasteriseZones, mean as _mean };
