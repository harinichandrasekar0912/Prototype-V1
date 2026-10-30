// Stage 05 — programme, area statement and area budget (spec §46–55, §58).
//
// All arithmetic is deterministic. Gross built-up area is NOT the sum of rooms: it is
//   net programme + circulation allowance + wall/structure allowance + vertical core.
// Auto-balance fits unlocked rooms between their min and max so the programme meets the target;
// locked rooms are never changed (spec §54).

import { LIB, SUITE_CHILDREN, ZONES } from '../rules/spaces.js';
import { DESIGN } from '../rules/assumptions.js';
import { round, sum, clamp } from '../core/util.js';

let sid = 0;
export const spaceId = () => `S${Date.now().toString(36).slice(-4)}${(sid++).toString(36)}`;

export function makeSpace(type, extra = {}) {
  const L = LIB[type] || LIB.custom;
  return { id: spaceId(), type, name: extra.name || L.label, area: extra.area ?? L.rec, locked: false, floor: null, parent: null, dh: false, ...extra };
}

// Adds a space and its usual attached children (bedroom → bath, master → bath + dressing).
export function addSpaceWithSuite(spaces, type, extra = {}) {
  const s = makeSpace(type, extra);
  const out = [s];
  for (const ch of SUITE_CHILDREN[type] || []) out.push(makeSpace(ch, { parent: s.id }));
  return renumber([...spaces, ...out]);
}

// "Bedroom" ×3 → Bedroom 1, 2, 3 ; their baths follow their bedroom's number.
export function renumber(spaces) {
  const counts = {};
  for (const s of spaces) if (!s.parent && !s.customName) counts[s.type] = (counts[s.type] || 0) + 1;
  const idx = {};
  const out = spaces.map((s) => ({ ...s }));
  for (const s of out) {
    if (s.parent || s.customName) continue;
    const L = LIB[s.type] || LIB.custom;
    if (counts[s.type] > 1) { idx[s.type] = (idx[s.type] || 0) + 1; s.name = `${L.label} ${idx[s.type]}`; s.num = idx[s.type]; }
    else { s.name = L.label; s.num = null; }
  }
  for (const s of out) {
    if (!s.parent || s.customName) continue;
    const p = out.find((x) => x.id === s.parent);
    const L = LIB[s.type] || LIB.custom;
    s.name = p && p.num ? `${L.label} ${p.num}` : L.label;
  }
  return out;
}

export function defaultProgramme(brief) {
  const floors = brief.floors || 1;
  const occ = Math.max(1, brief.occupants || 3);
  const text = `${brief.client || ''}`.toLowerCase();
  let sp = [];
  const add = (t, extra) => { sp = addSpaceWithSuite(sp, t, extra); };
  add('foyer'); add('formal_living'); add('dining'); add('kitchen'); add('utility'); add('powder'); add('puja');
  if (occ >= 3) add('family_living');
  add('master_bed');
  let others = Math.max(0, occ - 2);
  if (/grand|parent|elder|mother|father|in-law/.test(text) || (floors >= 2 && others >= 2)) { add('guest_bed', { name: 'Guest / parents bedroom' }); others--; }
  const kids = Math.min(3, Math.max(0, others));
  for (let i = 0; i < kids; i++) add('bedroom');
  if (floors >= 2) add('family_lounge');
  if (/help|staff|maid|servant|cook|driver/.test(text)) add('staff_room');
  add('store');
  if (floors >= 2) {
    const m = sp.find((s) => s.type === 'master_bed');
    sp = renumber([...sp, makeSpace('balcony', { parent: m.id })]);
  }
  if (brief.lift) sp = renumber([...sp, makeSpace('custom', { name: 'Lift', area: 2.5, customName: true, zone: 'circulation' })]);
  return sp;
}

export function coreArea(brief) {
  const floors = brief.floors || 1;
  const stair = floors > 1 ? DESIGN.stair.w * DESIGN.stair.d * floors : 0;
  const lift = brief.lift ? DESIGN.lift.w * DESIGN.lift.d * floors : 0;
  return { stair, lift, total: stair + lift };
}

export function budget(spaces, settings, brief, A) {
  const c = settings.circulationPct ?? DESIGN.circulationPct;
  const w = settings.wallPct ?? DESIGN.wallPct;
  const net = sum(spaces, (s) => s.area);
  const circulation = net * c;
  const walls = (net + circulation) * w;
  const core = coreArea(brief);
  const gross = net + circulation + walls + core.total;
  const stilt = brief.parking?.type === 'stilt' ? (brief.parking.cars || 1) * DESIGN.stilPerCar : 0;
  const target = brief.targetBUA || 0;
  const netTarget = Math.max(0, (target - core.total) / ((1 + c) * (1 + w)));
  return {
    net, circulation, walls, core, gross, fsiCounted: gross, stiltExcluded: stilt,
    target, netTarget, remainingNet: netTarget - net, maxBUA: A ? A.maxBUA : Infinity,
    minNet: sum(spaces, (s) => (s.locked ? s.area : (LIB[s.type] || LIB.custom).min)),
    maxNet: sum(spaces, (s) => (s.locked ? s.area : (LIB[s.type] || LIB.custom).max)),
    c, w,
  };
}

// Fit unlocked spaces to `netTarget` by a common scale on their recommended (or current) areas,
// clamped to [min, max] — bisection on the scale factor.
export function autoBalance(spaces, netTarget, { from = 'rec' } = {}) {
  const locked = sum(spaces.filter((s) => s.locked), (s) => s.area);
  const free = spaces.filter((s) => !s.locked);
  const need = netTarget - locked;
  const base = (s) => (from === 'rec' ? (LIB[s.type] || LIB.custom).rec : s.area);
  const val = (s, f) => {
    const L = LIB[s.type] || LIB.custom;
    const lo = s.customName ? s.area * 0.5 : L.min, hi = s.customName ? s.area * 2 : L.max;
    return clamp(base(s) * f, lo, hi);
  };
  let lo = 0.1, hi = 5;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (sum(free, (s) => val(s, mid)) > need) hi = mid; else lo = mid;
  }
  const f = (lo + hi) / 2;
  const map = new Map(free.map((s) => [s.id, round(val(s, f) * 2, 0) / 2])); // half-m² steps
  return spaces.map((s) => (map.has(s.id) ? { ...s, area: map.get(s.id) } : s));
}

// Floor assignment (spec §58): preferences + capacity balancing; attached rooms follow parents.
export function assignFloors(spaces, nFloors, capacities, { stilt = false } = {}) {
  const top = nFloors - 1;
  const firstRes = stilt ? Math.min(1, top) : 0;
  const out = spaces.map((s) => ({ ...s }));
  const byId = new Map(out.map((s) => [s.id, s]));
  const pref = (s) => {
    const L = LIB[s.type] || LIB.custom;
    if (nFloors === 1) return 0;
    // on a stilt level only the entrance lobby and staff/plant spaces stay at ground
    if (stilt && ['foyer', 'staff_room', 'motor_room'].includes(s.type)) return 0;
    if (L.floor === 'ground') return firstRes;
    if (L.floor === 'top') return top;
    if (L.floor === 'upper') return Math.min(top, firstRes + 1);
    return L.zone === 'private' || L.zone === 'semi-private' ? Math.min(top, firstRes + 1) : firstRes;
  };
  for (const s of out) if (!s.parent) s.floorAuto = s.floor ?? pref(s);
  const floorOf = (s) => (s.parent ? floorOf(byId.get(s.parent) || s) : s.floorAuto);
  const load = () => {
    const L = new Array(nFloors).fill(0);
    for (const s of out) L[Math.max(0, Math.min(top, floorOf(s)))] += s.area;
    return L;
  };
  // balance: move the most movable groups from overfull floors
  for (let guard = 0; guard < 40; guard++) {
    const L = load();
    const over = L.map((v, f) => v - (capacities[f] ?? Infinity));
    const f = over.indexOf(Math.max(...over));
    if (over[f] <= 0.03 * (capacities[f] || 1)) break;
    const groupArea = (s) => s.area + sum(out.filter((x) => x.parent === s.id), (x) => x.area);
    const movable = out.filter((s) => !s.parent && s.floorAuto === f && s.floor == null)
      .map((s) => {
        const Lb = LIB[s.type] || LIB.custom;
        const target = Lb.zone === 'private' || Lb.zone === 'semi-private' ? Math.min(top, f + 1) : Math.max(firstRes, f - 1);
        const alt = target !== f ? target : f + 1 <= top ? f + 1 : f - 1;
        const flex = Lb.floor === 'any' ? 2 : Lb.floor === 'upper' ? 1 : 0.4;
        return { s, alt, cost: (1 / flex) * Math.abs(groupArea(s) - over[f]) };
      })
      .filter((m) => m.alt >= firstRes && m.alt <= top && m.alt !== f && L[m.alt] + groupArea(m.s) <= (capacities[m.alt] ?? Infinity) * 1.03)
      .sort((a, b) => a.cost - b.cost);
    if (!movable.length) break;
    movable[0].s.floorAuto = movable[0].alt;
  }
  for (const s of out) s.floorAuto = floorOf(s);
  return out;
}

export function floorLoads(spaces, nFloors) {
  const L = new Array(nFloors).fill(0);
  for (const s of spaces) L[Math.max(0, Math.min(nFloors - 1, s.floorAuto ?? 0))] += s.area;
  return L;
}

// Net area each floor of the chosen footprint can hold (garage area excluded by the caller).
export function floorCapacities(footprintArea, nFloors, brief, settings, stilt = false) {
  const c = settings.circulationPct ?? DESIGN.circulationPct;
  const w = settings.wallPct ?? DESIGN.wallPct;
  const core = coreArea(brief);
  const perFloorCore = core.total / Math.max(1, nFloors);
  return Array.from({ length: nFloors }, (_, f) => {
    if (stilt && f === 0) return Math.max(0, (footprintArea * 0.35) / ((1 + c) * (1 + w)));
    return Math.max(0, (footprintArea - perFloorCore) / ((1 + c) * (1 + w)));
  }).map((v) => round(v, 1));
}

// Architectural validation messages (spec §55, §117).
export function validateProgramme(spaces, B, brief, A, loads, capacities) {
  const errors = [], warnings = [], ok = [];
  if (A && brief.targetBUA > A.maxBUA) errors.push(`The target built-up area (${round(brief.targetBUA)} m²) exceeds the maximum allowed by FSI ${A.fsi} on this plot (${round(A.maxBUA)} m²). Reduce the target.`);
  if (A && brief.floors * A.floorHeight > A.maxHeight) errors.push(`${brief.floors} floors at ${A.floorHeight} m exceed the ${A.maxHeight} m height limit.`);
  if (B.minNet > B.netTarget + 0.5) errors.push(`At minimum sizes this programme needs about ${round(B.minNet * (1 + B.c) * (1 + B.w) + B.core.total)} m² gross, while the target is ${round(B.target)} m². Remove spaces, unlock rooms or raise the target (up to ${round(B.maxBUA)} m²).`);
  else if (B.maxNet < B.netTarget - 0.5) warnings.push(`Even at maximum sizes the programme reaches only ~${round(B.maxNet * (1 + B.c) * (1 + B.w) + B.core.total)} m² of the ${round(B.target)} m² target — add spaces or lower the target.`);
  const diff = B.gross - B.target;
  if (Math.abs(diff) > Math.max(5, 0.03 * B.target)) warnings.push(`At the current room sizes the programme comes to ${round(B.gross, 0)} m² gross (${diff > 0 ? '+' : ''}${round(diff, 0)} m² against the ${round(B.target, 0)} m² target). Use auto-balance or adjust rooms.`);
  else ok.push(`Programme fits the target: ${round(B.gross, 0)} m² gross for ${round(B.target, 0)} m².`);
  if (!spaces.some((s) => s.type === 'kitchen')) warnings.push('The programme has no kitchen.');
  if (!spaces.some((s) => ['master_bed', 'bedroom', 'guest_bed'].includes(s.type))) warnings.push('The programme has no bedroom.');
  for (const s of spaces) {
    const L = LIB[s.type];
    if (!L || s.customName) continue;
    if (s.area < L.min - 1e-6) warnings.push(`${s.name} (${s.area} m²) is below the ${L.min} m² minimum used for ${L.label.toLowerCase()}s.`);
  }
  if (loads && capacities) loads.forEach((v, f) => {
    if (capacities[f] != null && v > capacities[f] * 1.05) warnings.push(`${floorName(f)} programme (${round(v)} m² net) exceeds what the chosen footprint holds (~${round(capacities[f])} m² net after circulation, walls and stair). Move spaces to another floor or revisit the footprint.`);
  });
  return { errors, warnings, ok };
}

export const floorName = (f) => (f === 0 ? 'Ground floor' : f === 1 ? 'First floor' : f === 2 ? 'Second floor' : `Floor ${f}`);
export const floorShort = (f) => (f === 0 ? 'GF' : `F${f}`);
export const zoneOf = (s) => (s.zone || (LIB[s.type] || LIB.custom).zone);
export const zoneColor = (s) => (ZONES[zoneOf(s)] || ZONES['semi-private']).color;
