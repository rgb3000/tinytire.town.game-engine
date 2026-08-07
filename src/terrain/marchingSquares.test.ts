import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../constants';
import { SUBCELL, buildCoverageField } from './field';
import { buildSignedDistanceField, type SignedField } from './distanceField';
import { traceIsolines } from './marchingSquares';

function trace(cells: { gx: number; gy: number }[], threshold = 0) {
  return traceIsolines(buildSignedDistanceField(buildCoverageField(cells)!), threshold);
}

function isClosed(loop: number[][]): boolean {
  const a = loop[0];
  const b = loop[loop.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function bounds(loop: number[][]) {
  const xs = loop.map(p => p[0]);
  const ys = loop.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('traceIsolines', () => {
  it('produces one closed loop for a single cell', () => {
    const loops = trace([{ gx: 5, gy: 5 }]);
    expect(loops).toHaveLength(1);
    expect(isClosed(loops[0])).toBe(true);
  });

  it('every emitted loop is closed', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 6; x++) for (let y = 1; y <= 4; y++) cells.push({ gx: x, gy: y });
    for (const loop of trace(cells)) expect(isClosed(loop)).toBe(true);
  });

  it('traces a painted square close to its painted bounds', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 2; x <= 5; x++) for (let y = 2; y <= 5; y++) cells.push({ gx: x, gy: y });
    const loops = trace(cells);
    expect(loops).toHaveLength(1);
    const b = bounds(loops[0]);
    const tol = TILE_SIZE * 0.3;
    expect(Math.abs(b.minX - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.maxX - 6 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.minY - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.maxY - 6 * TILE_SIZE)).toBeLessThan(tol);
  });

  it('traces a ring as two loops, not one filled disc', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x >= 3 && x <= 5 && y >= 3 && y <= 5) continue;
        cells.push({ gx: x, gy: y });
      }
    }
    const loops = trace(cells);
    expect(loops).toHaveLength(2);
    for (const loop of loops) expect(isClosed(loop)).toBe(true);
  });

  it('traces two disjoint blobs as two loops', () => {
    const loops = trace([{ gx: 2, gy: 2 }, { gx: 8, gy: 2 }]);
    expect(loops).toHaveLength(2);
  });

  it('resolves a diagonal pinch without dropping or duplicating a loop', () => {
    // Two cells touching only at a corner — the configuration the old walker tangled on.
    const loops = trace([{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }]);
    expect(loops.length).toBeGreaterThanOrEqual(1);
    for (const loop of loops) {
      expect(isClosed(loop)).toBe(true);
      expect(loop.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('shrinks inward as the threshold rises', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 8; x++) for (let y = 1; y <= 8; y++) cells.push({ gx: x, gy: y });
    const outer = bounds(trace(cells, 0)[0]);
    const inner = bounds(trace(cells, 1.0)[0]);
    expect(inner.minX).toBeGreaterThan(outer.minX);
    expect(inner.maxX).toBeLessThan(outer.maxX);
  });

  it('returns nothing when the threshold exceeds the shape thickness', () => {
    expect(trace([{ gx: 5, gy: 5 }], 5)).toHaveLength(0);
  });

  it('never visits a crossing twice, within or across loops', () => {
    // Each edge carries at most one crossing and every crossing has degree 2, so a correct
    // walk uses each exactly once. A repeated vertex is the signature of the tangling the
    // old segment chainer produced. Includes a freehand diagonal stroke, its worst case.
    const diagonal = [1, 2, 3, 4, 5].map(n => ({ gx: n, gy: n }));
    const ring: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x >= 3 && x <= 5 && y >= 3 && y <= 5) continue;
        ring.push({ gx: x, gy: y });
      }
    }
    for (const cells of [diagonal, ring, [{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }]]) {
      const seen = new Set<string>();
      for (const loop of trace(cells)) {
        // The repeated closing point is not a fresh visit, so stop one short of the end.
        for (let i = 0; i < loop.length - 1; i++) {
          const key = `${loop[i][0]},${loop[i][1]}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('places crossings by linear interpolation, not at the edge midpoint', () => {
    // One sample inside at +3 surrounded by -1, so the zero crossing sits a quarter of the
    // way in from each outside neighbour, not halfway.
    const width = 3, height = 3;
    const data = new Float32Array(width * height).fill(-1);
    data[1 * width + 1] = 3;
    const field: SignedField = { width, height, originGx: 0, originGy: 0, data, maxInside: 3 };

    const loops = traceIsolines(field, 0);
    expect(loops).toHaveLength(1);

    const t = (0 - -1) / (3 - -1);
    expect(t).toBe(0.25);
    // Sample index 0 -> 1 on both axes, so the leading crossings sit at sample 0.25.
    const interpolated = ((0.25 + 0.5) / SUBCELL) * TILE_SIZE;
    const midpoint = ((0.5 + 0.5) / SUBCELL) * TILE_SIZE;
    const xs = loops[0].map(p => p[0]);
    const ys = loops[0].map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(interpolated, 9);
    expect(Math.min(...ys)).toBeCloseTo(interpolated, 9);
    // Confirm the assertions can actually tell interpolation from the midpoint answer.
    expect(Math.min(...xs)).not.toBeCloseTo(midpoint, 9);
    expect(Math.min(...ys)).not.toBeCloseTo(midpoint, 9);
  });

  it('steps between adjacent crossings that share a cell, including back to the start', () => {
    // Two crossings can only be linked if one cell holds both, so no step may exceed a
    // cell diagonal. Checking the closing step too is what makes closure meaningful:
    // `isClosed` alone cannot fail, because the walk always appends its first point.
    const step = TILE_SIZE / SUBCELL;
    const limit = step * Math.SQRT2 + 1e-9;
    const ring: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x >= 3 && x <= 5 && y >= 3 && y <= 5) continue;
        ring.push({ gx: x, gy: y });
      }
    }
    const fixtures = [
      [{ gx: 5, gy: 5 }],
      ring,
      [1, 2, 3, 4, 5].map(n => ({ gx: n, gy: n })),
      [{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }],
      [{ gx: 2, gy: 2 }, { gx: 3, gy: 2 }, { gx: 2, gy: 3 }],
    ];
    for (const cells of fixtures) {
      const loops = trace(cells);
      expect(loops.length).toBeGreaterThan(0);
      for (const loop of loops) {
        for (let i = 1; i < loop.length; i++) {
          const dx = loop[i][0] - loop[i - 1][0];
          const dy = loop[i][1] - loop[i - 1][1];
          expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(limit);
        }
      }
    }
  });

  describe('saddle resolution', () => {
    /**
     * Two 2x2 inside blocks meeting corner-to-corner at one ambiguous cell. `main` puts
     * them on the leading diagonal, which makes that cell case 5; the anti-diagonal makes
     * it case 10. Both must be resolved, so both are covered.
     */
    function diagonalBlocks(inside: number, outside: number, main: boolean): SignedField {
      const width = 6, height = 6;
      const data = new Float32Array(width * height).fill(outside);
      const blocks = main ? [[1, 1], [3, 3]] : [[3, 1], [1, 3]];
      for (const [bx, by] of blocks) {
        for (let y = by; y < by + 2; y++) for (let x = bx; x < bx + 2; x++) data[y * width + x] = inside;
      }
      return { width, height, originGx: 0, originGy: 0, data, maxInside: inside };
    }

    for (const main of [true, false]) {
      const label = main ? 'case 5' : 'case 10';

      it(`joins the two inside corners when the centre average is inside (${label})`, () => {
        // Corner average is (3 - 1 + 3 - 1) / 4 = +1, so the blocks are one region.
        const loops = traceIsolines(diagonalBlocks(3, -1, main), 0);
        expect(loops).toHaveLength(1);
        expect(isClosed(loops[0])).toBe(true);
      });

      it(`keeps the two inside corners apart when the centre average is outside (${label})`, () => {
        // Corner average is (1 - 3 + 1 - 3) / 4 = -1, so the blocks are two regions.
        const loops = traceIsolines(diagonalBlocks(1, -3, main), 0);
        expect(loops).toHaveLength(2);
        for (const loop of loops) expect(isClosed(loop)).toBe(true);
      });
    }

    it('treats a centre average of exactly the threshold as inside', () => {
      // Two cells touching only at a corner average to exactly 0 at the saddle, and `>=`
      // resolves that tie inside — so a diagonal stroke reads as one connected blob.
      expect(trace([{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }])).toHaveLength(1);
    });
  });
});
