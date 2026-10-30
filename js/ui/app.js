// Application shell: stage rail, drawing canvas, stage panels, design timeline.
// The loop at every stage is the spec's human-in-the-loop cycle (§111):
//   generate → evaluate → explain → architect selects / locks / modifies → validate → record.

import { store, subscribe, update, setUI, toast, load, restore, resetProject, importProject, exportProject, addHistory } from '../core/store.js';
import { STAGES, OPEN_SPACE_TYPES } from '../core/model.js';
import { getAnalysis, getFields, getMasks, getZoning, getBubbleCtx, getPlans, selected, preservedSet, bases, stageStatus, anchorsFor, targets } from '../core/pipeline.js';
import { siteSummary } from '../analysis/site.js';
import { FIELD_INFO } from '../analysis/fields.js';
import { generateAccess } from '../design/access.js';
import { generateFootprints, SCORE_LABEL, FAMILY_LABEL } from '../design/footprint.js';
import { defaultProgramme, budget, autoBalance, assignFloors, floorCapacities, floorLoads, validateProgramme, addSpaceWithSuite, renumber, floorName, floorShort, zoneOf } from '../design/programme.js';
import { defaultRelations, REL_TYPES, STRENGTH_LABEL, relId } from '../rules/relations.js';
import { generateBubbleOptions, reviseOption, rescore, STRATEGIES } from '../design/bubbles.js';
import { interpretIntent, interpretPreferences, interpretRevision, describeCmd } from '../design/interpret.js';
import { PLAN_VARIANTS } from '../design/plan.js';
import { SPACE_LIBRARY, LIB, ZONES } from '../rules/spaces.js';
import { PRIORITIES, REGULATION_NOTES, REGULATION_PACKAGE, MIN_STANDARDS_NOTE, DESIGN } from '../rules/assumptions.js';
import { drawScene, sceneBounds } from '../render/draw.js';
import { Canvas, thumbSVG } from './canvas.js';
import { esc, optionCard, messages, kv, section, scoreBars } from './components.js';
import * as P from './parse.js';
import { openSheets } from './sheets.js';
import { round, deepClone, hash, M2_TO_FT2, fmtFt2, sum, listJoin } from '../core/util.js';
import { compass8, COMPASS_NAMES } from '../geometry/polygon.js';

const $ = (s, r = document) => r.querySelector(s);
let canvas;
let drafts = {}; // un-applied text in panels (intent, prefs, revision, layer editors)
let lastCanvasKey = '';
let lastFit = '';

// ---------------------------------------------------------------------------------------------
export function boot() {
  load();
  canvas = new Canvas($('#svg'), {
    onBubbleDown: (id) => setUI({ selected: id }),
    onBubbleDrag: dragBubble,
    onBubbleUp: dropBubble,
    onMove: (w) => { const el = $('#coords'); if (el) el.textContent = `x ${w[0].toFixed(1)}  y ${w[1].toFixed(1)} m`; },
  });
  $('#svg').addEventListener('viewchange', (e) => drawScaleBar(e.detail.pxPerM));
  subscribe(render);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#sheets').classList.add('hidden'); } });
  render();
}

function busy(label, fn) {
  setUI({ busy: label });
  setTimeout(() => {
    try { fn(); } catch (err) { console.error(err); toast(`Something went wrong: ${err.message}`, 'err'); }
    setUI({ busy: null });
  }, 30);
}

// ---------------------------------------------------------------------------------------------
function render() {
  const p = store.project, ui = store.ui;
  document.body.dataset.stage = ui.stage;
  // each part renders independently so one failure never blanks the whole interface
  const safe = (name, fn) => { try { fn(); } catch (err) { console.error(`render ${name}:`, err); } };
  safe('header', () => renderHeader(p));
  safe('rail', () => renderRail(p, ui));
  safe('main', () => renderMain(p, ui));
  if (!isTyping()) safe('panel', () => renderPanel(p, ui));
  safe('timeline', () => renderTimeline(p));
  const t = $('#toast');
  t.className = ui.toast ? `toast show ${ui.toast.kind}` : 'toast';
  t.textContent = ui.toast ? ui.toast.text : '';
  $('#busy').classList.toggle('show', !!ui.busy);
  $('#busy-label').textContent = ui.busy || '';
}
const isTyping = () => {
  const a = document.activeElement;
  return a && $('#panel').contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'));
};

function renderHeader(p) {
  const A = getAnalysis(p);
  $('#proj-name').value = p.name;
  $('#proj-meta').textContent = A.ok ? `${round(A.area, 0)} m² site · ${p.brief.floors === 1 ? 'G' : `G+${p.brief.floors - 1}`} · target ${p.brief.targetBUA} m² · ${p.location.label}` : 'Site not defined';
}

function renderRail(p, ui) {
  $('#rail').innerHTML = STAGES.map((s) => {
    const st = stageStatus(p, s.key);
    return `<button class="stage-btn ${ui.stage === s.key ? 'is-active' : ''} st-${st}" data-action="goto" data-stage="${s.key}">
      <span class="n">${s.n}</span><span class="l">${esc(s.label)}</span><span class="dot" title="${st}"></span></button>`;
  }).join('') + `<div class="rail-foot"><div class="legend"><span class="dot st-accepted"></span>accepted <span class="dot st-options"></span>options <span class="dot st-stale"></span>needs review</div>
  <p class="disclaimer">Design-assistance prototype. Regulations are prototype assumptions; compliance must be verified by a qualified professional.</p></div>`;
}

// ---------------------------------------------------------------------------------------------
const FLOOR_STAGES = ['bubbles', 'plan'];
function renderMain(p, ui) {
  const stage = ui.stage;
  const main = $('#main');
  const showTable = stage === 'programme';
  const showRecord = stage === 'record';
  main.dataset.mode = showTable ? 'table' : showRecord ? 'record' : 'canvas';
  // toolbar
  const tb = [];
  if (!showTable && !showRecord) {
    const layerSet = stage === 'site' ? ['grid', 'context', 'setbacks', 'trees', 'wind', 'sun', 'noise', 'views', 'privacy', 'labels'] :
      stage === 'footprint' ? ['grid', 'context', 'setbacks', 'trees', 'zoning', 'views', 'labels'] :
        stage === 'bubbles' ? ['grid', 'context', 'trees', 'relations', 'labels'] : ['grid', 'context', 'setbacks', 'trees', 'labels'];
    tb.push(`<div class="chips">${layerSet.map((k) => `<button class="chip ${ui.layers[k] ? 'on' : ''}" data-action="layer" data-k="${k}">${k}</button>`).join('')}</div>`);
    if (FLOOR_STAGES.includes(stage) && p.brief.floors > 1) tb.push(`<div class="seg">${Array.from({ length: p.brief.floors }, (_, f) => `<button class="${ui.floor === f ? 'on' : ''}" data-action="floor" data-f="${f}">${f === 0 ? 'Ground' : `Floor ${f}`}</button>`).join('')}</div>`);
    const st = p.stages[stage];
    if (st && st.options && st.options.length > 1) tb.push(`<button class="chip ${ui.compare ? 'on' : ''}" data-action="compare">compare A·B·C</button>`);
    tb.push(`<button class="chip" data-action="fit" title="Fit drawing (or double-click)">fit</button>`);
  }
  $('#toolbar').innerHTML = tb.join('');
  if (showTable) { renderProgrammeTable(p); return; }
  if (showRecord) { renderRecordMain(p); return; }
  const st = p.stages[stage];
  const compare = ui.compare && st && st.options && st.options.length > 1 && ['access', 'footprint', 'bubbles', 'plan'].includes(stage);
  $('#compare').classList.toggle('hidden', !compare);
  if (compare) renderCompare(p, ui, stage);
  const layers = { ...ui.layers };
  const scene = drawScene(p, { stage, layers, floor: ui.floor, selectedBubble: ui.selected });
  const key = hash([stage, scene.geo.length, scene.txt.length, hash(scene.geo), hash(scene.txt)]);
  const fitKey = `${stage}:${hash(p.site.boundary)}`;
  if (key !== lastCanvasKey) {
    canvas.render(scene, { refit: fitKey !== lastFit });
    lastCanvasKey = key;
    lastFit = fitKey;
  }
  const A = getAnalysis(p);
  $('#north').style.transform = `rotate(${A.ok ? p.location.northDeg : 0}deg)`;
  $('#legend').innerHTML = compare ? '' : legendFor(stage, ui);
}

function drawScaleBar(pxPerM) {
  const el = $('#scalebar');
  if (!el || !pxPerM) return;
  const nice = [1, 2, 5, 10, 20, 50].find((m) => m * pxPerM >= 70) || 50;
  el.innerHTML = `<i style="width:${Math.round(nice * pxPerM)}px"></i><span>${nice} m</span>`;
}

function legendFor(stage, ui) {
  const items = {
    site: [['line k', 'site boundary'], ['dash r', 'setback'], ['fill g', 'tree canopy'], ['fill d', 'road'], ['fill l', 'context'], ['line b', 'wind'], ['line y', 'sun path'], ['ring o', 'noise'], ['dash p', 'view'], ['ring v', 'privacy']],
    trees: [['fill g', 'preserved tree'], ['hatch g', 'exclusion square (canopy + 1.5 m)'], ['dash m', 'removed']],
    access: [['bar r', 'vehicle gate'], ['bar k', 'pedestrian gate'], ['hatch m', 'reserved circulation (path ± 2 m)']],
    footprint: [['fill br', 'ground footprint'], ['fill or', 'public'], ['fill ye', 'semi-public'], ['fill bl', 'private']],
    bubbles: Object.entries(ZONES).map(([k, z]) => [`zone`, z.label, z.color]),
    plan: [['line k', 'wall'], ['dot k', 'open / visual partition'], ['line m', 'floor below']],
  }[stage] || [];
  return items.map(([cls, label, col]) => `<span class="lg"><i class="sw ${cls.replace(' ', '-')}" ${col ? `style="background:${col}"` : ''}></i>${esc(label)}</span>`).join('');
}

function renderCompare(p, ui, stage) {
  const st = p.stages[stage];
  const full = stage === 'plan' ? getPlans(p) || [] : null;
  const html = st.options.map((o) => {
    const ov = { [stage]: stage === 'plan' ? full.find((x) => x.id === o.id) || null : o };
    const sc = drawScene(p, { stage, layers: { ...ui.layers, labels: false }, floor: ui.floor, override: ov, thumb: false });
    const A = getAnalysis(p);
    if (A.ok) { const m = 2; sc.bounds = { x0: A.bbox.x0 - m, y0: A.bbox.y0 - m - 3, x1: A.bbox.x1 + m, y1: A.bbox.y1 + m }; }
    return `<div class="cmp ${o.id === st.selectedId ? 'is-selected' : ''}" data-action="select-option" data-stage="${stage}" data-id="${o.id}">
      <div class="cmp-h"><b>${o.id}</b> ${esc(o.title)} ${o.recommended ? '<span class="tag rec">recommended</span>' : ''}</div>${thumbSVG(sc, 'cmp-svg')}</div>`;
  }).join('');
  $('#compare').innerHTML = html;
}

// ---------------------------------------------------------------------------------------------
function renderPanel(p, ui) {
  const fn = { brief: panelBrief, site: panelSite, trees: panelTrees, access: panelAccess, footprint: panelFootprint, programme: panelProgramme, bubbles: panelBubbles, plan: panelPlan, record: panelRecord }[ui.stage];
  const st = stageStatus(p, ui.stage);
  const stale = st === 'stale' ? `<div class="msg warn stale">An earlier decision changed after this stage was generated. Review and regenerate — locked elements are kept.<button class="btn sm" data-action="regen-stale">Regenerate</button></div>` : '';
  $('#panel').innerHTML = `${stale}${fn(p, ui)}`;
}

const stageHead = (n, title, lede) => `<header class="ph"><span class="ph-n">${n}</span><h2>${esc(title)}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
const acceptBar = (stage, label, disabled = false, extra = '') => `<div class="accept">${extra}<button class="btn primary" data-action="accept" data-stage="${stage}" ${disabled ? 'disabled' : ''}>${esc(label)}</button></div>`;
const num = (bind, val, attrs = '') => `<input type="number" data-bind="${bind}" value="${val ?? ''}" ${attrs}>`;

// 00 BRIEF -----------------------------------------------------------------------------------------
function panelBrief(p) {
  const b = p.brief, A = getAnalysis(p);
  const interp = p.intent.interpreted || [];
  return `${stageHead('00', 'Brief & design intent', 'Who the house is for, how big it can be, and the architectural idea that every later option is measured against.')}
  ${section('Project', `
    <label>Project name<input type="text" data-bind="name" value="${esc(p.name)}"></label>
    <label>Client & household<textarea data-bind="brief.client" rows="2">${esc(b.client)}</textarea></label>
    <div class="row"><label>Occupants${num('brief.occupants', b.occupants, 'min="1" max="20"')}</label>
    <label>Location<input type="text" data-bind="location.label" value="${esc(p.location.label)}"></label></div>`)}
  ${section('Building', `
    <div class="row"><label>Floors<select data-bind="brief.floors" data-type="number">${[1, 2, 3].map((n) => `<option value="${n}" ${b.floors === n ? 'selected' : ''}>${n === 1 ? 'G' : `G+${n - 1}`}</option>`).join('')}</select></label>
    <label>Target built-up area (m²)${num('brief.targetBUA', b.targetBUA, 'min="40" step="5"')}</label></div>
    ${A.ok ? `<p class="hint">FSI ${A.fsi} allows up to ${round(A.maxBUA, 0)} m² (${fmtFt2(A.maxBUA)}) on this ${round(A.area, 0)} m² site — prototype assumption.</p>` : ''}
    ${A.ok && b.targetBUA > A.maxBUA ? `<div class="msg err">The target exceeds the FSI maximum (${round(A.maxBUA)} m²).</div>` : ''}
    <label class="check"><input type="checkbox" data-bind="brief.lift" ${b.lift ? 'checked' : ''}> Include an indoor lift</label>`)}
  ${section('Parking & arrival', `
    <div class="row"><label>Parking<select data-bind="brief.parking.type">${[['open', 'Open to sky'], ['garage', 'Built garage'], ['stilt', 'Stilt'], ['none', 'None']].map(([k, l]) => `<option value="${k}" ${b.parking.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Cars${num('brief.parking.cars', b.parking.cars, 'min="0" max="6"')}</label></div>
    <label class="check"><input type="checkbox" data-bind="brief.separatePedestrianGate" ${b.separatePedestrianGate ? 'checked' : ''}> Separate pedestrian gate</label>
    <div class="radios">${[['subtle', 'Subtle', 'recessed, indirect, screened threshold'], ['grand', 'Grand', 'arrival court, wider approach, axial procession'], ['imposing', 'Imposing', 'strong frontal axis, dominant entrance']].map(([k, l, d]) => `<label class="radio ${b.entryCharacter === k ? 'on' : ''}"><input type="radio" name="entry" data-bind="brief.entryCharacter" value="${k}" ${b.entryCharacter === k ? 'checked' : ''}><b>${l}</b><span>${d}</span></label>`).join('')}</div>`)}
  ${section('Open spaces wanted', `<div class="opens">${OPEN_SPACE_TYPES.map((o) => {
    const cur = b.openSpaces.find((x) => x.type === o.key);
    return `<label class="check"><input type="checkbox" data-action="toggle-open" data-k="${o.key}" ${cur ? 'checked' : ''}> ${o.label}${cur ? `<input type="number" class="tiny" data-open-area="${o.key}" value="${cur.area || o.area}"> m²` : ''}</label>`;
  }).join('')}</div><p class="hint">Open spaces are programme, not leftovers: the footprint stage scores options on whether they deliver them.</p>`)}
  ${section('Design intent', `
    <textarea id="intent-text" rows="5" data-draft="intent">${esc(drafts.intent ?? p.intent.text)}</textarea>
    <button class="btn sm" data-action="read-intent">Read the intent</button>
    ${interp.length ? `<div class="interp">${interp.map((x) => `<span class="pill">${esc(x.label)} ↑ <em>“${esc(x.phrases.join('”, “'))}”</em></span>`).join('')}</div>` : ''}
    <p class="hint">Priorities weight the scoring of every option. They never override hard constraints (site, setbacks, trees, FSI, locks).</p>
    <div class="prios">${PRIORITIES.map((pr) => `<label class="prio" title="${esc(pr.hint)}"><span>${esc(pr.label)}</span><input type="range" min="0" max="3" step="0.5" data-bind="intent.priorities.${pr.key}" data-type="number" value="${p.intent.priorities[pr.key] ?? 1}"><b>${p.intent.priorities[pr.key] ?? 1}</b></label>`).join('')}</div>`)}
  ${acceptBar('brief', 'Accept brief')}`;
}

// 01 SITE -----------------------------------------------------------------------------------------
function panelSite(p, ui) {
  const A = getAnalysis(p);
  const d = (k, v) => esc(drafts[`layer:${k}`] ?? v);
  const editor = (k, title, value, help, open = false) => section(title, `<textarea rows="${Math.min(8, Math.max(3, value.split('\n').length + 1))}" data-draft="layer:${k}" spellcheck="false">${d(k, value)}</textarea>
    <div class="row-btn"><span class="hint">${help}</span><button class="btn sm" data-action="apply-layer" data-k="${k}">Apply</button></div>${drafts[`err:${k}`] ? messages({ errors: drafts[`err:${k}`] }) : ''}`, { open });
  const roads = A.ok ? `<table class="grid-t"><tr><th>Edge</th><th>Length</th><th>Faces</th><th>Road width</th><th>Name</th></tr>${p.site.boundary.map((_, i) => {
    const e = A.edges.find((x) => x.user === i);
    const r = p.site.roads.find((x) => x.edge === i);
    return `<tr><td>e${i + 1}</td><td>${e ? round(e.length, 1) : ''} m</td><td>${e ? e.facing : ''}</td><td><input type="number" class="tiny" data-road-w="${i}" value="${r ? r.width : ''}" placeholder="—" step="0.5"></td><td><input type="text" class="sm" data-road-n="${i}" value="${esc(r ? r.name : '')}"></td></tr>`;
  }).join('')}</table><p class="hint">Frontage = edge on the widest road (prototype rule). It takes the ${p.regulations.frontSetback} m front setback.</p>` : '';
  const reg = p.regulations;
  return `${stageHead('01', 'Site & analysis', 'Manually entered Cartesian data in metres. The analysis is computed, never estimated.')}
  ${messages({ errors: A.errors || [], warnings: A.warnings || [], notes: A.notes || [] })}
  ${A.ok ? section('Site summary', kv(siteSummary(A))) : ''}
  ${section('Influence fields', `<p class="hint">The plot as a set of spatial fields the generators score against.</p><div class="chips wrap">${['none', ...Object.keys(FIELD_INFO)].map((k) => `<button class="chip ${(ui.layers.field || 'none') === k ? 'on' : ''}" data-action="field" data-k="${k}">${k === 'none' ? 'off' : FIELD_INFO[k].label}</button>`).join('')}</div>${ui.layers.field ? `<p class="hint">${esc(FIELD_INFO[ui.layers.field].note)}</p>` : ''}`, { open: false })}
  ${editor('boundary', 'Site boundary', P.fmtBoundary(p.site.boundary), 'One corner per line: x, y (or the original “(x,y,0);(…)”).', !A.ok)}
  ${section('Roads', roads || '<p class="hint">Define the boundary first.</p>', { open: false })}
  ${editor('trees', 'Existing trees', P.fmtTrees(p.site.trees), 'x, y, canopy radius, height, species')}
  ${editor('buildings', 'Context buildings', P.fmtBuildings(p.site.buildings), 'x,y corners | height | use')}
  ${editor('winds', 'Wind', P.fmtWinds(p.site.winds), 'x1,y1 -> x2,y2, label (first = prevailing)')}
  ${editor('noise', 'Noise sources', P.fmtPointRadius(p.site.noise), 'x, y, radius, label')}
  ${editor('views', 'Views', P.fmtViews(p.site.views), 'x1,y1 -> x2,y2, desirable|undesirable, label')}
  ${editor('privacy', 'Privacy concerns', P.fmtPointRadius(p.site.privacy), 'x, y, radius, label')}
  ${section('Regulations & orientation', `<p class="hint">${esc(REGULATION_PACKAGE.status)}</p>
    <div class="row"><label>FSI${num('regulations.fsi', reg.fsi, 'step="0.1"')}</label><label>Max height (m)${num('regulations.maxHeight', reg.maxHeight)}</label></div>
    <div class="row"><label>Front setback (m)${num('regulations.frontSetback', reg.frontSetback, 'step="0.5"')}</label><label>Other setbacks (m)${num('regulations.otherSetback', reg.otherSetback, 'step="0.5"')}</label></div>
    <div class="row"><label>Floor height (m)${num('regulations.floorHeight', reg.floorHeight, 'step="0.1"')}</label><label>North (° from +y)${num('location.northDeg', p.location.northDeg, 'step="1"')}</label></div>
    <div class="row"><label>Latitude${num('location.lat', p.location.lat, 'step="0.01"')}</label><label>Driving side<select data-bind="location.drivingSide"><option value="left" ${p.location.drivingSide === 'left' ? 'selected' : ''}>left</option><option value="right" ${p.location.drivingSide === 'right' ? 'selected' : ''}>right</option></select></label></div>
    <label class="check"><input type="checkbox" data-bind="regulations.allRoadEdgesAreFront" ${reg.allRoadEdgesAreFront ? 'checked' : ''}> Treat every road edge as a front (corner plots)</label>
    <ul class="notes">${Object.values(REGULATION_NOTES).map((n) => `<li><b>${esc(n.label)}</b> <span class="tag k-${n.kind}">${n.kind}</span> ${esc(n.note)}</li>`).join('')}</ul>`, { open: false })}
  ${acceptBar('site', 'Accept site analysis', !A.ok)}`;
}

// 02 TREES ----------------------------------------------------------------------------------------
function panelTrees(p) {
  const A = getAnalysis(p);
  if (!A.ok) return `${stageHead('02', 'Tree decisions', '')}<div class="msg warn">Define a valid site first.</div>`;
  const pres = preservedSet(p);
  const inside = A.trees.filter((t) => t.inside);
  const lost = sum(inside.filter((t) => pres.has(t.id)), (t) => t.cost);
  const cards = inside.map((t) => {
    const keep = pres.has(t.id);
    const share = A.setbackArea ? t.cost / A.setbackArea : 0;
    const note = t.cost < 3 ? 'Sits in a setback or edge zone — preserving it costs almost nothing buildable.'
      : share > 0.12 ? `Preserving it removes ${round(t.cost, 1)} m² (${Math.round(share * 100)}%) of the buildable area. The house will have to organise itself around it — a constraint and an opportunity.`
        : `Preserving it removes ${round(t.cost, 1)} m² of buildable area.`;
    return `<div class="tree ${keep ? '' : 'removed'}"><div class="tree-h"><b>${t.id}</b> ${esc(t.species || 'Tree')} <span class="muted">canopy r ${t.r} m · ${t.h} m tall · square ${round(t.side, 1)} m</span></div>
      <p class="hint">${note}</p>
      <div class="seg"><button class="${keep ? 'on' : ''}" data-action="tree" data-id="${t.id}" data-v="preserve">Preserve</button><button class="${!keep ? 'on' : ''}" data-action="tree" data-id="${t.id}" data-v="remove">Remove</button></div></div>`;
  }).join('');
  return `${stageHead('02', 'Tree decisions', 'The system never removes a tree on its own. Each preserved tree reserves its canopy square plus 1.5 m (spec V1 rule).')}
  ${kv([['Area within setbacks', `${round(A.setbackArea, 1)} m²`], ['Reserved for preserved trees', `≈ ${round(lost, 1)} m²`], ['Trees on site', `${inside.length} (${pres.size} preserved)`]])}
  <p class="hint">Trees can also anchor the design: footprint options include courtyards and wings that wrap preserved trees.</p>
  ${cards || '<p class="hint">No trees inside the plot.</p>'}
  ${acceptBar('trees', 'Confirm tree decisions')}`;
}

// 03 ACCESS ---------------------------------------------------------------------------------------
function panelAccess(p, ui) {
  const st = p.stages.access, b = p.brief;
  const opts = st.options || [];
  const labels = { efficiency: 'Paving economy', buildable: 'Buildable kept', trees: 'Tree roots', safety: 'Junction safety', character: 'Entry character', frontage: 'Free frontage' };
  return `${stageHead('03', 'Access & parking', 'Gates, the vehicular path and its 4 m reserved corridor (path ± 2 m), parking and the pedestrian approach.')}
  ${section('Settings', `<div class="row"><label>Parking<select data-bind="brief.parking.type">${[['open', 'Open to sky'], ['garage', 'Built garage'], ['stilt', 'Stilt'], ['none', 'None']].map(([k, l]) => `<option value="${k}" ${b.parking.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Cars${num('brief.parking.cars', b.parking.cars, 'min="0" max="6"')}</label></div>
    <div class="row"><label>Entry character<select data-bind="brief.entryCharacter">${['subtle', 'grand', 'imposing'].map((k) => `<option ${b.entryCharacter === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label><label class="check"><input type="checkbox" data-bind="brief.separatePedestrianGate" ${b.separatePedestrianGate ? 'checked' : ''}> pedestrian gate</label></div>
    <p class="hint">Traffic flow is evaluated for ${p.location.drivingSide}-hand driving and each road's direction — not a fixed “entry left of exit” rule.</p>`, { open: !opts.length })}
  <div class="row-btn"><button class="btn" data-action="gen-access">${opts.length ? 'Regenerate options' : 'Generate access options'}</button></div>
  ${st.note ? `<div class="msg warn">${esc(st.note)}</div>` : ''}
  <div class="opts">${opts.map((o) => optionCard(o, { stage: 'access', selected: o.id === st.selectedId, labels, thumb: thumbFor(p, 'access', o) })).join('')}</div>
  ${acceptBar('access', 'Accept access', !st.selectedId)}`;
}

function thumbFor(p, stage, o, floor = 0) {
  const sc = drawScene(p, { stage, layers: { grid: false, labels: false, context: false }, override: { [stage]: o }, thumb: true, floor });
  return thumbSVG(sc);
}

// 04 FOOTPRINT ------------------------------------------------------------------------------------
function panelFootprint(p) {
  const st = p.stages.footprint;
  const opts = st.options || [];
  const T = targets(p);
  const masks = getMasks(p);
  const avail = masks ? round(sum(Array.from(masks.buildable), (x) => x) * DESIGN.cell ** 2, 0) : 0;
  const z = getZoning(p);
  const keys = ['privacy', 'trees', 'court', 'ventilation', 'solar', 'garden', 'views', 'noise', 'compactness', 'arrival', 'fit'];
  return `${stageHead('04', 'Footprint & zoning', 'Where the mass, the open spaces and the public-to-private gradient go. Options come from different architectural families and are scored on explicit components weighted by your intent.')}
  ${!selected(p, 'access') ? '<div class="msg warn">Accept an access option first.</div>' : ''}
  ${kv([['Target footprint per floor', `${round(T.target, 0)} m² (${p.brief.targetBUA} m² over ${T.resFloors} residential floor${T.resFloors > 1 ? 's' : ''})`], ['Buildable after trees & drive', `${avail} m²`], ['Courtyard asked', T.courtArea ? `${T.courtArea} m²` : '—']])}
  <div class="row-btn"><button class="btn" data-action="gen-footprint" ${selected(p, 'access') ? '' : 'disabled'}>${opts.length ? 'Regenerate' : 'Generate footprint options'}</button>${opts.length ? '<button class="btn ghost" data-action="more-footprint">Three more</button>' : ''}</div>
  ${st.reason ? `<div class="msg err">${esc(st.reason)}</div>` : ''}
  ${(st.sharedNotes || []).length ? `<div class="msg note"><b>Common to all options:</b> ${st.sharedNotes.map(esc).join(' ')}</div>` : ''}
  <div class="opts">${opts.map((o) => optionCard(o, { stage: 'footprint', selected: o.id === st.selectedId, labels: SCORE_LABEL, keys, thumb: thumbFor(p, 'footprint', o), extra: `<p class="fam">${esc(FAMILY_LABEL[o.family])} · ${o.metrics.area} m² · wings ~${o.metrics.wingDepth} m · perimeter ${o.metrics.perimeter} m</p>` })).join('')}</div>
  ${z && st.selectedId ? section('Zoning of the selected option', `<p class="hint">Public → private by walking depth from the entrance and exposure to the street.</p>${kv(z.spaces.map((s) => [s.kind.replace('-', ' '), `${Math.round(s.area)} m²`]))}`) : ''}
  ${acceptBar('footprint', 'Accept footprint', !st.selectedId)}`;
}

// 05 PROGRAMME ------------------------------------------------------------------------------------
function ensureProgramme(p) {
  if (p.stages.programme.spaces) return;
  update((pp) => {
    let spaces = defaultProgramme(pp.brief);
    const settings = { circulationPct: DESIGN.circulationPct, wallPct: DESIGN.wallPct, mode: 'auto', openness: 'semi' };
    const B = budget(spaces, settings, pp.brief, getAnalysis(pp));
    spaces = autoBalance(spaces, B.netTarget);
    pp.stages.programme = { ...pp.stages.programme, spaces, settings, relations: [], prefsText: '', prefsItems: [], status: 'draft' };
    refreshFloorsAndRelations(pp);
  });
}
function programmeFacts(p) {
  const prog = p.stages.programme;
  const A = getAnalysis(p);
  const fp = selected(p, 'footprint');
  const B = budget(prog.spaces, prog.settings, p.brief, A);
  const n = p.brief.floors;
  const stilt = p.brief.parking?.type === 'stilt';
  const caps = fp ? floorCapacities(fp.metrics.area, n, p.brief, prog.settings, stilt) : null;
  const loads = floorLoads(prog.spaces, n);
  const v = validateProgramme(prog.spaces, B, p.brief, A, loads, caps);
  return { B, caps, loads, v };
}
function refreshFloorsAndRelations(pp) {
  const prog = pp.stages.programme;
  const fp = selected(pp, 'footprint');
  const n = pp.brief.floors;
  const caps = fp ? floorCapacities(fp.metrics.area, n, pp.brief, prog.settings, pp.brief.parking?.type === 'stilt') : new Array(n).fill(Infinity);
  prog.spaces = assignFloors(prog.spaces, n, caps, { stilt: pp.brief.parking?.type === 'stilt' });
  const userRels = (prog.relations || []).filter((r) => r.source !== 'rule');
  const removed = new Set(prog.removedRules || []);
  const rules = defaultRelations(prog.spaces, anchorsFor(pp)).filter((r) => !removed.has(`${r.a}|${r.b}`));
  const key = (r) => [r.a, r.b].sort().join('|');
  const userKeys = new Set(userRels.map(key));
  prog.relations = [...rules.filter((r) => !userKeys.has(key(r))), ...userRels];
}

function panelProgramme(p) {
  if (!p.stages.programme.spaces) { setTimeout(() => ensureProgramme(store.project), 0); return stageHead('05', 'Programme & areas', 'Preparing the default programme…'); }
  const prog = p.stages.programme;
  const { B, caps, loads, v } = programmeFacts(p);
  const items = drafts.prefsItems || prog.prefsItems || [];
  const nameOf = (id) => (id.startsWith('@') ? id.slice(1) : (prog.spaces.find((s) => s.id === id) || {}).name || id);
  const rels = prog.relations || [];
  return `${stageHead('05', 'Programme & area statement', 'Rooms, areas and floors — deterministic arithmetic. Gross area = rooms + circulation + walls + stair/lift core.')}
  ${!selected(p, 'footprint') ? '<div class="msg warn">Accept a footprint first so floor capacities are known.</div>' : ''}
  ${section('Area budget', `${kv([
    ['Net programme', `${round(B.net, 1)} m²`], [`Circulation ${Math.round(B.c * 100)}%`, `${round(B.circulation, 1)} m²`], [`Walls & structure ${Math.round(B.w * 100)}%`, `${round(B.walls, 1)} m²`],
    ['Stair / lift core', `${round(B.core.total, 1)} m²`], ['Gross built-up area', `${round(B.gross, 1)} m² · ${fmtFt2(B.gross)}`], ['Target', `${round(B.target, 0)} m²`], ['FSI maximum', `${round(B.maxBUA, 0)} m²`],
  ])}
  <div class="row"><label>Circulation %<input type="number" data-bind="stages.programme.settings.circulationPct" data-type="pct" value="${Math.round(B.c * 100)}"></label><label>Walls %<input type="number" data-bind="stages.programme.settings.wallPct" data-type="pct" value="${Math.round(B.w * 100)}"></label></div>
  <div class="seg"><button class="${prog.settings.mode === 'manual' ? 'on' : ''}" data-action="prog-mode" data-v="manual">Manual</button><button class="${prog.settings.mode !== 'manual' ? 'on' : ''}" data-action="prog-mode" data-v="auto">Auto-balance</button></div>
  <p class="hint">${prog.settings.mode === 'manual' ? `Manual: editing a room changes nothing else. Remaining net budget: ${round(B.remainingNet, 1)} m².` : 'Auto-balance: editing a room locks it and rebalances the unlocked rooms within their min–max range.'}</p>
  <button class="btn sm" data-action="fit-target">Fit unlocked rooms to the target</button>`)}
  ${caps ? section('Floors', loads.map((L, f) => {
    const cap = caps[f] || 1, r = Math.min(1.3, L / cap);
    return `<div class="floorbar"><span>${floorName(f)}</span><span class="bt"><i class="${L > cap * 1.05 ? 'over' : ''}" style="width:${Math.min(100, r * 77)}%"></i><em style="left:77%"></em></span><span class="mono">${round(L, 0)} / ${round(cap, 0)} m²</span></div>`;
  }).join('') + '<p class="hint">Net room area per floor against what the chosen footprint holds after circulation, walls and core. Floors are assigned automatically unless you set one in the table.</p><button class="btn sm" data-action="reassign-floors">Re-assign floors automatically</button>') : ''}
  ${messages({ errors: v.errors, warnings: v.warnings, ok: v.ok })}
  ${section('Add a space', `<div class="row"><select id="add-type">${SPACE_LIBRARY.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select><button class="btn sm" data-action="add-space">Add</button></div><p class="hint">${esc(MIN_STANDARDS_NOTE)}</p>`, { open: false })}
  ${section('Spatial preferences', `<textarea rows="4" data-draft="prefs" placeholder="e.g. Formal living close to the foyer but visually separated from family spaces. Dining should connect to the courtyard and kitchen. Master bedroom with maximum privacy and the best garden view.">${esc(drafts.prefs ?? prog.prefsText ?? '')}</textarea>
    <button class="btn sm" data-action="read-prefs">Interpret</button>
    ${items.length ? `<div class="interp">${items.map((it, i) => `<span class="pill ${it.ambiguous ? 'amb' : ''}" title="${esc(it.phrase)}">${esc(describeItem(it, nameOf))}<button class="x" data-action="drop-pref" data-i="${i}">×</button></span>`).join('')}</div><button class="btn sm" data-action="apply-prefs">Apply ${items.length} interpreted item${items.length > 1 ? 's' : ''}</button>` : ''}
    ${(drafts.prefsUnread || []).length ? `<div class="msg note">Not understood: “${drafts.prefsUnread.map(esc).join('”, “')}”. Rephrase or add the relationship below.</div>` : ''}
    <p class="hint">Rule-based interpretation: every item is shown before anything is applied.</p>`, { open: true })}
  ${section(`Relationships (${rels.length})`, `<div class="rels">${rels.map((r) => `<div class="rel src-${r.source}"><span>${esc(nameOf(r.a))}</span><select data-rel="${r.id}" data-f="type">${Object.entries(REL_TYPES).map(([k, t]) => `<option value="${k}" ${r.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select><span>${esc(nameOf(r.b))}</span><select data-rel="${r.id}" data-f="strength">${[1, 2, 3].map((s) => `<option value="${s}" ${r.strength === s ? 'selected' : ''}>${STRENGTH_LABEL[s]}</option>`).join('')}</select><span class="src" title="${esc(r.note || '')}">${r.source}</span><button class="x" data-action="drop-rel" data-id="${r.id}">×</button></div>`).join('')}</div>
    <div class="row"><select id="rel-a">${relOptions(prog)}</select><select id="rel-t">${Object.entries(REL_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select><select id="rel-b">${relOptions(prog, true)}</select><button class="btn sm" data-action="add-rel">Add</button></div>
    <p class="hint">Defaults are heuristics (source “rule”), not laws. Edit or delete any of them.</p>`, { open: false })}
  ${section('Openness', `<div class="seg">${[['open', 'Open plan'], ['semi', 'Semi-open'], ['enclosed', 'Enclosed']].map(([k, l]) => `<button class="${(prog.settings.openness || 'semi') === k ? 'on' : ''}" data-action="openness" data-v="${k}">${l}</button>`).join('')}</div><p class="hint">How living, dining, family and kitchen relate in the plan: one volume, partly divided, or separate rooms.</p>`, { open: false })}
  ${acceptBar('programme', 'Accept programme', v.errors.length > 0 || !selected(p, 'footprint'))}`;
}
const relOptions = (prog, anchors = false) => prog.spaces.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') + (anchors ? ['@courtyard', '@garden', '@service-yard', '@stair'].map((a) => `<option value="${a}">${a.slice(1)}</option>`).join('') : '');
function describeItem(it, nameOf) {
  if (it.kind === 'relation') return `${nameOf(it.a)} ${REL_TYPES[it.type].label} ${nameOf(it.b)}`;
  if (it.kind === 'attr') return `${nameOf(it.id)}: ${it.attr === 'dh' ? 'double height' : it.attr === 'view' ? 'best views' : it.attr === 'noise' ? 'quiet' : 'high privacy'}`;
  if (it.kind === 'floor') return `${nameOf(it.id)} on ${it.floor === 0 ? 'ground' : it.floor === 'top' ? 'top floor' : 'first floor'}`;
  if (it.kind === 'open') return `${nameOf(it.a)} open to ${nameOf(it.b)}`;
  if (it.kind === 'area') return `${nameOf(it.id)} ${it.abs ? `${it.abs} m²` : it.rel > 1 ? 'larger' : 'smaller'}`;
  return it.kind;
}

function renderProgrammeTable(p) {
  const el = $('#table');
  if (!p.stages.programme.spaces) { el.innerHTML = '<p class="hint pad">Preparing…</p>'; return; }
  const prog = p.stages.programme;
  const n = p.brief.floors;
  const rows = [...prog.spaces].sort((a, b) => (a.floorAuto ?? 0) - (b.floorAuto ?? 0) || (ZONES[zoneOf(a)]?.rank ?? 0) - (ZONES[zoneOf(b)]?.rank ?? 0));
  const tot = sum(prog.spaces, (s) => s.area);
  el.innerHTML = `<table class="area-t"><thead><tr><th>#</th><th>Space</th><th>Zone</th><th>Floor</th><th class="r">Min</th><th class="r">Rec.</th><th class="r">Max</th><th class="r">Area m²</th><th class="r">ft²</th><th title="Area lock">Lock</th><th title="Double height">DH</th><th></th></tr></thead><tbody>
  ${rows.map((s, i) => {
    const L = LIB[s.type] || LIB.custom;
    const z = zoneOf(s);
    const low = s.area < L.min - 1e-6 && !s.customName;
    return `<tr class="${s.parent ? 'child' : ''}"><td class="mono">${i + 1}</td><td>${s.parent ? '↳ ' : ''}<input type="text" class="name" data-space="${s.id}" data-f="name" value="${esc(s.name)}"></td>
      <td><span class="zone" style="--z:${(ZONES[z] || ZONES['semi-private']).color}">${esc((ZONES[z] || {}).label || z)}</span></td>
      <td><select data-space="${s.id}" data-f="floor" ${s.parent ? 'disabled' : ''}><option value="">auto · ${floorShort(s.floorAuto ?? 0)}</option>${Array.from({ length: n }, (_, f) => `<option value="${f}" ${s.floor === f ? 'selected' : ''}>${floorShort(f)}</option>`).join('')}</select></td>
      <td class="r mono">${L.min}</td><td class="r mono">${L.rec}</td><td class="r mono">${L.max}</td>
      <td class="r"><input type="number" class="area ${low ? 'low' : ''}" step="0.5" data-space="${s.id}" data-f="area" value="${s.area}"></td><td class="r mono">${Math.round(s.area * M2_TO_FT2)}</td>
      <td class="c"><input type="checkbox" data-space="${s.id}" data-f="locked" ${s.locked ? 'checked' : ''}></td>
      <td class="c">${L.dh ? `<input type="checkbox" data-space="${s.id}" data-f="dh" ${s.dh ? 'checked' : ''}>` : ''}</td>
      <td><button class="x" data-action="drop-space" data-id="${s.id}" title="Remove">×</button></td></tr>`;
  }).join('')}</tbody><tfoot><tr><td></td><td>Net programme</td><td></td><td></td><td></td><td></td><td></td><td class="r mono">${round(tot, 1)}</td><td class="r mono">${Math.round(tot * M2_TO_FT2)}</td><td colspan="3"></td></tr></tfoot></table>`;
}

// 06 BUBBLES --------------------------------------------------------------------------------------
function panelBubbles(p, ui) {
  const st = p.stages.bubbles;
  const opts = st.options || [];
  const X = getBubbleCtx(p);
  const cur = st.current;
  const labels = { adjacency: 'Adjacency', separation: 'Separation', gradient: 'Privacy gradient', noise: 'Quiet', privacy: 'Privacy', views: 'Views', court: 'Court/garden life', fit: 'Fit' };
  const sel = ui.selected && X ? X.spaces.find((s) => s.id === ui.selected) : null;
  const pins = st.pins || {};
  const cmds = drafts.revCmds || [];
  const nameOf = (id) => (id.startsWith('@') ? id.slice(1).replace('-', ' ') : (X?.spaces.find((s) => s.id === id) || {}).name || id);
  const missing = (c) => [c.a, c.b, ...(c.ids || [])].filter(Boolean).filter((id) => id.startsWith('@') && id !== '@stair' && X && !X.distTo[id]);
  return `${stageHead('06', 'Spatial organisation', 'Bubble diagrams: area-true ellipses placed by adjacency, the site fields and one of three spatial strategies. Drag a bubble to move it; pin what is right; describe changes in words.')}
  ${!X ? '<div class="msg warn">Accept the programme first.</div>' : ''}
  <div class="row-btn"><button class="btn" data-action="gen-bubbles" ${X ? '' : 'disabled'}>${opts.length ? 'Regenerate (pins kept)' : 'Generate three organisations'}</button>${opts.length ? '<button class="btn ghost" data-action="more-bubbles">Three more</button>' : ''}</div>
  <div class="opts">${opts.map((o) => optionCard(o, { stage: 'bubbles', selected: o.id === st.selectedId, labels, thumb: thumbFor(p, 'bubbles', o) })).join('')}</div>
  ${cur ? section('Selected design', `${kv([['Strategy', STRATEGIES[cur.strategy]?.title || cur.strategy], ['Version', cur.version || '—'], ['Pinned', Object.keys(pins).length ? Object.keys(pins).map(nameOf).join(', ') : 'nothing pinned']])}
    ${sel ? `<div class="insp"><b>${esc(sel.name)}</b> · ${round(sel.area, 1)} m² · ${esc(ZONES[zoneOf(sel)]?.label || '')} · ${floorName(sel.floorAuto ?? 0)}
      <div class="row-btn"><button class="btn sm" data-action="pin" data-id="${sel.id}">${pins[sel.id] ? 'Unpin' : 'Pin position'}</button></div></div>` : '<p class="hint">Click a bubble to inspect or pin it.</p>'}`) : ''}
  ${cur ? section('Revise with words', `<textarea rows="3" data-draft="revision" placeholder="e.g. Move the kitchen closer to the service yard but keep the courtyard and master bedroom unchanged.">${esc(drafts.revision || '')}</textarea>
    <button class="btn sm" data-action="read-revision">Interpret</button>
    ${cmds.length ? `<div class="interp">${cmds.map((c, i) => `<span class="pill ${missing(c).length ? 'amb' : ''}" title="${esc(c.phrase)}">${esc(describeCmd(c, nameOf))}${missing(c).length ? ` — no ${missing(c).map((m) => m.slice(1)).join(', ')} in this design` : ''}<button class="x" data-action="drop-cmd" data-i="${i}">×</button></span>`).join('')}</div><button class="btn sm primary" data-action="apply-revision">Apply to the selected design</button>` : ''}
    ${(drafts.revUnread || []).length ? `<div class="msg note">Not understood: “${drafts.revUnread.map(esc).join('”, “')}”.</div>` : ''}
    <p class="hint">Revisions modify the selected design from where it is — they never swap it for an unrelated layout.</p>
    ${(cur.revisions || []).length ? `<ol class="revlog">${cur.revisions.map((r) => `<li><b>${esc(r.v)}</b> ${esc(r.text)}<br><span class="muted">${esc(r.summary)}</span></li>`).join('')}</ol>` : ''}`) : ''}
  ${acceptBar('bubbles', 'Accept spatial organisation', !cur)}`;
}

// 07 PLANS ----------------------------------------------------------------------------------------
function panelPlan(p, ui) {
  const st = p.stages.plan;
  const plans = getPlans(p);
  if (plans && !st.options) setTimeout(() => update((pp) => { pp.stages.plan = { ...pp.stages.plan, options: plans.map(planSummary), selectedId: (plans.find((x) => x.recommended) || plans[0]).id, status: 'options', basis: bases(pp).plan, generatedAt: Date.now() }; }), 0);
  const pl = plans ? plans.find((x) => x.id === st.selectedId) || plans[0] : null;
  const labels = { access: 'Access', areas: 'Area accuracy', circulation: 'Circulation economy', proportion: 'Room proportions' };
  const rows = pl ? pl.floors.flatMap((fl) => fl.regions.filter((r) => r.kind === 'room').map((r) => [fl.f, r])) : [];
  return `${stageHead('07', 'Single-line plans', 'Rooms sliced from the footprint wings in the order of the accepted bubbles: walls as thick lines, open partitions dotted, one plan per floor.')}
  ${!plans ? '<div class="msg warn">Accept a spatial organisation first.</div>' : ''}
  <div class="opts">${(plans || []).map((o) => optionCard(o, { stage: 'plan', selected: o.id === (pl && pl.id), labels, thumb: thumbFor(p, 'plan', o, ui.floor) })).join('')}</div>
  ${pl && pl.issues.length ? section(`Planning issues (${pl.issues.length})`, `<ul class="issues">${pl.issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p class="hint">Issues are reported, not hidden. Revise the bubbles (move, pin, re-floor) or the footprint, then regenerate.</p>`) : ''}
  ${pl ? section('Areas — programme vs plan', `<table class="grid-t"><tr><th>Floor</th><th>Room</th><th class="r">Target</th><th class="r">Plan</th><th class="r">Δ</th></tr>${rows.map(([f, r]) => {
    const d = r.area - r.target;
    return `<tr><td>${floorShort(f)}</td><td>${esc(r.name)}</td><td class="r mono">${round(r.target, 1)}</td><td class="r mono">${round(r.area, 1)}</td><td class="r mono ${Math.abs(d) > 0.2 * r.target ? 'bad' : ''}">${d > 0 ? '+' : ''}${round(d, 1)}</td></tr>`;
  }).join('')}</table><p class="hint">Plan gross (enclosed): ${pl.metrics.gross} m² · corridors & halls ${pl.metrics.corridor} m².</p>`, { open: false }) : ''}
  ${acceptBar('plan', 'Accept plans', !pl)}`;
}
const planSummary = (pl) => ({ id: pl.id, title: pl.title, variant: pl.variant, total: pl.total, scores: pl.scores });

// 08 RECORD ---------------------------------------------------------------------------------------
function panelRecord(p) {
  const accepted = STAGES.filter((s) => p.stages[s.key]?.status === 'accepted');
  return `${stageHead('08', 'Design record', 'The process is an output: every decision, the options considered and why.')}
  ${kv([['Iterations recorded', String(p.history.length)], ['Stages accepted', accepted.map((s) => s.short).join(', ') || '—']])}
  <div class="col-btn">
    <button class="btn primary" data-action="sheets">Open output sheets</button>
    <button class="btn" data-action="export-json">Export project (.json)</button>
    <button class="btn" data-action="export-svg">Download current drawing (.svg)</button>
    <label class="btn file">Import project<input type="file" accept=".json,application/json" data-action="import"></label>
    <button class="btn ghost" data-action="reset-sample">Reload benchmark project</button>
    <button class="btn ghost" data-action="reset-new">Start an empty project</button>
  </div>
  <p class="hint">Projects are saved in this browser only. Export to keep or share a copy.</p>`;
}

function renderRecordMain(p) {
  const el = $('#record');
  const items = [...p.history].reverse();
  el.innerHTML = `<div class="trace"><h3>Decision trace</h3>${traceHTML(p)}</div><div class="hist"><h3>Design evolution</h3>${items.map((h) => {
    const st = STAGES.find((s) => s.key === h.stage);
    const isHead = p.head === h.id;
    let th = '';
    if (h.snapshot && ['footprint', 'bubbles', 'plan', 'access', 'site', 'trees'].includes(h.stage)) {
      try { th = thumbSVG(drawScene(h.snapshot, { stage: h.stage === 'plan' ? 'plan' : h.stage, thumb: true, layers: { grid: false, labels: false, context: false } }), 'hthumb'); } catch { th = ''; }
    }
    return `<div class="h ${isHead ? 'is-head' : ''}"><div class="h-thumb">${th}</div><div class="h-body"><div class="h-top"><b>${esc(h.v)}</b> <span class="tag">${esc(st ? st.short : h.stage)}</span> <span class="muted">${new Date(h.t).toLocaleString()}</span>${isHead ? ' <span class="tag rec">current</span>' : ''}</div>
      <div class="h-title">${esc(h.title)}</div>${h.prompt ? `<div class="h-prompt">“${esc(h.prompt)}”</div>` : ''}${h.explanation ? `<div class="h-exp">${esc(h.explanation)}</div>` : ''}
      ${h.options?.length ? `<div class="h-opts">Options: ${h.options.map((o) => `<span class="${o.id === h.selected ? 'sel' : ''}">${esc(o.id)} ${esc(o.title)}${o.total != null ? ` (${Math.round(o.total * 100)})` : ''}</span>`).join(' · ')}</div>` : ''}
      ${h.changed?.length ? `<div class="h-ch">Changed: ${esc(h.changed.join(', '))}</div>` : ''}
      ${h.snapshot && !isHead ? `<button class="btn sm ghost" data-action="restore" data-id="${h.id}">Branch from here</button>` : ''}</div></div>`;
  }).join('')}</div>`;
}

export function traceHTML(p) {
  const out = [];
  const A = getAnalysis(p);
  if (p.intent.text) out.push(['Intent', p.intent.text]);
  const pr = Object.entries(p.intent.priorities).filter(([, v]) => v >= 1.5).map(([k]) => PRIORITIES.find((x) => x.key === k)?.label).filter(Boolean);
  if (pr.length) out.push(['Priorities', listJoin(pr)]);
  if (A.ok) {
    const pres = preservedSet(p), rem = A.trees.filter((t) => t.inside && !pres.has(t.id));
    out.push(['Trees', `${pres.size} preserved${rem.length ? `; removed ${rem.map((t) => t.id).join(', ')}` : ''}`]);
  }
  for (const [stage, label] of [['access', 'Access'], ['footprint', 'Footprint'], ['bubbles', 'Organisation'], ['plan', 'Plan']]) {
    const st = p.stages[stage];
    const o = stage === 'bubbles' ? st?.current : st?.options?.find((x) => x.id === st.selectedId);
    if (!o) continue;
    const others = (st.options || []).filter((x) => x.id !== st.selectedId).map((x) => x.title);
    out.push([label, `${o.title}${st.status === 'accepted' ? ' — accepted' : ' — selected'}${others.length ? `; over ${listJoin(others)}` : ''}${o.pros?.length ? `. ${o.pros[0]}` : ''}`]);
  }
  return `<ol class="trace-l">${out.map(([k, v]) => `<li><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join('<li class="arrow">↓</li>')}</ol>`;
}

// ---------------------------------------------------------------------------------------------
function renderTimeline(p) {
  const items = p.history.slice(-40);
  $('#timeline').innerHTML = `<span class="tl-h">Design evolution</span><div class="tl">${items.map((h) => `<button class="tl-i ${p.head === h.id ? 'is-head' : ''}" data-action="goto-history" data-id="${h.id}" title="${esc(h.title)}"><b>${esc(h.v)}</b><span>${esc(h.title)}</span></button>`).join('<i class="tl-sep"></i>')}</div>`;
  const tl = $('#timeline .tl');
  if (tl) tl.scrollLeft = tl.scrollWidth;
}

// ---------------------------------------------------------------------------------------------
// Event handling
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = val;
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.draft) drafts[t.dataset.draft] = t.value;
  if (t.type === 'range' && t.dataset.bind) { const b = t.parentElement.querySelector('b'); if (b) b.textContent = t.value; }
}

function onChange(e) {
  const t = e.target;
  const p = store.project;
  if (t.id === 'proj-name') { update((pp) => { pp.name = t.value; }); return; }
  if (t.dataset.action === 'import' && t.files?.[0]) {
    t.files[0].text().then((txt) => { try { importProject(txt); toast('Project imported.'); } catch (err) { toast(err.message, 'err'); } });
    return;
  }
  if (t.dataset.bind) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number' || t.dataset.type === 'number') v = Number(v);
    if (t.dataset.type === 'pct') v = Number(t.value) / 100;
    update((pp) => {
      setPath(pp, t.dataset.bind, v);
      if (t.dataset.bind.startsWith('stages.programme.settings') && pp.stages.programme.settings.mode !== 'manual') rebalance(pp);
    });
    return;
  }
  if (t.dataset.openArea) { update((pp) => { const o = pp.brief.openSpaces.find((x) => x.type === t.dataset.openArea); if (o) o.area = Number(t.value); }); return; }
  if (t.dataset.roadW != null || t.dataset.roadN != null) {
    const i = Number(t.dataset.roadW ?? t.dataset.roadN);
    update((pp) => {
      let r = pp.site.roads.find((x) => x.edge === i);
      if (t.dataset.roadW != null) {
        const w = Number(t.value);
        if (!t.value || !(w > 0)) { pp.site.roads = pp.site.roads.filter((x) => x.edge !== i); return; }
        if (!r) { r = { id: `R${pp.site.roads.length + 1}`, edge: i, width: w, name: `Road on e${i + 1}`, oneWay: null }; pp.site.roads.push(r); } else r.width = w;
      } else if (r) r.name = t.value;
    });
    return;
  }
  if (t.dataset.space) {
    const id = t.dataset.space, f = t.dataset.f;
    update((pp) => {
      const prog = pp.stages.programme;
      const s = prog.spaces.find((x) => x.id === id);
      if (!s) return;
      if (f === 'name') { s.name = t.value; s.customName = true; }
      if (f === 'area') { s.area = Math.max(0.5, Number(t.value)); if (prog.settings.mode !== 'manual') { s.locked = true; rebalance(pp, 'current'); } }
      if (f === 'locked') s.locked = t.checked;
      if (f === 'dh') s.dh = t.checked;
      if (f === 'floor') { s.floor = t.value === '' ? null : Number(t.value); for (const ch of prog.spaces.filter((x) => x.parent === id)) ch.floor = s.floor; refreshFloorsAndRelations(pp); }
    });
    return;
  }
  if (t.dataset.rel) {
    update((pp) => {
      const r = pp.stages.programme.relations.find((x) => x.id === t.dataset.rel);
      if (!r) return;
      if (t.dataset.f === 'type') r.type = t.value; else r.strength = Number(t.value);
      r.source = 'user';
    });
  }
}

function rebalance(pp, from = 'rec') {
  const prog = pp.stages.programme;
  const B = budget(prog.spaces, prog.settings, pp.brief, getAnalysis(pp));
  prog.spaces = autoBalance(prog.spaces, B.netTarget, { from });
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT' && el.type === 'file') return;
  const a = el.dataset.action;
  const p = store.project;
  const handlers = {
    goto: () => { drafts = {}; setUI({ stage: el.dataset.stage, selected: null, floor: 0 }); lastCanvasKey = ''; autoGenerate(el.dataset.stage); },
    layer: () => setUI({ layers: { ...store.ui.layers, [el.dataset.k]: !store.ui.layers[el.dataset.k] } }),
    field: () => setUI({ layers: { ...store.ui.layers, field: el.dataset.k === 'none' ? null : el.dataset.k } }),
    floor: () => setUI({ floor: Number(el.dataset.f) }),
    compare: () => setUI({ compare: !store.ui.compare }),
    fit: () => canvas.fit(sceneBounds(p)),
    'toggle-open': () => update((pp) => {
      const k = el.dataset.k;
      const has = pp.brief.openSpaces.some((x) => x.type === k);
      pp.brief.openSpaces = has ? pp.brief.openSpaces.filter((x) => x.type !== k) : [...pp.brief.openSpaces, { type: k, area: OPEN_SPACE_TYPES.find((o) => o.key === k).area }];
    }),
    'read-intent': () => {
      const text = drafts.intent ?? p.intent.text;
      const r = interpretIntent(text);
      update((pp) => {
        pp.intent.text = text;
        pp.intent.interpreted = r.priorities;
        for (const k of Object.keys(pp.intent.priorities)) pp.intent.priorities[k] = 1;
        for (const x of r.priorities) pp.intent.priorities[x.key] = x.weight;
        if (r.entry) pp.brief.entryCharacter = r.entry;
      });
      delete drafts.intent;
      toast(r.priorities.length ? `Read ${r.priorities.length} priorities from the intent — adjust the sliders if they are wrong.` : 'No priorities recognised; set them with the sliders.');
    },
    'apply-layer': () => applyLayer(el.dataset.k),
    tree: () => update((pp) => { pp.decisions.trees[el.dataset.id] = el.dataset.v; }),
    accept: () => accept(el.dataset.stage),
    'gen-access': () => genAccess(),
    'gen-footprint': () => genFootprint(false),
    'more-footprint': () => genFootprint(true),
    'select-option': () => selectOption(el.dataset.stage, el.dataset.id),
    'prog-mode': () => update((pp) => { pp.stages.programme.settings.mode = el.dataset.v; }),
    'fit-target': () => update((pp) => rebalance(pp, 'rec')),
    'reassign-floors': () => update((pp) => { for (const s of pp.stages.programme.spaces) s.floor = null; refreshFloorsAndRelations(pp); }),
    'add-space': () => update((pp) => {
      const type = $('#add-type').value;
      pp.stages.programme.spaces = addSpaceWithSuite(pp.stages.programme.spaces, type);
      if (pp.stages.programme.settings.mode !== 'manual') rebalance(pp, 'current');
      refreshFloorsAndRelations(pp);
    }),
    'drop-space': () => update((pp) => {
      const id = el.dataset.id;
      const prog = pp.stages.programme;
      prog.spaces = renumber(prog.spaces.filter((s) => s.id !== id && s.parent !== id));
      prog.relations = (prog.relations || []).filter((r) => r.a !== id && r.b !== id);
      refreshFloorsAndRelations(pp);
    }),
    'read-prefs': () => {
      const text = drafts.prefs ?? p.stages.programme.prefsText ?? '';
      const r = interpretPreferences(text, p.stages.programme.spaces);
      drafts.prefsItems = r.items; drafts.prefsUnread = r.unread; drafts.prefs = text;
      update((pp) => { pp.stages.programme.prefsText = text; });
    },
    'drop-pref': () => { drafts.prefsItems = (drafts.prefsItems || []).filter((_, i) => i !== Number(el.dataset.i)); renderPanel(store.project, store.ui); },
    'apply-prefs': () => applyPrefs(),
    'drop-rel': () => update((pp) => {
      const prog = pp.stages.programme;
      const r = prog.relations.find((x) => x.id === el.dataset.id);
      if (r && r.source === 'rule') prog.removedRules = [...(prog.removedRules || []), `${r.a}|${r.b}`];
      prog.relations = prog.relations.filter((x) => x.id !== el.dataset.id);
    }),
    'add-rel': () => update((pp) => {
      const a = $('#rel-a').value, b = $('#rel-b').value, type = $('#rel-t').value;
      if (a === b) return;
      pp.stages.programme.relations.push({ id: relId(), a, b, type, strength: 2, source: 'user', note: 'added by the architect' });
    }),
    openness: () => update((pp) => { pp.stages.programme.settings.openness = el.dataset.v; }),
    'gen-bubbles': () => genBubbles(false),
    'more-bubbles': () => genBubbles(true),
    pin: () => togglePin(el.dataset.id),
    'read-revision': () => {
      const X = getBubbleCtx(p);
      const r = interpretRevision(drafts.revision || '', X.spaces);
      drafts.revCmds = r.cmds; drafts.revUnread = r.unread;
      renderPanel(store.project, store.ui);
    },
    'drop-cmd': () => { drafts.revCmds = (drafts.revCmds || []).filter((_, i) => i !== Number(el.dataset.i)); renderPanel(store.project, store.ui); },
    'apply-revision': () => applyRevision(),
    'regen-stale': () => regenStale(),
    sheets: () => openSheets(store.project),
    'export-json': () => download(`${slug(p.name)}.json`, exportProject(), 'application/json'),
    'export-svg': () => download(`${slug(p.name)}-${store.ui.stage}.svg`, svgFile(), 'image/svg+xml'),
    'reset-sample': () => { if (confirm('Replace the current project with the benchmark? Export first if you want to keep it.')) { resetProject('sample'); drafts = {}; } },
    'reset-new': () => { if (confirm('Start an empty project? Export first if you want to keep the current one.')) { resetProject('new'); drafts = {}; setUI({ stage: 'site' }); } },
    restore: () => { restore(el.dataset.id); toast('Restored as a new branch — later iterations stay in the record.'); },
    'goto-history': () => setUI({ stage: 'record' }),
  };
  if (handlers[a]) { e.preventDefault?.(); handlers[a](); }
}

// ---------------------------------------------------------------------------------------------
// Stage actions
function applyLayer(k) {
  const text = drafts[`layer:${k}`];
  if (text == null) { toast('Nothing changed.'); return; }
  const parser = { boundary: P.parseBoundary, trees: P.parseTrees, buildings: P.parseBuildings, noise: P.parseNoise, views: P.parseViews, privacy: P.parsePrivacy, winds: P.parseWinds }[k];
  const r = parser(text);
  if (r.errors.length) { drafts[`err:${k}`] = r.errors; renderPanel(store.project, store.ui); return; }
  delete drafts[`err:${k}`]; delete drafts[`layer:${k}`];
  update((pp) => {
    pp.site[k] = r.value;
    if (k === 'trees') for (const t of r.value) if (!pp.decisions.trees[t.id]) pp.decisions.trees[t.id] = 'preserve';
    if (k === 'boundary') pp.site.roads = pp.site.roads.filter((x) => x.edge < r.value.length);
  });
  lastFit = '';
  toast(`${k[0].toUpperCase()}${k.slice(1)} updated.`);
}

function accept(stage) {
  const p = store.project;
  const b = bases(p);
  const st = p.stages[stage];
  const entry = { stage, action: 'accept' };
  if (stage === 'brief') Object.assign(entry, { title: 'Brief and design intent accepted', explanation: p.intent.text });
  if (stage === 'site') { const A = getAnalysis(p); Object.assign(entry, { title: 'Site analysis accepted', explanation: `${round(A.area, 1)} m² site, ${round(A.setbackArea, 1)} m² within setbacks, frontage on edge ${A.front.user + 1}.` }); }
  if (stage === 'trees') {
    const A = getAnalysis(p), pres = preservedSet(p);
    const rem = A.trees.filter((t) => t.inside && !pres.has(t.id)).map((t) => t.id);
    Object.assign(entry, { title: `Tree decisions: ${pres.size} preserved${rem.length ? `, ${rem.join(', ')} removed` : ''}`, changed: rem, explanation: 'Preserved trees reserve their canopy square + 1.5 m as unbuildable.' });
  }
  if (['access', 'footprint'].includes(stage)) {
    const o = selected(p, stage);
    if (!o) return;
    Object.assign(entry, { title: `${STAGES.find((s) => s.key === stage).short}: option ${o.id} — ${o.title}`, options: st.options.map((x) => ({ id: x.id, title: x.title, total: x.total })), selected: o.id, scores: o.scores, explanation: [o.explanation || o.logic, ...(o.pros || [])].filter(Boolean).join(' ') });
  }
  if (stage === 'programme') { const { B } = programmeFacts(p); Object.assign(entry, { title: `Programme accepted — ${p.stages.programme.spaces.length} spaces, ${round(B.gross)} m² gross`, explanation: `Net ${round(B.net, 1)} m² + circulation, walls and core.` }); }
  if (stage === 'bubbles') { const c = st.current; Object.assign(entry, { title: `Spatial organisation accepted — ${c.title}`, options: (st.options || []).map((x) => ({ id: x.id, title: x.title, total: x.total })), selected: st.selectedId, locked: Object.keys(st.pins || {}), explanation: c.logic }); }
  if (stage === 'plan') {
    const plans = getPlans(p);
    const pl = plans.find((x) => x.id === st.selectedId) || plans[0];
    Object.assign(entry, { title: `Plans accepted — ${pl.title}`, options: plans.map((x) => ({ id: x.id, title: x.title, total: x.total })), selected: pl.id, explanation: [pl.logic, ...pl.pros, ...pl.issues.slice(0, 3)].join(' ') });
  }
  update((pp) => {
    pp.stages[stage] = { ...pp.stages[stage], status: 'accepted', basis: b[stage], acceptedAt: Date.now() };
  }, entry);
  const idx = STAGES.findIndex((s) => s.key === stage);
  const next = STAGES[idx + 1];
  if (next) { setUI({ stage: next.key, selected: null, floor: 0 }); lastCanvasKey = ''; drafts = {}; autoGenerate(next.key); }
}

function autoGenerate(stage) {
  const p = store.project;
  const st = p.stages[stage];
  if (stage === 'access' && !st.options && getAnalysis(p).ok) genAccess();
  if (stage === 'footprint' && !st.options && selected(p, 'access')) genFootprint(false);
  if (stage === 'programme' && !st.spaces) ensureProgramme(p);
  if (stage === 'bubbles' && !st.options && getBubbleCtx(p)) genBubbles(false);
}

function genAccess() {
  busy('Generating access options…', () => {
    const p = store.project;
    const A = getAnalysis(p), F = getFields(p);
    const seed = (p.stages.access.seed || 0) + 1;
    const r = generateAccess(A, F, p.brief, p.location, preservedSet(p), seed);
    update((pp) => {
      const rec = r.options.find((o) => o.recommended);
      pp.stages.access = { status: r.options.length ? 'options' : 'empty', options: r.options, selectedId: rec ? rec.id : null, seed, basis: bases(pp).access, generatedAt: Date.now(), note: r.note || null };
    }, r.options.length ? { stage: 'access', action: 'generate', title: `Access: ${r.options.length} options from ${r.candidatesEvaluated} gate arrangements`, options: r.options.map((o) => ({ id: o.id, title: o.title, total: o.total })) } : null);
  });
}

function genFootprint(more) {
  busy('Generating footprints…', () => {
    const p = store.project;
    const A = getAnalysis(p), F = getFields(p), masks = getMasks(p);
    const prev = p.stages.footprint;
    const seed = (prev.seed || 0) + 1;
    const exclude = more ? [...(prev.shown || []), ...(prev.options || []).map((o) => o.rects)] : [];
    const r = generateFootprints({ A, F, masks, access: selected(p, 'access'), brief: p.brief, priorities: p.intent.priorities, preserved: preservedSet(p), exclude }, seed);
    update((pp) => {
      const rec = r.options.find((o) => o.recommended);
      pp.stages.footprint = { status: r.options.length ? 'options' : 'empty', options: r.options, selectedId: rec ? rec.id : null, seed, shown: exclude.slice(-12), basis: bases(pp).footprint, generatedAt: Date.now(), reason: r.reason || null, sharedNotes: r.sharedNotes || [] };
    }, r.options.length ? { stage: 'footprint', action: 'generate', title: `Footprints: ${r.options.length} options from ${r.evaluated} candidates`, options: r.options.map((o) => ({ id: o.id, title: o.title, total: o.total })) } : null);
  });
}

function selectOption(stage, id) {
  const p = store.project;
  if (stage === 'bubbles') {
    const o = p.stages.bubbles.options.find((x) => x.id === id);
    update((pp) => {
      const st = pp.stages.bubbles;
      st.selectedId = id;
      st.current = { ...deepClone(o), version: `${id}.0`, revisions: [] };
      st.pins = {};
    }, { stage: 'bubbles', action: 'select', title: `Organisation ${id} selected — ${o.title}`, selected: id, explanation: o.logic });
    return;
  }
  if (stage === 'plan') { update((pp) => { pp.stages.plan.selectedId = id; }); return; }
  const o = p.stages[stage].options.find((x) => x.id === id);
  if (p.stages[stage].selectedId === id) return;
  update((pp) => { pp.stages[stage].selectedId = id; }, { stage, action: 'select', title: `${STAGES.find((s) => s.key === stage).short}: option ${id} selected — ${o.title}`, selected: id });
}

function applyPrefs() {
  const items = drafts.prefsItems || [];
  if (!items.length) return;
  update((pp) => {
    const prog = pp.stages.programme;
    for (const it of items) {
      if (it.kind === 'relation') {
        prog.relations = prog.relations.filter((r) => !([r.a, r.b].sort().join('|') === [it.a, it.b].sort().join('|')));
        prog.relations.push({ id: relId(), a: it.a, b: it.b, type: it.type, strength: it.strength, source: 'text', note: it.phrase });
      } else if (it.kind === 'attr') {
        const s = prog.spaces.find((x) => x.id === it.id);
        if (s) { if (it.attr === 'dh') s.dh = true; else s.attrs = { ...(s.attrs || {}), [it.attr]: true }; }
      } else if (it.kind === 'floor') {
        const s = prog.spaces.find((x) => x.id === it.id);
        if (s) { s.floor = it.floor === 'top' ? pp.brief.floors - 1 : Math.min(pp.brief.floors - 1, it.floor); for (const ch of prog.spaces.filter((x) => x.parent === s.id)) ch.floor = s.floor; }
      } else if (it.kind === 'area') {
        const s = prog.spaces.find((x) => x.id === it.id);
        if (s) { s.area = it.abs || Math.round(s.area * it.rel * 2) / 2; s.locked = true; }
      }
    }
    prog.prefsItems = [...(prog.prefsItems || []), ...items.filter((i) => i.kind === 'open')];
    refreshFloorsAndRelations(pp);
    if (prog.settings.mode !== 'manual') rebalance(pp, 'current');
  }, { stage: 'programme', action: 'interpret', title: `Spatial preferences applied (${items.length} items)`, prompt: drafts.prefs, changed: [...new Set(items.flatMap((i) => [i.a, i.b, i.id].filter(Boolean)))].map((id) => (store.project.stages.programme.spaces.find((s) => s.id === id) || {}).name || id) });
  drafts.prefsItems = []; drafts.prefsUnread = [];
  toast('Preferences applied to the programme and relationships.');
}

function pinnedCtx(p) {
  const X = getBubbleCtx(p);
  const pins = p.stages.bubbles.pins || {};
  return { ...X, spaces: X.spaces.map((s) => (pins[s.id] ? { ...s, pinned: true, floorAuto: pins[s.id][2] } : s)) };
}

function genBubbles(more) {
  busy('Arranging bubbles…', () => {
    const p = store.project;
    const st = p.stages.bubbles;
    const pins = st.pins || {};
    const X = pinnedCtx(p);
    const seed = (st.seed || 0) + 1 + (more ? 7 : 0);
    const init = Object.fromEntries(Object.entries(pins).map(([id, v]) => [id, [v[0], v[1]]]));
    const keepStair = Object.keys(pins).length && st.current ? st.current.stair : undefined;
    const options = generateBubbleOptions(X, seed, ['court', 'gradient', 'view'], { init, stair: keepStair });
    update((pp) => {
      const rec = options.find((o) => o.recommended) || options[0];
      const prevPins = pp.stages.bubbles.pins || {};
      pp.stages.bubbles = { status: 'options', options, selectedId: rec.id, current: { ...deepClone(rec), version: `${rec.id}.0`, revisions: [] }, seed, pins: prevPins, basis: bases(pp).bubbles, generatedAt: Date.now() };
      pp.stages.plan = { status: 'empty' };
    }, { stage: 'bubbles', action: 'generate', title: `Three organisations generated${Object.keys(pins).length ? ` (${Object.keys(pins).length} pinned bubbles kept)` : ''}`, options: options.map((o) => ({ id: o.id, title: o.title, total: o.total })), locked: Object.keys(pins) });
  });
}

function togglePin(id) {
  const p = store.project;
  const cur = p.stages.bubbles.current;
  let pos = null;
  for (const fl of cur.floors) for (const n of fl.nodes) if (n.id === id) pos = [n.x, n.y, fl.f];
  const name = (getBubbleCtx(p).spaces.find((s) => s.id === id) || {}).name;
  const on = !(p.stages.bubbles.pins || {})[id];
  update((pp) => {
    const pins = { ...(pp.stages.bubbles.pins || {}) };
    if (on && pos) pins[id] = pos; else delete pins[id];
    pp.stages.bubbles.pins = pins;
  }, { stage: 'bubbles', action: on ? 'lock' : 'unlock', title: `${name} ${on ? 'pinned' : 'unpinned'}`, locked: on ? [name] : [] });
}

let dragState = null;
function dragBubble(id, w) {
  const p = store.project;
  const cur = p.stages.bubbles?.current;
  if (!cur || store.ui.stage !== 'bubbles') return;
  const fr = getAnalysis(p).frame;
  const [s, t] = fr.toLocal(w);
  if (!dragState) dragState = { id, before: deepClone(cur) };
  for (const fl of cur.floors) for (const n of fl.nodes) if (n.id === id && fl.f === store.ui.floor) { n.x = s; n.y = t; }
  // live redraw without recording
  lastCanvasKey = '';
  renderMain(p, store.ui);
}
function dropBubble(id, moved) {
  if (!moved || !dragState) { dragState = null; return; }
  const p = store.project;
  const X = getBubbleCtx(p);
  const name = (X.spaces.find((s) => s.id === id) || {}).name;
  const cur = p.stages.bubbles.current;
  const sc = rescore(X, cur);
  update((pp) => {
    const c = pp.stages.bubbles.current;
    c.scores = sc.scores; c.total = sc.total;
    const n = (c.revisions || []).length + 1;
    c.version = `${pp.stages.bubbles.selectedId}.${n}`;
    c.revisions = [...(c.revisions || []), { v: c.version, text: `${name} moved by hand`, summary: `Score ${Math.round(sc.total * 100)}` }];
    if (pp.stages.bubbles.pins?.[id]) { const f = store.ui.floor; for (const fl of c.floors) for (const nd of fl.nodes) if (nd.id === id) pp.stages.bubbles.pins[id] = [nd.x, nd.y, f]; }
    pp.stages.plan = { status: 'empty' };
  }, { stage: 'bubbles', action: 'modify', title: `${name} moved by hand`, changed: [name], explanation: `Weighted score now ${Math.round(sc.total * 100)}.` });
  dragState = null;
}

function applyRevision() {
  const cmds = drafts.revCmds || [];
  if (!cmds.length) return;
  busy('Revising the selected design…', () => {
    const p = store.project;
    const X = pinnedCtx(p);
    const cur = p.stages.bubbles.current;
    const nameOf = (id) => (id.startsWith('@') ? id.slice(1).replace('-', ' ') : (X.spaces.find((s) => s.id === id) || {}).name || id);
    const pinsKeep = Object.keys(p.stages.bubbles.pins || {});
    const next = reviseOption(X, cur, [...cmds, ...(pinsKeep.length ? [{ kind: 'keep', ids: pinsKeep }] : [])], Date.now() % 1000);
    const changed = next.revision.changed.map((c) => `${nameOf(c.id)}${c.floorFrom != null && c.floorFrom !== c.floorTo ? ` (${floorShort(c.floorFrom)}→${floorShort(c.floorTo)})` : c.moved ? ` (${c.moved} m)` : ''}`);
    const kept = next.revision.keep.map(nameOf);
    const summary = `${changed.length ? `Changed: ${changed.join(', ')}.` : 'Nothing moved more than 0.75 m.'}${kept.length ? ` Kept: ${kept.join(', ')}.` : ''} Score ${Math.round(cur.total * 100)} → ${Math.round(next.total * 100)}.`;
    update((pp) => {
      const st = pp.stages.bubbles;
      const n = (cur.revisions || []).length + 1;
      const v = `${st.selectedId}.${n}`;
      st.current = { ...next, version: v, revisions: [...(cur.revisions || []), { v, text: drafts.revision || cmds.map((c) => describeCmd(c, nameOf)).join('; '), summary }] };
      // floor changes and new relationships are design decisions that also update the programme
      const prog = pp.stages.programme;
      for (const [id, f] of Object.entries(next.floorOverride || {})) { const s = prog.spaces.find((x) => x.id === id); if (s) s.floor = f; }
      for (const c of cmds) {
        if (c.kind === 'relate') prog.relations.push({ id: relId(), a: c.a, b: c.b, type: c.type, strength: 3, source: 'text', note: c.phrase });
        if (c.kind === 'area') { const s = prog.spaces.find((x) => x.id === c.a); if (s) { s.area = c.abs || Math.round(s.area * c.rel * 2) / 2; s.locked = true; } }
      }
      pp.stages.plan = { status: 'empty' };
    }, { stage: 'bubbles', action: 'revise', title: `Revision ${store.project.stages.bubbles.selectedId}.${(cur.revisions || []).length + 1}: ${cmds.map((c) => describeCmd(c, nameOf)).join('; ')}`, prompt: drafts.revision, changed, locked: kept, explanation: summary });
    drafts.revCmds = []; drafts.revision = ''; drafts.revUnread = [];
    toast(summary);
  });
}

function regenStale() {
  const st = store.ui.stage;
  if (st === 'access') genAccess();
  else if (st === 'footprint') genFootprint(false);
  else if (st === 'programme') update((pp) => { refreshFloorsAndRelations(pp); pp.stages.programme.basis = bases(pp).programme; pp.stages.programme.status = 'draft'; });
  else if (st === 'bubbles') genBubbles(false);
  else if (st === 'plan') update((pp) => { pp.stages.plan = { status: 'empty' }; });
  else update((pp) => { pp.stages[st].basis = bases(pp)[st]; });
}

// ---------------------------------------------------------------------------------------------
function svgFile() {
  const svg = $('#svg').cloneNode(true);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('font-family', 'IBM Plex Sans, Helvetica, Arial, sans-serif');
  const v = canvas.view;
  svg.setAttribute('width', `${Math.round(v.w * 20)}`); svg.setAttribute('height', `${Math.round(v.h * 20)}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
}
export function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const slug = (s) => (s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export { compass8, COMPASS_NAMES, getFields, scoreBars, addHistory };
