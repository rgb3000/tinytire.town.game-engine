import { SegmentKind } from './types';
import type { Route, TrafficWorld, Vehicle } from './types';
import type { LaneIndex } from './lanes';
import { segmentAt } from './route';
import { DEFAULT_IDM, STOP_LINE_SETBACK } from './tuning';

/** What produced a constraint. Diagnostic identity; the stepper reads only arc and speed. */
export const ConstraintKind = {
  /** The end of the route: a car stops when it arrives. */
  RouteEnd: 'route-end',
  /** The rear bumper of the vehicle ahead in the same lane. */
  Leader: 'leader',
  /** The stop line of a junction this vehicle has not been admitted to. */
  StopLine: 'stop-line',
} as const;
export type ConstraintKind = (typeof ConstraintKind)[keyof typeof ConstraintKind];

export interface Constraint {
  /** Arc distance on the vehicle's own route that it must not pass. */
  arc: number;
  /** Speed of whatever is at that arc. Zero for stop lines and parked cars. */
  speed: number;
  /**
   * Which of the three sources won. Carried so that `diagnose.ts` can report *why* a car
   * is held using the stepper's own decision rather than a reimplementation that could
   * drift. Costs nothing: every path here already allocates a fresh object.
   */
  kind: ConstraintKind;
  /** The vehicle ahead, when `kind` is `Leader`. */
  leaderId?: string;
  /** Index into `route.cells` of the junction, when `kind` is `StopLine`. */
  cellIndex?: number;
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
 * Group every junction cell any route touches into its maximal region of 8-adjacent
 * junction cells: `junctionKey` of a cell -> `junctionKey` of the region's representative
 * (its smallest member key, so the id is independent of route insertion order).
 *
 * Regions rather than cells are what admission is keyed by, and the reason is geometric: a
 * stop line rests a car `STOP_LINE_SETBACK` before the junction's entry boundary, which is
 * inside the *previous* route cell. For a lone junction that cell is plain road; for two
 * adjacent junction cells, each one's stop line is inside the other's box, so per-cell
 * admission let two opposing cars come to rest each inside the box the other needed —
 * `inside` holds are absolute and physical, and the pair froze permanently, with the whole
 * board queueing behind it (`adjacentJunctions.test.ts`). Region admission restores the
 * invariant the stop line's placement depends on: the cell before any region's entry is
 * never itself a junction cell, because a junction cell adjacent to the entry would be *in*
 * the region — so every rest position is on plain ground.
 *
 * Adjacency is over all eight directions, matching `Grid.recomputeIntersectionFlags`: a
 * route may step diagonally, so a diagonal neighbour's stop line lands inside this cell's
 * box exactly like a cardinal one's.
 *
 * Junction-ness is read per route by segment at the cell's arc — the same definition
 * `nextJunctionCell` and the stepper use — so a cell one route crosses as a junction joins
 * the region even if another route (or none) sees it as plain road at a span joint.
 */
export function junctionComponents(world: TrafficWorld): Map<number, number> {
  const junctionCells = new Set<number>();
  for (const route of world.routes.values()) {
    for (let i = 0; i < route.cells.length; i++) {
      const seg = segmentAt(route, route.cellDist[i]);
      if (seg !== null && seg.kind === SegmentKind.Intersection) {
        const c = route.cells[i];
        junctionCells.add(junctionKey(c.gx, c.gy));
      }
    }
  }

  const component = new Map<number, number>();
  for (const start of junctionCells) {
    if (component.has(start)) continue;
    const members: number[] = [];
    const queue = [start];
    component.set(start, start);
    while (queue.length > 0) {
      const key = queue.pop()!;
      members.push(key);
      const gx = key & 0xff;
      const gy = key >> 8;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const neighbour = junctionKey(gx + dx, gy + dy);
          if (!junctionCells.has(neighbour) || component.has(neighbour)) continue;
          component.set(neighbour, start);
          queue.push(neighbour);
        }
      }
    }
    const representative = Math.min(...members);
    for (const m of members) component.set(m, representative);
  }
  return component;
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
  /**
   * `junctionComponents` of this world, mapping each junction cell to the region key that
   * `admitted` is keyed by. Omitted, every cell is its own region — the pre-region
   * behaviour, kept as the default so unit fixtures with lone junctions need not build a
   * component map. The stepper always passes the real one.
   */
  components?: Map<number, number>,
): Constraint {
  const route = world.routes.get(vehicle.routeId);
  // No route is no road: hold position rather than accelerate into nothing.
  if (!route) return { arc: vehicle.arcDistance, speed: 0, kind: ConstraintKind.RouteEnd };

  // The destination is always a constraint: a car stops when it arrives.
  let best: Constraint = { arc: route.length, speed: 0, kind: ConstraintKind.RouteEnd };

  const leader = index.findLeader(world, vehicle);
  if (leader !== null) {
    // `gap` is already net of one car length, so this is the leader's rear bumper.
    const leaderArc = vehicle.arcDistance + leader.gap;
    if (leaderArc < best.arc) {
      best = { arc: leaderArc, speed: leader.speed, kind: ConstraintKind.Leader, leaderId: leader.id };
    }
  }

  // A junction the vehicle has not been admitted to becomes a stop line at its boundary.
  // Admission to some *other* junction is not admission to this one.
  //
  // The constraint arc sits `s0 - STOP_LINE_SETBACK` *past* the boundary, so the IDM rest
  // position — constraint minus `s0` — lands `STOP_LINE_SETBACK` short of it. A stop line
  // is a line, not a car's rear bumper: parking the full `s0` behind it left a car-length
  // of daylight before the crossing. The rest stays outside the boundary, so an unadmitted
  // car never flips `inside`; the margin is sized in `tuning.ts` against the worst forced
  // stop, which is what bounds how late an admission can be revoked.
  const cellIndex = nextJunctionCell(route, vehicle.arcDistance);
  if (cellIndex >= 0) {
    const cell = route.cells[cellIndex];
    const cellKey = junctionKey(cell.gx, cell.gy);
    const regionKey = components?.get(cellKey) ?? cellKey;
    const admittedHere = admitted.get(regionKey)?.has(vehicle.id) === true;
    if (!admittedHere) {
      const stopArc = junctionEntryArc(route, cellIndex) + (DEFAULT_IDM.s0 - STOP_LINE_SETBACK);
      if (stopArc < best.arc) best = { arc: stopArc, speed: 0, kind: ConstraintKind.StopLine, cellIndex };
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
