/**
 * The geometry decision behind the hovered-car route overlay.
 *
 * Every route here is a real one, built by `TrafficAdapter.installRoute` from a real grid,
 * because the two properties under test are properties of what `buildRoute` actually
 * produces: that its polyline is a lane-offset, corner-smoothed curve rather than a string
 * of tile centres, and that `splitAt` degenerates to two coincident points at both ends of
 * it. A hand-written `Route` literal could be made to show either and would prove neither.
 */
import { describe, it, expect } from 'vitest';

import { Grid } from '../../core/Grid';
import { Car } from '../../entities/Car';
import { TrafficAdapter } from '../../systems/car/TrafficAdapter';
import { CellType, GameColor } from '../../types';
import type { GridPos, PixelPos } from '../../types';
import { DEFAULT_GAME_CONSTANTS, TILE_SIZE } from '../../constants';
import type { PathStep } from '../../highways/types';
import { sampleRoute, splitAt } from '../../traffic';
import type { Route } from '../../traffic';
import { drawableHalves, isDrawablePolyline, toLinePositions } from './routeOverlay';

/** Eight cells straight along row zero. */
const STRAIGHT: GridPos[] = Array.from({ length: 8 }, (_, i) => ({ gx: i, gy: 0 }));

/** A right-angle turn, which is where the smoothed lane curve leaves the tile centres. */
const CORNER: GridPos[] = [
  { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 },
  { gx: 2, gy: 1 }, { gx: 2, gy: 2 }, { gx: 2, gy: 3 },
];

function routeOver(cells: GridPos[]): Route {
  const grid = new Grid();
  for (const c of cells) grid.setCell(c.gx, c.gy, { type: CellType.Road });
  const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
  const car = new Car('house-1', GameColor.Red, cells[0], DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
  const path: PathStep[] = cells.map(pos => ({ kind: 'grid', pos } as PathStep));
  expect(adapter.installRoute(car, path, false), 'the fixture route was refused').toBe(true);
  const route = adapter.getRouteFor(car);
  expect(route).not.toBeNull();
  return route!;
}

/** The polyline the deleted `buildFromGridPath` would have drawn: one point per tile centre. */
function tileCentres(cells: GridPos[]): PixelPos[] {
  return cells.map(c => ({ x: (c.gx + 0.5) * TILE_SIZE, y: (c.gy + 0.5) * TILE_SIZE }));
}

function coincide(a: PixelPos, b: PixelPos): boolean {
  return a.x === b.x && a.y === b.y;
}

describe('isDrawablePolyline', () => {
  it('rejects a point list too short to be a segment', () => {
    expect(isDrawablePolyline([])).toBe(false);
    expect(isDrawablePolyline([{ x: 5, y: 5 }])).toBe(false);
  });

  it('rejects the stub splitAt returns at the start of a real route', () => {
    const route = routeOver(STRAIGHT);
    const { travelled } = splitAt(route, 0);

    // The premise, asserted rather than assumed: this really is two points on top of
    // each other, so the rejection below is about degeneracy and not about length.
    expect(travelled).toHaveLength(2);
    expect(coincide(travelled[0], travelled[1])).toBe(true);

    expect(isDrawablePolyline(travelled)).toBe(false);
  });

  it('rejects the stub splitAt returns at the end of a real route', () => {
    const route = routeOver(STRAIGHT);
    const { remaining } = splitAt(route, route.length);

    expect(remaining).toHaveLength(2);
    expect(coincide(remaining[0], remaining[1])).toBe(true);

    expect(isDrawablePolyline(remaining)).toBe(false);
  });

  it('accepts a polyline that returns to where it started', () => {
    // Compared against the *last* point rather than every point, this would be rejected —
    // and a route that doubles back on itself is a real shape on this grid.
    const loop: PixelPos[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 }];
    expect(coincide(loop[0], loop[loop.length - 1])).toBe(true);

    expect(isDrawablePolyline(loop)).toBe(true);
  });

  it('rejects a long point list that never leaves its first point', () => {
    const stub: PixelPos[] = Array.from({ length: 6 }, () => ({ x: 12, y: 34 }));
    expect(isDrawablePolyline(stub)).toBe(false);
  });

  it('measures the threshold in squared pixels', () => {
    // The threshold is 0.01 px², a tenth of a pixel. Written out rather than imported: a
    // test that read the implementation's own constant would pass for any retuning of it.
    // 0.05 px apart is 0.0025 px² — under. 0.2 px apart is 0.04 px² — over.
    expect(isDrawablePolyline([{ x: 0, y: 0 }, { x: 0.05, y: 0 }])).toBe(false);
    expect(isDrawablePolyline([{ x: 0, y: 0 }, { x: 0.2, y: 0 }])).toBe(true);
  });
});

describe('drawableHalves', () => {
  it('drops the travelled half at the start of the route', () => {
    const route = routeOver(STRAIGHT);
    const { travelled, remaining } = drawableHalves(route, 0);

    expect(travelled).toBeNull();
    expect(remaining).toEqual(route.points);
  });

  it('drops the remaining half at the end of the route', () => {
    const route = routeOver(STRAIGHT);
    const { travelled, remaining } = drawableHalves(route, route.length);

    expect(remaining).toBeNull();
    expect(travelled).toEqual(route.points);
  });

  it('keeps both halves in the middle, meeting where the car is', () => {
    const route = routeOver(STRAIGHT);
    const arc = route.length / 2;
    const { travelled, remaining } = drawableHalves(route, arc);

    expect(travelled).not.toBeNull();
    expect(remaining).not.toBeNull();

    // The cut belongs to both halves, so drawing them back to back leaves no gap...
    const cut = travelled![travelled!.length - 1];
    expect(coincide(cut, remaining![0])).toBe(true);

    // ...and it is where the simulation says the car is, not merely the nearest vertex.
    const here = sampleRoute(route, arc);
    expect(cut.x).toBeCloseTo(here.x, 6);
    expect(cut.y).toBeCloseTo(here.y, 6);
  });

  it('draws the curve the car drives, not the centres of the tiles it passes', () => {
    // What the deleted `buildFromGridPath` did: walk `car.path` and emit a tile centre per
    // step. On a corner the two answers are visibly different, and the route's own polyline
    // is the one the car's position is sampled from.
    const route = routeOver(CORNER);
    const centres = tileCentres(CORNER);

    // The premise: these fixtures really do disagree, so the assertion below discriminates.
    expect(route.points.length).toBeGreaterThan(centres.length);
    expect(route.points.some(p => centres.every(c => c.x !== p.x || c.y !== p.y))).toBe(true);

    const { remaining } = drawableHalves(route, 0);
    expect(remaining).toEqual(route.points);
    expect(remaining).not.toEqual(centres);
  });

  it('gives a car standing still on a real route both halves once it has moved', () => {
    // Between the two degenerate extremes there is no third one: an arc one cell along a
    // corner route still cuts a polyline in two drawable pieces.
    const route = routeOver(CORNER);
    const { travelled, remaining } = drawableHalves(route, TILE_SIZE);

    expect(travelled).not.toBeNull();
    expect(remaining).not.toBeNull();
    expect(travelled!.length + remaining!.length).toBeGreaterThan(route.points.length);
  });
});

describe('toLinePositions', () => {
  it('flattens grid depth into world z at the given height', () => {
    // Route space is the grid plane: a point's `y` is a depth and becomes the world's `z`,
    // while the world's `y` is the constant height the overlay floats at.
    expect(toLinePositions([{ x: 1, y: 2 }, { x: 3, y: 4 }], 7)).toEqual([1, 7, 2, 3, 7, 4]);
  });

  it('produces three numbers per point', () => {
    const route = routeOver(STRAIGHT);
    expect(toLinePositions(route.points, 1)).toHaveLength(route.points.length * 3);
  });
});
