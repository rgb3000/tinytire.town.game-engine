import { describe, it, expect } from 'vitest';
import { buildCoverageField, SUBCELL } from './field';
import { buildSignedDistanceField, sampleFieldBilinear } from './distanceField';

function fieldFor(cells: { gx: number; gy: number }[]) {
  return buildSignedDistanceField(buildCoverageField(cells)!);
}

/** Value at the centre of the given cell. */
function atCellCentre(f: ReturnType<typeof fieldFor>, gx: number, gy: number): number {
  const sx = (gx - f.originGx) * SUBCELL + SUBCELL / 2 - 0.5;
  const sy = (gy - f.originGy) * SUBCELL + SUBCELL / 2 - 0.5;
  return sampleFieldBilinear(f, sx, sy);
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
});
