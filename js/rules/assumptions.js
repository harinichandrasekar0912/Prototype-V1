// Every number the engine relies on lives here, labelled with what kind of thing it is.
//   kind: 'regulation-assumption' — stands in for a real rule; must be verified per jurisdiction
//         'standard'              — taken from a published standard (secondary sources, verify)
//         'heuristic'             — a design rule of thumb; never presented as law
//         'prototype'             — a modelling simplification from the V1 spec
// Regulations become a data-driven package later (jurisdiction / source / version / effective date).

export const REGULATION_PACKAGE = {
  id: 'proto-chennai-v1',
  jurisdiction: 'Chennai / Tamil Nadu — prototype context',
  status: 'Prototype assumptions. Not a compliance check. Verify against TNCDBR 2019 (as amended) and NBC 2016.',
  version: '1.0',
};

export const DEFAULT_REGULATIONS = {
  fsi: 2.0,
  frontSetback: 3.0,
  otherSetback: 1.5,
  maxHeight: 15,
  floorHeight: 3.0,
  allRoadEdgesAreFront: false,
};

export const REGULATION_NOTES = {
  fsi: { kind: 'regulation-assumption', label: 'FSI', note: 'Spec §20 prototype constant. Secondary sources report a base FSI of 2.0 for non-high-rise buildings under TNCDBR 2019; verify for the actual plot and road width.' },
  frontSetback: { kind: 'regulation-assumption', label: 'Front setback', note: 'Spec §19. Applied to the frontage edge (edge abutting the widest road).' },
  otherSetback: { kind: 'regulation-assumption', label: 'Side / rear setback', note: 'Spec §19. Applied to every other edge.' },
  maxHeight: { kind: 'regulation-assumption', label: 'Maximum height', note: 'Spec §20 prototype constant (the TN non-high-rise threshold is reported as 18.3 m, raised to 19.5 m by G.O. 194 — verify).' },
  floorHeight: { kind: 'prototype', label: 'Floor-to-floor height', note: 'Preliminary default (spec §48).' },
  allRoadEdgesAreFront: { kind: 'regulation-assumption', label: 'Corner plots', note: 'When on, every road-facing edge takes the front setback.' },
};

export const DESIGN = {
  cell: 0.5, // design grid (m)
  treeBuffer: 1.5, // spec §30: circumscribing square offset by 1.5 m
  drivewayHalfWidth: 2.0, // spec §36: path buffered 2 m each side
  gateVehicle: 3.6,
  gateInOut: 3.2,
  gatePedestrian: 1.2,
  bayW: 2.75,
  bayD: 5.5,
  garagePerCar: { w: 3.2, d: 6.0 },
  stilPerCar: 16, // m² incl. aisle share
  corridor: 1.2, // internal corridor width (NBC residential minimum reported as 1.0 m)
  stair: { w: 2.5, d: 4.5 }, // dog-leg, 3 m floor-to-floor, 1.0 m flights
  lift: { w: 1.8, d: 1.8 },
  minWing: 4.0, // a wing must hold a 1.2 m corridor plus a 2.8 m room
  maxWing: 13,
  courtMin: 3.5,
  circulationPct: 0.15, // net -> gross allowances (spec §53)
  wallPct: 0.1,
};

export const MIN_STANDARDS_NOTE =
  'Minimum room sizes follow NBC 2016 Part 3 as reported by secondary sources (habitable room 9.5 m² / 7.5 m², kitchen 5.0 m², bath 1.8 m², WC 1.1 m², combined 2.8 m²). Recommended and maximum sizes are this prototype’s defaults for an Indian individual residence and can be edited.';

// How strongly each footprint/bubble metric is tied to an intent priority.
export const PRIORITIES = [
  { key: 'privacy', label: 'Privacy', hint: 'Shield gardens and private rooms from the street and neighbours' },
  { key: 'trees', label: 'Existing trees', hint: 'Organise the house around preserved vegetation' },
  { key: 'courtyard', label: 'Courtyard life', hint: 'An enclosed open-to-sky heart' },
  { key: 'ventilation', label: 'Cross-ventilation', hint: 'Slim wings open to the prevailing breeze' },
  { key: 'climate', label: 'Solar control', hint: 'Short west facades, long north/south faces' },
  { key: 'views', label: 'Views', hint: 'Major spaces face the desirable views' },
  { key: 'garden', label: 'Usable garden', hint: 'One generous, well-proportioned garden' },
  { key: 'noise', label: 'Quiet', hint: 'Keep sensitive rooms away from noise' },
  { key: 'compactness', label: 'Economy', hint: 'Compact plan, short perimeter, efficient circulation' },
  { key: 'procession', label: 'Procession', hint: 'A considered sequence of arrival and thresholds' },
];
