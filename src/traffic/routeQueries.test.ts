import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { routeCoversCell, cellsBetween, splitAt } from './routeQueries';
import { SegmentKind } from './types';
import type { RouteCellInput, RouteInput, RouteSpan } from './types';
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

function roadCells(from: number, to: number): RouteCellInput[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    pos: { gx: from + i, gy: 0 },
    kind: SegmentKind.Road,
    speedLimit: 40,
    pendingDeletion: false,
  }));
}

/** A straight eastbound run of `n` road cells along y = 0, from gx=0 to gx=n-1. */
function straight(n: number): RouteInput {
  return { id: 'r1', spans: [{ kind: 'grid', cells: roadCells(0, n - 1) }] };
}

/** A straight eastbound highway polyline along the tile centre line. */
function highway(fromX: number, toX: number): RouteSpan {
  return {
    kind: 'highway',
    polyline: [{ x: fromX, y: TILE_SIZE / 2 }, { x: toX, y: TILE_SIZE / 2 }],
    speedLimit: 90,
  };
}

/**
 * Road out to the centre of tile 2, five tiles of highway, then road on from tile 7.
 *
 * The only fixture where `cells` is sparse against `points`: the highway contributes 200px
 * of arc and no cells at all. Arc distances are 0/40/80 for cells gx=0..2 and 280/320/360
 * for gx=7..9, over a route 360px long.
 */
function withHighway(): RouteInput {
  return {
    id: 'r1',
    spans: [
      { kind: 'grid', cells: roadCells(0, 2) },
      highway(centreX(2), centreX(7)),
      { kind: 'grid', cells: roadCells(7, 9) },
    ],
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

describe('cellsBetween for a car between two cell centres', () => {
  /**
   * A car 40% of the way from the centre of cell 2 towards cell 3. It is physically
   * standing on cell 2, which is what the `pathIndex` loops in `Game.tryRemoveRoad`
   * encoded: cell 2 is excluded from the cells behind it and included in the cells ahead.
   * Comparing arcs against cell *centres* gets the second of those backwards and hands a
   * homebound car's own cell to the road deleter.
   */
  const arc = arcOfCell(2) + 0.4 * TILE_SIZE;

  it('keeps the cell the car is standing on in its travelled range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, 0, arc).map(c => c.gx)).toEqual([0, 1, 2]);
  });

  it('keeps the cell the car is standing on in its remaining range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, arc, arcLength(5)).map(c => c.gx)).toEqual([2, 3, 4]);
  });

  it('reports the cell as covered in both directions', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 2, 0, 0, arc)).toBe(true);
    expect(routeCoversCell(route, 2, 0, arc, arcLength(5))).toBe(true);
  });

  it('drops the cell behind once the car is fully clear of it', () => {
    const route = buildRoute(straight(5))!;
    // Cell 1's extent ends at the midpoint between cells 1 and 2.
    const clear = arcOfCell(1) + 0.5 * TILE_SIZE + 0.01;
    expect(cellsBetween(route, clear, arcLength(5)).map(c => c.gx)).toEqual([2, 3, 4]);
    expect(routeCoversCell(route, 1, 0, clear, arcLength(5))).toBe(false);
  });
});

describe('cellsBetween across a highway span', () => {
  it('returns every grid cell for the full arc range, and only grid cells', () => {
    const route = buildRoute(withHighway())!;
    expect(cellsBetween(route, 0, 9 * TILE_SIZE).map(c => c.gx)).toEqual([0, 1, 2, 7, 8, 9]);
  });

  it('skips the stretch of route that contributes no cells', () => {
    const route = buildRoute(withHighway())!;
    // 100px in: still on the road approaching the on-ramp, nowhere near tile 7.
    expect(cellsBetween(route, 0, 100).map(c => c.gx)).toEqual([0, 1, 2]);
  });

  it('reports the flanking cell for a car out on the highway', () => {
    const route = buildRoute(withHighway())!;
    // Arc 150-170 lies inside the highway, which owns no cells. The midpoint rule
    // stretches the cells either side of it across that gap, so the last cell entered is
    // still reported. Over-including is the safe direction for the road deleter.
    expect(cellsBetween(route, 150, 170).map(c => c.gx)).toEqual([2]);
    expect(routeCoversCell(route, 2, 0, 150, 170)).toBe(true);
  });

  it('never reports a cell the highway merely flies over', () => {
    const route = buildRoute(withHighway())!;
    expect(routeCoversCell(route, 4, 0, 0, 9 * TILE_SIZE)).toBe(false);
    expect(routeCoversCell(route, 5, 0, 0, 9 * TILE_SIZE)).toBe(false);
  });
});

describe('routeCoversCell', () => {
  it('finds a cell inside the range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 1, 0, 0, arcLength(5))).toBe(true);
  });

  it('finds a cell inside a range that spans neither end of the route', () => {
    const route = buildRoute(straight(5))!;
    // A narrow window in the middle: neither bound is 0 or the route length, so a query
    // that only ever answers for the whole route cannot satisfy this.
    expect(routeCoversCell(route, 2, 0, arcOfCell(1), arcOfCell(3))).toBe(true);
    expect(routeCoversCell(route, 0, 0, arcOfCell(2), arcOfCell(3))).toBe(false);
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

  it('cuts inside a highway span, where the route has no cells to cut at', () => {
    const route = buildRoute(withHighway())!;
    // The highway runs from x=100 to x=300 and starts at arc 80, so arc 180 is 100px
    // along it: x=200, still on the lane centre line.
    const { travelled, remaining } = splitAt(route, 180);
    expect(travelled[travelled.length - 1]).toEqual({ x: 200, y: LANE_Y });
    expect(remaining[0]).toEqual({ x: 200, y: LANE_Y });
    expect(polylineLength(travelled)).toBeCloseTo(180, 5);
    expect(polylineLength(remaining)).toBeCloseTo(180, 5);
  });

  it('clamps an out-of-range arc rather than extrapolating', () => {
    const route = buildRoute(straight(4))!;
    expect(splitAt(route, -100).remaining[0]).toEqual({ x: centreX(0), y: LANE_Y });
    expect(splitAt(route, arcLength(4) + 100).travelled.at(-1))
      .toEqual({ x: centreX(3), y: LANE_Y });
  });
});
