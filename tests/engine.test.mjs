// Engine tests — run with:  node --test tests/
// They check the guarantees the product makes: deterministic geometry, hard constraints never
// violated, arithmetic that adds up, and the interpreter reading the spec's own example sentence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleProject } from '../js/core/model.js';
import { area, insetPolygon, isSimple, signedArea, pointInPolygon } from '../js/geometry/polygon.js';
import { analyseSite } from '../js/analysis/site.js';
import { buildFields } from '../js/analysis/fields.js';
import { solarPosition } from '../js/analysis/sun.js';
import { generateAccess, accessMasks } from '../js/design/access.js';
import { generateFootprints, zoneFootprint, footprintMask } from '../js/design/footprint.js';
import { defaultProgramme, budget, autoBalance, assignFloors, floorCapacities } from '../js/design/programme.js';
import { defaultRelations } from '../js/rules/relations.js';
import { bubbleContext, generateBubbleOptions, reviseOption } from '../js/design/bubbles.js';
import { generatePlans } from '../js/design/plan.js';
import { interpretPreferences, interpretRevision } from '../js/design/interpret.js';
import { DESIGN } from '../js/rules/assumptions.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('shoelace area and orientation', () => {
  const sq = [[0, 0], [15, 0], [15, 25], [0, 25]];
  assert.equal(area(sq), 375);
  assert.ok(signedArea(sq) > 0);
  assert.ok(signedArea([...sq].reverse()) < 0);
});

test('mitred setback inset of a rectangle', () => {
  const sq = [[0, 0], [15, 0], [15, 25], [0, 25]];
  const r = insetPolygon(sq, [3, 1.5, 1.5, 1.5]);
  assert.ok(r && isSimple(r.pts));
  assert.ok(near(area(r.pts), 12 * 20.5));
});

test('site analysis: frontage, setbacks and FSI; clockwise input gives the same result', () => {
  const p = sampleProject();
  const A = analyseSite(p);
  assert.ok(A.ok, A.errors.join());
  assert.equal(A.front.user, 0); // widest road on edge 1
  assert.ok(near(A.maxBUA, A.area * 2));
  const q = sampleProject();
  q.site.boundary = [...q.site.boundary].reverse();
  q.site.roads = [{ id: 'R1', edge: 2, width: 9 }, { id: 'R2', edge: 3, width: 6 }];
  const B = analyseSite(q);
  assert.ok(B.ok);
  assert.ok(near(A.setbackArea, B.setbackArea, 1e-6));
  // every setback vertex is inside the plot
  for (const v of A.setbackPoly) assert.ok(pointInPolygon(v, A.pts));
});

test('sun: noon sun is north in June and south in December at 13°N', () => {
  assert.ok(solarPosition(13.08, 172, 12).az < 1 || solarPosition(13.08, 172, 12).az > 359);
  assert.ok(near(solarPosition(13.08, 355, 12).az, 180, 1));
});

function pipeline(preserve = ['T1', 'T2', 'T3']) {
  const p = sampleProject();
  const A = analyseSite(p);
  const set = new Set(preserve);
  const F = buildFields(A, set);
  const acc = generateAccess(A, F, p.brief, p.location, set, 1);
  const ao = acc.options[0];
  const masks = accessMasks(A, F, ao, set);
  const fp = generateFootprints({ A, F, masks, access: ao, brief: p.brief, priorities: p.intent.priorities, preserved: set }, 1);
  return { p, A, F, set, acc, ao, masks, fp };
}

test('access: corridors stay inside the plot and clear of preserved trunks', () => {
  const { A, acc } = pipeline();
  assert.ok(acc.options.length >= 2);
  const strategies = new Set(acc.options.map((o) => o.strategy));
  assert.equal(strategies.size, acc.options.length, 'options are different strategies');
  for (const o of acc.options) for (const poly of o.polys) for (const t of A.trees.filter((x) => x.inside)) assert.ok(!pointInPolygon([t.x, t.y], poly));
});

test('footprints: hard constraints (buildable cells only, area within tolerance, distinct families)', () => {
  const { F, masks, fp } = pipeline();
  assert.ok(fp.options.length >= 2, fp.reason);
  for (const o of fp.options) {
    const m = footprintMask(F.grid, o.rects.filter((r) => r.role !== 'garage' && r.role !== 'stilt'));
    for (let k = 0; k < m.length; k++) if (m[k]) assert.ok(masks.buildable[k], `option ${o.id} builds on a non-buildable cell`);
    assert.ok(Math.abs(o.metrics.area - fp.target.target) / fp.target.target < 0.15);
  }
});

test('programme arithmetic: gross = net + circulation + walls + core, auto-balance meets target', () => {
  const p = sampleProject();
  const A = analyseSite(p);
  let spaces = defaultProgramme(p.brief);
  const st = { circulationPct: 0.15, wallPct: 0.1 };
  const B0 = budget(spaces, st, p.brief, A);
  assert.ok(near(B0.gross, B0.net + B0.circulation + B0.walls + B0.core.total));
  // a locked room never changes
  spaces[1] = { ...spaces[1], area: 30, locked: true };
  spaces = autoBalance(spaces, B0.netTarget);
  assert.equal(spaces[1].area, 30);
  const B1 = budget(spaces, st, p.brief, A);
  assert.ok(Math.abs(B1.gross - p.brief.targetBUA) < 0.04 * p.brief.targetBUA);
});

test('interpreter reads the spec example into structured items', () => {
  const sp = defaultProgramme(sampleProject().brief);
  const r = interpretPreferences('I want the formal living close to the foyer but visually separated from family spaces. Dining should connect to the courtyard and kitchen. The master bedroom should have maximum privacy and the best garden view.', sp);
  const kinds = r.items.map((i) => `${i.kind}:${i.type || i.attr}`);
  assert.deepEqual(kinds, ['relation:adjacent', 'relation:separated', 'relation:adjacent', 'relation:adjacent', 'attr:privacy', 'attr:view']);
  const rv = interpretRevision('Move the kitchen closer to the service yard but keep the courtyard and master bedroom unchanged.', sp);
  assert.deepEqual(rv.cmds.map((c) => c.kind), ['attract', 'keep']);
});

test('bubbles → plans: rooms inside the footprint, no overlaps, revision keeps locked/kept rooms', () => {
  const { p, A, F, ao, masks, fp } = pipeline();
  const fo = fp.options[0];
  const zoning = zoneFootprint({ F, access: ao, masks, brief: p.brief }, fo);
  let spaces = defaultProgramme(p.brief);
  spaces = autoBalance(spaces, budget(spaces, {}, p.brief, A).netTarget);
  spaces = assignFloors(spaces, p.brief.floors, floorCapacities(fo.metrics.area, p.brief.floors, p.brief, {}));
  const relations = defaultRelations(spaces, new Set(['@stair', '@garden', '@courtyard']));
  const X = bubbleContext({ A, F, footprint: fo, zoning, brief: p.brief, spaces, relations, priorities: p.intent.priorities });
  const opts = generateBubbleOptions(X, 1);
  assert.equal(new Set(opts.map((o) => o.strategy)).size, 3);
  const master = spaces.find((s) => s.type === 'master_bed');
  const before = opts[0].floors.flatMap((f) => f.nodes).find((n) => n.id === master.id);
  const rev = reviseOption(X, opts[0], [{ kind: 'keep', ids: [master.id] }, { kind: 'direction', a: spaces.find((s) => s.type === 'kitchen').id, dir: 'rear' }], 3);
  const after = rev.floors.flatMap((f) => f.nodes).find((n) => n.id === master.id);
  assert.ok(near(before.x, after.x, 1e-9) && near(before.y, after.y, 1e-9), 'kept room did not move');
  const plans = generatePlans(X, opts[0], {});
  const inFp = (s, t) => fo.rects.some((r) => s >= r.s0 - 1e-6 && s <= r.s1 + 1e-6 && t >= r.t0 - 1e-6 && t <= r.t1 + 1e-6);
  for (const pl of plans) for (const fl of pl.floors) {
    const rects = fl.regions.flatMap((r) => r.rects.map((q) => ({ ...q, id: r.id })));
    for (const q of rects) {
      assert.ok(inFp(q.s0, q.t0) && inFp(q.s1, q.t1), `${q.id} leaves the footprint`);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ov = Math.max(0, Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0)) * Math.max(0, Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0));
      assert.ok(ov < 0.02, `${a.id} overlaps ${b.id} by ${ov.toFixed(2)} m²`);
    }
  }
  assert.ok(DESIGN.cell === 0.5);
});
