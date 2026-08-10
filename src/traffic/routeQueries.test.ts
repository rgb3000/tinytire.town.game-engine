import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { routeCoversCell, cellsBetween, splitAt } from './routeQueries';
import { SegmentKind } from './types';
import type { RouteInput } from './types';
import { LANE_OFFSET, TILE_SIZE } from '../constants';

/**
 * Cars drive on the right, so an eastbound lane sits below the tile centre line (screen y
 * grows downward). Expectations below use this, and the tile arithmetic beside it, rather
 * than reading back `route.points` or `route.cellDist` — a query that agreed with the
 * route it was handed would pass either way.
 */
const LANE_Y = TILE_SIZE / 2 + LANE_OFFSET;
/** Centre of tile `gx` along the x axis. */
const centreX = (gx: number): number => gx * TILE_SIZE + TILE_SIZE / 2;
/** Arc distance of the `i`th cell of a straight run: cell centres are one tile apart. */
const arcOfCell = (i: number): number => i * TILE_SIZE;
/** Arc length of a straight run of `n` cells: `n - 1` gaps between centres. */
const arcLength = (n: number): number => (n - 1) * TILE_SIZE;

/** A straight eastbound run of `n` road cells along y = 0, from gx=0 to gx=n-1. */
function straight(n: number): RouteInput {
  return {
    id: 'r1',
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: SegmentKind.Road,
        speedLimit: 40,
        pendingDeletion: false,
      })),
    }],
  };
}

/** Polyline length, so a split can be measured without consulting the route it came from. */
function polylineLength(pts: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

describe('cellsBetween', () => {
  it('returns every cell for the full arc range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, 0, arcLength(5))).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }, { gx: 4, gy: 0 },
    ]);
  });

  it('returns only cells at or before the arc for a travelled range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, 0, arcOfCell(2)).map(c => c.gx)).toEqual([0, 1, 2]);
  });

  it('returns only cells at or after the arc for a remaining range', () => {
    const route = buildRoute(straight(5))!;
    // Cell 2 sits exactly on the cut and belongs to both ranges: a car standing on a cell
    // still depends on it, whichever direction the caller is asking about.
    expect(cellsBetween(route, arcOfCell(2), arcLength(5)).map(c => c.gx)).toEqual([2, 3, 4]);
  });

  it('returns nothing for an inverted range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, arcLength(5), 0)).toEqual([]);
  });
});

describe('routeCoversCell', () => {
  it('finds a cell inside the range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 1, 0, 0, arcLength(5))).toBe(true);
  });

  it('rejects a cell outside the range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 4, 0, 0, arcOfCell(2))).toBe(false);
  });

  it('rejects a cell the route never visits', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 9, 9, 0, arcLength(5))).toBe(false);
  });

  it('rejects every cell for an inverted range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 1, 0, arcLength(5), 0)).toBe(false);
  });
});

describe('splitAt', () => {
  it('puts the whole route in remaining at arc 0', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, 0);
    // travelled is [points[0], cut] where cut === points[0]: a degenerate zero-length
    // stub. Drawing it is harmless; the invariant that matters is that `remaining`
    // carries the entire route.
    expect(travelled).toHaveLength(2);
    expect(polylineLength(travelled)).toBeCloseTo(0, 5);
    // A straight run is not smoothed, so it carries one point per cell.
    expect(remaining).toHaveLength(4);
    expect(remaining[0]).toEqual({ x: centreX(0), y: LANE_Y });
    expect(remaining[remaining.length - 1]).toEqual({ x: centreX(3), y: LANE_Y });
    expect(polylineLength(remaining)).toBeCloseTo(arcLength(4), 5);
  });

  it('puts the whole route in travelled at the far end', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, arcLength(4));
    expect(travelled).toHaveLength(4);
    expect(travelled[0]).toEqual({ x: centreX(0), y: LANE_Y });
    expect(polylineLength(travelled)).toBeCloseTo(arcLength(4), 5);
    // Mirror of the arc-0 case: `remaining` is the degenerate zero-length stub, both of
    // its points sitting on the route's final point.
    expect(remaining).toEqual([
      { x: centreX(3), y: LANE_Y },
      { x: centreX(3), y: LANE_Y },
    ]);
  });

  it('shares the split point between both halves', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, arcLength(4) / 2);
    expect(travelled[travelled.length - 1]).toEqual(remaining[0]);
    // Halfway along a three-tile straight is one and a half tiles past the first centre.
    expect(remaining[0].x).toBeCloseTo(centreX(0) + 1.5 * TILE_SIZE, 5);
    expect(remaining[0].y).toBeCloseTo(LANE_Y, 5);
  });

  it('loses no length across the split', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, arcLength(4) / 3);
    expect(polylineLength(travelled)).toBeCloseTo(arcLength(4) / 3, 5);
    expect(polylineLength(travelled) + polylineLength(remaining))
      .toBeCloseTo(arcLength(4), 5);
  });

  it('clamps an out-of-range arc rather than extrapolating', () => {
    const route = buildRoute(straight(4))!;
    expect(splitAt(route, -100).remaining[0]).toEqual({ x: centreX(0), y: LANE_Y });
    expect(splitAt(route, arcLength(4) + 100).travelled.at(-1))
      .toEqual({ x: centreX(3), y: LANE_Y });
  });
});
