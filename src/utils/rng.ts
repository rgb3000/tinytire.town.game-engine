/**
 * A small deterministic PRNG, used so terrain generation can be pinned in tests.
 *
 * The engine previously called `Math.random()` directly everywhere, which meant generated
 * terrain could not be asserted on at all. `ObstacleSystem` takes a seed and threads this
 * through instead. It is a *generation* seed, not a wire-format field: maps do not carry
 * one, and unseeded construction still randomises so gameplay stays varied.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
