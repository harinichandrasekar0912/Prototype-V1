// Derived design data. Nothing here is stored: everything is recomputed (and memoised) from the
// project, so drawings can never drift from the design state (spec §86, §132 "UI/state mismatch").
// Each stage also has a *basis* — a hash of the upstream inputs it depends on. Options generated
// from an older basis are flagged stale instead of being silently kept (spec §111–112).

import { hash } from './util.js';
import { analyseSite } from '../analysis/site.js';
import { buildFields } from '../analysis/fields.js';
import { accessMasks } from '../design/access.js';
import { zoneFootprint, footprintTargets } from '../design/footprint.js';
import { bubbleContext } from '../design/bubbles.js';
import { generatePlans } from '../design/plan.js';
import { STAGES } from './model.js';

const memo = new Map();
function cached(key, fn) {
  if (memo.has(key)) return memo.get(key);
  const v = fn();
  memo.set(key, v);
  if (memo.size > 60) memo.delete(memo.keys().next().value);
  return v;
}

export const siteKey = (p) => hash({ site: p.site, reg: p.regulations, loc: p.location });

export function getAnalysis(p) {
  return cached(`A:${siteKey(p)}`, () => analyseSite(p));
}

export function preservedSet(p) {
  const A = getAnalysis(p);
  const out = new Set();
  for (const t of A.trees || []) if (t.inside && p.decisions.trees[t.id] !== 'remove') out.add(t.id);
  return out;
}
const presKey = (p) => [...preservedSet(p)].sort().join(',');

export function getFields(p) {
  const A = getAnalysis(p);
  if (!A.ok) return null;
  return cached(`F:${siteKey(p)}:${presKey(p)}`, () => buildFields(A, preservedSet(p)));
}

export const selected = (p, stage) => {
  const st = p.stages[stage];
  if (!st || !st.options) return null;
  return st.options.find((o) => o.id === st.selectedId) || null;
};

export function getMasks(p) {
  const A = getAnalysis(p), F = getFields(p);
  if (!F) return null;
  const acc = selected(p, 'access');
  return cached(`M:${siteKey(p)}:${presKey(p)}:${acc ? hash(acc.polys) + hash(acc.fixedRect || 0) : 'none'}`, () => accessMasks(A, F, acc, preservedSet(p)));
}

export function getZoning(p) {
  const fp = selected(p, 'footprint');
  if (!fp) return null;
  const F = getFields(p), masks = getMasks(p);
  if (!F || !masks) return null;
  return cached(`Z:${hash(fp.rects)}:${siteKey(p)}:${presKey(p)}:${hash(selected(p, 'access')?.arrival || 0)}`, () =>
    zoneFootprint({ F, access: selected(p, 'access'), masks, brief: p.brief }, fp));
}

export function anchorsFor(p) {
  const z = getZoning(p);
  const set = new Set();
  if ((p.brief.floors || 1) > 1) set.add('@stair');
  if (z) for (const s of z.spaces) set.add(s.kind === 'courtyard' ? '@courtyard' : s.kind === 'service-yard' ? '@service-yard' : '@garden');
  return set;
}

export function getBubbleCtx(p) {
  const fp = selected(p, 'footprint'), zoning = getZoning(p);
  const prog = p.stages.programme;
  if (!fp || !zoning || !prog || !prog.spaces) return null;
  const A = getAnalysis(p), F = getFields(p);
  const key = `X:${hash(fp.rects)}:${hash(prog.spaces)}:${hash(prog.relations || [])}:${hash(p.intent.priorities)}:${p.brief.floors}:${presKey(p)}:${siteKey(p)}`;
  return cached(key, () => bubbleContext({ A, F, footprint: fp, zoning, brief: p.brief, spaces: prog.spaces, relations: prog.relations || [], priorities: p.intent.priorities }));
}

export function getPlans(p) {
  const X = getBubbleCtx(p), b = p.stages.bubbles?.current;
  if (!X || !b) return null;
  const prog = p.stages.programme;
  const openPairs = (prog.prefsItems || []).filter((i) => i.kind === 'open').map((i) => [i.a, i.b]);
  return cached(`P:${hash(b)}:${hash(prog.spaces)}:${hash(openPairs)}:${hash(X.footprint.rects)}`, () => generatePlans(X, b, { openPairs, openness: prog.settings?.openness || 'semi' }));
}

// ---- stage bases & status -----------------------------------------------------------------------
export function bases(p) {
  const site = siteKey(p);
  const trees = hash([site, p.decisions.trees]);
  const access = hash([trees, p.brief.parking, p.brief.separatePedestrianGate, p.brief.entryCharacter, p.location.drivingSide]);
  const accSel = selected(p, 'access');
  const footprint = hash([access, accSel ? hash(accSel.polys) : null, p.brief.targetBUA, p.brief.floors, p.brief.openSpaces, p.intent.priorities]);
  const fpSel = selected(p, 'footprint');
  const programme = hash([footprint, fpSel ? hash(fpSel.rects) : null, p.brief.floors, p.brief.targetBUA]);
  const prog = p.stages.programme || {};
  const bubbles = hash([programme, prog.spaces ? prog.spaces.map((s) => [s.id, s.area, s.floor, s.floorAuto, s.dh, s.attrs]) : null, prog.relations ? prog.relations.length : 0]);
  const plan = hash([bubbles, p.stages.bubbles?.current ? hash(p.stages.bubbles.current) : null]);
  return { brief: hash([p.brief, p.intent]), site, trees, access, footprint, programme, bubbles, plan, record: plan };
}

export function stageStatus(p, key) {
  const st = p.stages[key] || {};
  const b = bases(p);
  if (key === 'record') return p.history.length > 1 ? 'accepted' : 'empty';
  if (st.status === 'accepted' && st.basis && st.basis !== b[key]) return 'stale';
  if (st.status === 'options' && st.basis && st.basis !== b[key]) return 'stale';
  return st.status || 'empty';
}

export function staleReason(p, key) {
  const order = STAGES.map((s) => s.key);
  const idx = order.indexOf(key);
  for (let i = idx - 1; i >= 0; i--) {
    const k = order[i];
    const st = p.stages[k];
    if (st && st.acceptedAt && p.stages[key]?.generatedAt && st.acceptedAt > p.stages[key].generatedAt) return STAGES[i].label;
  }
  return 'an earlier decision';
}

export const targets = (p) => footprintTargets(p.brief, selected(p, 'access'));
