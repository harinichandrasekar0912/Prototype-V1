// V1 output package (spec §84): a set of printable sheets generated from the design state.

import { getAnalysis, getPlans, selected, preservedSet, getBubbleCtx } from '../core/pipeline.js';
import { siteSummary } from '../analysis/site.js';
import { budget, floorName } from '../design/programme.js';
import { drawScene } from '../render/draw.js';
import { thumbSVG } from './canvas.js';
import { esc, kv } from './components.js';
import { PRIORITIES, REGULATION_PACKAGE } from '../rules/assumptions.js';
import { STAGES } from '../core/model.js';
import { ZONES, LIB } from '../rules/spaces.js';
import { round, sum, M2_TO_FT2 } from '../core/util.js';

const sheet = (title, n, body, p) => `<section class="sheet"><header class="sh-h"><div><b>${esc(p.name)}</b><span>${esc(title)}</span></div><div class="sh-n">${n}</div></header><div class="sh-b">${body}</div>
  <footer class="sh-f"><span>${esc(REGULATION_PACKAGE.jurisdiction)} · prototype assumptions</span><span>${new Date().toLocaleDateString()}</span><span>Design assistant — Prototype V1</span></footer></section>`;

function drawing(p, stage, opts = {}) {
  const sc = drawScene(p, { stage, layers: { grid: true, context: true, setbacks: true, trees: true, wind: true, sun: true, noise: true, views: true, privacy: true, labels: true, zoning: true, ...opts.layers }, floor: opts.floor || 0 });
  return `<div class="sh-draw">${thumbSVG(sc, 'sh-svg')}</div>`;
}

export function openSheets(p) {
  const el = document.getElementById('sheets');
  const A = getAnalysis(p);
  const pages = [];
  let n = 1;
  const pri = Object.entries(p.intent.priorities).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><span>${esc(PRIORITIES.find((x) => x.key === k)?.label || k)}</span><i style="width:${(v / 3) * 100}%"></i></li>`).join('');
  pages.push(sheet('Design intent', n++, `<div class="cols"><div><h3>Intent</h3><p class="big">${esc(p.intent.text || '—')}</p><h3>Client</h3><p>${esc(p.brief.client || '—')}</p>
    ${kv([['Floors', p.brief.floors === 1 ? 'G' : `G+${p.brief.floors - 1}`], ['Target built-up area', `${p.brief.targetBUA} m²`], ['Parking', `${p.brief.parking.cars} car(s), ${p.brief.parking.type}`], ['Entry character', p.brief.entryCharacter]])}</div>
    <div><h3>Priorities</h3><ul class="pri">${pri}</ul><p class="small">${esc(REGULATION_PACKAGE.status)}</p></div></div>`, p));
  if (A.ok) pages.push(sheet('Site analysis', n++, `<div class="cols w"><div>${drawing(p, 'site')}</div><div><h3>Site summary</h3>${kv(siteSummary(A))}</div></div>`, p));
  if (selected(p, 'footprint')) {
    const pres = preservedSet(p);
    pages.push(sheet('Ground zoning', n++, `<div class="cols w"><div>${drawing(p, 'footprint')}</div><div><h3>Decisions</h3>${kv([
      ['Trees', `${pres.size} preserved${A.trees.filter((t) => t.inside && !pres.has(t.id)).length ? `; removed ${A.trees.filter((t) => t.inside && !pres.has(t.id)).map((t) => t.id).join(', ')}` : ''}`],
      ['Access', selected(p, 'access')?.title || '—'], ['Footprint', selected(p, 'footprint').title], ['Footprint area', `${selected(p, 'footprint').metrics.area} m² per floor`]])}
      <h3>Why</h3><ul>${(selected(p, 'footprint').pros || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul><h3>Trade-offs</h3><ul>${(selected(p, 'footprint').cons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`, p));
  }
  const prog = p.stages.programme;
  if (prog?.spaces) {
    const B = budget(prog.spaces, prog.settings, p.brief, A);
    const rows = [...prog.spaces].sort((a, b) => (a.floorAuto ?? 0) - (b.floorAuto ?? 0));
    pages.push(sheet('Area statement', n++, `<table class="area-t sh"><thead><tr><th>#</th><th>Space</th><th>Zone</th><th>Floor</th><th class="r">m²</th><th class="r">ft²</th></tr></thead><tbody>${rows.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(ZONES[s.zone || (LIB[s.type] || LIB.custom).zone]?.label || '')}</td><td>${esc(floorName(s.floorAuto ?? 0))}</td><td class="r">${round(s.area, 1)}</td><td class="r">${Math.round(s.area * M2_TO_FT2)}</td></tr>`).join('')}</tbody></table>
      ${kv([['Net programme', `${round(B.net, 1)} m²`], ['Circulation', `${round(B.circulation, 1)} m²`], ['Walls & structure', `${round(B.walls, 1)} m²`], ['Stair / lift core', `${round(B.core.total, 1)} m²`], ['Gross built-up area', `${round(B.gross, 1)} m²`], ['FSI maximum', `${round(B.maxBUA, 0)} m²`]])}`, p));
  }
  const cur = p.stages.bubbles?.current;
  if (cur) for (let f = 0; f < p.brief.floors; f++) pages.push(sheet(`Spatial organisation — ${floorName(f)}`, n++, `${drawing(p, 'bubbles', { floor: f, layers: { relations: false } })}<p class="small">${esc(cur.title)} · ${esc(cur.logic || '')}</p>`, p));
  const plans = getPlans(p);
  if (plans) {
    const pl = plans.find((x) => x.id === p.stages.plan?.selectedId) || plans[0];
    for (let f = 0; f < p.brief.floors; f++) pages.push(sheet(`Single-line plan — ${floorName(f)}`, n++, `${drawing(p, 'plan', { floor: f })}<p class="small">${esc(pl.title)}. Walls are schematic single lines; dimensions read from the 1 m grid.${pl.issues.length ? ` Open issues: ${esc(pl.issues.slice(0, 4).join(' '))}` : ''}</p>`, p));
  }
  pages.push(sheet('Design evolution', n++, `<ol class="sh-tl">${p.history.map((h) => `<li><b>${esc(h.v)}</b> <span class="tag">${esc(STAGES.find((s) => s.key === h.stage)?.short || h.stage)}</span> ${esc(h.title)}${h.prompt ? ` — “${esc(h.prompt)}”` : ''}<div class="small">${esc(h.explanation || '')}</div></li>`).join('')}</ol>`, p));
  el.innerHTML = `<div class="sheets-bar"><b>Output sheets</b><span>${pages.length} sheets · A3 landscape</span><button class="btn" onclick="window.print()">Print / save as PDF</button><button class="btn ghost" onclick="document.getElementById('sheets').classList.add('hidden')">Close</button></div><div class="sheets-body">${pages.join('')}</div>`;
  el.classList.remove('hidden');
  void getBubbleCtx; void sum;
}
