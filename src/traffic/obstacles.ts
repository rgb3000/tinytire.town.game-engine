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
 * Identity of a junction, packed from its cell coordinates the same way `laneKey` packs
 * its own. Admission is keyed by it rather than by vehicle id alone: `_isIntersection` is
 * a connection count, so two junction cells can sit side by side, and a car cleared to
 * cross one must still stop at the next. One definition, so admission and the stop line
 * cannot drift apart.
 */
export function junctionKey(gx: number, gy: number): number {
  return gx | (gy << 8);
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
 *
 * `admitted` maps a vehicle id to the `junctionKey` of the one junction it may cross —
 * never to a bare "is admitted" flag. A car inside junction A is a candidate for A while
 * the junction ahead of it is already B, so membership alone would wave it out of A and
 * straight into B's cross traffic without yielding. Adjacent junctions are ordinary in a
 * grid city, since a cell is an intersection by connection count.
 */
export function nearestConstraint(
  world: TrafficWorld,
  vehicle: Vehicle,
  index: LaneIndex,
  admitted: Map<string, number>,
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
  // Admission to some *other* junction is not admission to this one.
  const cellIndex = nextJunctionCell(route, vehicle.arcDistance);
  if (cellIndex >= 0) {
    const cell = route.cells[cellIndex];
    if (admitted.get(vehicle.id) !== junctionKey(cell.gx, cell.gy)) {
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
