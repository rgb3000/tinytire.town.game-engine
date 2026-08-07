import { describe, it, expect } from 'vitest';
import { buildCoverageField, sampleAt, SUBCELL } from './field';

describe('buildCoverageField', () => {
  it('returns null for no cells', () => {
    expect(buildCoverageField([])).toBeNull();
  });

  it('covers a full cell entirely', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    let inside = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i] > 0) inside++;
    expect(inside).toBe(SUBCELL * SUBCELL);
  });

  it('pads by one cell on every side', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    expect(f.originGx).toBe(4);
    expect(f.originGy).toBe(4);
    expect(f.width).toBe(3 * SUBCELL);
    expect(f.height).toBe(3 * SUBCELL);
  });

  it('leaves the border samples empty so contours always close', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    for (let x = 0; x < f.width; x++) {
      expect(sampleAt(f, x, 0)).toBe(0);
      expect(sampleAt(f, x, f.height - 1)).toBe(0);
    }
    for (let y = 0; y < f.height; y++) {
      expect(sampleAt(f, 0, y)).toBe(0);
      expect(sampleAt(f, f.width - 1, y)).toBe(0);
    }
  });

  it('gives a single quadrant about a quarter of the cell', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }], new Map([['5,5', { top: true }]]))!;
    let total = 0;
    for (let i = 0; i < f.data.length; i++) total += f.data[i];
    // A quarter of SUBCELL^2 = 4. Supersampling holds this within a rounding margin.
    expect(total).toBeGreaterThan(3.4);
    expect(total).toBeLessThan(4.6);
  });

  it('gives all four quadrants near-equal area', () => {
    // The regression test for point sampling, which skewed these to 2 / 4 / 4 / 6.
    const areas = (['top', 'right', 'bottom', 'left'] as const).map(q => {
      const f = buildCoverageField([{ gx: 5, gy: 5 }], new Map([['5,5', { [q]: true }]]))!;
      let total = 0;
      for (let i = 0; i < f.data.length; i++) total += f.data[i];
      return total;
    });
    for (const area of areas) {
      expect(area).toBeGreaterThan(3.4);
      expect(area).toBeLessThan(4.6);
    }
  });

  it('places the top quadrant above centre and the bottom quadrant below', () => {
    const top = buildCoverageField([{ gx: 0, gy: 0 }], new Map([['0,0', { top: true }]]))!;
    const bottom = buildCoverageField([{ gx: 0, gy: 0 }], new Map([['0,0', { bottom: true }]]))!;
    // Sample just inside the cell, above and below its centre.
    const above = { x: SUBCELL + 2, y: SUBCELL + 0 };
    const below = { x: SUBCELL + 2, y: SUBCELL + 3 };
    expect(sampleAt(top, above.x, above.y)).toBeGreaterThan(0.5);
    expect(sampleAt(top, below.x, below.y)).toBeLessThan(0.5);
    expect(sampleAt(bottom, above.x, above.y)).toBeLessThan(0.5);
    expect(sampleAt(bottom, below.x, below.y)).toBeGreaterThan(0.5);
  });

  it('treats all four flags set as a full cell', () => {
    const tri = new Map([['5,5', { top: true, right: true, bottom: true, left: true }]]);
    const f = buildCoverageField([{ gx: 5, gy: 5 }], tri)!;
    let inside = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i] > 0) inside++;
    expect(inside).toBe(SUBCELL * SUBCELL);
  });

  it('spans the bounding box of disjoint cells', () => {
    const f = buildCoverageField([{ gx: 2, gy: 3 }, { gx: 6, gy: 3 }])!;
    expect(f.originGx).toBe(1);
    expect(f.width).toBe(7 * SUBCELL); // cells 1..7 inclusive
  });
});
