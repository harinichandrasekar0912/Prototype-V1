// Adjacency model (spec §57). Relationships are explicit data with provenance:
//   source: 'rule' (typology default) | 'user' (edited) | 'text' (interpreted from the brief)
// Defaults are architectural heuristics, not laws (spec §88): they can be removed or changed.

export const REL_TYPES = {
  must_touch: { label: 'must touch', short: 'touch', attract: true, gapOk: 0.3, gapZero: 4 },
  adjacent: { label: 'adjacent', short: 'adj.', attract: true, gapOk: 0.6, gapZero: 6 },
  near: { label: 'near', short: 'near', attract: true, gapOk: 3, gapZero: 10 },
  visual: { label: 'visually connected', short: 'visual', attract: true, gapOk: 4, gapZero: 12 },
  separated: { label: 'separated', short: 'apart', attract: false, gapOk: 4, gapZero: 0 },
  must_not_touch: { label: 'must not touch', short: 'not touch', attract: false, gapOk: 1, gapZero: 0 },
};
export const STRENGTH_LABEL = { 1: 'low', 2: 'medium', 3: 'high' };

// Satisfaction of one relationship given the clear gap between two bubbles (m).
export function relSatisfaction(type, gap) {
  const T = REL_TYPES[type];
  if (!T) return 1;
  if (T.attract) {
    if (gap <= T.gapOk) return 1;
    if (gap >= T.gapZero) return 0;
    return 1 - (gap - T.gapOk) / (T.gapZero - T.gapOk);
  }
  if (gap >= T.gapOk) return 1;
  if (gap <= T.gapZero) return 0;
  return (gap - T.gapZero) / (T.gapOk - T.gapZero);
}

// [typeA, typeB, relation, strength, why]
const RULES = [
  ['kitchen', 'dining', 'must_touch', 3, 'serving distance'],
  ['kitchen', 'pantry', 'must_touch', 3, 'storage off the kitchen'],
  ['kitchen', 'utility', 'must_touch', 3, 'wash area off the kitchen'],
  ['utility', 'laundry', 'adjacent', 2, 'wet service cluster'],
  ['foyer', 'formal_living', 'adjacent', 3, 'visitors reach the formal living without crossing family spaces'],
  ['foyer', 'powder', 'adjacent', 2, 'a guest toilet off the public zone'],
  ['foyer', '@stair', 'adjacent', 2, 'the stair is found from the entrance'],
  ['dining', 'family_living', 'adjacent', 2, 'everyday family cluster'],
  ['formal_living', 'dining', 'near', 1, 'hosting sequence'],
  ['dining', '@courtyard', 'adjacent', 2, 'dining opens to the courtyard'],
  ['family_living', '@garden', 'adjacent', 2, 'family space spills into the garden'],
  ['formal_living', '@courtyard', 'visual', 1, 'formal living looks into the courtyard'],
  ['puja', 'dining', 'near', 1, 'the pooja room sits within the family core'],
  ['office', 'foyer', 'near', 1, 'visitors to the office stay in the public zone'],
  ['guest_bed', 'foyer', 'near', 1, 'guests reach their room without entering family zones'],
  ['home_bar', 'formal_living', 'adjacent', 1, 'entertaining cluster'],
  ['family_lounge', '@stair', 'adjacent', 2, 'upper hall at the head of the stair'],
  ['family_lounge', 'bedroom', 'adjacent', 2, 'bedrooms open off the family lounge'],
  ['family_lounge', 'master_bed', 'near', 1, 'master suite reached from the upper hall'],
  ['kitchen', '@service-yard', 'adjacent', 2, 'kitchen works with the service yard'],
  ['staff_room', 'utility', 'adjacent', 2, 'staff room within the service zone'],
  ['motor_room', 'utility', 'near', 1, 'plant with the wet services'],
  ['garage', 'utility', 'near', 1, 'service entry from the garage'],
  ['verandah', 'foyer', 'adjacent', 2, 'verandah as the threshold before the foyer'],
  ['gym', '@garden', 'near', 1, 'exercise with a garden outlook'],
  ['master_bed', 'formal_living', 'separated', 3, 'master suite kept away from visitors'],
  ['master_bed', 'kitchen', 'separated', 2, 'kitchen noise and smells'],
  ['bedroom', 'kitchen', 'separated', 1, 'kitchen noise and smells'],
  ['bedroom', 'formal_living', 'separated', 2, 'bedrooms out of the public zone'],
  ['guest_bed', 'master_bed', 'separated', 2, 'acoustic privacy between generations/guests'],
  ['staff_room', 'master_bed', 'separated', 2, 'household privacy'],
  ['gym', 'bedroom', 'separated', 1, 'gym noise'],
  ['theatre', 'bedroom', 'separated', 1, 'theatre noise'],
  ['utility', 'formal_living', 'separated', 2, 'service kept out of the public zone'],
  ['powder', 'dining', 'separated', 1, 'no toilet door off the dining table'],
  ['powder', 'kitchen', 'separated', 1, 'hygiene'],
];

let relCounter = 0;
export const relId = () => `r${Date.now().toString(36)}${(relCounter++).toString(36)}`;

// spaces: [{id, type, parent}] ; anchors: Set of available anchors ('@courtyard', '@garden', …)
export function defaultRelations(spaces, anchors = new Set()) {
  const out = [];
  const seen = new Set();
  const push = (a, b, type, strength, note) => {
    const k = [a, b].sort().join('|');
    if (seen.has(k) || a === b) return;
    seen.add(k);
    out.push({ id: relId(), a, b, type, strength, source: 'rule', note });
  };
  // attached children always touch their parent
  for (const s of spaces) if (s.parent) push(s.parent, s.id, 'must_touch', 3, 'attached to its room');
  const byType = (t) => spaces.filter((s) => s.type === t);
  for (const [ta, tb, type, strength, note] of RULES) {
    const As = byType(ta);
    if (tb.startsWith('@')) {
      if (!anchors.has(tb)) continue;
      for (const a of As) push(a.id, tb, type, strength, note);
      continue;
    }
    const Bs = byType(tb);
    for (const a of As) for (const b of Bs) {
      // children of one bedroom should not inherit rules against another suite's parts
      if (type === 'must_touch' && As.length > 1 && Bs.length > 1) continue;
      push(a.id, b.id, type, strength, note);
    }
  }
  return out;
}
