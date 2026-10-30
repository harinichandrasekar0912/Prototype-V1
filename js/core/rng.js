// Seeded random numbers. Every generator in the engine takes a seed so an option can be
// reproduced exactly from (inputs, seed). "Generate three more" simply advances the seed.

export function makeRng(seed = 1) {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()), // inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    gauss: () => {
      const u = Math.max(next(), 1e-9), v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
