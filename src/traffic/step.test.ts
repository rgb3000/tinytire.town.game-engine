/**
 * The stepper is where the six modules below it become one simulation, so this suite is
 * mostly about the *seams* rather than about any one module's arithmetic.
 *
 * Three properties carry the weight, and each has a mutant it exists to kill:
 *
 *  - **Order independence.** Pass one reads only frame-start state; pass two writes. A
 *    stepper that reads and writes as it walks `world.vehicles` — the way `CarSystem` did
 *    with its shared `occupied` map — gives different answers for different array orders.
 *  - **Two candidates per vehicle.** A vehicle offers itself to the junction it is *inside*
 *    and to the junction *ahead*. Emitting one deadlocks adjacent junction pairs, and
 *    adjacent junction cells are ordinary in a grid city.
 *  - **A sticky arrival time keyed to the junction actually queued for.** Ageing against
 *    "admitted anywhere" restarts the clock of a car mid-crossing A while it waits at B,
 *    and starves it forever.
 *
 * Fixtures are horizontal, **vertical** and **L-shaped** on purpose. Every route in
 * `route.test.ts`, `routeQueries.test.ts` and `obstacles.test.ts` runs west to east, which
 * is how a `junctionKey` that dropped `gy` survived twenty tests. The two-junction
 * scenarios below run north to south, so a key that collapsed `(3,3)` and `(3,4)` merges
 * two junctions' candidates into one `admit` call and fails outright.
 *
 * Expectations are tile arithmetic. A straight grid span puts cell centres exactly
 * `TILE_SIZE` apart, so a junction cell's stop line and extent are exact numbers, asserted
 * inline wherever a test depends on them.
 */
import { describe, it, expect, vi } from 'vitest';

// A pass-through spy on `admit`, so one test can inspect the *shape* of the candidates the
// stepper emits. Everything else behaves exactly as it would unmocked — `vi.fn` wraps the
// real implementation — so this costs the other 29 tests nothing.
//
// Needed because the maneuver a candidate carries is not fully observable from outside: an
// exit direction that is merely wrong produces *fewer* conflicts, and a junction that admits
// too eagerly looks identical to one nobody contested. Behaviour can show a conflict was
// found; only the candidate can show the right one was asked about.
vi.mock('./junction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./junction')>();
  return { ...actual, admit: vi.fn(actual.admit) };
});

import { buildRoute, sampleRoute, segmentAt } from './route';
import { LaneIndex } from './lanes';
import { admit } from './junction';
import type { JunctionCandidate } from './junction';
import { step } from './step';
import { Direction } from '../types';
import { SegmentKind, VehicleMode, TrafficEventKind, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { DEFAULT_IDM } from './tuning';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

const DT = 1 / 60;
const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

function road(id: string, n: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 }, kind: R, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(
  id: string, arc: number, speed = 0, mode: VehicleMode = VehicleMode.Driving,
): Vehicle {
  return { id, routeId: 'r1', arcDistance: arc, speed, mode, lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0 };
}

function world(n: number, ...vehicles: Vehicle[]): TrafficWorld {
  const w = createWorld();
  w.routes.set('r1', buildRoute(road('r1', n))!);
  w.vehicles.push(...vehicles);
  return w;
}

// --- fixtures for the junction scenarios ------------------------------------------------

/** One grid span from an explicit list of cells, so vertical and L shapes are as easy as straight ones. */
function span(id: string, cells: [number, number, SegmentKind][]): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: cells.map(([gx, gy, kind]) => ({
        pos: { gx, gy }, kind, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function car(
  id: string, routeId: string, arc: number, speed = 0, mode: VehicleMode = VehicleMode.Driving,
): Vehicle {
  return { id, routeId, arcDistance: arc, speed, mode, lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0 };
}

function addRoute(w: TrafficWorld, input: RouteInput): void {
  const r = buildRoute(input);
  expect(r).not.toBeNull();
  w.routes.set(input.id, r!);
}

const find = (w: TrafficWorld, id: string): Vehicle => w.vehicles.find(v => v.id === id)!;

/** Step `n` times, collecting the ids of everything that arrived along the way. */
function run(w: TrafficWorld, n: number): Set<string> {
  const arrived = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (const e of step(w, DT)) {
      if (e.kind === TrafficEventKind.Arrived) arrived.add(e.vehicleId);
    }
  }
  return arrived;
}

/**
 * A north-to-south route through two **adjacent** junction cells, crossed by a
 * west-to-east route at the first of them.
 *
 * `down` runs gx=3, gy=0..7 with junctions at gy=3 (call it A) and gy=4 (B). Straight grid
 * spans are exactly one tile per cell, so A's centre is at arc 120 and B's stop line — the
 * midpoint between the two centres — is at arc 140.
 */
function twoJunctionWorld(): TrafficWorld {
  const w = createWorld();
  addRoute(w, span('down', Array.from({ length: 8 }, (_, gy) =>
    [3, gy, gy === 3 || gy === 4 ? X : R] as [number, number, SegmentKind])));
  addRoute(w, span('across', Array.from({ length: 7 }, (_, gx) =>
    [gx, 3, gx === 3 ? X : R] as [number, number, SegmentKind])));
  return w;
}

describe('step', () => {
  it('moves a lone car forward', () => {
    const w = world(8, vehicle('a', 0));
    step(w, DT);
    expect(w.vehicles[0].arcDistance).toBeGreaterThan(0);
  });

  it('never exceeds the segment speed limit', () => {
    const w = world(20, vehicle('a', 0));
    for (let i = 0; i < 600; i++) step(w, DT);
    expect(w.vehicles[0].speed).toBeLessThanOrEqual(40 + 1e-6);
  });

  it('advances world time by dt', () => {
    const w = world(8, vehicle('a', 0));
    step(w, DT);
    expect(w.time).toBeCloseTo(DT, 9);
  });

  it('never moves a car backwards', () => {
    const w = world(20, vehicle('a', 0), vehicle('b', 60));
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      step(w, DT);
      expect(w.vehicles[0].arcDistance).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = w.vehicles[0].arcDistance;
    }
  });

  it('keeps a follower at least the standstill gap behind a parked car', () => {
    const w = world(20, vehicle('a', 0, 40), vehicle('b', 200, 0, VehicleMode.Parked));
    for (let i = 0; i < 1200; i++) {
      step(w, DT);
      const gap = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance;
      expect(gap).toBeGreaterThan(CAR_LENGTH);
    }
    // Arc difference is centre-to-centre; the NET gap the model controls is that minus
    // one car length. At rest the follower settles at s0 of clear bumper space, so the
    // centre spacing is CAR_LENGTH + s0. The 0.9 absorbs 60Hz Euler undershoot, which
    // settles a couple of percent short.
    const finalGap = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance;
    expect(finalGap).toBeGreaterThanOrEqual(CAR_LENGTH + DEFAULT_IDM.s0 * 0.9);
  });

  it('does not let a car jump more than its speed allows in one tick', () => {
    const w = world(20, vehicle('a', 0));
    for (let i = 0; i < 300; i++) {
      const before = w.vehicles[0].arcDistance;
      step(w, DT);
      const moved = w.vehicles[0].arcDistance - before;
      expect(moved).toBeLessThanOrEqual(40 * DT + 1e-6);
    }
  });

  it('emits an arrival event when a car reaches its destination cell', () => {
    const w = world(4, vehicle('a', 0, 40));
    let arrived = false;
    for (let i = 0; i < 600 && !arrived; i++) {
      arrived = step(w, DT).some(e => e.kind === TrafficEventKind.Arrived && e.vehicleId === 'a');
    }
    expect(arrived).toBe(true);
  });

  it('records distance travelled on the vehicle so the adapter can deduct fuel', () => {
    const w = world(20, vehicle('a', 0, 40));
    step(w, DT);
    expect(w.vehicles[0].distanceThisTick).toBeGreaterThan(0);
  });

  it('emits arrival once, not on every tick spent at the end', () => {
    const w = world(4, vehicle('a', 0, 40));
    let arrivals = 0;
    for (let i = 0; i < 900; i++) {
      arrivals += step(w, DT).filter(e => e.kind === TrafficEventKind.Arrived).length;
    }
    expect(arrivals).toBe(1);
  });

  it('does not advance a parked car', () => {
    const w = world(20, vehicle('a', 100, 0, VehicleMode.Parked));
    for (let i = 0; i < 60; i++) step(w, DT);
    expect(w.vehicles[0].arcDistance).toBe(100);
  });

  it('reports no distance travelled for a parked car, so the adapter burns no fuel', () => {
    // A vehicle that drove and then parked must not keep reporting its last moving tick
    // forever: the adapter deducts fuel from this field every frame.
    const w = world(20, vehicle('a', 0, 40));
    step(w, DT);
    expect(w.vehicles[0].distanceThisTick).toBeGreaterThan(0);

    w.vehicles[0].mode = VehicleMode.Parked;
    step(w, DT);
    expect(w.vehicles[0].distanceThisTick).toBe(0);
  });

  it('produces the same result regardless of vehicle array order', () => {
    const forward = world(20, vehicle('a', 0, 20), vehicle('b', 80, 20), vehicle('c', 160, 20));
    const reverse = world(20, vehicle('c', 160, 20), vehicle('b', 80, 20), vehicle('a', 0, 20));
    for (let i = 0; i < 240; i++) { step(forward, DT); step(reverse, DT); }

    const arcOf = (w: TrafficWorld, id: string) => w.vehicles.find(v => v.id === id)!.arcDistance;
    for (const id of ['a', 'b', 'c']) {
      expect(arcOf(forward, id)).toBeCloseTo(arcOf(reverse, id), 9);
    }
  });

  it('stops at the end of the route rather than running past it', () => {
    const w = world(4, vehicle('a', 0, 40));
    const route = w.routes.get('r1')!;
    for (let i = 0; i < 1200; i++) step(w, DT);
    expect(w.vehicles[0].arcDistance).toBeLessThanOrEqual(route.length + 1e-6);
    // Bounded below too. The upper bound alone is satisfied by the `Math.min(…, length)`
    // write on its own, so a stepper that never moved a car would pass it.
    expect(w.vehicles[0].arcDistance).toBeGreaterThan(route.length - TILE_SIZE);
  });

  it('parks closer to the route end than the arrival threshold, which is what makes arrival reachable', () => {
    // `ARRIVAL_SLACK` is half a tile, and the destination is a stop line the headway model
    // parks `s0` short of. Arrival is only reachable while that shortfall stays inside the
    // slack — raise `s0` past half a tile and no vehicle in the game would ever arrive.
    // Asserted on the measured resting position rather than by restating the inequality.
    const w = world(8, vehicle('a', 0, 40));
    for (let i = 0; i < 1200; i++) step(w, DT);

    const shortfall = w.routes.get('r1')!.length - w.vehicles[0].arcDistance;
    expect(shortfall).toBeGreaterThan(0);              // it really does park short of the end
    expect(shortfall).toBeLessThan(TILE_SIZE / 2);     // ...but inside the arrival slack
  });

  it('scales the arrival threshold down on a route shorter than two slacks', () => {
    // The `route.length / 2` floor. A grid span is at least two cells and so at least a tile
    // long, but a highway span carries an arbitrary polyline. On a route under two slacks a
    // flat half-tile threshold sits nearer the origin than the destination — on a 30px route
    // it would fire at arc 10 — so the floor keeps "arrived" in the far half whatever the
    // length, and keeps the arrival arc strictly inside the route.
    const w = createWorld();
    const short = buildRoute({
      id: 'r1',
      spans: [{ kind: 'highway', polyline: [{ x: 0, y: 0 }, { x: 30, y: 0 }], speedLimit: 40 }],
    })!;
    // Premise: the route really is in the band where the floor binds.
    expect(short.length).toBeCloseTo(30, 6);
    expect(short.length).toBeLessThan(2 * TILE_SIZE / 2);
    w.routes.set('r1', short);
    w.vehicles.push(vehicle('a', 0, 40));

    let arrivals = 0;
    let arcAtArrival = -1;
    for (let i = 0; i < 600; i++) {
      const n = step(w, DT).filter(e => e.kind === TrafficEventKind.Arrived).length;
      if (n > 0) arcAtArrival = w.vehicles[0].arcDistance;
      arrivals += n;
    }
    expect(arrivals).toBe(1);
    expect(arcAtArrival).toBeGreaterThanOrEqual(short.length / 2);
  });

  it('gets a car whose route ends in a junction cell through it and out', () => {
    // A terminal junction has no exit cell. Skipping the candidate for want of an exit
    // maneuver strands the vehicle for ever: `nextJunctionCell` still imposes the stop line,
    // and with no candidate no admission can arrive to lift it. Measured before the fix, the
    // car parked at arc 86.28 and never arrived in 3000 ticks.
    const w = createWorld();
    addRoute(w, span('ends', [[0, 0, R], [1, 0, R], [2, 0, R], [3, 0, X]]));
    const route = w.routes.get('ends')!;

    // Premises: the last cell really is the junction, and really is last.
    expect(route.cells.length).toBe(4);
    expect(segmentAt(route, route.cellDist[3])!.kind).toBe(SegmentKind.Intersection);

    w.vehicles.push(car('a', 'ends', 0, 40));
    const arrived = run(w, 900);

    expect(arrived.has('a')).toBe(true);
    // And it got there, rather than tripping the event from behind the stop line at 100.
    expect(find(w, 'a').arcDistance).toBeGreaterThan(100);
  });

  it('offers a terminal junction a straight-through maneuver, not an arbitrary exit', () => {
    // A route ending in a junction has no exit cell, so the exit direction is a choice. It
    // must be `entry` — the vehicle continuing the way it came — because that is the only
    // choice whose chord *contains* the ground the vehicle actually occupies. Any other
    // fixed direction sweeps a chord across ground it never touches while leaving ground it
    // does touch uncovered, so it misses real conflicts and admits crossing traffic on top
    // of a stationary car. `Direction.Up` in place of `entry` misses 13 true conflicts and
    // is invisible to every other test in this file, which is why this one reads the
    // candidate rather than the outcome.
    const w = createWorld();
    addRoute(w, span('ends', [[0, 0, R], [1, 0, R], [2, 0, R], [3, 0, X]]));
    w.vehicles.push(car('a', 'ends', 0, 40));

    vi.mocked(admit).mockClear();
    step(w, DT);

    const calls = vi.mocked(admit).mock.calls;
    // Premise: the terminal junction was put to `admit` at all, exactly once.
    expect(calls.length).toBe(1);
    const candidates = calls[0][0] as JunctionCandidate[];
    expect(candidates.map(c => c.vehicleId)).toEqual(['a']);

    // The route runs west to east, so entry is Right and a straight-through exit is Right.
    expect(candidates[0].entry).toBe(Direction.Right);
    expect(candidates[0].exit).toBe(Direction.Right);
    expect(candidates[0].exit).toBe(candidates[0].entry);
  });

  it('still makes a car entering a terminal junction yield to crossing traffic', () => {
    // Pins that a terminal junction is regulated at all — that a candidate and a stop line
    // both exist, so the vehicle yields rather than being waved through. It does *not* pin
    // the maneuver's shape; the test above does that, and neither subsumes the other.
    const w = createWorld();
    addRoute(w, span('ends', [[0, 3, R], [1, 3, R], [2, 3, R], [3, 3, X]]));
    addRoute(w, span('down', [[3, 1, R], [3, 2, R], [3, 3, X], [3, 4, R], [3, 5, R]]));

    // `holder` is stopped inside the junction and stays there, so it holds the box.
    w.vehicles.push(car('holder', 'down', 85));
    w.vehicles.push(car('blocker', 'down', 120, 0, VehicleMode.Parked));
    w.vehicles.push(car('arriver', 'ends', 0, 40));

    for (let i = 0; i < 900; i++) step(w, DT);

    const holder = find(w, 'holder');
    // Premise: the holder really is inside the junction cell, whose extent is [60,100].
    expect(holder.arcDistance).toBeGreaterThan(60);
    expect(holder.arcDistance).toBeLessThan(100);
    expect(holder.speed).toBeLessThan(1e-3);

    // So the terminal-junction car is held at its own stop line, at arc 100.
    const arriver = find(w, 'arriver');
    expect(arriver.arcDistance).toBeLessThan(100);
    expect(arriver.arcDistance).toBeGreaterThan(100 - 3 * DEFAULT_IDM.s0);
  });

  it('stops a car inserted closer than its own braking distance from driving through the one ahead', () => {
    // The safety net's job. At 40px/s and a 160px/s² ceiling on braking, a car needs 5px to
    // stop; placed 1px behind a stationary car's rear bumper it cannot, and the headway
    // model alone carries it 3.7px through. Nothing in the simulation creates that state,
    // which is exactly why the net has to exist: it is the boundary against whatever the
    // adapter hands in.
    const w = world(20, vehicle('a', 200 - CAR_LENGTH - 1, 40), vehicle('b', 200, 0, VehicleMode.Parked));
    // Premise: the follower really does start inside its own stopping distance.
    expect(w.vehicles[1].arcDistance - w.vehicles[0].arcDistance - CAR_LENGTH).toBeCloseTo(1, 9);

    for (let i = 0; i < 300; i++) {
      step(w, DT);
      const net = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance - CAR_LENGTH;
      expect(net).toBeGreaterThanOrEqual(0);
    }
  });

  it('lets the headway model, not the safety net, choose where a car comes to rest', () => {
    // The net defends the leader's rear bumper, not `bumper - s0`. IDM's own equilibrium is
    // a gap of exactly s0, which a 60Hz Euler integrator settles a fraction of a pixel
    // inside — so a ceiling at `bumper - s0` would fire on most ticks of an ordinary stop
    // and pin the resting gap to exactly s0 instead of leaving it where the model put it.
    const w = world(20, vehicle('a', 0, 40), vehicle('b', 200, 0, VehicleMode.Parked));
    for (let i = 0; i < 1200; i++) step(w, DT);

    const net = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance - CAR_LENGTH;
    expect(net).toBeLessThan(DEFAULT_IDM.s0);
    expect(net).toBeGreaterThan(DEFAULT_IDM.s0 * 0.9);
  });

  it('rebuilds the lane index once per tick, not once per vehicle', () => {
    // Per-vehicle rebuilds are quadratic in the vehicle count, and a rebuild mid-pass
    // would also feed pass one a partially-written frame.
    const w = world(20, ...Array.from({ length: 5 }, (_, i) => vehicle(`v${i}`, i * 30, 10)));
    const spy = vi.spyOn(LaneIndex.prototype, 'rebuild');
    try {
      step(w, DT);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Junction admission is keyed by junction *and* a vehicle may appear under two keys at
 * once. Task 6 structurally cannot show that second key mattering — `nearestConstraint`
 * consults only the junction ahead, so admission to the junction a car is *in* never
 * reaches its output. The stepper is the first place it becomes observable, and these are
 * the tests that observe it.
 */
describe('step: junction admission across two adjacent junctions', () => {
  it('keeps the junction it is inside reserved while it waits at the next one', () => {
    const w = twoJunctionWorld();
    const down = w.routes.get('down')!;
    const across = w.routes.get('across')!;

    // Premises, asserted rather than assumed: both cells really are intersections, they
    // really are adjacent, and the arithmetic below really is one tile per cell.
    expect(segmentAt(down, 120)!.kind).toBe(SegmentKind.Intersection);
    expect(segmentAt(down, 160)!.kind).toBe(SegmentKind.Intersection);
    expect(down.cellDist[3]).toBeCloseTo(3 * TILE_SIZE, 9);
    expect(down.cellDist[4]).toBeCloseTo(4 * TILE_SIZE, 9);
    expect(across.cellDist[3]).toBeCloseTo(3 * TILE_SIZE, 9);

    const A_ENTRY_DOWN = 100;  // midpoint of cellDist[2]=80 and cellDist[3]=120
    const A_EXIT_DOWN = 140;   // midpoint of cellDist[3]=120 and cellDist[4]=160, = B's stop line
    const A_ENTRY_ACROSS = 100;

    // `x` starts just inside A. `blocker` is parked in the cell beyond B, so B's exit has
    // no room and `x` can never be admitted to B — it comes to rest inside A.
    w.vehicles.push(car('x', 'down', 105));
    w.vehicles.push(car('blocker', 'down', 200, 0, VehicleMode.Parked));
    // `cross` approaches A from the west and conflicts with `x`'s southbound maneuver.
    w.vehicles.push(car('cross', 'across', 40, 20));

    for (let i = 0; i < 900; i++) step(w, DT);

    const x = find(w, 'x');
    const cross = find(w, 'cross');

    // `x` did move — the test is not passing because it never started.
    expect(x.arcDistance).toBeGreaterThan(105);
    // ...and stopped short of B's stop line, physically stranded inside A.
    expect(x.arcDistance).toBeLessThan(A_EXIT_DOWN);
    expect(x.arcDistance).toBeGreaterThan(A_ENTRY_DOWN);
    expect(x.speed).toBeLessThan(1e-3);

    // Which is the whole point: A stays reserved, so the crossing stream is held out.
    // Offer `x` only to the junction ahead and A sees no candidate at all, admits `cross`,
    // and drives it into an occupied box.
    expect(cross.arcDistance).toBeLessThan(A_ENTRY_ACROSS);
    // Non-vacuous: `cross` really did come up to the line rather than stall far away.
    expect(cross.arcDistance).toBeGreaterThan(A_ENTRY_ACROSS - 3 * DEFAULT_IDM.s0);
  });

  it('lets a car admitted to both junctions cross them both', () => {
    const w = twoJunctionWorld();
    const down = w.routes.get('down')!;
    const across = w.routes.get('across')!;

    expect(segmentAt(down, 120)!.kind).toBe(SegmentKind.Intersection);
    expect(segmentAt(down, 160)!.kind).toBe(SegmentKind.Intersection);

    // Same board as above minus the blocker: nothing stops `x` earning admission to B.
    w.vehicles.push(car('x', 'down', 105));
    w.vehicles.push(car('cross', 'across', 40, 20));

    const arrived = run(w, 1500);

    expect(arrived.has('x')).toBe(true);
    // And once `x` has left A, the crossing stream gets its turn — no deadlock either way.
    expect(arrived.has('cross')).toBe(true);
    // Both really did travel the length of their routes, not merely trip an event early.
    expect(find(w, 'x').arcDistance).toBeGreaterThan(down.length - TILE_SIZE);
    expect(find(w, 'cross').arcDistance).toBeGreaterThan(across.length - TILE_SIZE);
  });

  it('holds a sticky arrival time against the junction it is queueing for', () => {
    // A car mid-crossing A while blocked at B is admitted to A on every tick. Ageing
    // against "admitted anywhere" would reset its clock forever and starve it at B, and
    // re-stamping the clock every tick would do the same. Both must leave this untouched.
    const w = twoJunctionWorld();
    w.vehicles.push(car('x', 'down', 105));
    w.vehicles.push(car('blocker', 'down', 200, 0, VehicleMode.Parked));

    for (let i = 0; i < 300; i++) step(w, DT);

    const x = find(w, 'x');
    // Premise: it really is waiting inside A, not still rolling.
    expect(x.speed).toBeLessThan(1e-3);
    expect(x.arcDistance).toBeGreaterThan(100);
    expect(x.arcDistance).toBeLessThan(140);

    const stamped = x.arrivalTime;
    expect(stamped).toBeGreaterThan(0);

    for (let i = 0; i < 300; i++) {
      step(w, DT);
      expect(x.arrivalTime).toBe(stamped);
    }
    // The clock is genuinely ageing: it was stamped well before the world time now is.
    expect(w.time).toBeGreaterThan(stamped + 1);
  });

  it('clears the arrival time once the vehicle is admitted to the junction it waited at', () => {
    const w = twoJunctionWorld();
    w.vehicles.push(car('x', 'down', 105));
    const blocker = car('blocker', 'down', 200, 0, VehicleMode.Parked);
    w.vehicles.push(blocker);

    for (let i = 0; i < 300; i++) step(w, DT);
    const x = find(w, 'x');
    expect(x.arrivalTime).toBeGreaterThan(0);

    // Clear the exit and `x` is admitted to B, which is what resets the clock.
    w.vehicles.splice(w.vehicles.indexOf(blocker), 1);
    step(w, DT);
    expect(x.arrivalTime).toBe(0);
  });

  it('admits a car standing inside a junction, so its stop line is never behind it', () => {
    // Stop lines sit at a junction cell's near boundary, so a car past that boundary and
    // not admitted is handed a constraint *behind itself* — a negative gap, and therefore
    // maximal braking for as long as it stands there. The stepper's part of avoiding that
    // is to keep offering such a car as an `inside` candidate; `admit` does the rest, and
    // owns the separate rule that an inside candidate is exempt from `exitHasRoom`.
    // The blocked exit below is what makes that exemption necessary here.
    const w = createWorld();
    addRoute(w, span('down', Array.from({ length: 7 }, (_, gy) =>
      [3, gy, gy === 3 ? X : R] as [number, number, SegmentKind])));
    const down = w.routes.get('down')!;
    expect(segmentAt(down, 120)!.kind).toBe(SegmentKind.Intersection);

    w.vehicles.push(car('x', 'down', 105));
    w.vehicles.push(car('blocker', 'down', 160, 0, VehicleMode.Parked));

    // Premise: the blocker really does deny the junction's exit cell.
    expect(down.cells[4]).toEqual({ gx: 3, gy: 4 });
    expect(find(w, 'blocker').speed).toBe(0);

    for (let i = 0; i < 600; i++) step(w, DT);

    const x = find(w, 'x');
    // It crossed A's centre and closed up on the parked car, rather than freezing on the
    // spot with a stop line behind it.
    expect(x.arcDistance).toBeGreaterThan(125);
    // Still behind the blocker's rear bumper, by roughly the standstill gap.
    expect(x.arcDistance).toBeLessThan(160 - CAR_LENGTH);
  });

  it('keeps a junction reserved by a car in the far half of a cell shared between two spans', () => {
    // A junction cell that is the joint between two grid spans keeps a half-segment from
    // each. Deriving "inside" from the segment found at the cell centre therefore covers
    // only the first half of such a cell, and a car in the far half vanishes from the
    // junction's candidate list while it is still physically in the box.
    const w = createWorld();
    const cell = (gx: number, gy: number, kind: SegmentKind) =>
      ({ pos: { gx, gy }, kind, speedLimit: 40, pendingDeletion: false });
    const joint: RouteInput = {
      id: 'joint',
      spans: [
        { kind: 'grid', cells: [cell(0, 2, R), cell(1, 2, R), cell(2, 2, X)] },
        { kind: 'grid', cells: [cell(2, 2, X), cell(3, 2, R), cell(4, 2, R)] },
      ],
    };
    addRoute(w, joint);
    addRoute(w, span('down', [[2, 0, R], [2, 1, R], [2, 2, X], [2, 3, R], [2, 4, R]]));

    const jr = w.routes.get('joint')!;
    // Premise: the junction cell really is the shared joint, and really does span [60,100].
    expect(jr.cells[2]).toEqual({ gx: 2, gy: 2 });
    expect(jr.cellDist[2]).toBeCloseTo(2 * TILE_SIZE, 9);
    expect(segmentAt(jr, 80)!.kind).toBe(SegmentKind.Intersection);

    // `x` sits in the far half of the junction cell, held there by a parked car beyond it.
    w.vehicles.push(car('x', 'joint', 90));
    w.vehicles.push(car('parked', 'joint', 120, 0, VehicleMode.Parked));
    w.vehicles.push(car('cross', 'down', 20, 20));

    for (let i = 0; i < 600; i++) step(w, DT);

    const x = find(w, 'x');
    // Premise: `x` really is in the far half — past the centre, short of the boundary.
    expect(x.arcDistance).toBeGreaterThan(80);
    expect(x.arcDistance).toBeLessThan(100);

    // So the crossing stream must still be held out of the box.
    const cross = find(w, 'cross');
    expect(cross.arcDistance).toBeLessThan(60);   // midpoint of cellDist 40 and 80
    expect(cross.arcDistance).toBeGreaterThan(60 - 3 * DEFAULT_IDM.s0);
  });
});

describe('step: L-shaped routes', () => {
  /**
   * Two routes merging into the same southbound cells through a junction at a corner.
   *
   * A shared exit is a conflict, so admission serialises them; downstream they share one
   * directed edge, so the lane index makes them each other's leader. Both mechanisms have
   * to work for both cars to arrive without ever overlapping.
   */
  function mergeWorld(): TrafficWorld {
    const w = createWorld();
    addRoute(w, span('corner', [
      [0, 2, R], [1, 2, R], [2, 2, R], [3, 2, X], [3, 3, R], [3, 4, R], [3, 5, R],
    ]));
    addRoute(w, span('straight', [
      [3, 0, R], [3, 1, R], [3, 2, X], [3, 3, R], [3, 4, R], [3, 5, R],
    ]));
    return w;
  }

  it('serialises two routes merging through a corner junction and both arrive', () => {
    const w = mergeWorld();
    const corner = w.routes.get('corner')!;
    const straight = w.routes.get('straight')!;

    // Premise: the corner cell really is the junction on both routes.
    expect(corner.cells[3]).toEqual({ gx: 3, gy: 2 });
    expect(straight.cells[2]).toEqual({ gx: 3, gy: 2 });
    expect(segmentAt(corner, corner.cellDist[3])!.kind).toBe(SegmentKind.Intersection);
    expect(segmentAt(straight, straight.cellDist[2])!.kind).toBe(SegmentKind.Intersection);

    w.vehicles.push(car('turner', 'corner', 0, 20));
    w.vehicles.push(car('straighter', 'straight', 0, 20));

    const arrived = new Set<string>();
    let minSeparation = Infinity;
    let heldAtTheLine = false;
    for (let i = 0; i < 1500; i++) {
      for (const e of step(w, DT)) {
        arrived.add(e.vehicleId);
        // Both routes end in the same cell, so whoever gets there first would otherwise
        // block the other for ever. The adapter removes an arrived car; the test does the
        // same, because the claim here is about the merge, not about parking.
        w.vehicles.splice(w.vehicles.findIndex(v => v.id === e.vehicleId), 1);
      }
      const t = w.vehicles.find(v => v.id === 'turner');
      const s = w.vehicles.find(v => v.id === 'straighter');
      // `straight`'s junction is cell 2, so its stop line is the midpoint of cellDist 40
      // and 80. A car stationary short of that is one the junction actually held back.
      if (s !== undefined && s.speed < 1 && s.arcDistance < 60) heldAtTheLine = true;
      if (t !== undefined && s !== undefined) {
        const a = sampleRoute(corner, t.arcDistance);
        const b = sampleRoute(straight, s.arcDistance);
        minSeparation = Math.min(minSeparation, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }

    expect(arrived.has('turner')).toBe(true);
    expect(arrived.has('straighter')).toBe(true);
    // Non-vacuous on both counts: one of them really was stopped at the junction, and they
    // really did come near each other rather than passing at opposite ends of the board.
    expect(heldAtTheLine).toBe(true);
    expect(minSeparation).toBeLessThan(2 * TILE_SIZE);
    // ...and they never drove through one another on the way.
    expect(minSeparation).toBeGreaterThan(CAR_LENGTH);
  });

  it('drives a lone car the whole way round an L without exceeding the limit', () => {
    const w = mergeWorld();
    const corner = w.routes.get('corner')!;
    w.vehicles.push(car('turner', 'corner', 0, 0));

    let arrived = false;
    for (let i = 0; i < 1200; i++) {
      arrived ||= step(w, DT).some(e => e.kind === TrafficEventKind.Arrived);
      expect(w.vehicles[0].speed).toBeLessThanOrEqual(40 + 1e-6);
    }
    expect(arrived).toBe(true);
    expect(w.vehicles[0].arcDistance).toBeGreaterThan(corner.length - TILE_SIZE);
  });
});

describe('step: vertical routes', () => {
  it('runs a north-to-south queue without collisions', () => {
    const w = createWorld();
    addRoute(w, span('down', Array.from({ length: 10 }, (_, gy) =>
      [5, gy, R] as [number, number, SegmentKind])));
    const down = w.routes.get('down')!;

    w.vehicles.push(car('lead', 'down', 120, 0, VehicleMode.Parked));
    w.vehicles.push(car('follow', 'down', 0, 40));

    for (let i = 0; i < 900; i++) {
      step(w, DT);
      expect(find(w, 'lead').arcDistance - find(w, 'follow').arcDistance)
        .toBeGreaterThan(CAR_LENGTH);
    }
    // Premise: the follower actually closed the 120px it started with.
    expect(find(w, 'follow').arcDistance).toBeGreaterThan(120 - CAR_LENGTH - 2 * DEFAULT_IDM.s0);
    expect(down.cellDist[1]).toBeCloseTo(TILE_SIZE, 9);
  });
});
