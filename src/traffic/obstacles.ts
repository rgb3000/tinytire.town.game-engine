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
 * a connection count over all eight directions, so two junction cells can sit side by side
 * — and a diagonal arm makes one out of a cell that looks like plain road on the cardinal
 * axes — and a car cleared to cross one must still stop at the next. One definition, so
 * admission and the stop line cannot drift apart.
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
 * `admitted` maps a `junctionKey` to the ids admitted to *that* junction — never a bare
 * "is admitted" flag, and never one junction per vehicle. Both levels carry weight:
 *
 * - Keyed by junction, because a car inside junction A is a candidate for A while the
 *   junction ahead of it is already B. A flag alone would wave it out of A straight into
 *   B's cross traffic without yielding, and adjacent junction cells are ordinary in a grid
 *   city since a cell is an intersection by connection count over all eight directions.
 * - A **set** per junction, and one vehicle may legitimately appear under two keys at
 *   once: it holds A reserved while it physically occupies the box and is at the same time
 *   an entrant for B. That is the fact a vehicle-keyed map could not express, and without
 *   it a car mid-crossing can never earn admission to B, halts short of B's stop line
 *   while still inside A, and stalls there permanently, blocking A's cross traffic.
 *
 * It is also the shape `admit()` already returns, so the stepper stores each junction's
 * result directly.
 */
export function nearestConstraint(
  world: TrafficWorld,
  vehicle: Vehicle,
  index: LaneIndex,
  admitted: Map<number, Set<string>>,
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
    const admittedHere = admitted.get(junctionKey(cell.gx, cell.gy))?.has(vehicle.id) === true;
    if (!admittedHere) {
      const stopArc = junctionEntryArc(route, cellIndex);
      if (stopArc < best.arc) best = { arc: stopArc, speed: 0 };
    }
  }

  return best;
}

/**
 * Whether the vehicle currently sits inside a junction cell, by **segment**.
 *
 * Not the definition the stepper admits on, and the difference is deliberate rather than
 * accidental. `insideJunctionCell` in `step.ts` takes the cell's extent from `cellDist`
 * midpoints and the cell's kind from the segment at its *centre*; this takes both from the
 * segment at the arc itself. The two agree on every route of a single grid span and diverge
 * where a junction cell is the joint between two spans, which keeps a half-segment from each
 * side: at such a joint this function covers `(start, end]` — `segmentIndexAt` resolves the
 * start boundary itself to the preceding road segment — `insideJunctionCell` covers the
 * closed extent, and reading the extent off the first half-segment, the obvious third
 * option, covers only half the cell.
 *
 * The stepper cannot use this one, because it must agree with `nextJunctionCell` above about
 * *which cells are junctions at all*. On a junction cell opening a grid span after a highway
 * span, `nextJunctionCell` finds no junction and imposes no stop line while this function
 * reports `true` — a reservation with no stop line, which is worse than the unregulated
 * crossing the two get by agreeing.
 *
 * So this stays a segment-level predicate for tests and diagnostics: it answers "is this arc
 * in intersection terrain", not "which junction must admit this vehicle".
 */
export function isInsideJunction(route: Route, arc: number): boolean {
  const seg = segmentAt(route, arc);
  return seg !== null && seg.kind === SegmentKind.Intersection;
}
