// Single source of truth: the project object + transient UI state.
// Every accepted decision is written to project.history with a snapshot of the decisions at that
// moment (spec §74, §113), so the design evolution can be replayed, compared and branched.

import { sampleProject, newProject, migrate, STAGES } from './model.js';
import { deepClone } from './util.js';

const KEY = 'proto-v1/project';
const listeners = new Set();

export const store = {
  project: null,
  ui: {
    stage: 'brief', floor: 0, compare: true, hover: null, selected: null, toast: null,
    layers: { grid: true, context: true, setbacks: true, trees: true, wind: true, sun: true, noise: true, views: true, privacy: true, field: null, labels: true, zoning: true, underlay: true, relations: false },
    preview: null, // history entry being previewed
  },
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let pending = false;
export function emit() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; for (const fn of listeners) fn(store); });
}

export function load() {
  let p = null;
  try { const raw = localStorage.getItem(KEY); if (raw) p = migrate(JSON.parse(raw)); } catch { p = null; }
  store.project = p || sampleProject();
  if (!p) addHistory({ stage: 'brief', action: 'start', title: 'Benchmark project loaded', explanation: 'The Chennai benchmark residence was loaded as a starting point.' });
  try { const st = localStorage.getItem(`${KEY}/stage`); if (st && STAGES.some((s) => s.key === st)) store.ui.stage = st; } catch { /* ignore */ }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store.project));
      localStorage.setItem(`${KEY}/stage`, store.ui.stage);
    } catch (e) {
      toast('Could not save in this browser (storage full or blocked). Export the project to keep it.', 'warn');
    }
  }, 250);
}

// mutate the project; optionally record a history entry
export function update(mutator, entry = null) {
  mutator(store.project);
  store.project.modified = new Date().toISOString();
  if (entry) addHistory(entry);
  save();
  emit();
}

export function setUI(patch) {
  Object.assign(store.ui, patch);
  if (patch.stage) save();
  emit();
}

export function toast(text, kind = 'info') {
  store.ui.toast = { text, kind, t: Date.now() };
  emit();
  setTimeout(() => { if (store.ui.toast && Date.now() - store.ui.toast.t > 3800) { store.ui.toast = null; emit(); } }, 4000);
}

function snapshotOf(p) {
  const s = deepClone({ ...p, history: undefined });
  delete s.history;
  return s;
}

const STAGE_NUM = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
export function addHistory(entry) {
  const p = store.project;
  const stageN = STAGE_NUM[entry.stage] ?? 0;
  const sameStage = p.history.filter((h) => h.stage === entry.stage).length;
  const parent = p.head || (p.history.length ? p.history[p.history.length - 1].id : null);
  const h = {
    id: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    v: `V${stageN}.${sameStage}`,
    t: new Date().toISOString(),
    parent,
    changed: [], locked: [], options: [], ...entry,
    snapshot: snapshotOf(p),
  };
  p.history.push(h);
  p.head = h.id;
  // keep storage bounded: drop snapshots (not the record) of very old entries
  if (p.history.length > 120) for (const old of p.history.slice(0, p.history.length - 120)) old.snapshot = null;
  return h;
}

// Restore a previous state as a new branch (nothing is deleted — spec §126 alternative history).
export function restore(historyId) {
  const p = store.project;
  const h = p.history.find((x) => x.id === historyId);
  if (!h || !h.snapshot) return;
  const history = p.history;
  const snap = deepClone(h.snapshot);
  store.project = migrate({ ...snap, history });
  store.project.head = h.id;
  addHistory({ stage: h.stage, action: 'restore', title: `Returned to ${h.v} — ${h.title}`, explanation: 'A previous state was restored as a new branch; later iterations remain in the record.', restoredFrom: h.id });
  save();
  emit();
}

export function resetProject(kind = 'sample') {
  store.project = kind === 'sample' ? sampleProject() : newProject();
  store.ui.stage = kind === 'sample' ? 'brief' : 'brief';
  addHistory({ stage: 'brief', action: 'start', title: kind === 'sample' ? 'Benchmark project loaded' : 'New project started' });
  save();
  emit();
}

export function importProject(json) {
  const p = migrate(typeof json === 'string' ? JSON.parse(json) : json);
  if (!p || !p.site) throw new Error('This file is not a project from this tool.');
  store.project = p;
  addHistory({ stage: 'brief', action: 'import', title: 'Project imported' });
  save();
  emit();
}

export function exportProject() {
  return JSON.stringify(store.project, null, 1);
}
