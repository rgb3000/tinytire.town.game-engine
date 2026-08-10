import { describe, it, expect } from 'vitest';
import { buildRoute, sampleRoute, speedLimitAt } from './route';
import { SegmentKind } from './types';
import type { RouteInput } from './types';
import { TILE_SIZE } from '../constants';

/** A straight run of road cells along y = 0, from gx=0 to gx=n-1. */
function straightRoad(n: number, speed = 40): RouteInput {
  return {
    id: 'r1',
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: SegmentKind.Road,
        speedLimit: speed,
        pendingDeletion: false,
      })),
    }],
  };
}

describe('buildRoute', () => {
  it('returns null for a span with fewer than two cells', () => {
    expect(buildRoute(straightRoad(1))).toBeNull();
  });

  it('records one cell entry per input cell, in order', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(route.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 },
    ]);
    expect(route.cellDist).toHaveLength(4);
  });

  it('spans three tiles of arc length across four cell centres', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(route.length).toBeCloseTo(3 * TILE_SIZE, 5);
  });

  it('gives strictly increasing cell distances', () => {
    const route = buildRoute(straightRoad(6))!;
    for (let i = 1; i < route.cellDist.length; i++) {
      expect(route.cellDist[i]).toBeGreaterThan(route.cellDist[i - 1]);
    }
  });
});

describe('sampleRoute', () => {
  it('samples the start at arc 0 and the end at arc length', () => {
    const route = buildRoute(straightRoad(4))!;
    const start = sampleRoute(route, 0);
    const end = sampleRoute(route, route.length);
    expect(start.x).toBeCloseTo(route.points[0].x, 5);
    expect(end.x).toBeCloseTo(route.points[route.points.length - 1].x, 5);
  });

  it('clamps beyond either end rather than extrapolating', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, -100).x).toBeCloseTo(sampleRoute(route, 0).x, 5);
    expect(sampleRoute(route, route.length + 100).x)
      .toBeCloseTo(sampleRoute(route, route.length).x, 5);
  });

  it('faces along +x on an eastbound straight', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, TILE_SIZE).angle).toBeCloseTo(0, 5);
  });

  it('reports zero elevation on plain road', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, TILE_SIZE).elevationY).toBe(0);
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
    const route = buildRoute(input)!;
    expect(speedLimitAt(route, route.cellDist[2])).toBe(28);
    expect(speedLimitAt(route, route.cellDist[0])).toBe(40);
  });
});
