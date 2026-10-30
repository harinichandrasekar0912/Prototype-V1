// Natural-language interpretation (spec §91, §124). V1 uses an explicit, inspectable rule-based
// interpreter: it turns sentences into structured items the architect can see, edit or delete
// before anything is applied. Nothing here computes geometry. An LLM interpreter can later
// implement the same output shape (see interpretWith in DEVLOG) without changing the engine.

import { SPACE_SYNONYMS, ANCHOR_SYNONYMS } from '../rules/spaces.js';
import { PRIORITIES } from '../rules/assumptions.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- intent → priority weights ---------------------------------------------------------------
const INTENT_WORDS = {
  privacy: ['introvert', 'inward', 'private', 'privacy', 'secluded', 'seclusion', 'protected', 'screened', 'shielded', 'withdrawn'],
  trees: ['tree', 'trees', 'neem', 'mango', 'coconut', 'vegetation', 'green', 'nature', 'preserve', 'preserved', 'canopy'],
  courtyard: ['courtyard', 'court', 'atrium', 'mutram', 'muttam', 'open-to-sky', 'open to sky', 'nadumuttam', 'heart'],
  ventilation: ['ventilat', 'breeze', 'airy', 'cross-vent', 'wind', 'porous', 'airflow'],
  climate: ['sun', 'shade', 'shaded', 'heat', 'cool', 'tropical', 'climat', 'thermal', 'west sun', 'glare'],
  views: ['view', 'vista', 'outlook', 'overlook', 'framed'],
  garden: ['garden', 'lawn', 'landscape', 'outdoor', 'green space', 'planting'],
  noise: ['quiet', 'noise', 'calm', 'peaceful', 'serene', 'silent', 'acoustic'],
  compactness: ['compact', 'efficient', 'economical', 'budget', 'affordable', 'minimal', 'frugal', 'lean'],
  procession: ['procession', 'threshold', 'layered', 'sequence', 'arrival', 'approach', 'transition', 'gradual', 'journey', 'reveal', 'grand'],
};

export function interpretIntent(text) {
  const t = ` ${(text || '').toLowerCase()} `;
  const out = [];
  for (const P of PRIORITIES) {
    const hits = (INTENT_WORDS[P.key] || []).filter((w) => t.includes(w));
    if (!hits.length) continue;
    out.push({ key: P.key, label: P.label, weight: Math.min(3, 1 + 0.5 * hits.length), phrases: hits });
  }
  let entry = null;
  if (/\b(grand|imposing|monumental|formal arrival)\b/.test(t)) entry = /imposing|monumental/.test(t) ? 'imposing' : 'grand';
  else if (/\b(subtle|discreet|quiet entry|layered|indirect|understated)\b/.test(t)) entry = 'subtle';
  return { priorities: out, entry };
}

// ---- mention finding ------------------------------------------------------------------------
// Returns [{start, end, phrase, ids:[spaceId|anchor], kind}] for every space/anchor mentioned.
export function findMentions(text, spaces) {
  const t = text.toLowerCase();
  const entries = [];
  // exact instance names first ("bedroom 2", "guest / parents bedroom")
  for (const s of spaces) entries.push({ phrase: s.name.toLowerCase(), ids: [s.id], kind: 'space' });
  // type synonyms: plural forms refer to all instances
  for (const [type, syns] of Object.entries(SPACE_SYNONYMS)) {
    const inst = spaces.filter((s) => s.type === type);
    if (!inst.length) continue;
    for (const syn of syns) {
      const plural = /s$/.test(syn) && !/ss$/.test(syn);
      entries.push({ phrase: syn, ids: plural || inst.length === 1 ? inst.map((s) => s.id) : [inst[0].id], kind: 'space', ambiguous: !plural && inst.length > 1, all: inst.map((s) => s.id) });
    }
  }
  for (const [anchor, syns] of Object.entries(ANCHOR_SYNONYMS)) for (const syn of syns) entries.push({ phrase: syn, ids: [`@${anchor}`], kind: 'anchor' });
  entries.sort((a, b) => b.phrase.length - a.phrase.length);
  const taken = new Array(t.length).fill(false);
  const found = [];
  for (const e of entries) {
    const re = new RegExp(`\\b${esc(e.phrase)}\\b`, 'g');
    let m;
    while ((m = re.exec(t))) {
      const a = m.index, b = a + e.phrase.length;
      if (taken.slice(a, b).some(Boolean)) continue;
      for (let k = a; k < b; k++) taken[k] = true;
      found.push({ start: a, end: b, phrase: text.slice(a, b), ids: e.ids, kind: e.kind, ambiguous: e.ambiguous });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

const REL_PATTERNS = [
  ['separated', /\b(away from|far from|separate[d]? from|apart from|not (?:next to|near|adjacent to|beside)|isolated from|distant from|shielded from|screened from|buffered from|visually separated from|not visible from|private from|separate)\b/],
  ['must_touch', /\b(attached to|directly (?:off|connected to|next to|adjacent to)|en[- ]?suite|opening into|opens into|right next to|must touch)\b/],
  ['visual', /\b(overlook(?:s|ing)?|look(?:s|ing)? (?:into|onto|out to|over|at)|views? (?:of|to|into|over)|visually connected|visual connection|see(?:s)?)\b/],
  ['adjacent', /\b(next to|adjacent to|adjoining|beside|connect(?:s|ed)? (?:to|with)|connect|open(?:s|ing)? (?:on)?to|link(?:ed|s)? (?:to|with)|off the|alongside|close to|spill(?:s)? (?:in)?to|together with)\b/],
  ['near', /\b(near|within reach of|easy access to|accessible from|reachable from|not far from|convenient to)\b/],
];

const clauses = (text) => text.split(/(?<=[.;!?])\s+|\s+(?:but|while|whereas|however)\s+|\n+/i).map((s) => s.trim()).filter(Boolean);

function floorFrom(c) {
  if (/\b(ground floor|downstairs|at ground level|on the ground)\b/.test(c)) return 0;
  if (/\b(second floor|top floor|topmost)\b/.test(c)) return 'top';
  if (/\b(first floor|upstairs|upper floor|upper level|above)\b/.test(c)) return 1;
  return null;
}
function areaFrom(c) {
  let m = c.match(/(\d+(?:\.\d+)?)\s*(?:m2|m²|sqm|sq\.?\s?m|square met)/);
  if (m) return { abs: parseFloat(m[1]) };
  m = c.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s?ft|sqft|ft2|ft²|square feet)/);
  if (m) return { abs: Math.round((parseFloat(m[1]) / 10.7639) * 2) / 2 };
  if (/\b(bigger|larger|more spacious|generous|enlarge|increase)\b/.test(c)) return { rel: 1.15 };
  if (/\b(smaller|compact|reduce|tighter|shrink)\b/.test(c)) return { rel: 0.87 };
  return null;
}

// ---- programme preferences (spec §56) --------------------------------------------------------
export function interpretPreferences(text, spaces) {
  const items = [], unread = [];
  let lastSubject = null;
  for (const cl of clauses(text || '')) {
    const c = cl.toLowerCase();
    const ms = findMentions(cl, spaces);
    if (!ms.length) { unread.push(cl); continue; }
    let used = false;
    // a clause like "...but visually separated from family spaces" continues the previous subject
    if (lastSubject && REL_PATTERNS.some(([, re]) => { const m = c.match(re); return m && !ms.some((x) => x.start < m.index); })) ms.unshift({ ...lastSubject, start: -1, end: -1 });
    // relationships: subject = first mention before the keyword, objects = mentions after it
    for (const [type, re] of REL_PATTERNS) {
      const m = c.match(re);
      if (!m) continue;
      const k = m.index;
      const before = ms.filter((x) => x.start < k), after = ms.filter((x) => x.start > k);
      const subj = before.length ? before[before.length - 1] : after.shift();
      for (const obj of after) {
        for (const a of subj.ids) for (const b of obj.ids) {
          if (a === b) continue;
          items.push({ kind: 'relation', a, b, type, strength: /\b(must|always|definitely|strongly|directly)\b/.test(c) ? 3 : 2, phrase: cl, ambiguous: subj.ambiguous || obj.ambiguous });
        }
        used = true;
      }
      if (used) break;
    }
    const subj = ms[0];
    if (subj.kind === 'space') lastSubject = subj;
    const spaceIds = ms.filter((x) => x.kind === 'space' && x.start >= 0).flatMap((x) => x.ids);
    if (/\b(maximum|max|most|high|complete|total|full|lot of|utmost) privacy\b|\bmost private\b|\bvery private\b|\bsecluded\b|\bprotected\b/.test(c)) {
      for (const id of spaceIds.slice(0, 1)) items.push({ kind: 'attr', id, attr: 'privacy', value: 1, phrase: cl });
      used = true;
    }
    if (/\bquiet\b|\bpeaceful\b|\bcalm\b|\baway from (?:the )?(?:road|street|noise|traffic)\b/.test(c)) {
      for (const id of spaceIds.slice(0, 1)) items.push({ kind: 'attr', id, attr: 'noise', value: 1, phrase: cl });
      used = true;
    }
    if (/\b(best|good|great|garden|landscape|nice|beautiful) views?\b|\bview(?:s)? (?:of|to|over) (?:the )?(?:garden|park|tree|courtyard|landscape|lake|sea)\b/.test(c)) {
      for (const id of spaceIds.slice(0, 1)) items.push({ kind: 'attr', id, attr: 'view', value: 1, phrase: cl });
      used = true;
    }
    const fl = floorFrom(c);
    if (fl !== null && !/\b(above|overlook)/.test(c)) {
      for (const id of spaceIds) items.push({ kind: 'floor', id, floor: fl, phrase: cl });
      used = true;
    }
    if (/\bdouble[- ]height\b|\btall volume\b|\bhigh ceiling\b/.test(c)) {
      for (const id of spaceIds.slice(0, 1)) items.push({ kind: 'attr', id, attr: 'dh', value: true, phrase: cl });
      used = true;
    }
    if (/\bopen[- ]plan\b|\bopen to each other\b|\bone continuous\b|\bflows? into\b/.test(c) && spaceIds.length >= 2) {
      for (let i = 0; i < spaceIds.length - 1; i++) items.push({ kind: 'open', a: spaceIds[i], b: spaceIds[i + 1], phrase: cl });
      used = true;
    }
    const ar = areaFrom(c);
    if (ar && subj.kind === 'space') { items.push({ kind: 'area', id: subj.ids[0], ...ar, phrase: cl }); used = true; }
    if (!used) unread.push(cl);
  }
  return { items, unread };
}

// ---- revision commands for a selected design (spec §72) --------------------------------------
const DIRS = ['north', 'south', 'east', 'west', 'front', 'rear', 'back', 'left', 'right', 'street', 'road', 'centre', 'center', 'middle'];
export function interpretRevision(text, spaces) {
  const cmds = [], unread = [];
  if (/\b(regenerate|try again|new options|start over|three more|3 more)\b/i.test(text || '')) cmds.push({ kind: 'regenerate', phrase: text });
  for (const cl of clauses(text || '')) {
    const c = cl.toLowerCase();
    const ms = findMentions(cl, spaces);
    let used = false;
    if (/\b(keep|preserve|retain|leave|lock|freeze|don't (?:move|change|touch)|do not (?:move|change|touch)|unchanged|as it is|as is|fixed|in place)\b/.test(c)) {
      const ids = ms.flatMap((m) => m.ids);
      if (ids.length) { cmds.push({ kind: 'keep', ids, phrase: cl }); used = true; }
    }
    if (!used && /\b(swap|switch|exchange|interchange)\b/.test(c) && ms.length >= 2) {
      cmds.push({ kind: 'swap', a: ms[0].ids[0], b: ms[1].ids[0], phrase: cl });
      used = true;
    }
    if (!used && ms.length) {
      const subj = ms[0];
      const away = c.match(/\b(away from|further from|farther from|far from|distance from|separate from)\b/);
      const toward = c.match(/\b(closer to|nearer to|nearer|toward|towards|next to|near|adjacent to|beside|close to|by the|connect(?:ed)? to|open(?:s)? (?:on)?to)\b/);
      const dirM = c.match(new RegExp(`\\b(?:to|towards|toward|on|at) the (${DIRS.join('|')})\\b|\\b(${DIRS.slice(0, 4).join('|')})(?:ern)? (?:side|edge|end)\\b`));
      const obj = ms.slice(1);
      if (away && obj.length) {
        for (const o of obj.filter((o) => o.start > away.index)) cmds.push({ kind: 'repel', a: subj.ids[0], b: o.ids[0], phrase: cl });
        used = true;
      } else if (toward && obj.length) {
        for (const o of obj.filter((o) => o.start > toward.index)) cmds.push({ kind: 'attract', a: subj.ids[0], b: o.ids[0], phrase: cl });
        used = cmds.some((x) => x.phrase === cl);
      }
      if (!used && dirM) {
        const d = (dirM[1] || dirM[2]).replace('back', 'rear').replace('road', 'street').replace('center', 'centre').replace('middle', 'centre');
        cmds.push({ kind: 'direction', a: subj.ids[0], dir: d, phrase: cl });
        used = true;
      }
      const fl = floorFrom(c);
      if (fl !== null && /\b(move|put|place|shift|relocate|bring|take)\b/.test(c)) { cmds.push({ kind: 'floor', a: subj.ids[0], floor: fl, phrase: cl }); used = true; }
      const ar = areaFrom(c);
      if (ar && subj.kind === 'space') { cmds.push({ kind: 'area', a: subj.ids[0], ...ar, phrase: cl }); used = true; }
      if (!used) {
        for (const [type, re] of REL_PATTERNS) {
          const m = c.match(re);
          if (!m || ms.length < 2) continue;
          cmds.push({ kind: 'relate', a: subj.ids[0], b: ms[1].ids[0], type, phrase: cl });
          used = true;
          break;
        }
      }
    }
    if (!used && !/\b(regenerate|try again|new options|start over|three more|3 more)\b/.test(c)) unread.push(cl);
  }
  return { cmds, unread };
}

export function describeCmd(cmd, nameOf) {
  const n = (id) => nameOf(id);
  switch (cmd.kind) {
    case 'keep': return `Keep ${cmd.ids.map(n).join(', ')} where ${cmd.ids.length > 1 ? 'they are' : 'it is'}`;
    case 'swap': return `Swap ${n(cmd.a)} and ${n(cmd.b)}`;
    case 'attract': return `Move ${n(cmd.a)} towards ${n(cmd.b)}`;
    case 'repel': return `Move ${n(cmd.a)} away from ${n(cmd.b)}`;
    case 'direction': return `Move ${n(cmd.a)} to the ${cmd.dir}`;
    case 'floor': return `Put ${n(cmd.a)} on the ${cmd.floor === 0 ? 'ground floor' : cmd.floor === 'top' ? 'top floor' : 'first floor'}`;
    case 'area': return cmd.abs ? `Make ${n(cmd.a)} ${cmd.abs} m²` : `Make ${n(cmd.a)} ${cmd.rel > 1 ? 'larger' : 'smaller'}`;
    case 'relate': return `${n(cmd.a)} ${cmd.type.replace('_', ' ')} ${n(cmd.b)}`;
    case 'regenerate': return 'Generate new options';
    default: return cmd.kind;
  }
}
