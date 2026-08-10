import { SegmentKind } from './types';
import type { Route, TrafficWorld, Vehicle } from './types';
import type { LaneIndex } from './lanes';
import { segmentAt } from './route';

export interface Constraint {
  /** Arc distance on the vehicle's own route that it must not pass. */
  arc: number;
  /** Speed of whatever is at that arc. Zero for stop lines and parked cars. */
  speed: number;
}

/**
 * Where a junction cell begins, in arc distance: midway between the previous cell centre
 * and the junction's own centre. Cars stop here, not at the centre.
 */
export function junctionEntryArc(route: Route, cellIndex: number): number {
  if (cellIndex <= 0) return route.cellDist[0] ?? 0;
  return (route.cellDist[cellIndex - 1] + route.cellDist[cellIndex]) / 2;
}

/**
 * Index of the next junction cell strictly ahead of `arc`, or -1.
 *
 * Looks the segment up **by arc**, never by cell index. `segments` and `cells` are not
 * index-aligned: a highway span contributes one segment and no cells, and adjacent grid
 * spans share a joint cell that keeps a half-segment from each side. Indexing one array
 * by the other silently reads the wrong segment on any route containing a highway.
 */
function nextJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    if (route.cellDist[i] <= arc) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return i;
  }
  return -1;
}

/**
 * The single obstacle a vehicle must respect this tick.
 *
 * Every reason a car might slow down produces one of these, and only the nearest
 * survives — so the headway model is the only place a deceleration is ever computed.
 * The old code combined a following multiplier and an intersection multiplier with
 * `Math.min`, which let two independently-tuned mechanisms disagree about how hard to
 * brake, and gave the intersection ramp no way to express "match the speed of the car
 * ahead".
 *
 * The arc returned may lie *behind* the vehicle: an overlapping leader reports a negative
 * gap, and a vehicle that has crossed a stop line it was not admitted through is past its
 * own constraint. Neither is filtered — both are exactly the situations that need the
 * hardest braking, and `idmAcceleration` floors the gap rather than dividing by zero. The
 * second is also why a vehicle inside a junction must stay in `admitted` until it has
 * left; see `JunctionCandidate.inside`.
 */
export function nearestConstraint(
  world: TrafficWorld,
  vehicle: Vehicle,
  index: LaneIndex,
  admitted: Set<string>,
): Constraint {
  const route = world.routes.get(vehicle.routeId);
  // No route is no road: hold position rather than accelerate into nothing.
  if (!route) return { arc: vehicle.arcDistance, speed: 0 };

  // The destination is always a constraint: a car stops when it arrives.
  let best: Constraint = { arc: route.length, speed: 0 };

  const leader = index.findLeader(world, vehicle);
  if (leader !== null) {
    // `gap` is already net of one car length, so this is the leader's rear bumper.
    const leaderArc = vehicle.arcDistance + leader.gap;
    if (leaderArc < best.arc) best = { arc: leaderArc, speed: leader.speed };
  }

  // A junction the vehicle has not been admitted to becomes a stop line at its boundary.
  if (!admitted.has(vehicle.id)) {
    const cellIndex = nextJunctionCell(route, vehicle.arcDistance);
    if (cellIndex >= 0) {
      const stopArc = junctionEntryArc(route, cellIndex);
      if (stopArc < best.arc) best = { arc: stopArc, speed: 0 };
    }
  }

  return best;
}

/** Whether the vehicle currently sits inside a junction cell. */
export function isInsideJunction(route: Route, arc: number): boolean {
  const seg = segmentAt(route, arc);
  return seg !== null && seg.kind === SegmentKind.Intersection;
}
