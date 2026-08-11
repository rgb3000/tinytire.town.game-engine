/**
 * The lane index is the fix for cars driving on top of each other.
 *
 * Two properties are under test, and each one names a specific failure of the model this
 * replaces. A lane is keyed by the *directed edge* rather than by the observer's own
 * heading, so every car standing on a stretch of road is visible to every other car on
 * it. And a gap is measured along the route rather than as straight-line pixels, so a
 * leader around a corner is not reported as nearer than it is.
 *
 * Expectations are derived from tile arithmetic and from the arc distances handed to the
 * vehicles as input — never by reading `route.cellDist` back out and asserting the index
 * agrees with it.
 */
import { describe, it, expect } from 'vitest';
import { buildRoute, sampleRoute } from './route';
import { laneKey, edgeIndexAt, LaneIndex } from './lanes';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { Route, RouteCellInput, RouteInput, RouteSpan, TrafficWorld, Vehicle } from './types';
import { Direction } from '../types';
import { CAR_LENGTH, GRID_COLS, GRID_ROWS, TILE_SIZE } from '../constants';
import { LEADER_SCAN_EDGES } from './tuning';

function roadCells(positions: { gx: number; gy: number }[]): RouteCellInput[] {
  return positions.map(pos => ({
    pos,
    kind: SegmentKind.Road,
    speedLimit: 40,
    pendingDeletion: false,
  }));
}

/** An eastbound run of `n` road cells along y = 0, from gx=0. Cell centres one tile apart. */
function straight(id: string, n: number): RouteInput {
  return {
    id,
    spans: [{ kind: 'grid', cells: roadCells(Array.from({ length: n }, (_, i) => ({ gx: i, gy: 0 }))) }],
  };
}

/** A run along y = 0 covering gx `from`..`to` inclusive, eastbound if from < to. */
function alongRow(id: string, from: number, to: number): RouteInput {
  const step = from <= to ? 1 : -1;
  const count = Math.abs(to - from) + 1;
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: roadCells(Array.from({ length: count }, (_, i) => ({ gx: from + i * step, gy: 0 }))),
    }],
  };
}

/** Centre of tile `gx` along the x axis. */
const centreX = (gx: number): number => gx * TILE_SIZE + TILE_SIZE / 2;
/** Arc distance of the `i`th cell of an unsmoothed straight run. */
const arcOfCell = (i: number): number => i * TILE_SIZE;
/**
 * The clear (bumper-to-bumper) gap the index should report for a given centre-to-centre
 * spacing. `LeaderInfo.gap` is net: one car length is deducted there so that no consumer
 * has to, which makes the no-overlap invariant `gap >= 0` instead of `gap >= CAR_LENGTH`.
 */
const clearGap = (centreSpacing: number): number => centreSpacing - CAR_LENGTH;

/** A straight eastbound highway polyline along the tile centre line. */
function highwaySpan(fromX: number, toX: number): RouteSpan {
  return {
    kind: 'highway',
    polyline: [{ x: fromX, y: TILE_SIZE / 2 }, { x: toX, y: TILE_SIZE / 2 }],
    speedLimit: 90,
  };
}

/**
 * Road out to the centre of tile 2, five tiles of highway, then road on from tile 7.
 *
 * The highway contributes 200px of arc and no cells at all, so `cells` is gx 0,1,2,7,8,9
 * at arcs 0/40/80 and 280/320/360, over a route 360px long.
 */
function withHighway(id: string): RouteInput {
  return {
    id,
    spans: [
      { kind: 'grid', cells: roadCells([{ gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }]) },
      highwaySpan(centreX(2), centreX(7)),
      { kind: 'grid', cells: roadCells([{ gx: 7, gy: 0 }, { gx: 8, gy: 0 }, { gx: 9, gy: 0 }]) },
    ],
  };
}

/** Two tiles east, then two tiles south: a right-angle turn at (2,0). */
function corner(id: string): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: roadCells([
        { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 2, gy: 1 }, { gx: 2, gy: 2 },
      ]),
    }],
  };
}

function vehicle(
  id: string,
  routeId: string,
  arc: number,
  speed = 0,
  mode: VehicleMode = VehicleMode.Driving,
): Vehicle {
  return {
    id,
    routeId,
    arcDistance: arc,
    speed,
    mode,
    lastAcceleration: 0,
    arrivalTime: 0,
    distanceThisTick: 0,
    arrivedReported: false,
  };
}

function worldOf(routes: RouteInput[], vehicles: Vehicle[]): TrafficWorld {
  const world = createWorld();
  for (const input of routes) {
    const route = buildRoute(input);
    if (route === null) throw new Error(`fixture route ${input.id} failed to build`);
    world.routes.set(input.id, route);
  }
  world.vehicles.push(...vehicles);
  return world;
}

/** The 8-cell straight route 'r1' plus whatever vehicles are on it. */
function worldWith(...vehicles: Vehicle[]): TrafficWorld {
  return worldOf([straight('r1', 8)], vehicles);
}

function indexed(world: TrafficWorld): LaneIndex {
  const index = new LaneIndex();
  index.rebuild(world);
  return index;
}

function routeOf(world: TrafficWorld, id: string): Route {
  const route = world.routes.get(id);
  if (route === undefined) throw new Error(`no route ${id}`);
  return route;
}

describe('laneKey', () => {
  it('distinguishes the two directions of the same edge', () => {
    expect(laneKey(3, 4, Direction.Right)).not.toBe(laneKey(3, 4, Direction.Left));
  });

  it('distinguishes different cells in the same direction', () => {
    expect(laneKey(3, 4, Direction.Right)).not.toBe(laneKey(4, 4, Direction.Right));
  });

  it('distinguishes cells that differ only in gy', () => {
    expect(laneKey(3, 4, Direction.Right)).not.toBe(laneKey(3, 5, Direction.Right));
  });

  it('is stable for the same inputs', () => {
    expect(laneKey(7, 2, Direction.Up)).toBe(laneKey(7, 2, Direction.Up));
  });

  it('gives all eight directions out of one cell distinct keys', () => {
    const keys = Object.values(Direction).map(dir => laneKey(5, 6, dir));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every cell of the whole grid, in every direction, a distinct key', () => {
    // The full board, not a corner of it: a narrower sweep stays injective under a packing
    // that reserves too few bits for gy, because small gx never collides with it.
    const keys: number[] = [];
    for (let gx = 0; gx < GRID_COLS; gx++) {
      for (let gy = 0; gy < GRID_ROWS; gy++) {
        for (const dir of Object.values(Direction)) keys.push(laneKey(gx, gy, dir));
      }
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('edgeIndexAt', () => {
  it('reports edge 0 at the route start', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, 0)).toBe(0);
  });

  it('advances an edge per tile travelled', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, TILE_SIZE * 1.5)).toBe(1);
  });

  it('puts a car standing exactly on a cell centre on the edge leaving it', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, arcOfCell(2))).toBe(2);
  });

  it('clamps to the last edge past the end', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, route.length + 100)).toBe(3);
  });

  it('resolves a car out on a highway to the synthetic edge spanning it', () => {
    // A highway span contributes no cells, so the edge either side of it joins two cells
    // that are not adjacent — here gx=2 to gx=7. That is deliberate: it puts every car on
    // the crossing into one bucket ordered by arc, which is exactly right for a
    // single-lane highway, and it is the only thing giving those cars a leader at all.
    const route = buildRoute(withHighway('r1'))!;
    expect(edgeIndexAt(route, 150)).toBe(2);
  });
});

describe('LaneIndex.findLeader', () => {
  it('finds a car ahead on the same edge and measures the gap along the route', () => {
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', 25);
    const world = worldWith(me, ahead);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(clearGap(25), 1);
  });

  it('ignores a car behind', () => {
    const me = vehicle('a', 'r1', 40);
    const behind = vehicle('b', 'r1', 10);
    const world = worldWith(me, behind);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });

  it('does not report a car as its own leader', () => {
    const me = vehicle('a', 'r1', 40);
    const world = worldWith(me);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });

  it('picks the nearest of several cars ahead', () => {
    const me = vehicle('a', 'r1', 0);
    const near = vehicle('b', 'r1', 30);
    const far = vehicle('c', 'r1', 70);
    const world = worldWith(me, far, near);

    expect(indexed(world).findLeader(world, me)?.id).toBe('b');
  });

  it('sees a parked car as an obstacle', () => {
    // The bug this fixes: CarLeaderIndex skipped Unloading and Refueling cars while they
    // still sat on the road, so followers drove onto them.
    const me = vehicle('a', 'r1', 0);
    const parked = vehicle('b', 'r1', 35, 0, VehicleMode.Parked);
    const world = worldWith(me, parked);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.speed).toBe(0);
  });

  it('prefers a nearer parked car to a further moving one', () => {
    const me = vehicle('a', 'r1', 0);
    const parked = vehicle('b', 'r1', 30, 0, VehicleMode.Parked);
    const moving = vehicle('c', 'r1', 60, 40);
    const world = worldWith(me, moving, parked);

    expect(indexed(world).findLeader(world, me)?.id).toBe('b');
  });

  it('finds a car one edge further along the route', () => {
    const me = vehicle('a', 'r1', 5);
    const ahead = vehicle('b', 'r1', TILE_SIZE + 10);
    const world = worldWith(me, ahead);

    expect(indexed(world).findLeader(world, me)?.id).toBe('b');
  });

  it('reports the leader speed so the follower can match it', () => {
    const me = vehicle('a', 'r1', 0, 40);
    const ahead = vehicle('b', 'r1', 50, 22);
    const world = worldWith(me, ahead);

    expect(indexed(world).findLeader(world, me)?.speed).toBeCloseTo(22, 5);
  });

  it('deducts exactly one car length from the centre-to-centre spacing', () => {
    // Two cars two tiles apart, centre to centre, have two tiles of road between their
    // centres and one car length less than that between their bumpers.
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', arcOfCell(2));
    const world = worldWith(me, ahead);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.gap).toBeCloseTo(2 * TILE_SIZE - CAR_LENGTH, 5);
  });

  it('reports an overlapping leader with a negative gap instead of dropping it', () => {
    // Closer than a car length is a car partly inside another. Filtering on the *net* gap
    // would discard exactly the vehicle a follower most needs to brake for; IDM floors the
    // gap at 1e-3, so a negative value becomes hard braking, which is what we want.
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', 5);
    const world = worldWith(me, ahead);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeLessThan(0);
    expect(leader?.gap).toBeCloseTo(clearGap(5), 5);
  });

  it('still ignores a car behind even though a near one would net out negative', () => {
    // Ahead-ness is decided before the car length comes off, so a car 5px *behind* is
    // behind — not a leader with a negative gap.
    const me = vehicle('a', 'r1', 40);
    const behind = vehicle('b', 'r1', 35);
    const world = worldWith(me, behind);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });

  it('returns null for a vehicle whose route the world does not have', () => {
    const me = vehicle('a', 'gone', 0);
    const world = worldWith(me);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });
});

describe('LaneIndex scan range', () => {
  /**
   * `LEADER_SCAN_EDGES` is 3, giving roughly 120px of lookahead. That is not arbitrary: a
   * car cannot stop in less than `v² / (2 * MAX_DECELERATION) + s0`, about 34px at the
   * fastest the engine ever runs a car, so the scan carries a 3.5x margin. These two
   * tests pin the number from both sides — a shorter scan misses the first, a longer one
   * fails the second.
   */
  it('finds a leader two edges ahead, at the far end of the scan', () => {
    const me = vehicle('a', 'r1', 5);
    // Between cell centres 2 and 3: edge 2, which is the last edge a 3-edge scan reaches.
    const ahead = vehicle('b', 'r1', arcOfCell(2) + 10);
    const world = worldWith(me, ahead);

    expect(indexed(world).findLeader(world, me)?.id).toBe('b');
  });

  it('ignores a leader three edges ahead, past the end of the scan', () => {
    const me = vehicle('a', 'r1', 5);
    const ahead = vehicle('b', 'r1', arcOfCell(3) + 10);
    const world = worldWith(me, ahead);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });

  it('scans exactly LEADER_SCAN_EDGES edges', () => {
    // Walk a leader forward one edge at a time and record where it stops being visible.
    const visible: boolean[] = [];
    for (let edge = 0; edge < LEADER_SCAN_EDGES + 2; edge++) {
      const me = vehicle('a', 'r1', 5);
      const ahead = vehicle('b', 'r1', arcOfCell(edge) + 10);
      const world = worldWith(me, ahead);
      visible.push(indexed(world).findLeader(world, me) !== null);
    }
    expect(visible.lastIndexOf(true) + 1).toBe(LEADER_SCAN_EDGES);
  });
});

describe('LaneIndex gaps around a corner', () => {
  /**
   * The old index measured straight-line pixels between car centres, which understates
   * the gap wherever the route bends — exactly where the geometry is tightest and the
   * braking matters most. The gap here must be the distance the follower actually has to
   * drive, which on a right-angle turn is visibly more than the chord.
   */
  const AHEAD_ARC = 115;
  const ME_ARC = 55;

  it('measures the gap along the route, not as the chord across the bend', () => {
    const me = vehicle('a', 'c1', ME_ARC);
    const ahead = vehicle('b', 'c1', AHEAD_ARC);
    const world = worldOf([corner('c1')], [me, ahead]);
    const route = routeOf(world, 'c1');

    // Precondition: the two really are on opposite sides of the turn.
    expect(edgeIndexAt(route, AHEAD_ARC)).toBeGreaterThan(edgeIndexAt(route, ME_ARC));

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(clearGap(AHEAD_ARC - ME_ARC), 5);
  });

  it('reports a gap larger than the straight-line distance across the bend', () => {
    const me = vehicle('a', 'c1', ME_ARC);
    const ahead = vehicle('b', 'c1', AHEAD_ARC);
    const world = worldOf([corner('c1')], [me, ahead]);
    const route = routeOf(world, 'c1');

    const here = sampleRoute(route, ME_ARC);
    const there = sampleRoute(route, AHEAD_ARC);
    const chord = Math.hypot(there.x - here.x, there.y - here.y);

    const gap = indexed(world).findLeader(world, me)!.gap;
    // The chord is a centre-to-centre measure, so compare it against the centre-to-centre
    // distance the index implies — adding back the car length it deducted — rather than
    // against the net gap. Comparing the two conventions directly would be meaningless.
    const alongRoute = gap + CAR_LENGTH;
    // The bend is real: the chord cuts the corner by more than a tenth of the distance.
    expect(chord).toBeLessThan(alongRoute * 0.9);
    expect(alongRoute).toBeCloseTo(AHEAD_ARC - ME_ARC, 5);
  });
});

describe('LaneIndex across routes', () => {
  it('sees a car from another route on the same directed edge', () => {
    // r1 runs gx 0..5 east; r2 runs gx 2..7 east. Both traverse the edge (3,0)->(4,0),
    // whose start cell is at arc 120 on r1 and at arc 40 on r2. Offsets are measured from
    // that shared start cell, so 10px along it on r1 and 30px along it on r2 are 20px
    // apart however the two routes are numbered.
    const me = vehicle('a', 'r1', arcOfCell(3) + 10);
    const other = vehicle('b', 'r2', arcOfCell(1) + 30);
    const world = worldOf([alongRow('r1', 0, 5), alongRow('r2', 2, 7)], [me, other]);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(clearGap(20), 1);
  });

  it('does not see a car on the same cells travelling the other way', () => {
    // Oncoming traffic occupies the opposite directed edge and is a different lane. A key
    // that dropped the direction would pair these two up and brake both of them.
    const me = vehicle('a', 'r1', arcOfCell(3) + 10);
    const oncoming = vehicle('b', 'r2', arcOfCell(1) + 30);
    const world = worldOf([alongRow('r1', 0, 5), alongRow('r2', 5, 0)], [me, oncoming]);

    expect(indexed(world).findLeader(world, me)).toBeNull();
    expect(indexed(world).findLeader(world, oncoming)).toBeNull();
  });

  it('does not see a car still on its approach to a shared cell', () => {
    // Deliberate, and not a gap to be papered over: a merge needs three or more road
    // connections, so the shared cell is always an intersection, and junction admission
    // serialises the two. The lane model and the junction model only cover this together.
    // Once the second car has turned onto the shared eastbound stretch it is on the same
    // directed edge and is visible again, which the previous tests cover.
    const me = vehicle('a', 'r1', arcOfCell(2) + 10);
    const approaching = vehicle('b', 'r2', 65);
    const world = worldOf([
      alongRow('r1', 0, 5),
      {
        id: 'r2',
        spans: [{
          kind: 'grid',
          cells: roadCells([
            { gx: 3, gy: 2 }, { gx: 3, gy: 1 }, { gx: 3, gy: 0 }, { gx: 4, gy: 0 }, { gx: 5, gy: 0 },
          ]),
        }],
      },
    ], [me, approaching]);

    // Precondition: 'b' is on the southbound edge into (3,0), not yet on the edge out of
    // it, and 'a' is one edge short of (3,0). Both are about to want the same cell.
    expect(edgeIndexAt(routeOf(world, 'r2'), 65)).toBe(1);
    expect(edgeIndexAt(routeOf(world, 'r1'), arcOfCell(2) + 10)).toBe(2);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });
});

describe('LaneIndex on a highway', () => {
  it('gives two cars out on the same highway span a leader', () => {
    // The span contributes no cells, so both cars resolve to the one synthetic edge from
    // gx=2 to gx=7 and share a bucket ordered by arc. The old model gave cars on a highway
    // no leader whatsoever, which is a direct cause of the overlap this task fixes.
    const me = vehicle('a', 'h1', 150, 60);
    const ahead = vehicle('b', 'h1', 200, 30);
    const world = worldOf([withHighway('h1')], [me, ahead]);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(clearGap(50), 5);
    expect(leader?.speed).toBeCloseTo(30, 5);
  });

  it('picks the nearest of several cars on the same highway span', () => {
    const me = vehicle('a', 'h1', 100);
    const near = vehicle('b', 'h1', 160);
    const far = vehicle('c', 'h1', 240);
    const world = worldOf([withHighway('h1')], [me, far, near]);

    expect(indexed(world).findLeader(world, me)?.id).toBe('b');
  });

  it('lets a car approaching the on-ramp see a car already on the highway', () => {
    // The follower is on the last grid edge before the ramp, so the highway is the very
    // next edge in its scan.
    const me = vehicle('a', 'h1', 70);
    const ahead = vehicle('b', 'h1', 150);
    const world = worldOf([withHighway('h1')], [me, ahead]);

    const leader = indexed(world).findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(clearGap(80), 5);
  });

  it('ignores a car on the highway that is behind', () => {
    const me = vehicle('a', 'h1', 200);
    const behind = vehicle('b', 'h1', 120);
    const world = worldOf([withHighway('h1')], [me, behind]);

    expect(indexed(world).findLeader(world, me)).toBeNull();
  });
});

describe('LaneIndex.rebuild', () => {
  it('reflects vehicles that have moved since the last rebuild', () => {
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', 30);
    const world = worldWith(me, ahead);
    const index = new LaneIndex();
    index.rebuild(world);
    expect(index.findLeader(world, me)?.gap).toBeCloseTo(clearGap(30), 1);

    ahead.arcDistance = 60;
    index.rebuild(world);
    expect(index.findLeader(world, me)?.gap).toBeCloseTo(clearGap(60), 1);
  });

  it('drops vehicles that have left the world', () => {
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', 30);
    const world = worldWith(me, ahead);
    const index = new LaneIndex();
    index.rebuild(world);

    world.vehicles.splice(world.vehicles.indexOf(ahead), 1);
    index.rebuild(world);
    expect(index.findLeader(world, me)).toBeNull();
  });
});
