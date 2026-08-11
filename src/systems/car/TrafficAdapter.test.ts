import { describe, it, expect } from 'vitest';
import { Grid } from '../../core/Grid';
import { Car, CarState } from '../../entities/Car';
import { TrafficAdapter } from './TrafficAdapter';
import { CellType, GameColor } from '../../types';
import { DEFAULT_GAME_CONSTANTS } from '../../constants';
import type { Highway, PathStep } from '../../highways/types';
import { RoadSystem } from '../RoadSystem';
import { HighwaySystem } from '../HighwaySystem';
import { defaultControlPoints } from '../../highways/highwayGeometry';
import { sampleRoute, SegmentKind, STALL_WATCHDOG_SECONDS, TrafficEventKind } from '../../traffic';
import type { Route } from '../../traffic';
import type { GridPos } from '../../types';

function roadRow(grid: Grid, n: number): void {
  for (let i = 0; i < n; i++) {
    grid.setCell(i, 0, { type: CellType.Road });
  }
}

function gridPath(n: number): PathStep[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'grid', pos: { gx: i, gy: 0 } } as PathStep));
}

function makeCar(): Car {
  return new Car('house-1', GameColor.Red, { gx: 0, gy: 0 }, DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
}

describe('TrafficAdapter.installRoute', () => {
  it('installs a route for a valid path', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();

    expect(adapter.installRoute(car, gridPath(6), false)).toBe(true);
    expect(adapter.getRouteFor(car)).not.toBeNull();
  });

  it('refuses a path too short to form a curve', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    expect(adapter.installRoute(makeCar(), gridPath(1), false)).toBe(false);
  });

  it('starts a fresh route at arc zero', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    expect(adapter.getArc(car)).toBe(0);
  });

  it('preserves position across a reroute instead of jumping to the start', () => {
    // The bug this fixes: reassignPath snapped arcDistance but clearPathState had already
    // reset pathIndex and segmentProgress, so the car rendered at the start of the route.
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();

    adapter.installRoute(car, gridPath(8), false);
    adapter.update(1 / 60);
    for (let i = 0; i < 120; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    const xBefore = car.pixelPos.x;
    expect(xBefore).toBeGreaterThan(50);

    adapter.installRoute(car, gridPath(8), true);
    adapter.writeBack([car]);

    expect(car.pixelPos.x).toBeCloseTo(xBefore, 0);
  });
});

describe('TrafficAdapter.writeBack', () => {
  it('derives pixel position and angle from the arc distance', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingToBusiness;
    adapter.installRoute(car, gridPath(6), false);

    for (let i = 0; i < 60; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    expect(car.pixelPos.x).toBeGreaterThan(20);
    expect(car.renderAngle).toBeCloseTo(0, 1);
  });

  it('records the previous position so the renderer can interpolate', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    for (let i = 0; i < 30; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);
    const first = car.pixelPos.x;
    for (let i = 0; i < 30; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    expect(car.prevPixelPos.x).toBeCloseTo(first, 5);
    expect(car.pixelPos.x).toBeGreaterThan(first);
  });
});

describe('TrafficAdapter.carDependsOnCell', () => {
  it('depends on cells already travelled while heading to a business', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingToBusiness;
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 180; i++) adapter.update(1 / 60);

    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(false);
  });

  it('depends on cells still ahead while heading home', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingHome;
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 180; i++) adapter.update(1 / 60);

    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(false);
  });

  it('depends on the whole route while parked', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.Unloading;
    adapter.installRoute(car, gridPath(8), false);

    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(true);
  });

  it('does not depend on a cell the route never visits', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingHome;
    adapter.installRoute(car, gridPath(8), false);

    expect(adapter.carDependsOnCell(car, 3, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Fixtures for everything below: real grids built through `RoadSystem`, so `_isIntersection`
// is the connection count the game computes rather than a flag set by hand.
// ---------------------------------------------------------------------------------------

const DT = 1 / 60;
const TILE = 40;
const LANE = TILE * 0.12;
/** `DEFAULT_IDM.s0`, restated so a change to the tuning shows up as a failing number here. */
const S0 = TILE * 0.35;
const CAR_LEN = TILE * 0.3;

function crossGrid(): { grid: Grid; roads: RoadSystem } {
  const grid = new Grid(20, 14);
  const roads = new RoadSystem(grid);
  for (let gx = 0; gx <= 11; gx++) roads.placeRoad(gx, 5);
  for (let gy = 0; gy <= 11; gy++) roads.placeRoad(5, gy);
  for (let gx = 0; gx < 11; gx++) roads.connectRoads(gx, 5, gx + 1, 5);
  for (let gy = 0; gy < 11; gy++) roads.connectRoads(5, gy, 5, gy + 1);
  grid.recomputeIntersectionFlags();
  return { grid, roads };
}

function rowPath(from: number, to: number, gy: number): PathStep[] {
  const stepDir = to >= from ? 1 : -1;
  const out: PathStep[] = [];
  for (let gx = from; gx !== to + stepDir; gx += stepDir) out.push({ kind: 'grid', pos: { gx, gy } });
  return out;
}

function columnPath(from: number, to: number, gx: number): PathStep[] {
  const stepDir = to >= from ? 1 : -1;
  const out: PathStep[] = [];
  for (let gy = from; gy !== to + stepDir; gy += stepDir) out.push({ kind: 'grid', pos: { gx, gy } });
  return out;
}

/**
 * Put a car on a route at a chosen arc distance.
 *
 * Via `car.pixelPos`, which `installRoute` falls back to only for a car the simulation
 * holds no route for — so this must be the car's *first* install. A throwaway car supplies
 * the route geometry; it is removed before anything is stepped.
 */
function placeAt(adapter: TrafficAdapter, car: Car, path: PathStep[], arc: number): void {
  const probe = makeCar();
  if (!adapter.installRoute(probe, path, false)) throw new Error('fixture route refused');
  const sample = sampleRoute(adapter.getRouteFor(probe)!, arc);
  adapter.removeVehicle(probe);

  car.pixelPos.x = sample.x;
  car.pixelPos.y = sample.y;
  if (!adapter.installRoute(car, path, true)) throw new Error('fixture route refused');
}

/** Arc at which a car must stop for the junction at `cellIndex`, mirroring `junctionEntryArc`. */
function stopLineArc(route: Route, cellIndex: number): number {
  return (route.cellDist[cellIndex - 1] + route.cellDist[cellIndex]) / 2;
}

describe('TrafficAdapter fixtures', () => {
  it('builds the junction the junction tests depend on', () => {
    const { grid } = crossGrid();
    expect(grid.getCell(5, 5)!._isIntersection).toBe(true);
    // A cell with only two neighbours must not be one, or "junction" would mean "road".
    expect(grid.getCell(3, 5)!._isIntersection).toBe(false);
    expect(grid.getCell(5, 2)!._isIntersection).toBe(false);

    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, rowPath(0, 11, 5), false);
    const route = adapter.getRouteFor(car)!;

    // Straight row: one cell per 40px, so every arc below is arithmetic on the tile size.
    expect(route.cells.length).toBe(12);
    for (let i = 0; i < route.cells.length; i++) expect(route.cellDist[i]).toBeCloseTo(i * TILE, 6);
    expect(route.segments[5].kind).toBe(SegmentKind.Intersection);
    expect(stopLineArc(route, 5)).toBeCloseTo(180, 6);
  });
});

describe('TrafficAdapter grid spans', () => {
  it('never begins a grid span on a junction cell, but keeps the junction slow', () => {
    const grid = new Grid(20, 14);
    const roads = new RoadSystem(grid);
    for (let gy = 0; gy <= 11; gy++) roads.placeRoad(5, gy);
    for (const gy of [5, 8]) for (const gx of [4, 6]) roads.placeRoad(gx, gy);
    for (let gy = 0; gy < 11; gy++) roads.connectRoads(5, gy, 5, gy + 1);
    for (const gy of [5, 8]) { roads.connectRoads(4, gy, 5, gy); roads.connectRoads(5, gy, 6, gy); }
    grid.recomputeIntersectionFlags();

    // Premise: both cells really are junctions, so the contrast below is between two
    // junctions rather than between a junction and a plain road.
    expect(grid.getCell(5, 5)!._isIntersection).toBe(true);
    expect(grid.getCell(5, 8)!._isIntersection).toBe(true);

    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    // A car rerouted while it stands in a junction: its path begins on one.
    expect(adapter.installRoute(car, columnPath(5, 10, 5), false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    expect(route.cells[0]).toEqual({ gx: 5, gy: 5 });
    expect(route.segments[0].kind).toBe(SegmentKind.Road);
    expect(route.cells[3]).toEqual({ gx: 5, gy: 8 });
    expect(route.segments[3].kind).toBe(SegmentKind.Intersection);

    // Demoted in kind only. Both still carry the slower intersection limit.
    const base = DEFAULT_GAME_CONSTANTS.CAR_SPEED * TILE;
    expect(route.segments[0].speedLimit).toBeCloseTo(base * 0.7, 6);
    expect(route.segments[3].speedLimit).toBeCloseTo(base * 0.7, 6);
    expect(route.segments[1].speedLimit).toBeCloseTo(base, 6);
  });

  it('never begins a grid span on a junction cell after a highway exit either', () => {
    const grid = new Grid(20, 14);
    const roads = new RoadSystem(grid);
    for (let gy = 0; gy <= 3; gy++) roads.placeRoad(2, gy);
    for (let gy = 0; gy < 3; gy++) roads.connectRoads(2, gy, 2, gy + 1);
    for (let gy = 5; gy <= 9; gy++) roads.placeRoad(12, gy);
    for (const gx of [11, 13]) roads.placeRoad(gx, 5);
    for (let gy = 5; gy < 9; gy++) roads.connectRoads(12, gy, 12, gy + 1);
    roads.connectRoads(11, 5, 12, 5);
    roads.connectRoads(12, 5, 13, 5);
    grid.recomputeIntersectionFlags();
    expect(grid.getCell(12, 5)!._isIntersection).toBe(true);

    const highways = new HighwaySystem();
    const { cp1, cp2 } = defaultControlPoints({ gx: 2, gy: 3 }, { gx: 12, gy: 5 });
    const hw = highways.addHighway({ gx: 2, gy: 3 }, { gx: 12, gy: 5 }, cp1, cp2);

    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways);
    const car = makeCar();
    const path: PathStep[] = [
      ...columnPath(0, 3, 2),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 3 }, to: { gx: 12, gy: 5 } },
      ...columnPath(5, 9, 12),
    ];
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    // The junction opens the grid span that follows the crossing.
    expect(route.cells[4]).toEqual({ gx: 12, gy: 5 });
    const segment = route.segments.find(s => s.startArc <= route.cellDist[4] && s.endArc >= route.cellDist[4] && s.kind !== SegmentKind.Highway);
    expect(segment!.kind).toBe(SegmentKind.Road);
    expect(route.segments.some(s => s.kind === SegmentKind.Intersection)).toBe(false);
  });
});

describe('TrafficAdapter highway spans', () => {
  function highwayFixture(): { adapter: TrafficAdapter; hw: Highway; grid: Grid } {
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const gx of [0, 1, 2]) roads.placeRoad(gx, 0);
    for (const gx of [10, 11]) roads.placeRoad(gx, 0);
    roads.connectRoads(0, 0, 1, 0);
    roads.connectRoads(1, 0, 2, 0);
    roads.connectRoads(10, 0, 11, 0);
    grid.recomputeIntersectionFlags();

    const highways = new HighwaySystem();
    const { cp1, cp2 } = defaultControlPoints({ gx: 2, gy: 0 }, { gx: 10, gy: 0 });
    const hw = highways.addHighway({ gx: 2, gy: 0 }, { gx: 10, gy: 0 }, cp1, cp2);
    return { adapter: new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways), hw, grid };
  }

  it('accepts a destination sitting at a highway exit', () => {
    const { adapter, hw } = highwayFixture();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      { kind: 'grid', pos: { gx: 10, gy: 0 } },
    ];
    // Premise: the trailing grid run really is a single cell — the shape `buildRoute` refuses.
    let lastCrossing = -1;
    for (let i = 0; i < path.length; i++) if (path[i].kind === 'highway') lastCrossing = i;
    expect(path.length - 1 - lastCrossing).toBe(1);

    const car = makeCar();
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    // Not truncated: the curve still reaches the exit cell, one lane offset from its centre.
    const end = route.points[route.points.length - 1];
    const centre = { x: 10 * TILE + TILE / 2, y: TILE / 2 };
    expect(Math.hypot(end.x - centre.x, end.y - centre.y)).toBeLessThanOrEqual(LANE + 0.01);
    expect(route.length).toBeGreaterThan(2 * TILE + hw.arcLength * 0.9);
  });

  it('folds a lone trailing cell into the crossing rather than dropping it', () => {
    // Synthetic: the pathfinder always ends a crossing on the highway's own endpoint, where
    // the polyline already terminates and folding is a no-op. Moving the lone cell one tile
    // further on is what separates "extended through it" from "silently discarded".
    const { adapter, hw } = highwayFixture();
    const car = makeCar();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      { kind: 'grid', pos: { gx: 11, gy: 0 } },
    ];
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;
    const end = route.points[route.points.length - 1];
    expect(end.x).toBeGreaterThan(11 * TILE);
  });

  it('joins spans without absorbing a phantom straight into the crossing', () => {
    const { adapter, hw } = highwayFixture();
    const car = makeCar();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ];
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    // Grid points carry `LANE_OFFSET` from `computeSmoothLanePath`, whose perpendicular
    // comes from the neighbouring cells; the crossing is offset by the same amount but from
    // its own polyline. Near-coincident, never equal — which is why `buildRoute` has a
    // tolerance at all. What the tolerance must not do is *absorb* a joint: a gap inside it
    // becomes real arc length carrying the following span's speed limit.
    //
    // Measured, the two joints together contribute 0.12px against a tolerance of a whole
    // tile, so a bound of one pixel is three hundred times sharper than the tolerance and
    // still not tight enough to be brittle.
    const excess = route.length - (2 * TILE + hw.arcLength + TILE);
    expect(Math.abs(excess)).toBeLessThan(1);

    // No long straight anywhere: the only full-tile edge is the two-cell tail span's own.
    let longest = 0;
    for (let i = 1; i < route.points.length; i++) {
      longest = Math.max(longest, Math.hypot(
        route.points[i].x - route.points[i - 1].x, route.points[i].y - route.points[i - 1].y,
      ));
    }
    expect(longest).toBeLessThan(TILE + 2 * LANE);
  });

  it('refuses a route whose highway it cannot resolve', () => {
    const { adapter } = highwayFixture();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: 'no-such-highway', from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ];
    expect(adapter.installRoute(makeCar(), path, false)).toBe(false);
  });

  it('does not mutate the highway system\'s own polyline', () => {
    const { adapter, hw } = highwayFixture();
    const before = hw.polyline.length;
    const car = makeCar();
    adapter.installRoute(car, [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      { kind: 'grid', pos: { gx: 11, gy: 0 } },
    ], false);
    expect(hw.polyline.length).toBe(before);
  });

  it('reports both ends of a crossing as depended-upon from the middle of it', () => {
    const { adapter, hw } = highwayFixture();
    const car = makeCar();
    car.state = CarState.GoingToBusiness;
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ];
    // Three quarters of the way across, so the answer cannot come from sitting on a midpoint,
    // where the two flanking cells' extents meet and both are trivially covered.
    placeAt(adapter, car, path, 2 * TILE + hw.arcLength * 0.75);
    const route = adapter.getRouteFor(car)!;
    expect(adapter.getArc(car)).toBeGreaterThan(2 * TILE + hw.arcLength * 0.6);

    // On-ramp, behind: the state's own direction.
    expect(adapter.carDependsOnCell(car, 2, 0)).toBe(true);
    // Off-ramp, still ahead: over-included, because a highway span contributes no cells and
    // so stretches the two cells flanking it across the whole crossing.
    expect(adapter.carDependsOnCell(car, 10, 0)).toBe(true);
    // The cell past the off-ramp is not stretched, so the over-inclusion is bounded.
    expect(adapter.carDependsOnCell(car, 11, 0)).toBe(false);
    expect(route.cells).toHaveLength(5);
  });
});

describe('TrafficAdapter junction admission', () => {
  /** A car at the stop line of (5,5) and another sitting in the cell beyond it. */
  function exitFixture(): { adapter: TrafficAdapter; approaching: Car; inExitCell: Car; route: Route } {
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const path = rowPath(0, 11, 5);
    const approaching = makeCar();
    const inExitCell = makeCar();
    placeAt(adapter, approaching, path, 170);
    placeAt(adapter, inExitCell, path, 240);
    const route = adapter.getRouteFor(approaching)!;

    // Premises. 180 is the stop line; 240 is the centre of (6,5), the cell beyond the
    // junction; and a car held only by headway behind a standstill leader at 240 would rest
    // at 214, well past the line — so "stopped short of 180" can only be the junction rule.
    expect(stopLineArc(route, 5)).toBeCloseTo(180, 6);
    expect(route.cells[6]).toEqual({ gx: 6, gy: 5 });
    expect(240 - CAR_LEN - S0).toBeGreaterThan(180);

    return { adapter, approaching, inExitCell, route };
  }

  it('holds a car out of a junction whose exit cell is occupied by a standstill', () => {
    const { adapter, approaching, inExitCell } = exitFixture();
    adapter.setParked(inExitCell, true);

    for (let i = 0; i < 60 * 12; i++) adapter.update(DT);

    expect(adapter.getArc(approaching)).toBeLessThan(180);
    expect(adapter.getSpeed(approaching)).toBe(0);
  });

  it('lets a car into a junction whose exit cell holds a car that is moving', () => {
    // The rule only ever gets pinned from the throughput side — "a blocked exit stops
    // admission". Its positive half is what keeps a junction flowing at all: an exit cell is
    // occupied by a moving car for most of the time any traffic is on it, and refusing those
    // would turn every junction into a full stop per car.
    const { adapter, approaching, inExitCell } = exitFixture();

    let crossedAt = -1;
    let exitClearedAt = -1;
    for (let i = 0; i < 60 * 6; i++) {
      adapter.update(DT);
      const t = (i + 1) * DT;
      if (crossedAt < 0 && adapter.getArc(approaching) > 180) crossedAt = t;
      // 280 is the far boundary of (6,5): past it the leader is no longer in the exit cell.
      if (exitClearedAt < 0 && adapter.getArc(inExitCell) >= 280) exitClearedAt = t;
    }

    expect(crossedAt).toBeGreaterThan(0);
    expect(exitClearedAt).toBeGreaterThan(0);
    // Admitted *while* the exit was still occupied, not merely once it emptied.
    expect(crossedAt).toBeLessThan(exitClearedAt);
  });

  it('gets a car that stops at a stop line in the first frames of the world through it', () => {
    // The regime a starvation defect lived in for three review rounds: `arrivalTime` is
    // stamped in world seconds, and a world created at t=0 with a car already at rest stamps
    // it at 0.017 — close enough to the "has not begun waiting" sentinel that the two were
    // confused. The adapter is the first thing that creates such a world, so the clock is
    // deliberately not warmed here.
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const across = rowPath(0, 11, 5);
    const waiter = makeCar();
    placeAt(adapter, waiter, columnPath(0, 11, 5), 180 - S0);

    const crossing: Car[] = [];
    let arrivedAt = -1;
    let crossArrivals = 0;
    let speedAt50ms = -1;

    for (let i = 0; i < 60 * 40; i++) {
      const t = i * DT;
      if (i % 120 === 0 && t < 25) {
        const car = makeCar();
        adapter.installRoute(car, across, false);
        crossing.push(car);
      }
      for (const event of adapter.update(DT)) {
        if (event.kind !== TrafficEventKind.Arrived) continue;
        const car = crossing.find(c => c.id === event.vehicleId);
        if (car) { adapter.removeVehicle(car); crossArrivals++; }
        if (event.vehicleId === waiter.id && arrivedAt < 0) arrivedAt = t;
      }
      if (Math.abs(t - 0.05) < DT / 2) speedAt50ms = adapter.getSpeed(waiter);
    }

    // Premise: it really did come to rest at the line inside 50ms, rather than rolling up to
    // it later, which is what puts the stamp next to the sentinel.
    expect(speedAt50ms).toBe(0);
    expect(adapter.getArc(waiter)).toBeGreaterThan(180);
    // Premise: the cross stream was real, so the waiter had something to be starved by.
    expect(crossArrivals).toBeGreaterThanOrEqual(5);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(25);
  });
});

describe('TrafficAdapter arrival and despawn', () => {
  function corridor(): { adapter: TrafficAdapter; path: PathStep[] } {
    const grid = new Grid(20, 5);
    const roads = new RoadSystem(grid);
    for (let gx = 0; gx < 8; gx++) roads.placeRoad(gx, 0);
    for (let gx = 0; gx < 7; gx++) roads.connectRoads(gx, 0, gx + 1, 0);
    grid.recomputeIntersectionFlags();
    return { adapter: new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS), path: rowPath(0, 7, 0) };
  }

  function runCorridor(despawnOnArrival: boolean): { follower: Car; adapter: TrafficAdapter; followerArrived: number } {
    const { adapter, path } = corridor();
    const leader = makeCar();
    const follower = makeCar();
    placeAt(adapter, leader, path, 200);
    placeAt(adapter, follower, path, 40);

    let followerArrived = -1;
    for (let i = 0; i < 60 * 25; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind !== TrafficEventKind.Arrived) continue;
        if (event.vehicleId === leader.id && despawnOnArrival) adapter.removeVehicle(leader);
        if (event.vehicleId === follower.id && followerArrived < 0) followerArrived = i * DT;
      }
    }
    return { follower, adapter, followerArrived };
  }

  it('leaves an arrived car blocking the road for ever when it is not despawned', () => {
    const { follower, adapter, followerArrived } = runCorridor(false);
    const route = adapter.getRouteFor(follower)!;
    expect(followerArrived).toBe(-1);
    // Parked one car length plus one standstill gap behind the arrived leader, and so short
    // of the half-tile band in which arrival is declared, for the remaining 22 seconds.
    expect(adapter.getArc(follower)).toBeLessThan(route.length - TILE / 2);
    expect(adapter.getArc(follower)).toBeGreaterThan(route.length - 2 * TILE);
    expect(adapter.getSpeed(follower)).toBe(0);
  });

  it('clears the road when the caller despawns on the arrival event', () => {
    const { followerArrived } = runCorridor(true);
    expect(followerArrived).toBeGreaterThan(0);
    expect(followerArrived).toBeLessThan(15);
  });

  it('forgets a removed car entirely', () => {
    const { adapter, path } = corridor();
    const car = makeCar();
    adapter.installRoute(car, path, false);
    expect(adapter.getRouteFor(car)).not.toBeNull();

    adapter.removeVehicle(car);

    expect(adapter.getRouteFor(car)).toBeNull();
    expect(adapter.getArc(car)).toBe(0);
    expect(adapter.getDistanceThisTick(car)).toBe(0);
    // And nothing left behind that a follower could brake for.
    const behind = makeCar();
    placeAt(adapter, behind, path, 40);
    for (let i = 0; i < 60 * 20; i++) adapter.update(DT);
    expect(adapter.getArc(behind)).toBeGreaterThan(adapter.getRouteFor(behind)!.length - TILE);
  });

  it('keeps a parked car in the way of its followers', () => {
    const { adapter, path } = corridor();
    const parked = makeCar();
    const follower = makeCar();
    placeAt(adapter, parked, path, 200);
    adapter.setParked(parked, true);
    placeAt(adapter, follower, path, 40);

    for (let i = 0; i < 60 * 15; i++) adapter.update(DT);

    expect(adapter.getArc(parked)).toBe(200);
    // One car length plus the standstill gap behind it, to within the integrator's own
    // fraction of a pixel — the equilibrium the model is built around.
    expect(200 - adapter.getArc(follower)).toBeCloseTo(CAR_LEN + S0, 0);
  });
});

describe('TrafficAdapter stall watchdog', () => {
  it('reports a car held behind a permanently blocked junction exit, and keeps reporting', () => {
    // `exitHasRoom` skips a candidate whose exit cell holds a standstill, which is what stops
    // a ring of junctions gridlocking. Nothing promises that cell ever empties: a car with no
    // route home stands where it stopped until a rescue succeeds, and a rescue may never
    // succeed. So the drainage guarantee cannot be given, and the adapter measures instead.
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const path = rowPath(0, 11, 5);
    const queued = makeCar();
    const abandoned = makeCar();
    placeAt(adapter, queued, path, 170);
    placeAt(adapter, abandoned, path, 240);
    adapter.setParked(abandoned, true);

    const blocked: number[] = [];
    for (let i = 0; i < 60 * 26; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked && event.vehicleId === queued.id) {
          blocked.push(i * DT);
        }
      }
    }

    // Premise: it is genuinely stuck, not merely slow.
    expect(adapter.getArc(queued)).toBeLessThan(180);
    expect(blocked).toHaveLength(2);
    expect(blocked[0]).toBeCloseTo(STALL_WATCHDOG_SECONDS, 1);
    expect(blocked[1] - blocked[0]).toBeCloseTo(STALL_WATCHDOG_SECONDS, 1);
    // The car that is parked on purpose is not reported: standing still is what parking is.
    expect(adapter.getStalledSeconds(abandoned)).toBe(0);
  });

  it('says nothing about traffic that is merely queued and moving', () => {
    const { adapter, path } = (() => {
      const grid = new Grid(20, 5);
      const roads = new RoadSystem(grid);
      for (let gx = 0; gx < 12; gx++) roads.placeRoad(gx, 0);
      for (let gx = 0; gx < 11; gx++) roads.connectRoads(gx, 0, gx + 1, 0);
      grid.recomputeIntersectionFlags();
      return { adapter: new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS), path: rowPath(0, 11, 0) };
    })();

    const cars = [makeCar(), makeCar(), makeCar()];
    cars.forEach((car, i) => placeAt(adapter, car, path, i * 60));

    let blocked = 0;
    let arrivals = 0;
    const seconds = 26;
    for (let i = 0; i < 60 * seconds; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked) blocked++;
        if (event.kind === TrafficEventKind.Arrived) { arrivals++; adapter.removeVehicle(cars.find(c => c.id === event.vehicleId)!); }
      }
    }

    // Premise: the run was long enough that a false positive had time to fire twice.
    expect(seconds).toBeGreaterThan(2 * STALL_WATCHDOG_SECONDS);
    expect(arrivals).toBe(3);
    expect(blocked).toBe(0);
  });
});

describe('TrafficAdapter reroutes', () => {
  it('does not move a car rerouted between updates, with no writeBack in between', () => {
    // `car.pixelPos` is a mirror that `writeBack` refreshes. Projecting onto it would put the
    // second representation back into the one path the design exists to keep it out of, and
    // the symptom is the reported one: the car snaps to where it was last drawn.
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 90; i++) adapter.update(DT);
    adapter.writeBack([car]);
    const drawnAt = car.pixelPos.x;

    for (let i = 0; i < 30; i++) adapter.update(DT);
    const arcBefore = adapter.getArc(car);
    // Premise: the mirror is genuinely stale, so projecting onto it would be a visible jump.
    expect(arcBefore).toBeGreaterThan(drawnAt - 20 + 5);

    adapter.installRoute(car, gridPath(8), true);

    expect(adapter.getArc(car)).toBeCloseTo(arcBefore, 3);
  });

  it('keeps a waiting car\'s place in the junction queue across a reroute', () => {
    // The stall watchdog above asks the caller to reroute exactly the cars that have been
    // waiting longest. `arrivalTime` is what a car's place in the queue *is*, and zero is the
    // sentinel for "has not begun waiting", which sorts last — so clearing the stamp on
    // reroute would make the remedy the cause.
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const down = columnPath(0, 11, 5);
    const across = rowPath(0, 11, 5);
    const waiter = makeCar();
    placeAt(adapter, waiter, down, 180 - S0);

    const crossing: Car[] = [];
    let arrivedAt = -1;
    let reroutes = 0;
    for (let i = 0; i < 60 * 40; i++) {
      const t = i * DT;
      if (i % 120 === 0 && t < 25) {
        const car = makeCar();
        adapter.installRoute(car, across, false);
        crossing.push(car);
      }
      if (i > 0 && i % 60 === 0 && arrivedAt < 0) { adapter.installRoute(waiter, down, true); reroutes++; }
      for (const event of adapter.update(DT)) {
        if (event.kind !== TrafficEventKind.Arrived) continue;
        const car = crossing.find(c => c.id === event.vehicleId);
        if (car) adapter.removeVehicle(car);
        if (event.vehicleId === waiter.id && arrivedAt < 0) arrivedAt = t;
      }
    }

    // Premise: the reroutes happened, and happened while it was still waiting.
    expect(reroutes).toBeGreaterThan(5);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(25);
  });
});

describe('TrafficAdapter configuration', () => {
  it('accepts the default speeds with room to spare', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    expect(() => new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS)).not.toThrow();

    // The margin the defaults enjoy, stated as a number so that raising either constant in
    // `constants.ts` shows up here rather than silently eating it.
    const fastest = DEFAULT_GAME_CONSTANTS.CAR_SPEED * DEFAULT_GAME_CONSTANTS.HIGHWAY_SPEED_MULTIPLIER;
    expect(fastest).toBe(2);
    const stopping = (fastest * TILE) ** 2 / (2 * TILE * 4) + S0;
    expect(stopping).toBeCloseTo(34, 6);
    expect(3 * TILE / stopping).toBeGreaterThan(3.5);
  });

  it('refuses a map whose cars cannot stop inside the leader search', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    // The ceiling is sqrt(2 * MAX_DECELERATION * (lookahead - s0)) = 184.17px/s = 4.604
    // tiles/sec of effective top speed, which at the default multiplier of 2 is a CAR_SPEED
    // of 2.302.
    expect(() => new TrafficAdapter(grid, { ...DEFAULT_GAME_CONSTANTS, CAR_SPEED: 2.3 })).not.toThrow();
    expect(() => new TrafficAdapter(grid, { ...DEFAULT_GAME_CONSTANTS, CAR_SPEED: 2.4 }))
      .toThrow(/safe ceiling is 4\.60 tiles\/sec/);
    // A multiplier below one cannot make a fast grid speed safe.
    expect(() => new TrafficAdapter(grid, { ...DEFAULT_GAME_CONSTANTS, CAR_SPEED: 6, HIGHWAY_SPEED_MULTIPLIER: 0.5 }))
      .toThrow(/CAR_SPEED 6/);
  });

  it('carries a map\'s speeds into the route rather than the module defaults', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, { ...DEFAULT_GAME_CONSTANTS, CAR_SPEED: 2 });
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    expect(adapter.getRouteFor(car)!.segments[1].speedLimit).toBeCloseTo(2 * TILE, 6);

    let fastest = 0;
    for (let i = 0; i < 60 * 8; i++) { adapter.update(DT); fastest = Math.max(fastest, adapter.getSpeed(car)); }
    expect(fastest).toBeGreaterThan(TILE * 1.5);

    // The contrast: the same route under the default `CAR_SPEED` never exceeds one tile a
    // second, so the number above came from the config and not from the module constant.
    const slow = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const other = makeCar();
    slow.installRoute(other, gridPath(6), false);
    let slowest = 0;
    for (let i = 0; i < 60 * 8; i++) { slow.update(DT); slowest = Math.max(slowest, slow.getSpeed(other)); }
    expect(slowest).toBeLessThanOrEqual(TILE);
  });
});

describe('TrafficAdapter bookkeeping', () => {
  it('drops a removed car\'s route as well as its vehicle', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const cars = [makeCar(), makeCar(), makeCar()];
    for (const car of cars) adapter.installRoute(car, gridPath(8), false);
    expect(adapter.debugCounts()).toEqual({ vehicles: 3, routes: 3 });

    adapter.removeVehicle(cars[0]);
    adapter.removeVehicle(cars[2]);

    // A route outliving its vehicle is invisible to everything except memory: every
    // consumer reaches one through `vehicle.routeId`, so nothing would ever read it again.
    expect(adapter.debugCounts()).toEqual({ vehicles: 1, routes: 1 });
  });

  it('rebuilding a car\'s route replaces it rather than accumulating', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    for (let i = 0; i < 5; i++) adapter.installRoute(car, gridPath(8), true);
    expect(adapter.debugCounts()).toEqual({ vehicles: 1, routes: 1 });
  });
});

describe('TrafficAdapter crossings', () => {
  function eastWestHighway(): { adapter: TrafficAdapter; hw: Highway } {
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const gx of [0, 1, 2, 10, 11]) roads.placeRoad(gx, 0);
    roads.connectRoads(0, 0, 1, 0);
    roads.connectRoads(1, 0, 2, 0);
    roads.connectRoads(10, 0, 11, 0);
    grid.recomputeIntersectionFlags();
    const highways = new HighwaySystem();
    const { cp1, cp2 } = defaultControlPoints({ gx: 2, gy: 0 }, { gx: 10, gy: 0 });
    const hw = highways.addHighway({ gx: 2, gy: 0 }, { gx: 10, gy: 0 }, cp1, cp2);
    return { adapter: new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways), hw };
  }

  it('orients the crossing the way the car travels it', () => {
    // A highway is stored once and driven in both directions. Taking the stored order for a
    // car entering at `toPos` would put the far end of the crossing at the near joint —
    // eight tiles from where the car actually is, which `buildRoute` refuses outright, so
    // the symptom is a car that cannot be routed home at all.
    const { adapter, hw } = eastWestHighway();
    const car = makeCar();
    const path: PathStep[] = [
      ...rowPath(11, 10, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 10, gy: 0 }, to: { gx: 2, gy: 0 } },
      ...rowPath(2, 0, 0),
    ];
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    expect(route.points[0].x).toBeGreaterThan(11 * TILE);
    expect(route.points[route.points.length - 1].x).toBeLessThan(TILE);
    expect(route.cells.map(c => c.gx)).toEqual([11, 10, 2, 1, 0]);
  });

  it('carries the highway speed multiplier onto the crossing', () => {
    const { adapter, hw } = eastWestHighway();
    const car = makeCar();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ];
    adapter.installRoute(car, path, false);
    const route = adapter.getRouteFor(car)!;

    const crossing = route.segments.find(s => s.kind === SegmentKind.Highway)!;
    const base = DEFAULT_GAME_CONSTANTS.CAR_SPEED * TILE;
    expect(crossing.speedLimit).toBeCloseTo(base * DEFAULT_GAME_CONSTANTS.HIGHWAY_SPEED_MULTIPLIER, 6);
    // Premise: the multiplier is not 1, or the assertion above would hold either way.
    expect(DEFAULT_GAME_CONSTANTS.HIGHWAY_SPEED_MULTIPLIER).toBeGreaterThan(1);

    // And it is reached: the car genuinely outruns the road limit while on the crossing.
    let fastest = 0;
    for (let i = 0; i < 60 * 15; i++) { adapter.update(DT); fastest = Math.max(fastest, adapter.getSpeed(car)); }
    expect(fastest).toBeGreaterThan(base * 1.5);
    expect(adapter.getArc(car)).toBeGreaterThan(route.length - TILE);
  });

  it('lifts a car off the ground over a crossing and sets it down again', () => {
    const { adapter, hw } = eastWestHighway();
    const car = makeCar();
    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ];
    adapter.installRoute(car, path, false);

    adapter.writeBack([car]);
    expect(car.onHighway).toBe(false);
    expect(car.elevationY).toBe(0);

    let liftedAt = -1;
    for (let i = 0; i < 60 * 15; i++) {
      adapter.update(DT);
      adapter.writeBack([car]);
      if (car.onHighway && liftedAt < 0) liftedAt = i * DT;
    }
    expect(liftedAt).toBeGreaterThan(0);
    expect(car.onHighway).toBe(false);
    expect(car.elevationY).toBe(0);
  });
});

describe('TrafficAdapter watchdog reset', () => {
  it('gives a rerouted car the full timeout again before reporting it', () => {
    // The caller's remedy for `Blocked` is a reroute. If the counter survived one, the next
    // report would arrive a tick later and the caller would be told the same thing over and
    // over about a car it had only just acted on.
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const path = rowPath(0, 11, 5);
    const queued = makeCar();
    const abandoned = makeCar();
    placeAt(adapter, queued, path, 170);
    placeAt(adapter, abandoned, path, 240);
    adapter.setParked(abandoned, true);

    const rerouteAfter = Math.round(60 * (STALL_WATCHDOG_SECONDS - 1));
    let blockedBeforeReroute = 0;
    for (let i = 0; i < rerouteAfter; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked) blockedBeforeReroute++;
      }
    }
    // Premise: it is one second short of the threshold, so a surviving counter would fire
    // almost at once and a reset one would not fire for another eight seconds.
    expect(blockedBeforeReroute).toBe(0);
    expect(adapter.getStalledSeconds(queued)).toBeCloseTo(STALL_WATCHDOG_SECONDS - 1, 1);

    adapter.installRoute(queued, path, true);
    expect(adapter.getStalledSeconds(queued)).toBe(0);

    let blockedAfter = 0;
    for (let i = 0; i < 60 * 3; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked) blockedAfter++;
      }
    }
    expect(blockedAfter).toBe(0);
  });
});

describe('TrafficAdapter mirrors', () => {
  it('mirrors the simulated speed onto the car for the debug overlay', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 60; i++) adapter.update(DT);
    adapter.writeBack([car]);

    expect(adapter.getSpeed(car)).toBeGreaterThan(0);
    expect(car.currentSpeed).toBe(adapter.getSpeed(car));
  });
});

describe('TrafficAdapter refusals', () => {
  it('folds a lone leading cell into the crossing that follows it', () => {
    // The mirror of the trailing case: an origin sitting at a highway entrance. Synthetic
    // for the same reason — the pathfinder puts the crossing's own endpoint there, where
    // the polyline already starts and folding cannot be told from dropping.
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const gx of [1, 2, 10, 11]) roads.placeRoad(gx, 0);
    roads.connectRoads(10, 0, 11, 0);
    grid.recomputeIntersectionFlags();
    const highways = new HighwaySystem();
    const { cp1, cp2 } = defaultControlPoints({ gx: 2, gy: 0 }, { gx: 10, gy: 0 });
    const hw = highways.addHighway({ gx: 2, gy: 0 }, { gx: 10, gy: 0 }, cp1, cp2);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways);

    const car = makeCar();
    expect(adapter.installRoute(car, [
      { kind: 'grid', pos: { gx: 1, gy: 0 } },
      { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      ...rowPath(10, 11, 0),
    ], false)).toBe(true);

    const route = adapter.getRouteFor(car)!;
    expect(route.points[0].x).toBeLessThan(2 * TILE);
  });

  it('refuses a route rather than splicing across a crossing it cannot resolve', () => {
    // Dropping the crossing leaves its two neighbours to be joined directly. Usually the
    // gap is wider than the joint tolerance and `buildRoute` rejects it anyway — but two
    // spans meeting at right angles sit 35.5px apart, inside the one-tile tolerance, so the
    // splice is accepted and the car drives a straight line across whatever the highway was
    // built to cross. Refusing at the source is what makes that unreachable.
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const pos of [[1, 0], [2, 0], [3, 0], [3, 1]]) roads.placeRoad(pos[0], pos[1]);
    roads.connectRoads(1, 0, 2, 0);
    roads.connectRoads(3, 0, 3, 1);
    grid.recomputeIntersectionFlags();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, new HighwaySystem());

    const path: PathStep[] = [
      { kind: 'grid', pos: { gx: 1, gy: 0 } },
      { kind: 'grid', pos: { gx: 2, gy: 0 } },
      { kind: 'highway', highwayId: 'removed-while-the-car-was-on-it', from: { gx: 2, gy: 0 }, to: { gx: 3, gy: 0 } },
      { kind: 'grid', pos: { gx: 3, gy: 0 } },
      { kind: 'grid', pos: { gx: 3, gy: 1 } },
    ];
    expect(adapter.installRoute(makeCar(), path, false)).toBe(false);
  });
});

describe('TrafficAdapter watchdog threshold', () => {
  it('does not fire during a congested stall that resolves itself', () => {
    // The bound that makes the threshold defensible from below. Task 8 measured a 9.65s
    // stall on a loaded nine-junction city that went on to clear normally, so a stall of
    // that length must pass in silence — a watchdog firing on healthy congestion trains its
    // consumer to ignore it, which is worse than no watchdog because it reads as coverage.
    // The predecessor constant was 8s and would have fired here.
    const { grid } = crossGrid();
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const path = rowPath(0, 11, 5);
    const queued = makeCar();
    const obstruction = makeCar();
    placeAt(adapter, queued, path, 170);
    placeAt(adapter, obstruction, path, 240);
    adapter.setParked(obstruction, true);

    const clearsAt = 9.7;
    let blocked = 0;
    for (let i = 0; i < Math.round(60 * clearsAt); i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked) blocked++;
      }
    }

    // Premises: the car really did stand still for the whole 9.7s, and the stall it endured
    // is the one Task 8 measured rather than an arbitrary number.
    expect(adapter.getStalledSeconds(queued)).toBeCloseTo(clearsAt, 1);
    expect(adapter.getStalledSeconds(queued)).toBeGreaterThan(9);
    expect(adapter.getStalledSeconds(queued)).toBeLessThan(10);
    expect(adapter.getArc(queued)).toBeLessThan(180);
    expect(blocked).toBe(0);

    // And it was congestion, not a defect: once the obstruction moves off, so does it.
    adapter.setParked(obstruction, false);
    for (let i = 0; i < 60 * 8; i++) {
      for (const event of adapter.update(DT)) {
        if (event.kind === TrafficEventKind.Blocked) blocked++;
      }
    }
    expect(adapter.getArc(queued)).toBeGreaterThan(180);
    expect(blocked).toBe(0);
  });

  it('sits between the two measurements that bracket it', () => {
    // Stated as numbers so that moving the constant without moving the argument fails here.
    expect(STALL_WATCHDOG_SECONDS).toBeGreaterThan(9.65);
    expect(STALL_WATCHDOG_SECONDS).toBeLessThan(15);
  });
});

describe('TrafficAdapter fold safety', () => {
  /**
   * Two crossings meeting at a single road cell, plus grid road either side.
   *
   * `(10,0)` is the endpoint of both highways and the only cell between them, so it is the
   * lone run that gets folded. This is the shape a review probe was mid-way through when it
   * died, and nothing else in the file covers it.
   */
  function twoCrossings(): { adapter: TrafficAdapter; path: PathStep[]; hwLength: number } {
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const gx of [0, 1, 2, 10, 18, 19]) roads.placeRoad(gx, 0);
    roads.connectRoads(0, 0, 1, 0);
    roads.connectRoads(1, 0, 2, 0);
    roads.connectRoads(18, 0, 19, 0);
    grid.recomputeIntersectionFlags();

    const highways = new HighwaySystem();
    const first = defaultControlPoints({ gx: 2, gy: 0 }, { gx: 10, gy: 0 });
    const hw1 = highways.addHighway({ gx: 2, gy: 0 }, { gx: 10, gy: 0 }, first.cp1, first.cp2);
    const second = defaultControlPoints({ gx: 10, gy: 0 }, { gx: 18, gy: 0 });
    const hw2 = highways.addHighway({ gx: 10, gy: 0 }, { gx: 18, gy: 0 }, second.cp1, second.cp2);

    const path: PathStep[] = [
      ...rowPath(0, 2, 0),
      { kind: 'highway', highwayId: hw1.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } },
      { kind: 'grid', pos: { gx: 10, gy: 0 } },
      { kind: 'highway', highwayId: hw2.id, from: { gx: 10, gy: 0 }, to: { gx: 18, gy: 0 } },
      ...rowPath(18, 19, 0),
    ];
    return {
      adapter: new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways),
      path,
      hwLength: hw1.arcLength + hw2.arcLength,
    };
  }

  it('routes a path with one road cell between two crossings', () => {
    const { adapter, path, hwLength } = twoCrossings();
    const car = makeCar();
    expect(adapter.installRoute(car, path, false)).toBe(true);
    const route = adapter.getRouteFor(car)!;

    // Not truncated and no phantom absorbed at any of the four joints.
    expect(Math.abs(route.length - (2 * TILE + hwLength + TILE))).toBeLessThan(2);
    expect(route.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 18, gy: 0 }, { gx: 19, gy: 0 },
    ]);
  });

  it('omits only highway endpoints from route.cells, in every shape that folds', () => {
    // This is the premise the fold's safety rests on. A folded cell is invisible to
    // `carDependsOnCell`, so the player's road-delete check cannot protect it — but
    // `Game.handleTryErase` erases every highway with an endpoint at the clicked cell
    // *before* it can reach the road-removal branch, so the click that would exercise the
    // gap destroys the crossing the car is riding in the same gesture, and the route is
    // invalidated by the larger event regardless. That argument holds only while every
    // omitted cell is a highway endpoint. If a future path shape folds an ordinary road
    // cell, this fails and the argument must be redone.
    const grid = new Grid(20, 8);
    const roads = new RoadSystem(grid);
    for (const gx of [0, 1, 2, 10, 11]) roads.placeRoad(gx, 0);
    roads.connectRoads(0, 0, 1, 0);
    roads.connectRoads(1, 0, 2, 0);
    roads.connectRoads(10, 0, 11, 0);
    grid.recomputeIntersectionFlags();
    const highways = new HighwaySystem();
    const { cp1, cp2 } = defaultControlPoints({ gx: 2, gy: 0 }, { gx: 10, gy: 0 });
    const hw = highways.addHighway({ gx: 2, gy: 0 }, { gx: 10, gy: 0 }, cp1, cp2);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS, highways);
    const crossing: PathStep = { kind: 'highway', highwayId: hw.id, from: { gx: 2, gy: 0 }, to: { gx: 10, gy: 0 } };

    const shapes: { name: string; adapter: TrafficAdapter; path: PathStep[] }[] = [
      // Destination sitting at a highway exit.
      { name: 'trailing', adapter, path: [...rowPath(0, 2, 0), crossing, { kind: 'grid', pos: { gx: 10, gy: 0 } }] },
      // Origin sitting at a highway entrance.
      { name: 'leading', adapter, path: [{ kind: 'grid', pos: { gx: 2, gy: 0 } }, crossing, ...rowPath(10, 11, 0)] },
      // One road cell between two crossings.
      { name: 'between', ...twoCrossings() },
    ];

    for (const shape of shapes) {
      const car = makeCar();
      expect(shape.adapter.installRoute(car, shape.path, false)).toBe(true);
      const route = shape.adapter.getRouteFor(car)!;

      const endpoints = new Set<string>();
      for (const step of shape.path) {
        if (step.kind !== 'highway') continue;
        endpoints.add(`${step.from.gx},${step.from.gy}`);
        endpoints.add(`${step.to.gx},${step.to.gy}`);
      }
      const kept = new Set(route.cells.map(c => `${c.gx},${c.gy}`));
      const omitted = shape.path
        .filter(s => s.kind === 'grid')
        .map(s => `${(s as { pos: GridPos }).pos.gx},${(s as { pos: GridPos }).pos.gy}`)
        .filter(key => !kept.has(key));

      // Premise: this shape really does fold something, or the assertion below is vacuous.
      expect(omitted.length, shape.name).toBeGreaterThan(0);
      for (const key of omitted) expect(endpoints.has(key), `${shape.name} omitted ${key}`).toBe(true);
    }
  });
});

describe('TrafficAdapter.getCurrentCell', () => {
  it('names the cell whose centre the car is nearest to', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    expect(adapter.getCurrentCell(car)).toEqual({ gx: 0, gy: 0 });

    // Two and a bit tiles along, so cell 2 is the nearest centre.
    for (let i = 0; i < 600 && adapter.getArc(car) < 2.2 * 40; i++) adapter.update(1 / 60);
    expect(adapter.getArc(car)).toBeGreaterThan(2.2 * 40);
    expect(adapter.getArc(car)).toBeLessThan(2.5 * 40);
    expect(adapter.getCurrentCell(car)).toEqual({ gx: 2, gy: 0 });
  });

  it('has no answer for a car it holds no route for', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    expect(adapter.getCurrentCell(makeCar())).toBeNull();
  });
});

describe('TrafficAdapter.consumePassedCells', () => {
  function drainTo(adapter: TrafficAdapter, car: Car, arc: number): string[] {
    const seen: string[] = [];
    for (let i = 0; i < 2000 && adapter.getArc(car) < arc; i++) {
      adapter.update(1 / 60);
      adapter.consumePassedCells(car, (gx, gy) => seen.push(`${gx},${gy}`));
    }
    return seen;
  }

  it('reports each cell once, as the car reaches the next one', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    const seen = drainTo(adapter, car, 3.5 * 40);
    expect(seen).toEqual(['0,0', '1,0', '2,0']);
  });

  it('never reports the last cell, which is the destination the car is standing on', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    const seen = drainTo(adapter, car, 5 * 40);
    // The car comes to rest a standstill gap short of the destination, so it is inside the
    // last cell without ever reaching its centre — and the last cell is never reported.
    const route = adapter.getRouteFor(car)!;
    expect(adapter.getArc(car)).toBeGreaterThan(route.cellDist[route.cells.length - 2]);
    expect(adapter.getArc(car)).toBeLessThan(route.length);
    expect(seen).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('re-walks a rerouted car, because the cells behind it on the new route are ones it no longer needs', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    drainTo(adapter, car, 3.5 * 40);

    // Same geometry, fresh route, position preserved — so the car is still at the same arc.
    expect(adapter.installRoute(car, gridPath(6), true)).toBe(true);
    const again: string[] = [];
    adapter.consumePassedCells(car, (gx, gy) => again.push(`${gx},${gy}`));

    expect(again).toEqual(['0,0', '1,0', '2,0']);
  });
});

describe('TrafficAdapter.crossesPendingDeletionAhead', () => {
  it('sees a cell marked ahead of the car and not one marked behind it', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    for (let i = 0; i < 2000 && adapter.getArc(car) < 2.2 * 40; i++) adapter.update(1 / 60);
    expect(adapter.getCurrentCell(car)).toEqual({ gx: 2, gy: 0 });

    expect(adapter.crossesPendingDeletionAhead(car)).toBe(false);

    grid.setCell(0, 0, { pendingDeletion: true });
    expect(adapter.crossesPendingDeletionAhead(car)).toBe(false);

    grid.setCell(4, 0, { pendingDeletion: true });
    expect(adapter.crossesPendingDeletionAhead(car)).toBe(true);
  });

  it('reads the grid, not the snapshot the route was built from', () => {
    // The caller asks precisely because a cell was marked *after* the route was compiled.
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    expect(adapter.getRouteFor(car)!.segments.every(s => !s.pendingDeletion)).toBe(true);

    grid.setCell(3, 0, { pendingDeletion: true });
    expect(adapter.crossesPendingDeletionAhead(car)).toBe(true);
  });
});

describe('TrafficAdapter.isCellOccupied', () => {
  it('finds a car by where the simulation holds it, not by where it was last drawn', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    expect(adapter.isCellOccupied(0, 0)).toBe(true);
    expect(adapter.isCellOccupied(3, 0)).toBe(false);

    for (let i = 0; i < 2000 && adapter.getArc(car) < 3 * 40; i++) adapter.update(1 / 60);
    // Deliberately no `writeBack`: the mirror on the car is stale and must not be the source.
    expect(car.pixelPos.x).toBeLessThan(40);
    expect(adapter.isCellOccupied(0, 0)).toBe(false);
    expect(adapter.isCellOccupied(3, 0)).toBe(true);
  });

  it('forgets a despawned car', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    adapter.removeVehicle(car);
    expect(adapter.isCellOccupied(0, 0)).toBe(false);
  });
});
