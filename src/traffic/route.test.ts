import { describe, it, expect } from 'vitest';
import { buildRoute, sampleRoute, speedLimitAt } from './route';
import { SegmentKind } from './types';
import type { RouteCellInput, RouteInput, RouteSpan } from './types';
import { LANE_OFFSET, TILE_SIZE } from '../constants';

/**
 * Cars drive on the right, so an eastbound lane sits below the tile centre line (screen y
 * grows downward). Expectations below use this rather than reading `route.points`, so a
 * sign error in the lane offset cannot pass by agreeing with itself.
 */
const LANE_Y = TILE_SIZE / 2 + LANE_OFFSET;
/** Centre of tile `gx` along the x axis. */
const centreX = (gx: number): number => gx * TILE_SIZE + TILE_SIZE / 2;

function roadCells(from: number, to: number, speed = 40): RouteCellInput[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    pos: { gx: from + i, gy: 0 },
    kind: SegmentKind.Road,
    speedLimit: speed,
    pendingDeletion: false,
  }));
}

/** A straight run of road cells along y = 0, from gx=0 to gx=n-1. */
function straightRoad(n: number, speed = 40): RouteInput {
  return { id: 'r1', spans: [{ kind: 'grid', cells: roadCells(0, n - 1, speed) }] };
}

function route(spans: RouteSpan[]): RouteInput {
  return { id: 'r1', spans };
}

/** A straight eastbound highway polyline along the tile centre line. */
function highway(fromX: number, toX: number, speedLimit = 90): RouteSpan {
  return {
    kind: 'highway',
    polyline: [{ x: fromX, y: TILE_SIZE / 2 }, { x: toX, y: TILE_SIZE / 2 }],
    speedLimit,
  };
}

/** Every segment starts where the previous one ended, with no gap and no overlap. */
function expectContiguousSegments(r: NonNullable<ReturnType<typeof buildRoute>>): void {
  expect(r.segments[0].startArc).toBeCloseTo(0, 5);
  for (let i = 1; i < r.segments.length; i++) {
    expect(r.segments[i].startArc).toBeCloseTo(r.segments[i - 1].endArc, 5);
  }
  expect(r.segments[r.segments.length - 1].endArc).toBeCloseTo(r.length, 5);
}

describe('buildRoute', () => {
  it('returns null for a span with fewer than two cells', () => {
    expect(buildRoute(straightRoad(1))).toBeNull();
  });

  it('records one cell entry per input cell, in order', () => {
    const r = buildRoute(straightRoad(4))!;
    expect(r.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 },
    ]);
    expect(r.cellDist).toHaveLength(4);
  });

  it('spans three tiles of arc length across four cell centres', () => {
    const r = buildRoute(straightRoad(4))!;
    expect(r.length).toBeCloseTo(3 * TILE_SIZE, 5);
  });

  it('gives strictly increasing cell distances', () => {
    const r = buildRoute(straightRoad(6))!;
    for (let i = 1; i < r.cellDist.length; i++) {
      expect(r.cellDist[i]).toBeGreaterThan(r.cellDist[i - 1]);
    }
  });

  it('covers the whole route with contiguous segments', () => {
    expectContiguousSegments(buildRoute(straightRoad(4))!);
  });
});

describe('buildRoute across adjacent grid spans', () => {
  /** Two grid spans meeting at a shared joint cell (2,0). */
  const adjacent = route([
    { kind: 'grid', cells: roadCells(0, 2) },
    { kind: 'grid', cells: roadCells(2, 4) },
  ]);

  it('records the shared joint cell exactly once', () => {
    const r = buildRoute(adjacent)!;
    expect(r.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }, { gx: 4, gy: 0 },
    ]);
  });

  it('keeps cell distances strictly increasing across the joint', () => {
    const r = buildRoute(adjacent)!;
    for (let i = 1; i < r.cellDist.length; i++) {
      expect(r.cellDist[i]).toBeGreaterThan(r.cellDist[i - 1]);
    }
    expect(r.cellDist).toEqual([0, 40, 80, 120, 160]);
  });

  it('measures the joined route as one continuous curve', () => {
    const r = buildRoute(adjacent)!;
    expect(r.length).toBeCloseTo(4 * TILE_SIZE, 5);
    expectContiguousSegments(r);
  });
});

describe('buildRoute across a highway span', () => {
  /** Road out to x=100, 200px of highway, then road on from x=300. */
  const mixed = route([
    { kind: 'grid', cells: roadCells(0, 2) },
    highway(centreX(2), centreX(7)),
    { kind: 'grid', cells: roadCells(7, 9) },
  ]);

  it('accumulates arc length continuously through the highway', () => {
    const r = buildRoute(mixed)!;
    expect(r.length).toBeCloseTo(9 * TILE_SIZE, 5);
  });

  it('records only grid cells, keeping distances strictly increasing', () => {
    const r = buildRoute(mixed)!;
    expect(r.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 },
      { gx: 7, gy: 0 }, { gx: 8, gy: 0 }, { gx: 9, gy: 0 },
    ]);
    expect(r.cellDist).toEqual([0, 40, 80, 280, 320, 360]);
  });

  it('joins road and highway segments with no gap', () => {
    const r = buildRoute(mixed)!;
    expectContiguousSegments(r);
    const hw = r.segments.filter(s => s.kind === SegmentKind.Highway);
    expect(hw).toHaveLength(1);
    expect(hw[0].startArc).toBeCloseTo(80, 5);
    expect(hw[0].endArc).toBeCloseTo(280, 5);
  });

  it('applies the highway speed limit only inside the highway', () => {
    const r = buildRoute(mixed)!;
    expect(speedLimitAt(r, 40)).toBe(40);
    expect(speedLimitAt(r, 180)).toBe(90);
    expect(speedLimitAt(r, 320)).toBe(40);
  });

  it('offsets the highway into the right-hand lane like the road', () => {
    const r = buildRoute(mixed)!;
    expect(sampleRoute(r, 180).y).toBeCloseTo(LANE_Y, 5);
  });

  it('raises elevation over the highway and leaves the road flat', () => {
    const r = buildRoute(mixed)!;
    // Peak of a 200px highway: GROUND_Y_POSITION + (HIGHWAY_PEAK_Y - GROUND_Y_POSITION).
    expect(sampleRoute(r, 180).elevationY).toBeCloseTo(45, 5);
    // Ends of the profile sit at ground level; plain road has no profile at all.
    expect(sampleRoute(r, 80.001).elevationY).toBeCloseTo(1.75, 2);
    expect(sampleRoute(r, 279.999).elevationY).toBeCloseTo(1.75, 2);
    expect(sampleRoute(r, 40).elevationY).toBe(0);
    expect(sampleRoute(r, 320).elevationY).toBe(0);
  });

  it('resolves an exact segment boundary to the earlier segment', () => {
    const r = buildRoute(mixed)!;
    // The arc where road meets highway belongs to both. Ties go to the segment that ends
    // there, so the entry point still reads as road. Flipping that convention is a
    // behaviour change, not a refactor — this test is here to say so.
    expect(speedLimitAt(r, 80)).toBe(40);
    expect(sampleRoute(r, 80).elevationY).toBe(0);
  });
});

describe('buildRoute rejects input that cannot form one curve', () => {
  it('accepts a joint gap within a tile, since lane offsets differ slightly', () => {
    const r = buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      highway(centreX(2) + TILE_SIZE - 1, centreX(7)),
    ]));
    expect(r).not.toBeNull();
  });

  it('returns null when a joint gap exceeds a tile', () => {
    expect(buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      highway(centreX(2) + TILE_SIZE + 1, centreX(7)),
    ]))).toBeNull();
  });

  it('returns null for a far-away highway rather than a phantom straight line', () => {
    expect(buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      { kind: 'highway', polyline: [{ x: 1000, y: 1000 }, { x: 1200, y: 1000 }], speedLimit: 90 },
    ]))).toBeNull();
  });

  it('returns null for a degenerate span rather than splicing across it', () => {
    // The spans either side of the one-cell span meet exactly, so dropping it would leave
    // a route that looks perfectly well formed. Only refusing the span itself catches this.
    expect(buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      { kind: 'grid', cells: roadCells(2, 2) },
      { kind: 'grid', cells: roadCells(2, 4) },
    ]))).toBeNull();
  });

  it('returns null for a degenerate highway span', () => {
    expect(buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      { kind: 'highway', polyline: [{ x: centreX(2), y: TILE_SIZE / 2 }], speedLimit: 90 },
      { kind: 'grid', cells: roadCells(2, 4) },
    ]))).toBeNull();
  });
});

describe('buildRoute with cells carried by a crossing', () => {
  /**
   * A grid run of one cell is not a span — one cell is a point, not a curve — so the
   * adapter folds it into the crossing beside it and hands the cell over as `entryCell` or
   * `exitCell`. What that has to buy is a place in `cells`: `LaneIndex` keys a vehicle by an
   * edge between two of them, so a route with fewer than two is one no lane can hold.
   */
  function carried(span: Partial<{ entryCell: { gx: number; gy: number }; exitCell: { gx: number; gy: number } }>): RouteSpan {
    return { ...highway(centreX(0), centreX(4)) as Extract<RouteSpan, { kind: 'highway' }>, ...span };
  }

  it('records a carried cell at the crossing arc it sits on', () => {
    const r = buildRoute(route([carried({ entryCell: { gx: 0, gy: 0 }, exitCell: { gx: 4, gy: 0 } })]))!;
    expect(r.cells).toEqual([{ gx: 0, gy: 0 }, { gx: 4, gy: 0 }]);
    expect(r.cellDist[0]).toBeCloseTo(0, 5);
    expect(r.cellDist[1]).toBeCloseTo(r.length, 5);
  });

  it('gives a carried cell no geometry and no segment of its own', () => {
    // The cell lies on the crossing's own terminal point, and the arc it would govern is the
    // span boundary — which `segmentIndexAt` resolves to the neighbouring span regardless.
    // A segment for it would be a zero-length one no lookup can ever select.
    const plain = buildRoute(route([highway(centreX(0), centreX(4))]))!;
    const withCells = buildRoute(route([carried({ entryCell: { gx: 0, gy: 0 }, exitCell: { gx: 4, gy: 0 } })]))!;
    expect(withCells.points).toEqual(plain.points);
    expect(withCells.length).toBeCloseTo(plain.length, 9);
    expect(withCells.segments).toEqual(plain.segments);
    expectContiguousSegments(withCells);
  });

  it('does not record a carried exit cell twice when a grid span continues from it', () => {
    // The joint cell belongs to both spans and must appear once, or `cellDist` stops being
    // strictly increasing — which `edgeIndexAt` and `cellStartArc` both divide by.
    const r = buildRoute(route([
      carried({ exitCell: { gx: 4, gy: 0 } }),
      { kind: 'grid', cells: roadCells(4, 6) },
    ]))!;
    expect(r.cells).toEqual([{ gx: 4, gy: 0 }, { gx: 5, gy: 0 }, { gx: 6, gy: 0 }]);
    for (let i = 1; i < r.cellDist.length; i++) {
      expect(r.cellDist[i], `cellDist[${i}]`).toBeGreaterThan(r.cellDist[i - 1]);
    }
  });

  it('still refuses a cell a grid span already recorded', () => {
    // The mirror of the case above: a crossing whose entry cell is the joint a preceding
    // grid span already ends on. One entry, and the arcs stay ordered.
    const r = buildRoute(route([
      { kind: 'grid', cells: roadCells(0, 2) },
      { ...highway(centreX(2), centreX(6)) as Extract<RouteSpan, { kind: 'highway' }>, entryCell: { gx: 2, gy: 0 } },
    ]))!;
    expect(r.cells).toEqual([{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }]);
    for (let i = 1; i < r.cellDist.length; i++) {
      expect(r.cellDist[i], `cellDist[${i}]`).toBeGreaterThan(r.cellDist[i - 1]);
    }
  });
});

describe('sampleRoute', () => {
  it('samples the start at arc 0 and the end at arc length', () => {
    const r = buildRoute(straightRoad(4))!;
    const start = sampleRoute(r, 0);
    const end = sampleRoute(r, r.length);
    expect(start.x).toBeCloseTo(centreX(0), 5);
    expect(start.y).toBeCloseTo(LANE_Y, 5);
    expect(end.x).toBeCloseTo(centreX(3), 5);
    expect(end.y).toBeCloseTo(LANE_Y, 5);
  });

  it('clamps beyond either end rather than extrapolating', () => {
    const r = buildRoute(straightRoad(4))!;
    const before = sampleRoute(r, -100);
    const after = sampleRoute(r, r.length + 100);
    expect(before.x).toBeCloseTo(centreX(0), 5);
    expect(before.y).toBeCloseTo(LANE_Y, 5);
    expect(after.x).toBeCloseTo(centreX(3), 5);
    expect(after.y).toBeCloseTo(LANE_Y, 5);
  });

  it('faces along +x on an eastbound straight', () => {
    const r = buildRoute(straightRoad(4))!;
    expect(sampleRoute(r, TILE_SIZE).angle).toBeCloseTo(0, 5);
  });

  it('reports zero elevation on plain road', () => {
    const r = buildRoute(straightRoad(4))!;
    expect(sampleRoute(r, TILE_SIZE).elevationY).toBe(0);
  });
});

describe('speedLimitAt', () => {
  it('returns the limit of the segment containing the arc', () => {
    const input = straightRoad(4);
    // Make the third cell an intersection with a lower limit.
    if (input.spans[0].kind === 'grid') {
      input.spans[0].cells[2].kind = SegmentKind.Intersection;
      input.spans[0].cells[2].speedLimit = 28;
    }
    const r = buildRoute(input)!;
    expect(speedLimitAt(r, r.cellDist[2])).toBe(28);
    expect(speedLimitAt(r, r.cellDist[0])).toBe(40);
  });
});
