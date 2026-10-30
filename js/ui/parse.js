// Text formats for site layers. Both the original prototype syntax "(x,y,0);(x,y,0)" and one item
// per line are accepted. Errors name the line and say what is missing (spec §117).

const NUM = /-?\d+(?:\.\d+)?/g;
const nums = (s) => (s.match(NUM) || []).map(Number);
const lines = (text) => (text || '').split(/\n/).map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => x.l && !x.l.startsWith('#'));

export function parseBoundary(text) {
  const errors = [];
  const tokens = (text || '').includes(';') ? text.split(';') : (text || '').split(/\n/);
  const pts = [];
  tokens.forEach((t, i) => {
    if (!t.trim()) return;
    const v = nums(t);
    if (v.length < 2) { errors.push(`Point ${i + 1}: needs x and y.`); return; }
    pts.push([v[0], v[1]]);
  });
  if (pts.length && pts.length < 3) errors.push('The boundary needs at least three points.');
  return { value: pts, errors };
}
export const fmtBoundary = (pts) => pts.map(([x, y]) => `${x}, ${y}`).join('\n');

export function parseTrees(text) {
  const out = [], errors = [];
  for (const { l, n } of splitItems(text)) {
    const v = nums(l);
    const label = l.replace(/[()]/g, ' ').replace(NUM, '').replace(/[,;|]/g, ' ').trim();
    let x, y, r, h;
    if (v.length >= 5) [x, y, , r, h] = v; // legacy (x, y, 0, radius, height)
    else if (v.length >= 3) [x, y, r, h] = v;
    else { errors.push(`Line ${n}: a tree needs x, y, canopy radius (and height).`); continue; }
    if (!(r > 0)) { errors.push(`Line ${n}: canopy radius must be positive.`); continue; }
    out.push({ id: `T${out.length + 1}`, x, y, r, h: h || 6, species: label || '' });
  }
  return { value: out, errors };
}
export const fmtTrees = (ts) => ts.map((t) => `${t.x}, ${t.y}, ${t.r}, ${t.h}${t.species ? `, ${t.species}` : ''}`).join('\n');

export function parseBuildings(text) {
  const out = [], errors = [];
  // legacy ((x,y,z);(x,y,z));((…))
  if (/\(\(/.test(text || '')) {
    const groups = text.match(/\(\((.*?)\)\)/g) || [];
    groups.forEach((g, i) => {
      const pts = g.replace(/[()]/g, '').split(';').map((pt) => nums(pt)).filter((v) => v.length >= 2).map((v) => [v[0], v[1]]);
      if (pts.length < 3) errors.push(`Building ${i + 1}: needs at least three corners.`);
      else out.push({ id: `B${out.length + 1}`, polygon: pts, height: 9, use: '' });
    });
    return { value: out, errors };
  }
  for (const { l, n } of splitItems(text)) {
    const [geom, h, use] = l.split('|').map((s) => s.trim());
    const v = nums(geom);
    if (v.length < 6 || v.length % 2) { errors.push(`Line ${n}: give corners as x,y pairs (at least three).`); continue; }
    const pts = [];
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
    out.push({ id: `B${out.length + 1}`, polygon: pts, height: h ? Number(nums(h)[0]) || 9 : 9, use: use || '' });
  }
  return { value: out, errors };
}
export const fmtBuildings = (bs) => bs.map((b) => `${b.polygon.map(([x, y]) => `${x},${y}`).join('  ')} | ${b.height} | ${b.use || ''}`).join('\n');

function pointRadius(text, prefix, what) {
  const out = [], errors = [];
  for (const { l, n } of splitItems(text)) {
    const v = nums(l);
    const label = l.replace(/[()]/g, ' ').replace(NUM, '').replace(/[,;|]/g, ' ').trim();
    let x, y, r;
    if (v.length >= 4 && /\(/.test(l)) [x, y, , r] = v; // legacy (x, y, z, radius)
    else if (v.length >= 3) [x, y, r] = v;
    else { errors.push(`Line ${n}: a ${what} needs x, y and a radius.`); continue; }
    out.push({ id: `${prefix}${out.length + 1}`, x, y, radius: r, label });
  }
  return { value: out, errors };
}
export const parseNoise = (t) => pointRadius(t, 'N', 'noise source');
export const parsePrivacy = (t) => pointRadius(t, 'P', 'privacy concern');
export const fmtPointRadius = (xs) => xs.map((s) => `${s.x}, ${s.y}, ${s.radius}${s.label ? `, ${s.label}` : ''}`).join('\n');

function vectors(text, prefix, withKind) {
  const out = [], errors = [];
  for (const { l, n } of splitItems(text)) {
    const v = nums(l);
    if (v.length < 4) { errors.push(`Line ${n}: give a start and an end point (x1,y1 -> x2,y2).`); continue; }
    const legacy3 = v.length >= 6 && /\(/.test(l);
    const from = [v[0], v[1]], to = legacy3 ? [v[3], v[4]] : [v[2], v[3]];
    const rest = l.replace(/[()]/g, ' ').replace(NUM, '').replace(/->|→|[,;|]/g, ' ').trim();
    let kind = 'desirable', label = rest;
    if (withKind) {
      if (/\bundesirable|bad|avoid|negative\b/i.test(rest)) kind = 'undesirable';
      label = rest.replace(/\b(undesirable|desirable|good|bad|avoid|negative|positive)\b/gi, '').trim();
    }
    out.push(withKind ? { id: `${prefix}${out.length + 1}`, from, to, kind, weight: 1, label } : { id: `${prefix}${out.length + 1}`, from, to, label });
  }
  return { value: out, errors };
}
export const parseViews = (t) => vectors(t, 'V', true);
export const parseWinds = (t) => vectors(t, 'W', false);
export const fmtViews = (vs) => vs.map((v) => `${v.from.join(',')} -> ${v.to.join(',')}, ${v.kind}${v.label ? `, ${v.label}` : ''}`).join('\n');
export const fmtWinds = (ws) => ws.map((w) => `${w.from.join(',')} -> ${w.to.join(',')}${w.label ? `, ${w.label}` : ''}`).join('\n');

// items separated by newlines, or by ";" between parenthesised legacy groups
function splitItems(text) {
  const t = text || '';
  if (!t.includes('\n') && /\)\s*;\s*\(/.test(t) && !/\(\(/.test(t)) return t.split(/\)\s*;\s*\(/).map((l, i) => ({ l: l.replace(/[()]/g, '').trim(), n: i + 1 })).filter((x) => x.l);
  return lines(t);
}
