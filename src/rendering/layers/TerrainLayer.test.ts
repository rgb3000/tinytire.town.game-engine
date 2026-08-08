import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../../constants';
import { buildTerrainContours, pointInPolygon } from '../../terrain';
import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { lakeFootprintLoops } from './TerrainLayer';

// `TerrainLayer.render` paints to a `CanvasRenderingContext2D` and builds a `Path2D`, neither
// of which exists in Node — but the decision that matters here is geometric, not painterly:
// *which* loops get punched out of the ground texture. That lives in `lakeFootprintLoops`,
// which is pure and returns plain point arrays. The canvas calls around it are a thin shell.

// ---------------------------------------------------------------------------- fixtures

/** A solid `size` x `size` lake, anchored at the grid origin. */
function block(size: number): GridPos[] {
  const cells: GridPos[] = [];
  for (let gx = 0; gx < size; gx++) {
    for (let gy = 0; gy < size; gy++) cells.push({ gx, gy });
  }
  return cells;
}

const RING_SIZE = 7;
const ISLAND_MIN = 2;
const ISLAND_MAX = 4;

/** 7x7 of water with the middle 3x3 left dry — the island case. */
function ringCells(): GridPos[] {
  return block(RING_SIZE).filter(
    c => !(c.gx >= ISLAND_MIN && c.gx <= ISLAND_MAX && c.gy >= ISLAND_MIN && c.gy <= ISLAND_MAX),
  );
}

/** Centre of the island square, in world pixels. */
const ISLAND_CENTRE = [
  ((ISLAND_MIN + ISLAND_MAX + 1) / 2) * TILE_SIZE,
  ((ISLAND_MIN + ISLAND_MAX + 1) / 2) * TILE_SIZE,
];

/** A point in open water, well inside the ring's left arm. */
const WATER_POINT = [0.5 * TILE_SIZE, 3.5 * TILE_SIZE];

/** How many of the returned loops contain a point — the even-odd rule's crossing count. */
function containment(loops: number[][][], point: number[]): number {
  return loops.filter(loop => pointInPolygon(point, loop)).length;
}

function bounds(loop: number[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of loop) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------- tests

describe('lakeFootprintLoops', () => {
  it('traces a solid lake as a single loop spanning its cells', () => {
    const loops = lakeFootprintLoops(block(4));

    expect(loops).toHaveLength(1);
    const { minX, minY, maxX, maxY } = bounds(loops[0]);
    // The level-0 isoline runs at majority coverage, within a subsample of the painted edge.
    const slack = TILE_SIZE / 2;
    expect(Math.abs(minX)).toBeLessThan(slack);
    expect(Math.abs(minY)).toBeLessThan(slack);
    expect(Math.abs(maxX - 4 * TILE_SIZE)).toBeLessThan(slack);
    expect(Math.abs(maxY - 4 * TILE_SIZE)).toBeLessThan(slack);
  });

  it('returns an island as a second loop, not as part of the outer one', () => {
    const loops = lakeFootprintLoops(ringCells());

    expect(loops).toHaveLength(2);
    const [big, small] = [...loops].sort((a, b) => {
      const ab = bounds(a), bb = bounds(b);
      return (bb.maxX - bb.minX) - (ab.maxX - ab.minX);
    });
    const smallBounds = bounds(small);
    const bigBounds = bounds(big);
    expect(smallBounds.minX).toBeGreaterThan(bigBounds.minX);
    expect(smallBounds.maxX).toBeLessThan(bigBounds.maxX);
  });

  it('leaves the island opaque under the even-odd rule', () => {
    const loops = lakeFootprintLoops(ringCells());

    // Even crossing count = outside the filled region = ground survives the punch-out.
    expect(containment(loops, ISLAND_CENTRE) % 2).toBe(0);
    // Odd = inside = the hole is cut and the water mesh shows through.
    expect(containment(loops, WATER_POINT) % 2).toBe(1);
  });

  it('matches the footprint LakeLayer builds its mesh from', () => {
    const cells = ringCells();
    // 0.15 is `LakeLayer`'s SHORELINE_TILES. It traces one extra contour *outside* the
    // footprint and must not shift level 0 — if it did, the ground hole and the water mesh
    // would part company and every shoreline would show a seam.
    const contours = buildTerrainContours(cells, undefined, 0.15)!;
    const expected = contours.levels[0].polygons.flatMap(p => [p.outer, ...p.holes]);

    expect(lakeFootprintLoops(cells)).toEqual(expected);
  });

  it('is empty when there are no cells', () => {
    expect(lakeFootprintLoops([])).toEqual([]);
  });

  it('is empty when triangle flags activate no quadrant', () => {
    // The map format allows this: `top: false` is an explicitly-present flag, so the cell is
    // registered as a lake cell yet rasterises to nothing. `buildTerrainContours` returns null.
    const triangles: LakeTriangles = new Map([['3,3', { top: false }]]);

    expect(lakeFootprintLoops([{ gx: 3, gy: 3 }], triangles)).toEqual([]);
  });
});
