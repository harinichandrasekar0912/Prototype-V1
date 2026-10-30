// Drawings are generated from the design state (spec §86): this module turns project data into SVG
// markup following the visual conventions of spec §118. World coordinates are metres (y up); the
// SVG flips y once. Strokes use non-scaling widths so line weights stay constant while zooming.

import { getAnalysis, getFields, getMasks, getZoning, getBubbleCtx, getPlans, selected, preservedSet } from '../core/pipeline.js';
import { footprintMask } from '../design/footprint.js';
import { maskOutlines } from '../geometry/grid.js';
import { sunPath, KEY_DAYS } from '../analysis/sun.js';
import { vecFromBearing, add, mul, sub, norm, leftNormal, dist } from '../geometry/polygon.js';
import { ZONES, LIB } from '../rules/spaces.js';
import { round } from '../core/util.js';

export const C = {
  ink: '#1b1b19', grid: '#e7e4dc', boundary: '#111', setback: '#d0312d', tree: '#2f8f46', road: '#4b4b4b',
  context: '#b8b6b0', wind: '#1e6bd6', sun: '#e2a400', noise: '#f08a00', view: '#e0569b', privacy: '#7b4fb4',
  footprint: '#8b5a2b', corridor: '#6b6b6b', gate: '#c2362b', court: '#5f9e6e', muted: '#8a857b',
};

const f2 = (v) => Math.round(v * 1000) / 1000;
const P = (pts) => pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(' ');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'vector-effect="non-scaling-stroke"';

function poly(pts, a = {}) {
  return `<polygon points="${P(pts)}" fill="${a.fill || 'none'}" fill-opacity="${a.fo ?? 1}" stroke="${a.stroke || 'none'}" stroke-width="${a.sw ?? 1}" ${a.dash ? `stroke-dasharray="${a.dash}"` : ''} stroke-linejoin="${a.join || 'miter'}" ${a.op != null ? `opacity="${a.op}"` : ''} ${NS} ${a.extra || ''}/>`;
}
function pline(pts, a = {}) {
  return `<polyline points="${P(pts)}" fill="none" stroke="${a.stroke || C.ink}" stroke-width="${a.sw ?? 1}" ${a.dash ? `stroke-dasharray="${a.dash}"` : ''} stroke-linecap="${a.cap || 'butt'}" stroke-linejoin="round" ${a.op != null ? `opacity="${a.op}"` : ''} ${a.marker ? `marker-end="url(#${a.marker})"` : ''} ${NS}/>`;
}
function circle(c, r, a = {}) {
  return `<circle cx="${f2(c[0])}" cy="${f2(c[1])}" r="${f2(r)}" fill="${a.fill || 'none'}" fill-opacity="${a.fo ?? 1}" stroke="${a.stroke || 'none'}" stroke-width="${a.sw ?? 1}" ${a.dash ? `stroke-dasharray="${a.dash}"` : ''} ${a.op != null ? `opacity="${a.op}"` : ''} ${NS}/>`;
}
// text lives in a non-flipped group: y is negated. TS scales labels with the drawing's extent so
// they read at a sensible size whatever the plot size.
let TS = 1;
function text(p, s, a = {}) {
  const size = (a.size || 0.42) * TS;
  return `<text x="${f2(p[0])}" y="${f2(-p[1])}" font-size="${size}" fill="${a.fill || C.ink}" text-anchor="${a.anchor || 'middle'}" dominant-baseline="${a.base || 'middle'}" font-weight="${a.weight || 400}" ${a.italic ? 'font-style="italic"' : ''} ${a.op != null ? `opacity="${a.op}"` : ''} ${a.family === 'mono' ? 'font-family="IBM Plex Mono, ui-monospace, monospace"' : ''} letter-spacing="${a.ls || 0}" paint-order="stroke" stroke="${a.halo === false ? 'none' : '#fbfaf6'}" stroke-width="${a.halo === false ? 0 : size * 0.28}" stroke-linejoin="round">${esc(s)}</text>`;
}

export function defs() {
  const head = (id, col, size = 0.7) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${size}" markerHeight="${size}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker>`;
  return `<defs>${head('a-wind', C.wind, 1)}${head('a-sun', C.sun, 0.9)}${head('a-view', C.view, 0.8)}${head('a-gate', C.gate, 0.8)}${head('a-ink', C.ink, 0.6)}${head('a-muted', C.muted, 0.55)}
  <pattern id="hatch" width="0.5" height="0.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="0.5" stroke="#8a857b" stroke-width="0.05"/></pattern>
  <pattern id="hatch-tree" width="0.6" height="0.6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="0.6" stroke="${C.tree}" stroke-width="0.05"/></pattern>
  <pattern id="hatch-stair" width="0.3" height="0.3" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0.3" y2="0" stroke="#555" stroke-width="0.03"/></pattern></defs>`;
}

// ---------------------------------------------------------------------------------------------------
export function sceneBounds(p) {
  const A = getAnalysis(p);
  const pts = [...(p.site.boundary || [])];
  if (A.ok) for (const r of A.roads) pts.push(...r.polygon);
  for (const b of p.site.buildings || []) pts.push(...(b.polygon || []));
  if (!pts.length) return { x0: -5, y0: -5, x1: 25, y1: 25 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // site-focused framing with some context around it
  const sb = A.ok ? A.bbox : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  const m = Math.max(sb.w, sb.h) * 0.35 + 3;
  return { x0: Math.max(x0, sb.x0 - m) - 1, y0: Math.max(y0, sb.y0 - m) - 1, x1: Math.min(x1, sb.x1 + m) + 1, y1: Math.min(y1, sb.y1 + m) + 1 };
}

// Compose a drawing for a stage. `o` may override the selected option (for previews/compare).
export function drawScene(p, { stage, layers = {}, floor = 0, override = {}, thumb = false, selectedBubble = null } = {}) {
  const A = getAnalysis(p);
  const L = { grid: true, context: true, setbacks: true, trees: true, labels: !thumb, ...layers };
  const geo = [], txt = [];
  const bounds = sceneBounds(p);
  if (!A.ok) {
    if (p.site.boundary?.length >= 2) geo.push(pline([...p.site.boundary, p.site.boundary[0]], { stroke: C.setback, sw: 2, dash: '4 3' }));
    return { geo: geo.join(''), txt: '', bounds };
  }
  const F = getFields(p);
  const fr = A.frame;
  const span = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
  TS = Math.min(2.2, Math.max(0.85, span / 42));
  const late = ['footprint', 'programme', 'bubbles', 'plan', 'record'].includes(stage);
  const planStage = stage === 'plan';

  // grid
  if (L.grid && !thumb) {
    const g = [];
    for (let x = Math.ceil(bounds.x0); x <= bounds.x1; x++) g.push(`M${x},${bounds.y0}V${bounds.y1}`);
    for (let y = Math.ceil(bounds.y0); y <= bounds.y1; y++) g.push(`M${bounds.x0},${y}H${bounds.x1}`);
    geo.push(`<path d="${g.join('')}" stroke="${C.grid}" stroke-width="0.6" fill="none" ${NS}/>`);
  }
  // influence field heat-map
  if (L.field && F && !thumb) geo.push(drawField(F, L.field));
  // roads
  for (const r of A.roads) {
    geo.push(poly(r.polygon, { fill: C.road, fo: 0.3, stroke: 'none' }));
    if (L.labels) {
      const c = mul(add(r.centre[0], r.centre[1]), 0.5);
      txt.push(text(c, `${r.name || r.id} · ${r.width} m`, { size: 0.5, fill: '#3d3d3d', ls: 0.02 }));
    }
  }
  // context
  if (L.context) for (const b of A.buildings) {
    if (!b.polygon || b.polygon.length < 3) continue;
    geo.push(poly(b.polygon, { fill: C.context, fo: 0.3, stroke: C.context, sw: 1 }));
    if (L.labels) txt.push(text(b.centroid, `${b.use || b.id}${b.height ? ` · ${b.height} m` : ''}`, { size: 0.42, fill: '#77746d' }));
  }
  // privacy & noise rings (site stage)
  const analysis = stage === 'site' || stage === 'brief' || stage === 'record';
  if (L.noise && (analysis || stage === 'trees') && !thumb) for (const s of A.noise) {
    const n = Math.min(14, Math.round(s.radius || 8));
    for (let k = 1; k <= n; k++) geo.push(circle([s.x, s.y], k, { stroke: C.noise, sw: 0.8, op: 0.75 - (0.55 * k) / n }));
    geo.push(circle([s.x, s.y], 0.25, { fill: C.noise }));
    if (L.labels) txt.push(text([s.x, s.y + 0.8], s.label || s.id, { size: 0.42, fill: '#b56300' }));
  }
  if (L.privacy && analysis && !thumb) for (const s of A.privacy) {
    const n = Math.min(10, Math.round(s.radius || 6));
    for (let k = 1; k <= n; k++) geo.push(circle([s.x, s.y], k, { stroke: C.privacy, sw: 0.7, dash: '2 3', op: 0.7 - (0.5 * k) / n }));
    if (L.labels) txt.push(text([s.x, s.y - 0.8], s.label || s.id, { size: 0.42, fill: C.privacy }));
  }
  // site boundary
  geo.push(poly(A.pts, { stroke: C.boundary, sw: thumb ? 1.4 : 2.2, fill: late ? 'none' : '#fff', fo: late ? 0 : 0.35 }));
  if (stage === 'site' && L.labels) {
    A.edges.forEach((e) => {
      const m = add(e.mid, mul(e.out, 0.7));
      txt.push(text(m, `e${e.user + 1}`, { size: 0.38, fill: '#55524b', family: 'mono' }));
    });
    const raw = p.site.boundary;
    raw.forEach((pt, i) => { geo.push(circle(pt, 0.12, { fill: C.boundary })); txt.push(text(add(pt, [0.45, 0.45]), `P${i + 1}`, { size: 0.32, fill: '#55524b', family: 'mono', anchor: 'start' })); });
  }
  // setbacks
  if (L.setbacks && A.setbackPoly) {
    geo.push(poly(A.setbackPoly, { stroke: C.setback, sw: thumb ? 0.8 : 1.3, dash: '6 4', op: planStage ? 0.45 : 1 }));
    if (stage === 'site' && L.labels) {
      const f = A.front;
      txt.push(text(add(f.mid, mul(f.out, -A.setbackDists[f.k] / 2)), `front setback ${A.setbackDists[f.k]} m`, { size: 0.36, fill: C.setback, italic: true }));
    }
  }
  // access & footprint layers
  const acc = override.access !== undefined ? override.access : selected(p, 'access');
  const showAccess = ['access', 'footprint', 'programme', 'bubbles', 'plan', 'record'].includes(stage) && acc;
  if (showAccess) geo.push(drawAccess(acc, { faint: late, thumb }), ...[]);
  // trees
  if (L.trees) {
    const pres = preservedSet(p);
    for (const t of A.trees) {
      const removed = t.inside && !pres.has(t.id);
      const showSq = !removed && t.inside && ['trees', 'access', 'footprint'].includes(stage);
      if (showSq) geo.push(poly(t.square, { fill: 'url(#hatch-tree)', stroke: C.tree, sw: 0.9, dash: '3 3', op: stage === 'trees' ? 1 : 0.65 }));
      if (removed) {
        geo.push(circle([t.x, t.y], t.r, { stroke: '#9a958b', sw: 1, dash: '3 3' }));
        geo.push(pline([[t.x - 0.5, t.y - 0.5], [t.x + 0.5, t.y + 0.5]], { stroke: '#9a958b', sw: 1 }), pline([[t.x - 0.5, t.y + 0.5], [t.x + 0.5, t.y - 0.5]], { stroke: '#9a958b', sw: 1 }));
      } else {
        geo.push(circle([t.x, t.y], t.r, { fill: C.tree, fo: planStage ? 0.12 : 0.25, stroke: C.tree, sw: thumb ? 0.8 : 1.3, op: planStage ? 0.6 : 1 }));
        geo.push(circle([t.x, t.y], 0.12, { fill: C.tree }));
      }
      if (L.labels) txt.push(text([t.x, t.y - 0.55], `${t.id}${t.h ? ` · ${t.h} m` : ''}`, { size: 0.4, fill: removed ? '#8a857b' : '#256f37', weight: 600 }));
    }
  }
  // wind
  if (L.wind && analysis && !thumb) for (const w of A.winds) {
    geo.push(pline([w.from, w.to], { stroke: C.wind, sw: 2, marker: 'a-wind' }));
    if (L.labels) txt.push(text(add(w.from, mul(sub(w.to, w.from), 0.2)), w.label || `wind from ${w.fromName}`, { size: 0.4, fill: C.wind, anchor: 'start' }));
  }
  // views
  if (L.views && (analysis || stage === 'footprint') && !thumb) for (const v of A.views) {
    const bad = v.kind === 'undesirable';
    geo.push(pline([v.from, v.to], { stroke: C.view, sw: 1.6, dash: '2 3', marker: 'a-view', op: bad ? 0.7 : 1 }));
    if (bad) { const d = norm(sub(v.to, v.from)), n = leftNormal(d); const m = add(v.from, mul(d, 1.2)); geo.push(pline([add(m, mul(n, 0.4)), add(m, mul(n, -0.4))], { stroke: C.view, sw: 2 })); }
    if (L.labels) txt.push(text(add(v.to, mul(norm(sub(v.to, v.from)), 0.6)), `${bad ? '✕ ' : ''}${v.label || v.id}`, { size: 0.4, fill: '#b83a78', anchor: 'middle' }));
  }
  // sun path
  if (L.sun && analysis && !thumb) geo.push(drawSun(A, txt, L.labels));

  // footprint / zoning
  const fp = override.footprint !== undefined ? override.footprint : selected(p, 'footprint');
  if (fp && ['footprint', 'programme', 'bubbles', 'record'].includes(stage)) {
    const g = F.grid;
    if (stage === 'footprint' && L.zoning && !thumb && !override.footprint) {
      const z = getZoning(p);
      if (z) geo.push(drawZones(F, z), drawOpenSpaces(F, z, txt, L.labels));
    }
    geo.push(drawFootprint(fr, g, fp, { thumb, faint: stage === 'bubbles' }));
    if (L.labels && stage !== 'bubbles') for (const r of fp.rects.filter((x) => x.role === 'garage' || x.role === 'stilt')) txt.push(text(fr.toWorld((r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2), r.role === 'garage' ? 'GARAGE' : 'STILT PARKING', { size: 0.4, fill: C.footprint, weight: 600, ls: 0.04 }));
  }
  // bubbles
  if (stage === 'bubbles') {
    const opt = override.bubbles !== undefined ? override.bubbles : p.stages.bubbles?.current;
    const X = getBubbleCtx(p);
    if (opt && X) geo.push(drawBubbles(p, X, opt, floor, txt, { thumb, layers: L, selected: selectedBubble }));
  }
  // plans
  if (planStage) {
    const plans = getPlans(p);
    const pl = override.plan !== undefined ? override.plan : plans ? plans.find((x) => x.id === p.stages.plan?.selectedId) || plans[0] : null;
    if (pl) geo.push(drawPlan(p, fr, pl, floor, txt, { thumb, layers: L }));
  }
  return { geo: geo.join(''), txt: txt.join(''), bounds };
}

// ---------------------------------------------------------------------------------------------------
function drawField(F, key) {
  const g = F.grid, out = [];
  const col = {
    noise: (v) => `rgba(240,138,0,${(v * 0.75).toFixed(3)})`,
    privacy: (v) => `rgba(123,79,180,${(v * 0.7).toFixed(3)})`,
    view: (v) => (v >= 0 ? `rgba(224,86,155,${(v * 0.8).toFixed(3)})` : `rgba(80,80,80,${(-v * 0.6).toFixed(3)})`),
    depth: (v) => `rgba(63,111,163,${(v * 0.55).toFixed(3)})`,
    breeze: (v) => `rgba(30,107,214,${(v * 0.5).toFixed(3)})`,
    shade: (v) => `rgba(47,143,70,${(v * 0.6).toFixed(3)})`,
  }[key];
  const field = F[key];
  if (!col || !field) return '';
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    if (!F.inSite[k]) continue;
    const v = field[k];
    if (Math.abs(v) < 0.03) continue;
    out.push(`<polygon points="${P(g.cornersWorld(i, j))}" fill="${col(v)}" stroke="none"/>`);
  }
  return `<g>${out.join('')}</g>`;
}

function drawSun(A, txt, labels) {
  const c = A.centroid;
  const R = Math.hypot(A.bbox.w, A.bbox.h) * 0.5 + 2.5;
  const out = [];
  out.push(circle(c, R, { stroke: C.sun, sw: 0.6, op: 0.35, dash: '1 4' }));
  for (const d of KEY_DAYS) {
    const sp = sunPath(A.lat, d.n, 40);
    const pts = sp.pts.map(({ az, alt }) => add(c, mul(vecFromBearing(az, A.northDeg), (R * (90 - Math.max(0, alt))) / 90)));
    const eq = d.key === 'equinox';
    out.push(pline(pts, { stroke: C.sun, sw: eq ? 2.2 : 1.3, dash: eq ? null : '5 4', marker: eq ? 'a-sun' : null, op: eq ? 1 : 0.85 }));
    if (labels) {
      const noon = pts[Math.floor(pts.length / 2)];
      txt.push(text(add(noon, mul(norm(sub(noon, c)), 0.7)), d.label, { size: 0.38, fill: '#a77800' }));
    }
  }
  if (labels) {
    for (const [b, nm] of [[90, 'E'], [180, 'S'], [270, 'W'], [0, 'N']]) txt.push(text(add(c, mul(vecFromBearing(b, A.northDeg), R + 0.9)), nm, { size: 0.55, fill: '#a77800', weight: 600 }));
    const sp = sunPath(A.lat, KEY_DAYS[1].n, 40);
    const sr = sp.pts[0];
    txt.push(text(add(c, mul(vecFromBearing(sr.az, A.northDeg), R + 2)), 'sunrise', { size: 0.34, fill: '#a77800', italic: true }));
  }
  return out.join('');
}

function drawAccess(acc, { faint, thumb }) {
  const out = [];
  const op = faint ? 0.45 : 1;
  for (const poly0 of acc.polys || []) out.push(poly(poly0, { fill: 'url(#hatch)', stroke: C.corridor, sw: 0.7, op: op * 0.9 }));
  if (acc.pad) {
    out.push(poly(acc.pad, { fill: '#fff', fo: 0.5, stroke: '#666', sw: 1, op }));
    // bay lines
    const [a, b, c2] = acc.pad;
    const n = Math.max(1, acc.parking?.cars || 1);
    const d = acc.pad[3];
    for (let k = 1; k < n; k++) { const t = k / n; out.push(pline([add(a, mul(sub(b, a), t)), add(d, mul(sub(c2, d), t))], { stroke: '#666', sw: 0.8, op })); }
  }
  if (acc.path?.length > 1 && !thumb) out.push(pline(acc.path, { stroke: '#555', sw: 1.2, dash: '5 3', op }));
  for (const g of acc.gates || []) {
    out.push(pline([g.a, g.b], { stroke: C.gate, sw: thumb ? 2 : 3.5, op }));
    if (!thumb) {
      const e = norm(sub(g.b, g.a)), inward = leftNormal(e);
      const cc = g.c;
      if (g.kind === 'exit') out.push(pline([add(cc, mul(inward, 1.6)), cc], { stroke: C.gate, sw: 1.6, marker: 'a-gate', op }));
      else out.push(pline([cc, add(cc, mul(inward, 1.6))], { stroke: C.gate, sw: 1.6, marker: 'a-gate', op }));
    }
  }
  if (acc.pedGate) {
    out.push(pline([acc.pedGate.a, acc.pedGate.b], { stroke: C.ink, sw: thumb ? 1.6 : 2.6, op }));
    if (acc.pedPath && !thumb) out.push(pline(acc.pedPath, { stroke: C.ink, sw: 1, dash: '1 3', marker: 'a-ink', op }));
  }
  return out.join('');
}

function drawFootprint(fr, g, fp, { thumb, faint }) {
  const out = [];
  const m = footprintMask(g, fp.rects);
  for (const loop of maskOutlines(g, m)) {
    const pts = loop.map(([s, t]) => fr.toWorld(s, t));
    out.push(poly(pts, { fill: C.footprint, fo: faint ? 0.07 : 0.2, stroke: C.footprint, sw: thumb ? 1.2 : faint ? 1.4 : 1.8, op: faint ? 0.9 : 1 }));
  }
  return out.join('');
}

function drawZones(F, z) {
  const g = F.grid, out = [];
  const cols = { 1: '#e9a25b', 2: '#e6cf7a', 3: '#86a9cf' };
  for (let k = 0; k < g.n; k++) if (z.zone[k]) out.push(`<polygon points="${P(g.cornersWorld(k % g.nx, Math.floor(k / g.nx)))}" fill="${cols[z.zone[k]]}" fill-opacity="0.45" stroke="none"/>`);
  return `<g>${out.join('')}</g>`;
}
function drawOpenSpaces(F, z, txt, labels) {
  const g = F.grid, out = [];
  const names = { 'front-garden': 'FRONT GARDEN', 'rear-garden': 'REAR GARDEN', 'side-garden': 'SIDE GARDEN', courtyard: 'COURTYARD', 'service-yard': 'SERVICE YARD' };
  for (const sp of z.spaces) {
    if (sp.kind === 'courtyard') for (const k of sp.cells) out.push(`<polygon points="${P(g.cornersWorld(k % g.nx, Math.floor(k / g.nx)))}" fill="${C.court}" fill-opacity="0.12" stroke="none"/>`);
    if (labels) txt.push(text(g.frame.toWorld(sp.centre[0], sp.centre[1]), `${names[sp.kind] || sp.kind} · ${Math.round(sp.area)} m²`, { size: 0.36, fill: '#4c7d58', weight: 600, ls: 0.03 }));
  }
  return out.join('');
}

// Ellipse aligned to the design frame, as a world polygon.
function ellipsePts(fr, x, y, a, b, n = 28) {
  const pts = [];
  for (let k = 0; k < n; k++) { const th = (2 * Math.PI * k) / n; pts.push(fr.toWorld(x + a * Math.cos(th), y + b * Math.sin(th))); }
  return pts;
}

export function zoneColorOf(space) {
  const L = LIB[space.type] || LIB.custom;
  return (ZONES[space.zone || L.zone] || ZONES['semi-private']).color;
}

function drawBubbles(p, X, opt, floor, txt, { thumb, layers, selected: selId }) {
  const fr = X.g.frame, out = [];
  const fl = opt.floors.find((x) => x.f === floor) || opt.floors[0];
  if (!fl) return '';
  const spaces = new Map(X.spaces.map((s) => [s.id, s]));
  // floor below as a faint underlay
  const below = opt.floors.find((x) => x.f === floor - 1);
  if (below && !thumb) for (const n of below.nodes) out.push(poly(ellipsePts(fr, n.x, n.y, n.a ?? n.r, n.b ?? n.r), { stroke: '#b5b0a6', sw: 0.8, dash: '2 3' }));
  if (opt.stair) {
    const w = fr.rectWorld(opt.stair);
    out.push(poly(w, { fill: 'url(#hatch-stair)', stroke: '#444', sw: 1 }));
    if (!thumb && layers.labels) txt.push(text(fr.toWorld((opt.stair.s0 + opt.stair.s1) / 2, (opt.stair.t0 + opt.stair.t1) / 2), 'STAIR', { size: 0.34, fill: '#444', weight: 600, ls: 0.05 }));
  }
  for (const v of fl.fixed.filter((n) => n.kind === 'void')) {
    out.push(poly(ellipsePts(fr, v.x, v.y, v.a ?? v.r, v.b ?? v.r), { stroke: '#666', sw: 1, dash: '4 3' }));
    if (!thumb && layers.labels) txt.push(text(fr.toWorld(v.x, v.y), 'VOID', { size: 0.34, fill: '#666', italic: true }));
  }
  // relationship lines
  if (layers.relations && !thumb) {
    const pos = new Map(fl.nodes.map((n) => [n.id, n]));
    for (const r of X.relations) {
      const a = pos.get(r.a), b = pos.get(r.b);
      if (!a || !b) continue;
      const sep = r.type === 'separated' || r.type === 'must_not_touch';
      out.push(pline([fr.toWorld(a.x, a.y), fr.toWorld(b.x, b.y)], { stroke: sep ? C.setback : '#555', sw: r.type === 'must_touch' ? 1.6 : 0.8, dash: sep ? '3 3' : r.type === 'near' || r.type === 'visual' ? '1 3' : null, op: 0.55 }));
    }
  }
  for (const n of fl.nodes) {
    const s = spaces.get(n.id);
    if (!s) continue;
    const col = zoneColorOf(s);
    const sel = selId === n.id;
    out.push(`<g data-bubble="${n.id}" class="bubble">${poly(ellipsePts(fr, n.x, n.y, n.a ?? n.r, n.b ?? n.r), { fill: col, fo: 0.32, stroke: sel ? C.ink : col, sw: s.pinned ? 2.6 : sel ? 2.2 : 1.3, dash: null })}</g>`);
    if (!thumb && layers.labels) {
      const c = fr.toWorld(n.x, n.y);
      const big = Math.min(n.a ?? n.r, n.b ?? n.r) > 1.2;
      txt.push(text([c[0], c[1] + (big ? 0.22 : 0.1)], `${s.pinned ? '● ' : ''}${s.name}`, { size: big ? 0.38 : 0.3, weight: 600 }));
      txt.push(text([c[0], c[1] - (big ? 0.32 : 0.28)], `${round(s.area, 1)} m²`, { size: big ? 0.32 : 0.26, fill: '#55524b', family: 'mono' }));
    }
  }
  return out.join('');
}

function segWorld(fr, sg) {
  return sg.axis === 't' ? [fr.toWorld(sg.at, sg.lo), fr.toWorld(sg.at, sg.hi)] : [fr.toWorld(sg.lo, sg.at), fr.toWorld(sg.hi, sg.at)];
}

function drawPlan(p, fr, plan, floor, txt, { thumb, layers }) {
  const out = [];
  const fl = plan.floors.find((x) => x.f === floor) || plan.floors[0];
  if (!fl) return '';
  // floor below as a translucent underlay (spec §47)
  const below = plan.floors.find((x) => x.f === floor - 1);
  if (below && !thumb) for (const w of below.walls) if (w.kind !== 'open') out.push(pline(segWorld(fr, w), { stroke: '#c9c4b9', sw: 1.2 }));
  // room fills (very light zone tint)
  for (const r of fl.regions) {
    for (const q of r.rects) {
      const pts = fr.rectWorld(q);
      if (r.kind === 'stair') out.push(poly(pts, { fill: '#fff', stroke: 'none' }), drawStairSymbol(fr, q));
      else if (r.kind === 'void') out.push(poly(pts, { fill: '#fff', fo: 0.6, stroke: 'none' }), pline([pts[0], pts[2]], { stroke: '#999', sw: 0.7 }), pline([pts[1], pts[3]], { stroke: '#999', sw: 0.7 }));
      else if (r.kind === 'garage' || r.kind === 'stilt') out.push(poly(pts, { fill: 'url(#hatch)', stroke: 'none', op: 0.5 }));
      else {
        const col = r.kind === 'room' ? (ZONES[r.zone] || ZONES['semi-private']).color : '#d8d3c8';
        out.push(poly(pts, { fill: col, fo: r.kind === 'room' ? 0.1 : 0.18, stroke: 'none' }));
      }
    }
  }
  // walls
  for (const w of fl.walls) {
    const pts = segWorld(fr, w);
    if (w.kind === 'ext') out.push(pline(pts, { stroke: C.ink, sw: thumb ? 1.6 : 3.2, cap: 'square' }));
    else if (w.kind === 'int') out.push(pline(pts, { stroke: C.ink, sw: thumb ? 1 : 2, cap: 'square' }));
    else if (w.kind === 'open') out.push(pline(pts, { stroke: C.ink, sw: 1, dash: '1.5 3' }));
    else if (w.kind === 'void') out.push(pline(pts, { stroke: '#555', sw: 1, dash: '4 3' }));
  }
  // doors: a thin swing arc in each opening
  if (!thumb) for (const d of [...fl.doors, ...(fl.mainDoor ? [fl.mainDoor] : [])]) {
    const a = d.c - d.w / 2;
    const hinge = d.axis === 't' ? [d.at, a] : [a, d.at];
    const leaf = d.axis === 't' ? [d.at + d.w * (d.out ? d.out[0] || 1 : 1), a] : [a, d.at + d.w * (d.out ? d.out[1] || 1 : 1)];
    const end = d.axis === 't' ? [d.at, a + d.w] : [a + d.w, d.at];
    const H = fr.toWorld(...hinge), Lf = fr.toWorld(...leaf), E = fr.toWorld(...end);
    out.push(pline([H, Lf], { stroke: d.main ? C.ink : '#555', sw: d.main ? 1.4 : 0.8 }));
    out.push(`<path d="M${f2(Lf[0])},${f2(Lf[1])} A${f2(d.w)},${f2(d.w)} 0 0 ${d.axis === 't' ? 1 : 0} ${f2(E[0])},${f2(E[1])}" fill="none" stroke="#777" stroke-width="0.6" ${NS}/>`);
    if (d.main) {
      const mid = fr.toWorld(d.axis === 't' ? d.at - (d.out ? d.out[0] : 1) * 1.6 : d.c, d.axis === 't' ? d.c : d.at - (d.out ? d.out[1] : 1) * 1.6);
      const door = fr.toWorld(d.axis === 't' ? d.at : d.c, d.axis === 't' ? d.c : d.at);
      out.push(pline([mid, door], { stroke: C.gate, sw: 1.6, marker: 'a-gate' }));
      txt.push(text(mid, 'ENTRY', { size: 0.32, fill: C.gate, weight: 600, ls: 0.06 }));
    }
  }
  // labels
  if (layers.labels && !thumb) for (const r of fl.regions) {
    if (r.kind === 'stair') continue;
    const big = r.rects.reduce((a, b) => ((b.s1 - b.s0) * (b.t1 - b.t0) > (a.s1 - a.s0) * (a.t1 - a.t0) ? b : a));
    const c = fr.toWorld((big.s0 + big.s1) / 2, (big.t0 + big.t1) / 2);
    const minDim = Math.min(big.s1 - big.s0, big.t1 - big.t0);
    const size = minDim < 1.6 ? 0.24 : minDim < 2.6 ? 0.3 : 0.36;
    const name = r.kind === 'void' ? 'VOID' : r.name.toUpperCase();
    txt.push(text([c[0], c[1] + size * 0.55], name, { size, weight: 600, ls: 0.04, fill: r.kind === 'room' ? C.ink : '#6f6b63' }));
    if (r.kind === 'room' || r.kind === 'garage') txt.push(text([c[0], c[1] - size * 0.75], `${round(r.area, 1)} m²`, { size: size * 0.85, fill: '#55524b', family: 'mono' }));
  }
  return out.join('');
}

function drawStairSymbol(fr, q) {
  const out = [];
  const alongS = q.s1 - q.s0 >= q.t1 - q.t0;
  const L = alongS ? q.s1 - q.s0 : q.t1 - q.t0, W = alongS ? q.t1 - q.t0 : q.s1 - q.s0;
  const run = L - 1.0;
  const n = 9;
  for (const half of [0, 1]) {
    for (let k = 0; k <= n; k++) {
      const x = (alongS ? q.s0 : q.t0) + (run * k) / n;
      const y0 = (alongS ? q.t0 : q.s0) + (half ? W / 2 + 0.05 : 0), y1 = y0 + W / 2 - 0.05;
      const a = alongS ? fr.toWorld(x, y0) : fr.toWorld(y0, x), b = alongS ? fr.toWorld(x, y1) : fr.toWorld(y1, x);
      out.push(pline([a, b], { stroke: '#555', sw: 0.6 }));
    }
  }
  const mid = (alongS ? q.t0 : q.s0) + W / 4;
  const p0 = alongS ? fr.toWorld(q.s0 + 0.2, mid) : fr.toWorld(mid, q.t0 + 0.2), p1 = alongS ? fr.toWorld(q.s0 + run, mid) : fr.toWorld(mid, q.t0 + run);
  out.push(pline([p0, p1], { stroke: '#333', sw: 0.9, marker: 'a-ink' }));
  out.push(poly(fr.rectWorld(q), { stroke: '#333', sw: 1.2 }));
  return out.join('');
}

export { dist as _d };
