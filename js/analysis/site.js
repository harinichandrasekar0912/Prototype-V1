// Step 1 — site analysis (spec §14–27). Pure function of the project: validates geometry, finds
// the frontage, offsets setbacks, computes the development controls and the solar facts.
// Messages are written in architectural language (spec §117).

import {
  signedArea, area, perimeter, centroid, bbox, isSimple, selfIntersections, insetPolygon,
  sub, norm, dist, add, mul, pointInPolygon, clipByConvex, bearingOf, compass8, COMPASS_NAMES,
} from '../geometry/polygon.js';
import { makeFrame } from '../geometry/grid.js';
import { sunSummary, facadeExposure } from './sun.js';
import { DESIGN } from '../rules/assumptions.js';
import { round } from '../core/util.js';

export function analyseSite(project) {
  const errors = [], warnings = [], notes = [];
  const reg = project.regulations;
  const loc = project.location;
  const raw = (project.site.boundary || []).filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 1e-6);
  if (raw.length > 2 && dist(raw[0], raw[raw.length - 1]) < 1e-6) raw.pop();
  if (raw.length < 3) {
    errors.push('The site boundary needs at least three corner points.');
    return { ok: false, errors, warnings, notes };
  }
  const n = raw.length;
  const flipped = signedArea(raw) < 0;
  const pts = flipped ? [...raw].reverse().map((p) => [...p]) : raw.map((p) => [...p]);
  // user edge i runs raw[i] -> raw[i+1]; map to the CCW edge index used internally
  const userToCCW = (i) => (flipped ? (((n - 2 - i) % n) + n) % n : i);
  const ccwToUser = (k) => (flipped ? (((n - 2 - k) % n) + n) % n : k);
  if (flipped) notes.push('Boundary points were entered clockwise; they are read anticlockwise internally (the drawing is unchanged).');

  if (!isSimple(pts)) {
    const [[i, j]] = selfIntersections(pts);
    errors.push(`The site boundary crosses itself (edge ${ccwToUser(i) + 1} meets edge ${ccwToUser(j) + 1}). Check the order of the corner points.`);
    return { ok: false, errors, warnings, notes };
  }
  const siteArea = area(pts);
  if (siteArea < 20) errors.push(`The site is only ${round(siteArea, 1)} m² — check the coordinates are in metres.`);

  const edges = pts.map((a, k) => {
    const b = pts[(k + 1) % n];
    const dir = norm(sub(b, a));
    const out = [dir[1], -dir[0]]; // right normal = outward for CCW
    const bearingOut = bearingOf(out, loc.northDeg);
    return {
      k, user: ccwToUser(k), a, b, dir, out, length: dist(a, b), mid: mul(add(a, b), 0.5),
      bearingOut, facing: compass8(bearingOut), exposure: facadeExposure(loc.lat, bearingOut), road: null,
    };
  });

  const roads = [];
  for (const r of project.site.roads || []) {
    if (!Number.isInteger(r.edge) || r.edge < 0 || r.edge >= n) {
      errors.push(`Road ${r.name || r.id} refers to edge ${Number(r.edge) + 1}, but the site has ${n} edges.`);
      continue;
    }
    if (!(r.width > 0)) { warnings.push(`Road ${r.name || r.id} has no width; it is ignored.`); continue; }
    const e = edges[userToCCW(r.edge)];
    if (e.road) warnings.push(`Edge ${r.edge + 1} has two roads; the wider one is used.`);
    if (!e.road || e.road.width < r.width) e.road = r;
  }
  for (const e of edges) {
    if (!e.road) continue;
    const ext = Math.min(e.road.width, 6);
    const a0 = sub(e.a, mul(e.dir, ext)), b0 = add(e.b, mul(e.dir, ext));
    roads.push({
      ...e.road, k: e.k, edge: e,
      polygon: [a0, b0, add(b0, mul(e.out, e.road.width)), add(a0, mul(e.out, e.road.width))],
      centre: [add(a0, mul(e.out, e.road.width / 2)), add(b0, mul(e.out, e.road.width / 2))],
    });
  }

  // Frontage (spec §18): the edge abutting the widest road; ties go to the longer edge.
  const roadEdges = edges.filter((e) => e.road).sort((p, q) => q.road.width - p.road.width || q.length - p.length);
  let front;
  if (roadEdges.length) {
    front = roadEdges[0];
    if (roadEdges.length > 1) notes.push(`Corner/multi-road plot: frontage taken as edge ${front.user + 1} (${front.road.name || 'road'}, ${front.road.width} m), the widest abutting road — a prototype rule that can be overridden later.`);
  } else {
    front = [...edges].sort((p, q) => q.length - p.length)[0];
    warnings.push(`No road is defined. Frontage is assumed to be the longest edge (edge ${front.user + 1}) until a road is added.`);
  }

  const dists = edges.map((e) =>
    e.k === front.k || (reg.allRoadEdgesAreFront && e.road) ? reg.frontSetback : reg.otherSetback,
  );
  const inset = insetPolygon(pts, dists);
  let setbackPoly = null, setbackArea = 0;
  if (!inset) errors.push('The setbacks leave no buildable area on this plot. Reduce the setbacks or check the plot dimensions.');
  else {
    setbackPoly = inset.pts;
    setbackArea = area(setbackPoly);
    if (inset.pts.length < n) warnings.push('A short boundary edge disappears inside the setback zone; the buildable outline has fewer corners than the plot.');
  }

  const frame = makeFrame(pts, front.k);
  const C = centroid(pts);

  // Trees: identity, inside/outside, exclusion square (spec §30) and its cost in buildable area.
  const trees = (project.site.trees || []).map((t) => {
    const c = [t.x, t.y];
    const inside = pointInPolygon(c, pts);
    const half = t.r + DESIGN.treeBuffer;
    const [s, tt] = frame.toLocal(c);
    const rect = { s0: s - half, t0: tt - half, s1: s + half, t1: tt + half };
    const square = frame.rectWorld(rect);
    const cost = setbackPoly ? area(clipByConvex(setbackPoly, square)) : 0;
    return { ...t, inside, rect, square, side: 2 * half, cost };
  });
  trees.filter((t) => !t.inside).forEach((t) => notes.push(`Tree ${t.id} stands outside the plot; it is context only.`));

  const buildings = (project.site.buildings || []).map((b) => {
    const poly = b.polygon;
    const ok = poly && poly.length >= 3 && isSimple(signedArea(poly) < 0 ? [...poly].reverse() : poly);
    if (!ok) warnings.push(`Context building ${b.id} has an invalid outline and is drawn as entered.`);
    const overlaps = poly && poly.some((p) => pointInPolygon(p, pts));
    if (overlaps) warnings.push(`Context building ${b.id} overlaps the plot boundary — check its coordinates.`);
    return { ...b, centroid: poly && poly.length ? centroid(poly) : [0, 0] };
  });

  const winds = (project.site.winds || []).map((w) => {
    const v = sub(w.to, w.from);
    const fromBearing = bearingOf(mul(v, -1), loc.northDeg);
    return { ...w, dir: norm(v), fromBearing, fromName: COMPASS_NAMES[compass8(fromBearing)] };
  });

  const maxBUA = siteArea * reg.fsi;
  const maxFloors = Math.max(1, Math.floor(reg.maxHeight / reg.floorHeight + 1e-9));
  const sun = sunSummary(loc.lat);
  const bb = bbox(pts);

  if (setbackPoly && setbackArea < 0.25 * siteArea) warnings.push(`Only ${round((100 * setbackArea) / siteArea)}% of the plot remains after setbacks; the plot is very constrained.`);

  return {
    ok: errors.length === 0,
    errors, warnings, notes,
    pts, flipped, userToCCW, ccwToUser, edges, roads, front, setbackDists: dists,
    setbackPoly, setbackArea, area: siteArea, perimeter: perimeter(pts), bbox: bb, centroid: C,
    frame, trees, buildings, winds,
    noise: project.site.noise || [], views: project.site.views || [], privacy: project.site.privacy || [],
    maxBUA, maxFloors, fsi: reg.fsi, maxHeight: reg.maxHeight, floorHeight: reg.floorHeight,
    sun, lat: loc.lat, northDeg: loc.northDeg,
  };
}

// Plain-language site summary (spec §27).
export function siteSummary(A) {
  if (!A || !A.ok) return [];
  const f = A.front;
  const rows = [
    ['Site area', `${round(A.area, 1)} m²`],
    ['Perimeter', `${round(A.perimeter, 1)} m`],
    ['Area within setbacks', `${round(A.setbackArea, 1)} m² (${round((100 * A.setbackArea) / A.area)}%)`],
    ['FSI (prototype assumption)', `${A.fsi}`],
    ['Maximum floor area (FSI)', `${round(A.maxBUA, 0)} m²`],
    ['Maximum height', `${A.maxHeight} m → up to ${A.maxFloors} floors at ${A.floorHeight} m`],
    ['Frontage', f.road ? `Edge ${f.user + 1} — ${f.road.name || 'road'}, ${f.road.width} m wide, facing ${COMPASS_NAMES[f.facing]}` : `Edge ${f.user + 1} (no road defined)`],
    ['Roads', A.roads.length ? A.roads.map((r) => `${r.name || r.id} ${r.width} m (edge ${r.edge.user + 1})`).join(' · ') : 'none'],
    ['Existing trees', `${A.trees.filter((t) => t.inside).length} on site${A.trees.some((t) => !t.inside) ? `, ${A.trees.filter((t) => !t.inside).length} outside` : ''}`],
  ];
  if (A.winds.length) rows.push(['Wind', A.winds.map((w) => `from ${w.fromName}${w.label ? ` (${w.label})` : ''}`).join(' · ')]);
  rows.push(['Sun', `${A.sun.summerNorth ? 'Summer sun passes north of overhead; ' : ''}highest façade heat from the ${COMPASS_NAMES[compass8(A.sun.worst.b)]}`]);
  if (A.noise.length) rows.push(['Noise sources', A.noise.map((s) => s.label || s.id).join(' · ')]);
  if (A.views.length) rows.push(['Views', A.views.map((v) => `${v.kind === 'undesirable' ? '✕' : '✓'} ${v.label || v.id}`).join(' · ')]);
  if (A.privacy.length) rows.push(['Privacy concerns', A.privacy.map((p) => p.label || p.id).join(' · ')]);
  return rows;
}
