/**
 * The mutual inside-hold class, from the first real deadlock the demo's freeze watchdog
 * captured (2026-08-12, dump `b -> e -> b`).
 *
 * Two junction cells that are *grid neighbours* put junction B's stop line inside junction
 * A's box: the stop line sits on the shared cell boundary and the rest position
 * `STOP_LINE_SETBACK` before it — which is inside A. Two opposing cars, each regularly
 * admitted through its first junction, each stopping at the second one's line, therefore
 * come to rest inside each other's box. Inside means absolute priority — it must, or cross
 * traffic would be admitted into a car physically in the way — so neither hold ever lifts,
 * and no reroute can help because the block is the cars' physical positions, not their
 * routes. The per-junction greedy order cannot see this: it is deadlock-free per junction,
 * and this cycle spans two.
 *
 * The fixture reconstructs the captured geometry minimally: an east-west corridor of two
 * adjacent junction cells, one car straight through westbound, one entering the corridor
 * from the north (a left turn across the westbound lane) and leaving it to the north (a
 * second left turn). Both maneuver pairs conflict by chord geometry, which is what makes
 * each car's inside-hold binding on the other. The routes are timed so both cars are
 * admitted into their first junction while the other approaches — honest driving, no
 * hand-placed frozen state.
 */
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { diagnoseWorld, formatDiagnosis } from './diagnose';
import { step } from './step';
import { SegmentKind, TrafficEventKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';

const DT = 1 / 60;
const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

function routeOf(id: string, cells: Array<[number, number, SegmentKind]>): RouteInput {
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

function vehicle(id: string, routeId: string, arc: number): Vehicle {
  return {
    id, routeId, arcDistance: arc, speed: 0, mode: VehicleMode.Driving,
    lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0, arrivedReported: false,
  };
}

/** Westbound straight through both corridor cells: (6,2) -> (0,2). */
const WEST: Array<[number, number, SegmentKind]> = [
  [6, 2, R], [5, 2, R], [4, 2, R], [3, 2, X], [2, 2, X], [1, 2, R], [0, 2, R],
];
/** From the north, east along the corridor, out to the north: two left turns. */
const TURNER: Array<[number, number, SegmentKind]> = [
  [2, 0, R], [2, 1, R], [2, 2, X], [3, 2, X], [3, 1, R], [3, 0, R],
];

function corridorWorld(): TrafficWorld {
  const w = createWorld();
  w.routes.set('west', buildRoute(routeOf('west', WEST))!);
  w.routes.set('turner', buildRoute(routeOf('turner', TURNER))!);
  // Symmetric approaches: `west` has 100px to its first stop line (junction (3,2) entry
  // boundary at arc 100), `turner` has 60px to its (junction (2,2) boundary at arc 60).
  // Both are admitted into their first, empty junction while the other approaches.
  w.vehicles.push(vehicle('west', 'west', 0), vehicle('turner', 'turner', 0));
  return w;
}

describe('adjacent junction cells with opposing turners', () => {
  it('lets both cars through — neither may come to rest inside a box the other needs', () => {
    const w = corridorWorld();
    const arrived = new Set<string>();

    for (let i = 0; i < 60 * 60; i++) {
      for (const e of step(w, DT)) {
        if (e.kind === TrafficEventKind.Arrived) arrived.add(e.vehicleId);
      }
      if (arrived.size === 2) break;
    }

    if (arrived.size < 2) {
      expect.fail(`froze instead of clearing:\n${formatDiagnosis(diagnoseWorld(w))}`);
    }
  });
});
