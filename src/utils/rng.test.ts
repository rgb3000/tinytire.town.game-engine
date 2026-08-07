import { describe, it, expect } from 'vitest';
import { mulberry32 } from './rng';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('stays within [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('matches known mulberry32 output vectors', () => {
    // Pinned against the canonical implementation. These exact values feed terrain
    // generation, so a change here is a change to every generated map.
    expect(mulberry32(0)()).toBe(0.26642920868471265);
    const rng = mulberry32(12345);
    expect(rng()).toBe(0.9797282677609473);
    expect(rng()).toBe(0.3067522644996643);
    expect(rng()).toBe(0.484205421525985);
  });

  it('is roughly uniform', () => {
    const rng = mulberry32(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(rng() * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});
