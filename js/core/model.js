// The project object (spec §86–87). This — not any SVG — is the design state. Drawings are
// regenerated from it; stages store their options, the architect's selection and the basis (hash of
// upstream inputs) they were generated from, so upstream edits can flag downstream work as stale.

import { DEFAULT_REGULATIONS } from '../rules/assumptions.js';

export const SCHEMA = 'prototype-v1/2';

export const STAGES = [
  { key: 'brief', n: '00', label: 'Brief & intent', short: 'Brief' },
  { key: 'site', n: '01', label: 'Site & analysis', short: 'Site' },
  { key: 'trees', n: '02', label: 'Tree decisions', short: 'Trees' },
  { key: 'access', n: '03', label: 'Access & parking', short: 'Access' },
  { key: 'footprint', n: '04', label: 'Footprint & zoning', short: 'Massing' },
  { key: 'programme', n: '05', label: 'Programme & areas', short: 'Programme' },
  { key: 'bubbles', n: '06', label: 'Spatial organisation', short: 'Bubbles' },
  { key: 'plan', n: '07', label: 'Single-line plans', short: 'Plans' },
  { key: 'record', n: '08', label: 'Design record', short: 'Record' },
];

export const OPEN_SPACE_TYPES = [
  { key: 'courtyard', label: 'Courtyard', area: 20, internal: true },
  { key: 'front-garden', label: 'Front garden', area: 30 },
  { key: 'rear-garden', label: 'Rear garden', area: 40 },
  { key: 'side-garden', label: 'Side garden', area: 20 },
  { key: 'lawn', label: 'Lawn', area: 40 },
  { key: 'service-yard', label: 'Service yard', area: 10 },
  { key: 'pool', label: 'Outdoor pool', area: 24 },
  { key: 'patio', label: 'Patio', area: 12 },
];

export function emptyStages() {
  return Object.fromEntries(STAGES.map((s) => [s.key, { status: 'empty' }]));
}

export function newProject() {
  return {
    schema: SCHEMA,
    id: `p${Date.now().toString(36)}`,
    name: 'Untitled residence',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    typology: 'individual_residence',
    units: 'm',
    location: { label: 'Chennai, Tamil Nadu', lat: 13.08, lon: 80.27, northDeg: 0, drivingSide: 'left' },
    brief: {
      client: '', occupants: 4, floors: 2, targetBUA: 250,
      parking: { type: 'open', cars: 1 }, separatePedestrianGate: false,
      entryCharacter: 'subtle', openSpaces: [], lift: false,
    },
    intent: { text: '', priorities: { privacy: 1, trees: 1, courtyard: 1, ventilation: 1, climate: 1, views: 1, garden: 1, noise: 1, compactness: 1, procession: 1 }, interpreted: [] },
    site: { boundary: [], roads: [], buildings: [], trees: [], noise: [], views: [], privacy: [], winds: [] },
    regulations: { ...DEFAULT_REGULATIONS },
    decisions: { trees: {} },
    stages: emptyStages(),
    history: [],
    head: null,
  };
}

// Benchmark project: a corner plot in a Chennai residential neighbourhood with three existing trees.
export function sampleProject() {
  const p = newProject();
  p.name = 'Neem Court House — benchmark';
  p.brief = {
    client: 'Family of five — couple, two school-age children, a grandparent — and a live-in help',
    occupants: 5,
    floors: 2,
    targetBUA: 330,
    parking: { type: 'open', cars: 2 },
    separatePedestrianGate: true,
    entryCharacter: 'subtle',
    openSpaces: [
      { type: 'courtyard', area: 20 },
      { type: 'rear-garden', area: 40 },
      { type: 'service-yard', area: 10 },
    ],
    lift: false,
  };
  p.intent = {
    text:
      'An introverted tropical home organised around the preserved trees: a quiet, layered approach from the street, a shaded courtyard at its heart and cross-ventilated living spaces that open to the garden. Bedrooms upstairs, protected from the road and from the west sun.',
    priorities: { privacy: 2, trees: 2, courtyard: 1.5, ventilation: 1.5, climate: 1.5, views: 1, garden: 1, noise: 1, compactness: 0.5, procession: 1 },
    interpreted: [],
  };
  p.site = {
    boundary: [[0, 0], [18, 0], [18.6, 30], [0, 29.4]],
    roads: [
      { id: 'R1', edge: 0, width: 9, name: 'Main road', oneWay: null },
      { id: 'R2', edge: 3, width: 6, name: 'Side street', oneWay: null },
    ],
    buildings: [
      { id: 'B1', polygon: [[19.6, 3], [27, 3], [27, 17], [19.6, 17]], height: 10, use: 'Residence G+2' },
      { id: 'B2', polygon: [[2, 31.5], [16, 31.5], [16, 40], [2, 40]], height: 7, use: 'Residence G+1' },
      { id: 'B3', polygon: [[-14, 6], [-7, 6], [-7, 22], [-14, 22]], height: 12, use: 'Apartments G+3' },
    ],
    trees: [
      { id: 'T1', x: 13.5, y: 24, r: 2.4, h: 11, species: 'Neem' },
      { id: 'T2', x: 2.4, y: 2.2, r: 1.5, h: 9, species: 'Coconut' },
      { id: 'T3', x: 8.5, y: 12.5, r: 1.3, h: 6, species: 'Mango' },
    ],
    noise: [{ id: 'N1', x: -4, y: -4.5, radius: 12, label: 'Road junction' }],
    views: [
      { id: 'V1', from: [14, 26], to: [24, 38], kind: 'desirable', weight: 1, label: 'Temple tank & park (NE)' },
      { id: 'V2', from: [1.5, 15], to: [-8, 15], kind: 'undesirable', weight: 1, label: 'Apartment block (W)' },
    ],
    privacy: [
      { id: 'P1', x: 19.6, y: 10, radius: 7, label: 'East neighbour windows' },
      { id: 'P2', x: -7, y: 14, radius: 9, label: 'Apartment balconies' },
    ],
    winds: [
      { id: 'W1', from: [27, -7], to: [19, 1], label: 'Sea breeze (SE, Mar–Jun afternoons)' },
      { id: 'W2', from: [-9, -9], to: [-2, -2], label: 'SW monsoon (Jun–Sep)' },
    ],
  };
  return p;
}

export function migrate(p) {
  if (!p || typeof p !== 'object') return null;
  const base = newProject();
  const out = { ...base, ...p };
  out.location = { ...base.location, ...(p.location || {}) };
  out.brief = { ...base.brief, ...(p.brief || {}) };
  out.brief.parking = { ...base.brief.parking, ...((p.brief || {}).parking || {}) };
  out.intent = { ...base.intent, ...(p.intent || {}) };
  out.intent.priorities = { ...base.intent.priorities, ...((p.intent || {}).priorities || {}) };
  out.site = { ...base.site, ...(p.site || {}) };
  out.regulations = { ...base.regulations, ...(p.regulations || {}) };
  out.decisions = { ...base.decisions, ...(p.decisions || {}) };
  out.stages = { ...emptyStages(), ...(p.stages || {}) };
  out.history = Array.isArray(p.history) ? p.history : [];
  out.schema = SCHEMA;
  return out;
}
