// Space library for the individual-residence typology (spec §50). A typology is a swappable data
// package: another typology replaces this file plus relations.js, the engine stays the same.
//
// zone      public | semi-public | semi-private | private | service   (spec §59 hierarchy)
// rank      0 (street-facing) … 1 (deepest privacy) — drives the privacy gradient
// floor     preferred level: ground | upper | top | any
// min/rec/max  m² (min follows NBC 2016 where one exists, see MIN_STANDARDS_NOTE)
// minW      minimum clear width (m)
// noise     sensitivity to noise 0..1      view   desire for views/garden 0..1
// wet       needs plumbing (stacking preference)
// access    hub (others can be entered from it) | room (needs a door to a hub) |
//           attached (entered only from its parent) | service (through kitchen/utility) | wc
// social    part of the living–dining–kitchen family that may be open-plan
// dh        sensible double-height candidate

export const ZONES = {
  public: { label: 'Public', rank: 0.1, color: '#d9822b' },
  'semi-public': { label: 'Semi-public', rank: 0.35, color: '#c9a227' },
  'semi-private': { label: 'Semi-private', rank: 0.65, color: '#5f9e6e' },
  private: { label: 'Private', rank: 0.9, color: '#3f6fa3' },
  service: { label: 'Service', rank: 0.5, color: '#8a7f73' },
  circulation: { label: 'Circulation', rank: 0.3, color: '#b9b4aa' },
};

const S = (key, label, zone, rank, floor, min, rec, max, minW, extra = {}) => ({
  key, label, zone, rank, floor, min, rec, max, minW,
  noise: 0.4, view: 0.4, wet: false, access: 'room', social: false, dh: false, ...extra,
});

export const SPACE_LIBRARY = [
  S('foyer', 'Foyer', 'public', 0.05, 'ground', 4, 8, 16, 1.8, { access: 'hub', noise: 0.1, view: 0.2 }),
  S('formal_living', 'Formal living', 'public', 0.15, 'ground', 14, 22, 40, 3.6, { access: 'hub', view: 0.8, noise: 0.5, dh: true, social: true }),
  S('family_living', 'Family living', 'semi-public', 0.45, 'any', 12, 18, 32, 3.3, { access: 'hub', view: 0.8, noise: 0.5, social: true }),
  S('dining', 'Dining', 'semi-public', 0.35, 'ground', 9, 14, 24, 3.0, { access: 'hub', view: 0.6, noise: 0.3, social: true, dh: true }),
  S('kitchen', 'Kitchen', 'service', 0.4, 'ground', 7.5, 11, 18, 2.4, { wet: true, noise: 0.2, view: 0.3, social: true }),
  S('pantry', 'Pantry', 'service', 0.45, 'ground', 3, 5, 8, 1.5, { access: 'service', noise: 0, view: 0 }),
  S('utility', 'Utility / wash', 'service', 0.5, 'ground', 4, 6, 10, 1.5, { wet: true, access: 'service', noise: 0, view: 0 }),
  S('laundry', 'Laundry', 'service', 0.55, 'any', 3, 4.5, 8, 1.5, { wet: true, access: 'service', noise: 0, view: 0 }),
  S('puja', 'Pooja room', 'semi-public', 0.3, 'ground', 2.5, 4, 8, 1.5, { noise: 0.7, view: 0.2 }),
  S('powder', 'Powder room', 'public', 0.2, 'ground', 1.8, 2.5, 4, 1.0, { wet: true, access: 'wc', noise: 0, view: 0 }),
  S('guest_bed', 'Guest bedroom', 'semi-private', 0.6, 'ground', 9.5, 13, 18, 2.7, { noise: 0.7, view: 0.5 }),
  S('guest_bath', 'Guest bath', 'private', 0.65, 'ground', 2.8, 4, 6, 1.2, { wet: true, access: 'attached', noise: 0, view: 0 }),
  S('master_bed', 'Master bedroom', 'private', 0.95, 'top', 12, 18, 26, 3.3, { noise: 0.9, view: 0.9 }),
  S('master_bath', 'Master bath', 'private', 0.97, 'top', 4, 6, 10, 1.5, { wet: true, access: 'attached', noise: 0, view: 0.1 }),
  S('dressing', 'Dressing', 'private', 0.96, 'top', 3, 5, 9, 1.5, { access: 'attached', noise: 0, view: 0 }),
  S('bedroom', 'Bedroom', 'private', 0.85, 'upper', 9.5, 13, 18, 2.7, { noise: 0.85, view: 0.6 }),
  S('bath', 'Bath', 'private', 0.87, 'upper', 2.8, 4.2, 6, 1.2, { wet: true, access: 'attached', noise: 0, view: 0 }),
  S('family_lounge', 'Family lounge', 'semi-private', 0.7, 'upper', 9, 14, 24, 3.0, { access: 'hub', view: 0.7, noise: 0.5 }),
  S('office', 'Home office', 'semi-public', 0.3, 'any', 7.5, 10, 16, 2.4, { noise: 0.8, view: 0.6 }),
  S('gym', 'Gym', 'semi-private', 0.6, 'any', 9, 14, 25, 3.0, { noise: 0.2, view: 0.5 }),
  S('home_bar', 'Home bar', 'semi-public', 0.3, 'any', 5, 8, 14, 2.1, { noise: 0.2, view: 0.5 }),
  S('theatre', 'Home theatre', 'semi-private', 0.6, 'any', 14, 18, 28, 3.6, { noise: 0.9, view: 0 }),
  S('staff_room', 'Staff room', 'service', 0.5, 'ground', 7.5, 9, 12, 2.4, { noise: 0.5, view: 0.2 }),
  S('staff_wc', 'Staff toilet', 'service', 0.52, 'ground', 1.8, 2.4, 3.5, 1.0, { wet: true, access: 'attached', noise: 0, view: 0 }),
  S('store', 'Store', 'service', 0.5, 'any', 2, 4, 8, 1.2, { access: 'service', noise: 0, view: 0 }),
  S('balcony', 'Balcony', 'private', 0.8, 'upper', 3, 5, 10, 1.2, { access: 'attached', view: 1, noise: 0.2 }),
  S('verandah', 'Verandah', 'public', 0.2, 'ground', 6, 10, 20, 1.8, { access: 'hub', view: 0.9, noise: 0.2 }),
  S('indoor_pool', 'Indoor pool', 'semi-private', 0.6, 'ground', 20, 30, 50, 3.5, { wet: true, view: 0.8 }),
  S('motor_room', 'Motor room', 'service', 0.5, 'ground', 1.5, 2.5, 4, 1.2, { access: 'service', noise: 0, view: 0 }),
  S('garage', 'Garage', 'service', 0.1, 'ground', 15, 18, 40, 3.0, { access: 'service', noise: 0, view: 0 }),
  S('ext_stair', 'External staircase', 'public', 0.3, 'ground', 5, 7, 10, 1.0, { access: 'hub', noise: 0, view: 0 }),
  S('custom', 'Custom space', 'semi-private', 0.5, 'any', 4, 10, 30, 2.4, {}),
];

export const LIB = Object.fromEntries(SPACE_LIBRARY.map((s) => [s.key, s]));

// Rooms that normally come with an attached child.
export const SUITE_CHILDREN = {
  master_bed: ['master_bath', 'dressing'],
  bedroom: ['bath'],
  guest_bed: ['guest_bath'],
  staff_room: ['staff_wc'],
};

export const isHabitable = (key) =>
  ['formal_living', 'family_living', 'dining', 'guest_bed', 'master_bed', 'bedroom', 'family_lounge', 'office', 'gym', 'theatre', 'staff_room'].includes(key);

// Name matching for the text interpreter (spec §91): every phrase that may refer to a space type.
export const SPACE_SYNONYMS = {
  foyer: ['foyer', 'entrance hall', 'entry hall', 'entrance lobby', 'lobby', 'entry', 'entrance'],
  formal_living: ['formal living', 'formal lounge', 'drawing room', 'living room', 'guest living', 'formal sitting', 'formal'],
  family_living: ['family living', 'informal living', 'family room', 'family area', 'family space', 'family spaces', 'informal'],
  dining: ['dining', 'dining room', 'dining area'],
  kitchen: ['kitchen', 'cooking'],
  pantry: ['pantry'],
  utility: ['utility', 'wash area', 'service area', 'wash'],
  laundry: ['laundry'],
  puja: ['pooja', 'puja', 'prayer', 'prayer room', 'shrine'],
  powder: ['powder', 'powder room', 'guest toilet', 'common toilet'],
  guest_bed: ['guest bedroom', 'guest room', 'parents bedroom', "parents' bedroom", 'parents room', 'grandparents', 'elders room', 'guest'],
  guest_bath: ['guest bath', 'guest bathroom'],
  master_bed: ['master bedroom', 'master suite', 'master', 'main bedroom', "parents' suite", 'owners bedroom'],
  master_bath: ['master bath', 'master bathroom', 'master toilet'],
  dressing: ['dressing', 'walk-in', 'wardrobe', 'closet'],
  bedroom: ['bedroom', 'bedrooms', "kids' room", 'kids room', "children's room", 'childrens room', 'kids bedroom', 'child bedroom'],
  bath: ['bathroom', 'bathrooms', 'bath', 'toilet', 'toilets'],
  family_lounge: ['family lounge', 'upper lounge', 'lounge', 'upper living'],
  office: ['office', 'study', 'home office', 'workroom', 'library'],
  gym: ['gym', 'fitness', 'workout'],
  home_bar: ['bar', 'home bar'],
  theatre: ['theatre', 'theater', 'media room', 'home theatre', 'cinema'],
  staff_room: ['staff room', 'servant room', "servant's room", 'servants quarters', 'servant quarters', 'staff', 'maid room', 'help'],
  staff_wc: ['staff toilet', 'servant toilet', 'staff wc'],
  store: ['store', 'storage', 'store room'],
  balcony: ['balcony', 'balconies'],
  verandah: ['verandah', 'veranda', 'porch', 'thinnai', 'sit-out', 'sitout'],
  indoor_pool: ['indoor pool'],
  motor_room: ['motor room', 'pump room'],
  garage: ['garage', 'car shed'],
};

// Open-space anchors the text interpreter and relationships can point at.
export const ANCHOR_SYNONYMS = {
  courtyard: ['courtyard', 'court', 'internal court', 'atrium', 'mutram', 'nadumuttam'],
  garden: ['garden', 'lawn', 'landscape', 'green', 'rear garden', 'front garden'],
  'service-yard': ['service yard', 'backyard', 'back yard', 'drying yard', 'service court'],
  entrance: ['main entrance', 'front door', 'entrance door'],
  street: ['street', 'road', 'front'],
  tree: ['tree', 'neem', 'mango', 'coconut'],
};
