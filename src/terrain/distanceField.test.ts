import { describe, it, expect } from 'vitest';
import type { TriangleMap } from './field';
import { buildCoverageField, SUBCELL } from './field';
import { buildSignedDistanceField, sampleFieldBilinear } from './distanceField';

function fieldFor(cells: { gx: number; gy: number }[]) {
  return buildSignedDistanceField(buildCoverageField(cells)!);
}

/** Value at an arbitrary point in grid units, where whole numbers are cell corners. */
function atGrid(f: ReturnType<typeof fieldFor>, gx: number, gy: number): number {
  return sampleFieldBilinear(f, (gx - f.originGx) * SUBCELL - 0.5, (gy - f.originGy) * SUBCELL - 0.5);
}

/** Value at the centre of the given cell. */
function atCellCentre(f: ReturnType<typeof fieldFor>, gx: number, gy: number): number {
  return atGrid(f, gx + 0.5, gy + 0.5);
}

/** How many samples the field calls inside. */
function positiveSamples(f: ReturnType<typeof fieldFor>): number {
  let n = 0;
  for (const v of f.data) if (v > 0) n++;
  return n;
}

/** Every cell in the inclusive grid rectangle. */
function block(x0: number, y0: number, x1: number, y1: number): { gx: number; gy: number }[] {
  const cells: { gx: number; gy: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push({ gx: x, gy: y });
  return cells;
}

describe('buildSignedDistanceField', () => {
  it('is positive inside terrain and negative outside', () => {
    const f = fieldFor([{ gx: 5, gy: 5 }]);
    expect(atCellCentre(f, 5, 5)).toBeGreaterThan(0);
    expect(atCellCentre(f, 4, 5)).toBeLessThan(0);
  });

  it('reports a single cell as roughly half a tile thick', () => {
    const f = fieldFor([{ gx: 5, gy: 5 }]);
    expect(f.maxInside).toBeGreaterThan(0.3);
    expect(f.maxInside).toBeLessThan(0.6);
  });

  it('grows with shape width', () => {
    const thin = fieldFor([
      { gx: 1, gy: 1 }, { gx: 2, gy: 1 }, { gx: 3, gy: 1 }, { gx: 4, gy: 1 },
    ]);
    const wide: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 6; x++) for (let y = 1; y <= 6; y++) wide.push({ gx: x, gy: y });
    expect(fieldFor(wide).maxInside).toBeGreaterThan(thin.maxInside * 2);
  });

  it('is symmetric about the centre of a square block', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 2; x <= 6; x++) for (let y = 2; y <= 6; y++) cells.push({ gx: x, gy: y });
    const f = fieldFor(cells);
    const left = atCellCentre(f, 3, 4);
    const right = atCellCentre(f, 5, 4);
    expect(Math.abs(left - right)).toBeLessThan(0.05);
  });

  it('shallows near an interior hole, so islands read correctly', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x === 4 && y === 4) continue; // the island
        cells.push({ gx: x, gy: y });
      }
    }
    const f = fieldFor(cells);
    const besideHole = atCellCentre(f, 3, 4);
    const awayFromHole = atCellCentre(f, 2, 2);
    expect(besideHole).toBeLessThan(awayFromHole);
  });

  it('gives each partly covered sample to the side that owns most of it', () => {
    // Only triangle-subdivided cells produce fractional coverage, so only they exercise the
    // majority rule: a top-only quadrant yields samples straddling half coverage.
    const triangles: TriangleMap = new Map([['5,5', { top: true }]]);
    const f = buildSignedDistanceField(buildCoverageField([{ gx: 5, gy: 5 }], triangles)!);

    // The painted quadrant is a quarter of a tile, so it should own a quarter of the cell's
    // samples. Awarding each straddling sample to the side covering most of it lands on that
    // true area give or take one sample; treating any non-zero coverage as inside would
    // instead claim the whole straddling ring and inflate the footprint.
    const trueArea = (SUBCELL * SUBCELL) / 4;
    expect(positiveSamples(f)).toBeGreaterThanOrEqual(trueArea - 1);
    expect(positiveSamples(f)).toBeLessThanOrEqual(trueArea + 1);
  });

  it('reads true distance from the painted boundary, with zero on the boundary itself', () => {
    // The block spans grid x 2..7, so its left edge is the line x = 2. Sampled at y = 4.5 the
    // nearest boundary is that edge and the distance is purely horizontal — a direction the
    // chamfer walks in exact unit steps — so the field should read off the ruler directly.
    const f = fieldFor(block(2, 2, 7, 7));
    const TOLERANCE = 0.02;
    expect(Math.abs(atGrid(f, 2.0, 4.5) - 0.0)).toBeLessThan(TOLERANCE);
    expect(Math.abs(atGrid(f, 2.5, 4.5) - 0.5)).toBeLessThan(TOLERANCE);
    expect(Math.abs(atGrid(f, 3.0, 4.5) - 1.0)).toBeLessThan(TOLERANCE);
    expect(Math.abs(atGrid(f, 1.5, 4.5) + 0.5)).toBeLessThan(TOLERANCE);
  });

  it('measures diagonal thickness as Euclidean distance, not as a Chebyshev step count', () => {
    // A square block cannot tell the two metrics apart, because its deepest point is reached
    // straight along an axis. A diamond's is reached diagonally: |x| + |y| <= R has inradius
    // R / sqrt(2), which a metric charging one per diagonal step reports as roughly R / 2.
    const R = 8;
    const C = 10;
    const cells = block(C - R, C - R, C + R, C + R).filter(
      (c) => Math.abs(c.gx - C) + Math.abs(c.gy - C) <= R,
    );
    const f = fieldFor(cells);

    // The chamfer approximates Euclidean distance to within a few percent; the wider 10% also
    // absorbs the staircase edge and the half-sample lattice offset.
    const trueInradius = R / Math.SQRT2;
    expect(f.maxInside).toBeGreaterThan(trueInradius * 0.9);
    expect(f.maxInside).toBeLessThan(trueInradius * 1.1);
  });
});
