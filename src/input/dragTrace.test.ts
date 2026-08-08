import { describe, it, expect } from 'vitest';
import { DragTracer, DRAG_DIAGONAL_HOLD_RATIO } from './dragTrace';
import type { GridPos } from '../types';

const TILE = 40;

/** Run a full drag through a tracer: advance through all points, flush on the last. */
function trace(points: Array<[number, number]>): GridPos[] {
  const [first, ...rest] = points;
  const tracer = new DragTracer(first[0], first[1], TILE);
  const out: GridPos[] = [];
  for (let i = 0; i < rest.length - 1; i++) {
    out.push(...tracer.advance(rest[i][0], rest[i][1]));
  }
  const last = rest.length > 0 ? rest[rest.length - 1] : first;
  out.push(...tracer.flush(last[0], last[1]));
  return out;
}

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

describe('DragTracer', () => {
  it('emits nothing for a zero-length drag', () => {
    expect(trace([[60, 60], [60, 60]])).toEqual([]);
  });

  it('emits nothing while the cursor jitters inside the start cell', () => {
    // Wiggling near the cell corner — the original bug's trigger geometry
    expect(trace([[35, 35], [38, 33], [35, 36], [37, 34]])).toEqual([]);
  });

  it('traces cardinal steps for a horizontal drag across three cells', () => {
    expect(trace([[20, 20], [140, 20]])).toEqual([
      { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 },
    ]);
  });

  it('traces cardinal steps for a vertical drag across three cells', () => {
    expect(trace([[20, 20], [20, 140]])).toEqual([
      { gx: 0, gy: 1 }, { gx: 0, gy: 2 }, { gx: 0, gy: 3 },
    ]);
  });

  it('emits diagonals for a 45-degree drag through cell centers', () => {
    expect(trace([[20, 20], [140, 140]])).toEqual([
      { gx: 1, gy: 1 }, { gx: 2, gy: 2 }, { gx: 3, gy: 3 },
    ]);
  });

  it('emits diagonals for a 45-degree drag offset from the corners', () => {
    // Through edge midpoints — maximum distance from every lattice corner
    expect(trace([[10, 30], [90, 110]])).toEqual([
      { gx: 1, gy: 1 }, { gx: 2, gy: 2 },
    ]);
  });

  it('emits diagonals for a slow 45-degree drag fed in tiny increments', () => {
    // Regression: small per-frame segments split the two crossings of a
    // diagonal across separate advance() calls; pairing must span them.
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) points.push([10 + i * 4, 30 + i * 4]);
    expect(trace(points)).toEqual([
      { gx: 1, gy: 1 }, { gx: 2, gy: 2 },
    ]);
  });

  it('keeps a deliberate L-turn as two cardinal runs', () => {
    expect(trace([[20, 20], [100, 20], [100, 100]])).toEqual([
      { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 2, gy: 1 }, { gx: 2, gy: 2 },
    ]);
  });

  it('commits a cardinal crossing in the same advance that produced it', () => {
    // Straight drags must not lag behind the cursor: barely 5px into the
    // next cell, the step is already out.
    const tracer = new DragTracer(20, 20, TILE);
    expect(tracer.advance(20, 45)).toEqual([{ gx: 0, gy: 1 }]);
  });

  it('swallows jitter across a cell boundary while heading diagonally', () => {
    // A diagonal drag wobbling briefly across a line it already crossed
    // cancels the crossing instead of emitting a step pair
    const tracer = new DragTracer(30, 10, TILE);
    const out = [
      ...tracer.advance(44, 24),  // crosses x=40 heading diagonally — held
      ...tracer.advance(38, 30),  // wobbles back across x=40 — cancelled
      ...tracer.flush(38, 30),
    ];
    expect(out).toEqual([]);
  });

  it('covers a long fast drag with a connected king path ending at the end cell', () => {
    const cells = trace([[20, 20], [20 + 15 * TILE, 20 + 7 * TILE]]);
    expect(isKingPath(cells, { gx: 0, gy: 0 })).toBe(true);
    expect(cells[cells.length - 1]).toEqual({ gx: 15, gy: 7 });
    expect(cells.length).toBeGreaterThanOrEqual(15);
    expect(cells.length).toBeLessThanOrEqual(22);
  });

  it('keeps floor semantics for endpoints exactly on grid lines', () => {
    // Rightward: start on the line belongs to cell 1, end on the line to cell 2
    expect(trace([[40, 20], [80, 20]])).toEqual([{ gx: 2, gy: 0 }]);
    // Leftward: start on the line belongs to cell 2, end on the line to cell 1
    expect(trace([[80, 20], [40, 20]])).toEqual([{ gx: 1, gy: 0 }]);
  });

  it('holds crossings long enough to pair any 45-degree lattice offset', () => {
    // Crossing pairs on a 45° line sit up to tile/√2 apart in arc length
    expect(DRAG_DIAGONAL_HOLD_RATIO).toBeGreaterThan(Math.SQRT1_2);
  });
});
