/**
 * Collapsing every reason to slow down into one virtual leader is the fix for two
 * independently-tuned mechanisms disagreeing about how hard to brake.
 *
 * The model this replaces multiplied the speed limit by
 * `Math.min(followingMult, intersectionMult)` (`CarMovement.ts:129`), where the two
 * multipliers came from `followingSpeedMultiplier` and `computeIntersectionYield` in
 * `CarTrafficManager.ts`. `minOfTwoMultipliers` below is that rule ported to this module's
 * vocabulary, and two tests assert it cannot produce the answer this module must:
 *
 *  - a following ramp on the gap alone is blind to the leader's *speed*, so it treats a
 *    stationary car and a car matching your own speed identically;
 *  - the intersection ramp reached zero `OLD_INTERSECTION_STOP_DIST` from the junction
 *    *centre*, which is inside the junction cell — cars stopped in the box.
 *
 * Expectations are derived from tile arithmetic (`TILE_SIZE`, `CAR_LENGTH`)
 * and from the arcs handed to the vehicles as input, never by reading a value back out of
 * the constraint under test. Where a test depends on a premise — that one arc is nearer
 * than another, that a cell really is an intersection, that the reference model is not
 * vacuously zero — the premise is asserted inline.
 */
import { describe, it, expect } from 'vitest';
import { buildRoute, segmentAt, speedLimitAt } from './route';
import { LaneIndex, laneKey } from './lanes';
import { idmAcceleration } from './headway';
import { DEFAULT_IDM, STOP_LINE_SETBACK } from './tuning';
import { junctionEntryArc, isInsideJunction, junctionKey, nearestConstraint } from './obstacles';
import { SegmentKind, VehicleMode, createWorld } from './types';
import { Direction } from '../types';
import type { Route, RouteInput, TrafficWorld, Vehicle } from './types';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

/**
 * The four tuning values the replaced model ran on, as they last stood in
 * `src/constants.ts` under the names `CAR_MIN_GAP`, `CAR_COMFORT_GAP`,
 * `INTERSECTION_STOP_DIST` and `INTERSECTION_DECEL_DIST`.
 *
 * They are inlined here because Task 14 deleted them from production: nothing computes with
 * them any more, and re-exporting them so a test can describe history would keep a dead
 * mechanism's vocabulary alive on the module surface. Their *values* still matter, because
 * the tests below claim the old rule gave a specific wrong answer, and that claim is only
 * checkable against the numbers the old rule actually used. Keeping them local also freezes
 * them: a future edit to a live constant can no longer silently rewrite what history says.
 */
const OLD_CAR_MIN_GAP = TILE_SIZE * 0.4;
const OLD_CAR_COMFORT_GAP = TILE_SIZE * 1.5;
const OLD_INTERSECTION_STOP_DIST = TILE_SIZE * 0.3;
const OLD_INTERSECTION_DECEL_DIST = TILE_SIZE * 2.0;

/**
 * The stop constraint sits this far past the junction boundary, so that the IDM rest —
 * constraint minus `s0` — lands `STOP_LINE_SETBACK` short of the boundary. A stop line is
 * a line, not a rear bumper; see the note in `tuning.ts`.
 */
const STOP_PAST = DEFAULT_IDM.s0 - STOP_LINE_SETBACK;

const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

/** A straight west-to-east route, one cell per kind, starting at the origin cell. */
function road(id: string, kinds: SegmentKind[], speedLimit = 40): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: kinds.map((kind, i) => ({
        pos: { gx: i, gy: 0 },
        kind,
        speedLimit,
        pendingDeletion: false,
      })),
    }],
  };
}

/**
 * Two grid spans joined by a highway, with the junction in the second span.
 *
 * The highway contributes a segment and no cells, so `segments` and `cells` fall out of
 * index alignment from the crossing onward — which is the whole point of this route.
 */
function highwayRoute(id: string): RouteInput {
  const centre = (gx: number) => ({ x: gx * TILE_SIZE + TILE_SIZE / 2, y: TILE_SIZE / 2 });
  const cell = (gx: number, kind: SegmentKind) => ({
    pos: { gx, gy: 0 }, kind, speedLimit: 40, pendingDeletion: false,
  });
  return {
    id,
    spans: [
      { kind: 'grid', cells: [cell(1, R), cell(2, R)] },
      { kind: 'highway', polyline: [centre(2), centre(6)], speedLimit: 80 },
      { kind: 'grid', cells: [cell(6, R), cell(7, X), cell(8, R)] },
    ],
  };
}

function vehicle(
  id: string, arc: number, speed = 0, mode: VehicleMode = VehicleMode.Driving,
): Vehicle {
  return {
    id, routeId: 'r1', arcDistance: arc, speed, mode,
    lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0, arrivedReported: false,
  };
}

function world(input: RouteInput, ...vehicles: Vehicle[]): TrafficWorld {
  const w = createWorld();
  const route = buildRoute(input);
  expect(route).not.toBeNull();
  w.routes.set(input.id, route!);
  w.vehicles.push(...vehicles);
  return w;
}

function indexed(w: TrafficWorld): LaneIndex {
  const index = new LaneIndex();
  index.rebuild(w);
  return index;
}

/**
 * Admission to specific junctions — the cells at `cellIndices` of `route`.
 *
 * Keyed by junction rather than by vehicle, so admission carries the junction's identity
 * and the same vehicle can appear under two keys at once: the junction it is physically
 * inside, and the one it is about to enter.
 */
function admittedTo(
  route: Route, cellIndices: number[], ...ids: string[]
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const i of cellIndices) {
    const cell = route.cells[i];
    out.set(junctionKey(cell.gx, cell.gy), new Set(ids));
  }
  return out;
}

/** Arc of the centre of the next junction cell strictly ahead, or null. */
function junctionCentreAhead(route: Route, arc: number): number | null {
  for (let i = 0; i < route.cells.length; i++) {
    if (route.cellDist[i] <= arc) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return route.cellDist[i];
  }
  return null;
}

/**
 * The rule this task replaces: two independently-tuned ramps combined with `Math.min`,
 * scaling the speed limit. Returns a target speed in px/s.
 *
 * Faithful to `CarMovement.ts:126-131` — `followingSpeedMultiplier(gap)` is a ramp on the
 * gap alone and `computeIntersectionYield` a ramp on distance to the junction centre,
 * neither aware of the other, and neither able to name *what* it is slowing down for.
 */
function minOfTwoMultipliers(
  w: TrafficWorld, v: Vehicle, index: LaneIndex, admitted: Map<number, Set<string>>,
): number {
  const route = w.routes.get(v.routeId)!;
  const limit = speedLimitAt(route, v.arcDistance);

  const leader = index.findLeader(w, v);
  const gap = leader === null ? Infinity : leader.gap;
  const followingMult = gap <= OLD_CAR_MIN_GAP ? 0
    : gap >= OLD_CAR_COMFORT_GAP ? 1
      : (gap - OLD_CAR_MIN_GAP) / (OLD_CAR_COMFORT_GAP - OLD_CAR_MIN_GAP);

  let intersectionMult = 1;
  // The old rule had no junction identity: admitted anywhere was admitted everywhere.
  if (![...admitted.values()].some(set => set.has(v.id))) {
    const centre = junctionCentreAhead(route, v.arcDistance);
    if (centre !== null) {
      const d = centre - v.arcDistance;
      intersectionMult = d <= OLD_INTERSECTION_STOP_DIST ? 0
        : d >= OLD_INTERSECTION_DECEL_DIST ? 1
          : (d - OLD_INTERSECTION_STOP_DIST) / (OLD_INTERSECTION_DECEL_DIST - OLD_INTERSECTION_STOP_DIST);
    }
  }

  return limit * Math.min(followingMult, intersectionMult);
}

describe('junctionKey', () => {
  it('identifies each junction cell uniquely', () => {
    const keys = new Set<number>();
    for (let gx = 0; gx < 3; gx++) {
      for (let gy = 0; gy < 3; gy++) keys.add(junctionKey(gx, gy));
    }
    // A key that dropped a coordinate would collide, and a car admitted to one junction
    // would be waved through a different one somewhere else on the board.
    expect(keys.size).toBe(9);
    expect(junctionKey(1, 0)).not.toBe(junctionKey(0, 1));
  });

  it('packs its cell the same way a lane key does', () => {
    // One packing convention across the module. `Direction.Up` occupies the zero slot of
    // the lane key's direction field, so the remaining bits are the cell alone.
    expect(junctionKey(5, 7)).toBe(laneKey(5, 7, Direction.Up));
  });
});

describe('junctionEntryArc', () => {
  it('places the stop line half a tile before the junction centre', () => {
    const route = buildRoute(road('r1', [R, R, X, R]))!;
    // Straight route: cell centres sit one tile apart, so the junction centre is 2 tiles in.
    expect(route.cellDist[2]).toBeCloseTo(2 * TILE_SIZE, 5);

    const entry = junctionEntryArc(route, 2);
    expect(entry).toBeCloseTo(2 * TILE_SIZE - TILE_SIZE / 2, 5);
    // The stop line is the junction segment's own start: a car stopped there has not
    // entered the cell at all.
    expect(segmentAt(route, route.cellDist[2])!.kind).toBe(SegmentKind.Intersection);
    expect(segmentAt(route, route.cellDist[2])!.startArc).toBeCloseTo(entry, 5);
  });

  it('clamps to the route start for the first cell', () => {
    const route = buildRoute(road('r1', [X, R, R]))!;
    expect(junctionEntryArc(route, 0)).toBeCloseTo(route.cellDist[0], 5);
  });
});

describe('nearestConstraint', () => {
  it('constrains an empty road only by its end', () => {
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0));
    const route = w.routes.get('r1')!;
    expect(route.length).toBeCloseTo(3 * TILE_SIZE, 5);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(3 * TILE_SIZE, 5);
    expect(c.speed).toBe(0);
  });

  it('constrains by the rear bumper of a car ahead when one is nearer than the end', () => {
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0), vehicle('b', 30, 10));
    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    // Gaps are net: the point the follower must not pass is the leader's rear bumper,
    // one car length behind its centre. Not the leader's centre, and not two lengths back.
    expect(c.arc).toBeCloseTo(30 - CAR_LENGTH, 5);
    expect(c.speed).toBeCloseTo(10, 5);
  });

  it('constrains by a parked car at zero speed', () => {
    const w = world(
      road('r1', [R, R, R, R]),
      vehicle('a', 0),
      vehicle('b', 30, 0, VehicleMode.Parked),
    );
    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(30 - CAR_LENGTH, 5);
    expect(c.speed).toBe(0);
  });

  it('reports an overlapping leader rather than dropping it', () => {
    const overlap = CAR_LENGTH / 2;
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0), vehicle('b', overlap, 5));
    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    // A negative arc — the car the follower most needs to brake for. `idmAcceleration`
    // floors the gap, so this becomes hard braking rather than a dropped constraint.
    expect(c.arc).toBeCloseTo(overlap - CAR_LENGTH, 5);
    expect(c.arc).toBeLessThan(0);
    expect(c.speed).toBeCloseTo(5, 5);
  });

  it('rests an unadmitted car just short of the junction boundary', () => {
    const w = world(road('r1', [R, R, X, R]), vehicle('a', 0));
    const route = w.routes.get('r1')!;
    const boundary = 2 * TILE_SIZE - TILE_SIZE / 2;
    expect(route.length).toBeGreaterThan(boundary);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(boundary + STOP_PAST, 5);
    // The arc is a means; the rest position is the point. IDM parks `s0` behind a
    // constraint, so the car comes to rest `STOP_LINE_SETBACK` outside the boundary —
    // at the line, and still out of the box.
    expect(c.arc - DEFAULT_IDM.s0).toBeCloseTo(boundary - STOP_LINE_SETBACK, 5);
    expect(c.arc - DEFAULT_IDM.s0).toBeLessThan(boundary);
    expect(c.speed).toBe(0);
  });

  it('does not stop at the junction when admitted', () => {
    const w = world(road('r1', [R, R, X, R]), vehicle('a', 0));
    const route = w.routes.get('r1')!;
    const boundary = 2 * TILE_SIZE - TILE_SIZE / 2;

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), admittedTo(route, [2], 'a'));
    expect(c.arc).toBeCloseTo(route.length, 5);
    expect(c.arc).toBeGreaterThan(boundary);
  });

  /**
   * Admission is to *a* junction, not to junctions in general. `_isIntersection` counts
   * cardinal connections, so two junction cells sit side by side wherever two roads run
   * parallel — and a car crossing the first is a candidate for the first while the stop
   * line ahead of it already belongs to the second. Membership alone would wave it out of
   * one junction directly into the cross traffic of the next.
   */
  it('still stops at the next junction when admitted to the one it is in', () => {
    const w = world(road('r1', [R, X, X, R]), vehicle('a', TILE_SIZE, 20));
    const route = w.routes.get('r1')!;
    const index = indexed(w);

    // Premises: the car is inside the first junction, the cell after it is a second
    // junction, and the two have distinct identities.
    expect(isInsideJunction(route, TILE_SIZE)).toBe(true);
    expect(route.cells[1]).toEqual({ gx: 1, gy: 0 });
    expect(route.cells[2]).toEqual({ gx: 2, gy: 0 });
    expect(segmentAt(route, route.cellDist[2])!.kind).toBe(SegmentKind.Intersection);
    expect(junctionKey(1, 0)).not.toBe(junctionKey(2, 0));

    const secondBoundary = (TILE_SIZE + 2 * TILE_SIZE) / 2;
    expect(secondBoundary).toBeGreaterThan(TILE_SIZE);

    const inFirst = nearestConstraint(w, w.vehicles[0], index, admittedTo(route, [1], 'a'));
    expect(inFirst.arc).toBeCloseTo(secondBoundary + STOP_PAST, 5);
    expect(inFirst.speed).toBe(0);

    // Admitted to the second as well, it may cross. Same geometry, so the difference is
    // the identity of the admission and nothing else.
    const inSecond = nearestConstraint(w, w.vehicles[0], index, admittedTo(route, [2], 'a'));
    expect(inSecond.arc).toBeCloseTo(route.length, 5);
  });

  /**
   * How a car mid-crossing gets out. It is offered to two junctions at once — an occupant
   * of the one it is in, an entrant to the one ahead — so admission is keyed by junction
   * with a set of ids under each, not one junction per vehicle. Held to a single junction
   * it could never be admitted to the next, would stop short of that line while still
   * inside the first, and would sit there blocking the cross traffic of a junction it had
   * already been let into.
   */
  it('proceeds when admitted to both the junction it is in and the one ahead', () => {
    const w = world(road('r1', [R, X, X, R]), vehicle('a', TILE_SIZE, 20));
    const route = w.routes.get('r1')!;
    const both = admittedTo(route, [1, 2], 'a');

    // Premise: one vehicle under two distinct junction keys at once — the state the
    // previous vehicle-keyed shape could not represent at all.
    expect(both.size).toBe(2);
    expect(both.get(junctionKey(1, 0))!.has('a')).toBe(true);
    expect(both.get(junctionKey(2, 0))!.has('a')).toBe(true);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), both);
    expect(c.arc).toBeCloseTo(route.length, 5);
    expect(c.speed).toBe(0);
  });

  it('does not constrain an admitted car already past its own stop line', () => {
    const boundary = 2 * TILE_SIZE - TILE_SIZE / 2;
    const inside = boundary + TILE_SIZE / 4;
    const w = world(road('r1', [R, R, X, R]), vehicle('a', inside, 20));
    const route = w.routes.get('r1')!;
    expect(isInsideJunction(route, inside)).toBe(true);
    // Premise: its own junction centre is still ahead of it, so the stop line it has
    // already crossed is a live candidate that admission must suppress.
    expect(route.cellDist[2]).toBeGreaterThan(inside);

    // Braking for a junction it has permission to cross would stop it in the box.
    const c = nearestConstraint(w, w.vehicles[0], indexed(w), admittedTo(route, [2], 'a'));
    expect(c.arc).toBeCloseTo(route.length, 5);
  });

  it('keeps the nearest constraint when several apply', () => {
    const w = world(
      road('r1', [R, R, X, R]),
      vehicle('a', 0),
      vehicle('b', 30, 0, VehicleMode.Parked),
    );
    const parkedRear = 30 - CAR_LENGTH;
    const boundary = 2 * TILE_SIZE - TILE_SIZE / 2;
    const route = w.routes.get('r1')!;
    // Premise: the parked car really is the nearest of the three candidates.
    expect(parkedRear).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(route.length);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(parkedRear, 5);
  });

  /**
   * The other ordering, and the one a min of two multipliers gets wrong: the leader has
   * crossed the stop line and is in the box. Both ramps are engaged here — the following
   * ramp is in fact the tighter of the two, 0.659 against 0.706 — so comparing ramps picks
   * the leader while comparing arcs picks the line, which is the whole difference.
   */
  it('keeps the junction when it is nearer than the car ahead', () => {
    const start = TILE_SIZE / 2;
    const gap = TILE_SIZE * 1.35;
    const w = world(
      road('r1', [R, R, X, R]),
      vehicle('a', start, 20),
      vehicle('b', start + gap + CAR_LENGTH, 10),
    );
    const route = w.routes.get('r1')!;
    const index = indexed(w);
    const boundary = 2 * TILE_SIZE - TILE_SIZE / 2;
    // Premise: the leader's rear bumper is beyond the stop constraint — it is in the box —
    // and the constraint is still ahead of the follower.
    expect(start + gap).toBeGreaterThan(boundary + STOP_PAST);
    expect(boundary).toBeGreaterThan(start);
    expect(isInsideJunction(route, w.vehicles[1].arcDistance)).toBe(true);
    // Premise: the leader is a live candidate, not an absent one. Without this the test
    // would pass just as well against a model that had no following mechanism at all.
    const leader = index.findLeader(w, w.vehicles[0]);
    expect(leader?.id).toBe('b');
    expect(leader!.gap).toBeCloseTo(gap, 5);

    const c = nearestConstraint(w, w.vehicles[0], index, new Map());
    expect(c.arc).toBeCloseTo(boundary + STOP_PAST, 5);
    expect(c.speed).toBe(0);

    // Admit it through, and the same geometry hands back that leader — so the junction won
    // on distance, not by default.
    const admitted = nearestConstraint(w, w.vehicles[0], index, admittedTo(route, [2], 'a'));
    expect(admitted.arc).toBeCloseTo(start + gap, 5);
    expect(admitted.speed).toBeCloseTo(10, 5);
  });

  it('ignores a junction the vehicle has already passed', () => {
    const exitBoundary = 2 * TILE_SIZE + TILE_SIZE / 2;
    const beyond = exitBoundary + TILE_SIZE / 4;
    const w = world(road('r1', [R, R, X, R]), vehicle('a', beyond, 20));
    const route = w.routes.get('r1')!;
    expect(isInsideJunction(route, beyond)).toBe(false);
    expect(beyond).toBeGreaterThan(route.cellDist[2]);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(route.length, 5);
  });

  it('stops at the first of two junctions ahead', () => {
    const w = world(road('r1', [R, X, R, X, R]), vehicle('a', 0));
    const route = w.routes.get('r1')!;
    expect(segmentAt(route, route.cellDist[1])!.kind).toBe(SegmentKind.Intersection);
    expect(segmentAt(route, route.cellDist[3])!.kind).toBe(SegmentKind.Intersection);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(TILE_SIZE - TILE_SIZE / 2 + STOP_PAST, 5);
  });

  it('finds the junction by arc, not by cell index, across a highway', () => {
    const w = world(highwayRoute('r1'), vehicle('a', 0));
    const route = w.routes.get('r1')!;

    // Premise: the highway span has knocked `segments` and `cells` out of alignment, so an
    // index lookup reads a plain road where the junction cell is, and would find the
    // junction one cell too late.
    const junctionCell = 3;
    expect(route.cells[junctionCell]).toEqual({ gx: 7, gy: 0 });
    expect(route.segments[junctionCell].kind).toBe(SegmentKind.Road);
    expect(segmentAt(route, route.cellDist[junctionCell])!.kind).toBe(SegmentKind.Intersection);

    // Two grid cells, then four tiles of highway, then the junction one cell further on.
    const centre = 6 * TILE_SIZE;
    expect(route.cellDist[junctionCell]).toBeCloseTo(centre, 5);
    const boundary = centre - TILE_SIZE / 2;
    const wrongBoundary = junctionEntryArc(route, junctionCell + 1);
    expect(wrongBoundary).toBeGreaterThan(boundary);

    const c = nearestConstraint(w, w.vehicles[0], indexed(w), new Map());
    expect(c.arc).toBeCloseTo(boundary + STOP_PAST, 5);
  });

  it('holds a vehicle in place when its route is gone', () => {
    const w = world(road('r1', [R, R, R, R]));
    const stray: Vehicle = { ...vehicle('a', 25, 30), routeId: 'missing' };
    w.vehicles.push(stray);

    const c = nearestConstraint(w, stray, indexed(w), new Map());
    expect(c.arc).toBeCloseTo(25, 5);
    expect(c.speed).toBe(0);
  });

  /**
   * The keystone. A constraint names an arc *and* a speed, so the headway model can be told
   * "match the car ahead" — the thing a pair of multipliers cannot say. The reference below
   * returns the identical target speed whether the leader is stopped dead or cruising at
   * the follower's own speed, and the follower would brake in both cases or neither.
   */
  it('carries the leader speed, which a min of two multipliers cannot express', () => {
    const limit = 60;
    const followerSpeed = TILE_SIZE;
    // Midway between the desired gap behind a leader matching the follower's speed and the
    // desired gap behind a stopped one — derived so the sign split below is structural
    // rather than an accident of the current `s0`.
    const sMatched = DEFAULT_IDM.s0 + followerSpeed * DEFAULT_IDM.T;
    const sStopped = sMatched
      + (followerSpeed * followerSpeed) / (2 * Math.sqrt(DEFAULT_IDM.a * DEFAULT_IDM.b));
    const gap = (sMatched + sStopped) / 2;
    const leaderArc = gap + CAR_LENGTH;

    const build = (leaderSpeed: number) => {
      const w = world(
        road('r1', [R, R, R, R], limit),
        vehicle('a', 0, followerSpeed),
        vehicle('b', leaderArc, leaderSpeed),
      );
      const index = indexed(w);
      return {
        w,
        constraint: nearestConstraint(w, w.vehicles[0], index, new Map()),
        old: minOfTwoMultipliers(w, w.vehicles[0], index, new Map()),
      };
    };

    const matched = build(followerSpeed);
    const stopped = build(0);

    // Premise: in both worlds the leader is the governing constraint, at the same arc.
    expect(matched.constraint.arc).toBeCloseTo(gap, 5);
    expect(stopped.constraint.arc).toBeCloseTo(gap, 5);
    expect(gap).toBeLessThan(matched.w.routes.get('r1')!.length);

    // The old rule: same answer for both, and not vacuously zero.
    expect(matched.old).toBeGreaterThan(0);
    expect(matched.old).toBe(stopped.old);

    // The new one: the speed of whatever is actually there.
    expect(matched.constraint.speed).toBeCloseTo(followerSpeed, 5);
    expect(stopped.constraint.speed).toBe(0);

    const accel = (speed: number) =>
      idmAcceleration(followerSpeed, limit, gap, speed, DEFAULT_IDM);
    // And the consequence, at the one site where a deceleration is ever computed.
    expect(accel(matched.constraint.speed)).toBeGreaterThan(0);
    expect(accel(stopped.constraint.speed)).toBeLessThan(0);
  });

  /**
   * The old intersection ramp measured to the junction *centre* and reached zero
   * `OLD_INTERSECTION_STOP_DIST` short of it — a stop line inside the cell, where cars came
   * to rest in the box. This module rests an unadmitted car `STOP_LINE_SETBACK` *outside*
   * the boundary, and a car past the boundary is inside the junction, which the stepper
   * always offers and admits (`JunctionCandidate.inside`) — committed cars are carried by
   * admission, never braked mid-box.
   */
  it('carries a car the old ramp would have stopped inside the box', () => {
    // Premise: the old ramp's zero point really did lie within the junction cell.
    expect(OLD_INTERSECTION_STOP_DIST).toBeLessThan(TILE_SIZE / 2);

    const centre = 2 * TILE_SIZE;
    const boundary = centre - TILE_SIZE / 2;
    const oldStopLine = centre - OLD_INTERSECTION_STOP_DIST;
    const between = (boundary + oldStopLine) / 2;
    expect(between).toBeGreaterThan(boundary);
    expect(between).toBeLessThan(oldStopLine);
    // Premise: the old ramp is engaged this close to the junction, not idling at 1.
    expect(centre - between).toBeLessThan(OLD_INTERSECTION_DECEL_DIST);

    const w = world(road('r1', [R, R, X, R]), vehicle('a', between, 20));
    const route = w.routes.get('r1')!;
    const index = indexed(w);

    // The old rule brakes this car toward a rest inside the box: it is past the boundary
    // and short of the centre, so its multiplier is engaged but has not reached zero.
    expect(minOfTwoMultipliers(w, w.vehicles[0], index, new Map())).toBeGreaterThan(0);

    // This module: the car is inside the junction, so it is admitted, and admission
    // dissolves the stop line entirely — the only constraint left is the route's end.
    expect(between).toBeGreaterThan(boundary);
    const c = nearestConstraint(w, w.vehicles[0], index, admittedTo(route, [2], 'a'));
    expect(c.arc).toBeCloseTo(route.length, 5);
    expect(c.arc).toBeGreaterThan(oldStopLine);
  });
});

describe('isInsideJunction', () => {
  it('covers the junction cell and nothing either side of it', () => {
    const route = buildRoute(road('r1', [R, R, X, R]))!;
    expect(isInsideJunction(route, route.cellDist[1])).toBe(false);
    expect(isInsideJunction(route, route.cellDist[2])).toBe(true);
    expect(isInsideJunction(route, route.cellDist[3])).toBe(false);
    // Just inside the entry boundary, and just outside the exit boundary.
    expect(isInsideJunction(route, 2 * TILE_SIZE - TILE_SIZE / 2 + 0.5)).toBe(true);
    expect(isInsideJunction(route, 2 * TILE_SIZE + TILE_SIZE / 2 + 0.5)).toBe(false);
  });
});
