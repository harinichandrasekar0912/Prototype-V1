// The site as a set of spatial influence fields (spec §25, §126 "sensory architecture").
// Each field is a 0..1 value per design-grid cell. They are simple, explicit models — distance
// decay from sources — chosen to be legible and editable, not to imitate simulation. Generators
// score candidates against them, and they can be drawn so the architect sees what the engine sees.

import { Grid, cellInsidePolygonStrict } from '../geometry/grid.js';
import { pointInPolygon, distToSegment, distToPolygon, dist, dot, sub } from '../geometry/polygon.js';
import { DESIGN } from '../rules/assumptions.js';
import { clamp } from '../core/util.js';

export const FIELD_INFO = {
  noise: { label: 'Noise', note: 'Roads as line sources (louder for wider roads) plus point sources, decaying with distance.' },
  privacy: { label: 'Overlooking', note: 'Exposure to the street, neighbouring buildings (taller = stronger) and marked privacy concerns.' },
  view: { label: 'Views', note: 'Proximity to desirable view origins (positive) and undesirable ones (negative).' },
  depth: { label: 'Depth from street', note: 'Distance from the frontage — the raw public-to-private gradient.' },
  breeze: { label: 'Windward', note: 'Which part of the plot meets the prevailing breeze first.' },
  shade: { label: 'Tree shade', note: 'Shade and green relief from preserved trees (scaled by height).' },
};

export function buildFields(A, preservedTreeIds = null) {
  const grid = new Grid(A.frame, DESIGN.cell, 0);
  const { nx, ny } = grid;
  const site = A.pts;
  const inSite = grid.mask((i, j) => pointInPolygon(grid.centerWorld(i, j), site));
  const setbackMask = A.setbackPoly ? grid.mask((i, j) => cellInsidePolygonStrict(grid, i, j, A.setbackPoly)) : new Uint8Array(grid.n);
  const preserved = A.trees.filter((t) => t.inside && (!preservedTreeIds || preservedTreeIds.has(t.id)));

  const noise = new Float32Array(grid.n), privacy = new Float32Array(grid.n), view = new Float32Array(grid.n);
  const depth = new Float32Array(grid.n), breeze = new Float32Array(grid.n), shade = new Float32Array(grid.n);

  const wind = A.winds[0];
  const proj = [];
  const T0 = A.frame.frontT, Tspan = Math.max(1, A.frame.T - T0);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const p = grid.centerWorld(i, j);
      const [, t] = grid.centerLocal(i, j);
      // noise: roads are line sources
      let q = 1;
      for (const r of A.roads) {
        const d = distToSegment(p, r.edge.a, r.edge.b);
        const L = clamp(r.width / 12, 0.35, 1);
        q *= 1 - L * Math.exp(-d / 7);
      }
      for (const s of A.noise) {
        const d = dist(p, [s.x, s.y]);
        q *= 1 - Math.pow(clamp(1 - d / (s.radius || 8)), 1.2);
      }
      noise[k] = 1 - q;
      // privacy / overlooking
      q = 1;
      for (const r of A.roads) q *= 1 - 0.9 * Math.exp(-distToSegment(p, r.edge.a, r.edge.b) / 6);
      for (const b of A.buildings) {
        if (!b.polygon || b.polygon.length < 3) continue;
        const h = clamp((b.height || 6) / 9, 0.4, 1);
        q *= 1 - h * Math.exp(-distToPolygon(p, b.polygon) / 7);
      }
      for (const s of A.privacy) q *= 1 - clamp(1 - dist(p, [s.x, s.y]) / (s.radius || 6));
      privacy[k] = 1 - q;
      // views
      let v = 0;
      for (const vw of A.views) {
        const w = (vw.weight ?? 1) * (vw.kind === 'undesirable' ? -1 : 1);
        v += w * Math.exp(-dist(p, vw.from) / 5);
      }
      view[k] = clamp(v, -1, 1);
      depth[k] = clamp((t - T0) / Tspan);
      if (wind) proj[k] = -dot(sub(p, A.centroid), wind.dir);
      let sh = 0;
      for (const tr of preserved) {
        const d = Math.max(0, dist(p, [tr.x, tr.y]) - tr.r);
        sh = Math.max(sh, Math.exp(-d / Math.max(1.5, (tr.h || 6) * 0.35)));
      }
      shade[k] = sh;
    }
  if (wind) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < grid.n; k++) if (inSite[k]) { lo = Math.min(lo, proj[k]); hi = Math.max(hi, proj[k]); }
    for (let k = 0; k < grid.n; k++) breeze[k] = hi > lo ? clamp((proj[k] - lo) / (hi - lo)) : 0.5;
  }
  return { grid, inSite, setbackMask, noise, privacy, view, depth, breeze, shade, preserved };
}

export function sampleField(F, field, sLocal, tLocal) {
  const [i, j] = F.grid.cellOf(sLocal, tLocal);
  if (!F.grid.inBounds(i, j)) return 0;
  return F[field][F.grid.idx(i, j)];
}
