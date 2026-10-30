// Solar geometry from latitude (spec §22). Deterministic astronomy, not decoration: the drawn
// sun path is where the sun actually is at this latitude, and facade exposure is computed from it.
// Uses Cooper's declination and the standard altitude/azimuth relations (accuracy ~1°, ample for
// early design). Times are local solar time.

const D2R = Math.PI / 180;

export const KEY_DAYS = [
  { key: 'jun', label: '21 Jun', n: 172 },
  { key: 'equinox', label: '21 Mar / 23 Sep', n: 80 },
  { key: 'dec', label: '21 Dec', n: 355 },
];

export function declination(n) {
  return 23.45 * Math.sin(D2R * (360 * (284 + n)) / 365);
}

export function solarPosition(lat, n, hour) {
  const phi = lat * D2R, dec = declination(n) * D2R, h = 15 * (hour - 12) * D2R;
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const azS = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const az = ((azS / D2R + 180) % 360 + 360) % 360; // clockwise from north
  return { alt: alt / D2R, az };
}

export function dayLength(lat, n) {
  const x = -Math.tan(lat * D2R) * Math.tan(declination(n) * D2R);
  if (x <= -1) return 24;
  if (x >= 1) return 0;
  return (2 * Math.acos(x)) / D2R / 15;
}

export function sunPath(lat, n, steps = 48) {
  const L = dayLength(lat, n);
  const t0 = 12 - L / 2, t1 = 12 + L / 2;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const hour = t0 + ((t1 - t0) * i) / steps;
    pts.push({ hour, ...solarPosition(lat, n, hour) });
  }
  return { sunrise: t0, sunset: t1, pts };
}

// Chennai-like heat weighting by month (heuristic): solar gain matters most in the hot season.
const MONTH_HEAT = [0.3, 0.4, 0.7, 0.9, 1, 1, 0.9, 0.85, 0.8, 0.6, 0.4, 0.3];

// Relative heat exposure of a vertical facade whose outward normal faces `bearing` (deg from N).
export function facadeExposureRaw(lat, bearing) {
  let s = 0;
  for (let m = 0; m < 12; m++) {
    const n = 15 + m * 30.4;
    for (let hour = 6; hour <= 18; hour += 0.5) {
      const { alt, az } = solarPosition(lat, n, hour);
      if (alt <= 0) continue;
      const beam = Math.pow(Math.sin(alt * D2R), 0.6); // crude air-mass attenuation
      const inc = Math.cos(alt * D2R) * Math.cos((az - bearing) * D2R);
      if (inc <= 0) continue;
      const afternoon = hour > 13 ? 1.25 : 1; // afternoon air is hotter
      s += beam * inc * afternoon * MONTH_HEAT[m];
    }
  }
  return s;
}

const cache = new Map();
// Normalised 0..1 across all orientations for this latitude.
export function facadeExposure(lat, bearing) {
  const key = Math.round(lat * 10);
  if (!cache.has(key)) {
    const table = [];
    for (let b = 0; b < 360; b += 5) table.push(facadeExposureRaw(lat, b));
    const max = Math.max(...table);
    cache.set(key, table.map((v) => v / max));
  }
  const table = cache.get(key);
  const b = ((bearing % 360) + 360) % 360;
  const i = Math.floor(b / 5), f = (b - i * 5) / 5;
  return table[i % 72] * (1 - f) + table[(i + 1) % 72] * f;
}

export function sunSummary(lat) {
  const noon = KEY_DAYS.map((d) => ({ ...d, ...solarPosition(lat, d.n, 12) }));
  const jun = noon[0];
  const summerNorth = jun.az < 90 || jun.az > 270;
  const orient = [0, 45, 90, 135, 180, 225, 270, 315].map((b) => ({ b, e: facadeExposure(lat, b) }));
  const worst = orient.reduce((a, c) => (c.e > a.e ? c : a));
  const best = orient.reduce((a, c) => (c.e < a.e ? c : a));
  return { noon, summerNorth, worst, best, orient };
}
