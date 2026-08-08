import { describe, it, expect } from 'vitest';
import { traceDragCells, DRAG_CORNER_TOLERANCE_RATIO } from './dragTrace';
import type { GridPos } from '../types';

const TILE = 40;

function isKingPath(cells: GridPos[], start: GridPos): boolean {
  let prev = start;
  for (const c of cells) {
    const dx = Math.abs(c.gx - prev.gx);
    const dy = Math.abs(c.gy - prev.gy);
    if (Math.max(dx, dy) !== 1) return false;
    prev = c;
  }
  return true;
}

describe('traceDragCells', () => {
  it('returns empty for a zero-length segment', () => {
    expect(traceDragCells(60, 60, 60, 60, TILE)).toEqual([]);
  });

  it('returns empty while the cursor stays inside the start cell', () => {
    // Jitter near the cell corner — the original bug's trigger geometry
    expect(traceDragCells(35, 35, 38, 33, TILE)).toEqual([]);
  });

  it('traces cardinal steps for a horizontal drag across three cells', () => {
    expect(traceDragCells(20, 20, 140, 20, TILE)).toEqual([
      { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 },
    ]);
  });

  it('traces cardinal steps for a vertical drag across three cells', () => {
    expect(traceDragCells(20, 20, 20, 140, TILE)).toEqual([
      { gx: 0, gy: 1 }, { gx: 0, gy: 2 }, { gx: 0, gy: 3 },
    ]);
  });

  it('emits diagonals for a 45-degree drag through cell centers', () => {
    expect(traceDragCells(20, 20, 140, 140, TILE)).toEqual([
      { gx: 1, gy: 1 }, { gx: 2, gy: 2 }, { gx: 3, gy: 3 },
    ]);
  });

  it('staircases a 45-degree drag through edge midpoints', () => {
    // Line y = x + 20 stays 20/sqrt(2) ≈ 14.1 px from every corner (tolerance is 10)
    const cells = traceDragCells(10, 30, 90, 110, TILE);
    expect(cells).toEqual([
      { gx: 0, gy: 1 }, { gx: 1, gy: 1 }, { gx: 1, gy: 2 }, { gx: 2, gy: 2 },
    ]);
    expect(isKingPath(cells, { gx: 0, gy: 0 })).toBe(true);
  });

  it('steps diagonally iff the segment passes within tolerance of the corner', () => {
    // 45° lines offset so their perpendicular distance to corner (40,40) is 9 / 11 px
    const near = 9 * Math.SQRT2;
    const far = 11 * Math.SQRT2;
    expect(traceDragCells(20, 20 + near, 60, 60 + near, TILE)).toEqual([
      { gx: 1, gy: 1 },
    ]);
    expect(traceDragCells(20, 20 + far, 60, 60 + far, TILE)).toEqual([
      { gx: 0, gy: 1 }, { gx: 1, gy: 1 },
    ]);
  });

  it('turns a shallow drag into cardinal runs with a diagonal transition', () => {
    // Slope 1/4 from cell center (0,0) to cell center (4,1): the row change
    // passes within tolerance of corner (80,40) → single diagonal step there.
    expect(traceDragCells(20, 20, 180, 60, TILE)).toEqual([
      { gx: 1, gy: 0 }, { gx: 2, gy: 1 }, { gx: 3, gy: 1 }, { gx: 4, gy: 1 },
    ]);
  });

  it('covers a long fast drag with a connected king path ending at the end cell', () => {
    const cells = traceDragCells(20, 20, 20 + 15 * TILE, 20 + 7 * TILE, TILE);
    expect(isKingPath(cells, { gx: 0, gy: 0 })).toBe(true);
    expect(cells[cells.length - 1]).toEqual({ gx: 15, gy: 7 });
    expect(cells.length).toBeGreaterThanOrEqual(15);
    expect(cells.length).toBeLessThanOrEqual(22);
  });

  it('keeps floor semantics for endpoints exactly on grid lines', () => {
    // Rightward: start on the line belongs to cell 1, end on the line to cell 2
    expect(traceDragCells(40, 20, 80, 20, TILE)).toEqual([{ gx: 2, gy: 0 }]);
    // Leftward: start on the line belongs to cell 2, end on the line to cell 1
    expect(traceDragCells(80, 20, 40, 20, TILE)).toEqual([{ gx: 1, gy: 0 }]);
  });

  it('visits the same cells when the drag is reversed', () => {
    const fwd = traceDragCells(25, 35, 230, 150, TILE);
    const back = traceDragCells(230, 150, 25, 35, TILE);
    const key = (c: GridPos) => `${c.gx},${c.gy}`;
    const fwdSet = new Set([...fwd.map(key), '0,0']);
    const backSet = new Set([...back.map(key), '5,3']);
    expect(backSet).toEqual(fwdSet);
  });

  it('traces through negative world coordinates without clamping', () => {
    expect(traceDragCells(-30, 20, 90, 20, TILE)).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 },
    ]);
  });

  it('exports the corner tolerance ratio used by default', () => {
    expect(DRAG_CORNER_TOLERANCE_RATIO).toBeCloseTo(0.25);
  });
});
