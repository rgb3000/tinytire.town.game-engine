/**
 * The diagnosis explains a standstill in the stepper's own terms, so most of what this
 * suite pins is *attribution*: the right kind, the right culprit ids, off states built to
 * stand still for one specific reason. Positions are tile arithmetic, as in `step.test.ts`:
 * a five-cell straight span has centres at 0/40/80/120/160, a junction at index 2 owns
 * [60, 100], and its stop constraint sits at 60 + (s0 - STOP_LINE_SETBACK) = 58.
 *
 * The cycle detector gets synthetic graphs, deliberately. A leader relation within one lane
 * is ordered by arc and cannot cycle; real cycles come from junction blame edges, whose
 * construction the attribution tests cover — the detector's own contract (find each cycle,
 * once, canonicalised) is graph-shaped and is tested as a graph.
 */
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { diagnoseWorld, findWaitCycles, formatDiagnosis } from './diagnose';
import { DEFAULT_IDM } from './tuning';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { CAR_LENGTH } from '../constants';

const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

function horizontal(id: string, kinds: SegmentKind[], gy: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: kinds.map((kind, i) => ({
        pos: { gx: i, gy }, kind, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function vertical(id: string, kinds: SegmentKind[], gx: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: kinds.map((kind, i) => ({
        pos: { gx, gy: i }, kind, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(
  id: string, routeId: string, arc: number, speed = 0, mode: VehicleMode = VehicleMode.Driving,
): Vehicle {
  return {
    id, routeId, arcDistance: arc, speed, mode,
    lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0, arrivedReported: false,
  };
}

function reasonOf(world: TrafficWorld, id: string) {
  const d = diagnoseWorld(world).vehicles.find((v) => v.vehicleId === id);
  expect(d).toBeDefined();
  return d!.reason;
}

describe('diagnose: attribution', () => {
  it('reports a rolling car as moving and a parked car as parked', () => {
    const w = createWorld();
    w.routes.set('r1', buildRoute(horizontal('r1', [R, R, R, R, R], 0))!);
    w.vehicles.push(vehicle('m', 'r1', 20, 40), vehicle('p', 'r1', 120, 0, VehicleMode.Parked));

    expect(reasonOf(w, 'm')).toEqual({ kind: 'moving' });
    expect(reasonOf(w, 'p')).toEqual({ kind: 'parked' });
  });

  it('names the leader a stopped follower is held by, with the net gap', () => {
    const w = createWorld();
    w.routes.set('r1', buildRoute(horizontal('r1', [R, R, R, R, R], 0))!);
    const rest = 100 - CAR_LENGTH - DEFAULT_IDM.s0;
    w.vehicles.push(
      vehicle('p', 'r1', 100, 0, VehicleMode.Parked),
      vehicle('f', 'r1', rest, 0),
    );

    expect(reasonOf(w, 'f')).toEqual({
      kind: 'leader', leaderId: 'p', gap: DEFAULT_IDM.s0,
    });
  });

  it('blames the stopped occupant of the exit path when admission is refused for room', () => {
    const w = createWorld();
    w.routes.set('r1', buildRoute(horizontal('r1', [R, R, X, R, R], 0))!);
    w.vehicles.push(
      // Standing just past the box boundary at 100 — too close for a car to rest with its
      // rear clear of the box, so the room test refuses.
      vehicle('p', 'r1', 110, 0, VehicleMode.Parked),
      // At the stop line's rest position, short of the junction boundary at 60.
      vehicle('w', 'r1', 54, 0),
    );

    const reason = reasonOf(w, 'w');
    expect(reason).toMatchObject({
      kind: 'junction',
      junction: { gx: 2, gy: 0 },
      why: 'no-exit-room',
      blockedBy: ['p'],
    });
  });

  it('blames the admitted crossing vehicle when the maneuvers conflict', () => {
    const w = createWorld();
    w.routes.set('ra', buildRoute(horizontal('ra', [R, R, X, R, R], 2))!);
    w.routes.set('rb', buildRoute(vertical('rb', [R, R, X, R, R], 2))!);
    w.vehicles.push(
      // Standing at the centre of the junction cell (2,2): inside, so admitted absolutely.
      vehicle('a', 'ra', 80, 0),
      // Standing at the crossing route's stop line rest, denied by the conflict with `a`.
      vehicle('b', 'rb', 54, 0),
    );

    const reason = reasonOf(w, 'b');
    expect(reason).toMatchObject({
      kind: 'junction',
      junction: { gx: 2, gy: 2 },
      why: 'conflict',
      blockedBy: ['a'],
      holders: ['a'],
    });
    // The car inside the box is not itself junction-blocked — it is free to leave.
    expect(reasonOf(w, 'a').kind).toBe('route-end');
  });
});

describe('diagnose: wait cycles', () => {
  it('finds a cycle once, canonicalised to its smallest id, ignoring feeders into it', () => {
    const edges = new Map<string, string[]>([
      ['c', ['a']], ['a', ['b']], ['b', ['c']], ['d', ['a']],
    ]);
    expect(findWaitCycles(edges)).toEqual([['a', 'b', 'c']]);
  });

  it('finds disjoint cycles separately', () => {
    const edges = new Map<string, string[]>([
      ['a', ['b']], ['b', ['a']], ['x', ['y']], ['y', ['x']],
    ]);
    expect(findWaitCycles(edges)).toEqual([['a', 'b'], ['x', 'y']]);
  });

  it('reports no cycles for a chain ending at a parked car', () => {
    const w = createWorld();
    w.routes.set('r1', buildRoute(horizontal('r1', [R, R, R, R, R], 0))!);
    const rest1 = 100 - CAR_LENGTH - DEFAULT_IDM.s0;
    const rest2 = rest1 - CAR_LENGTH - DEFAULT_IDM.s0;
    w.vehicles.push(
      vehicle('p', 'r1', 100, 0, VehicleMode.Parked),
      vehicle('f1', 'r1', rest1, 0),
      vehicle('f2', 'r1', rest2, 0),
    );

    expect(diagnoseWorld(w).cycles).toEqual([]);
  });
});

describe('diagnose: formatting', () => {
  it('prints the blame line for a frozen approach and the cycle line for a ring', () => {
    const w = createWorld();
    w.routes.set('r1', buildRoute(horizontal('r1', [R, R, X, R, R], 0))!);
    w.vehicles.push(
      vehicle('p', 'r1', 110, 0, VehicleMode.Parked),
      vehicle('w', 'r1', 54, 0),
    );

    const text = formatDiagnosis(diagnoseWorld(w));
    expect(text).toContain('2 not moving');
    expect(text).toContain('junction (2,0) no-exit-room by [p]');

    const ring = formatDiagnosis({
      time: 1,
      vehicles: [],
      cycles: [['a', 'b']],
      overlaps: [{ a: 'a', b: 'b', distance: 3.2 }],
    });
    expect(ring).toContain('DEADLOCK CYCLE: a -> b -> a');
    expect(ring).toContain('OVERLAP: a and b are 3.2px apart');
  });
});
