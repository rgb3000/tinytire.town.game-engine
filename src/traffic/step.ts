import { CAR_DEBUG, TILE_SIZE } from '../constants';
import { getDirection } from '../utils/direction';
import { idmAcceleration } from './headway';
import { LaneIndex, edgeIndexAt } from './lanes';
import { admit } from './junction';
import type { JunctionCandidate } from './junction';
import { nearestConstraint, junctionKey } from './obstacles';
import { segmentAt, speedLimitAt } from './route';
import { DEFAULT_IDM, MAX_DECELERATION, STOPPED_SPEED } from './tuning';
import { SegmentKind, TrafficEventKind, VehicleMode } from './types';
import type { Route, TrafficEvent, TrafficWorld, Vehicle } from './types';

/**
 * The arc range a route cell owns: from the midpoint with its predecessor to the midpoint
 * with its successor.
 *
 * Deliberately derived from `cellDist` rather than from the cell's `RouteSegment`, even
 * though for a route of one grid span the two are the same arithmetic. They diverge where
 * a junction cell is the **joint between two grid spans**: such a cell keeps a segment from
 * each side, each covering half of it, and `segmentAt` at the cell centre returns only the
 * first. Reading the extent off that segment makes `inside` flicker false halfway across
 * the box, which drops the car from the junction's candidate list while it is still
 * physically in it — and an inside vehicle missing for even one tick is exactly what lets
 * a conflicting stream be admitted on top of it.
 *
 * The midpoint form is also the one `junctionEntryArc` uses for the stop line, so the arc
 * at which a car becomes `inside` is precisely the arc it was told to stop at.
 */
function cellStartArc(route: Route, i: number): number {
  return i > 0 ? (route.cellDist[i - 1] + route.cellDist[i]) / 2 : route.cellDist[i];
}

function cellEndArc(route: Route, i: number): number {
  return i < route.cells.length - 1
    ? (route.cellDist[i] + route.cellDist[i + 1]) / 2
    : route.cellDist[i];
}

/**
 * The junction cell the vehicle is physically inside, or -1.
 *
 * The *kind* is looked up by arc at the cell centre, matching `nextJunctionCell` in
 * `obstacles.ts` exactly — `segments` and `cells` are not index-aligned, since a highway
 * span contributes a segment and no cells. Both functions must agree about which cells are
 * junctions or a car can be handed a stop line for a junction it is never offered to.
 */
function insideJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    if (arc < cellStartArc(route, i) || arc > cellEndArc(route, i)) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return i;
  }
  return -1;
}

/** The first junction cell strictly ahead of `arc`, or -1. Mirrors `nextJunctionCell`. */
function approachingJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    if (route.cellDist[i] <= arc) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return i;
  }
  return -1;
}

/**
 * Whether the cell beyond a junction has room for one more car.
 *
 * This is the don't-block-the-intersection rule, and it is what stops a ring of junctions
 * gridlocking: a car never enters a junction it cannot leave, so the far side always
 * drains. The old model had no notion of this at all — cars entered and stopped dead
 * inside, blocking every crossing stream until the deadlock timeout fired.
 */
function exitHasRoom(world: TrafficWorld, route: Route, junctionCell: number): boolean {
  const exitCell = route.cells[junctionCell + 1];
  if (exitCell === undefined) return true;

  for (const other of world.vehicles) {
    const theirRoute = world.routes.get(other.routeId);
    if (!theirRoute) continue;
    if (other.speed > STOPPED_SPEED) continue;

    const edge = edgeIndexAt(theirRoute, other.arcDistance);
    const cell = theirRoute.cells[edge];
    if (cell !== undefined && cell.gx === exitCell.gx && cell.gy === exitCell.gy) return false;
  }
  return true;
}

/**
 * Offer every vehicle to the junctions that concern it.
 *
 * A vehicle produces **up to two** candidates, and emitting only one deadlocks adjacent
 * junctions. A car mid-crossing A is bound by B's stop line (`nextJunctionCell` in
 * `obstacles.ts` looks strictly ahead), so if it is offered only to A it can never be
 * admitted to B, halts ~`s0` short of B's line while still inside A, and stays there
 * forever — blocking A's cross traffic. Adjacent junction cells are ordinary:
 * `_isIntersection` is `cardinalConnectionCount >= 3`.
 *
 * So: the junction it is **inside** gets it as `inside: true`, which keeps A reserved
 * while the car physically occupies the box; the junction **ahead** gets it as an
 * entrant, which is what lets it earn its way out.
 */
function buildJunctionCandidates(world: TrafficWorld): {
  byJunction: Map<number, JunctionCandidate[]>;
  /** Vehicle id -> the junction it is queueing for, if any. Drives arrival-time ageing. */
  approaching: Map<string, number>;
} {
  const byJunction = new Map<number, JunctionCandidate[]>();
  const approaching = new Map<string, number>();

  const offer = (v: Vehicle, route: Route, cellIndex: number, inside: boolean): void => {
    if (cellIndex < 0) return;
    const junction = route.cells[cellIndex];
    const before = route.cells[cellIndex - 1];
    const after = route.cells[cellIndex + 1];
    if (before === undefined || after === undefined) return;

    const candidate: JunctionCandidate = {
      vehicleId: v.id,
      entry: getDirection(before, junction),
      exit: getDirection(junction, after),
      inside,
      arrivalTime: v.arrivalTime,
      exitHasRoom: exitHasRoom(world, route, cellIndex),
    };

    const key = junctionKey(junction.gx, junction.gy);
    const list = byJunction.get(key);
    if (list) list.push(candidate);
    else byJunction.set(key, [candidate]);
  };

  for (const v of world.vehicles) {
    if (v.mode === VehicleMode.Parked) continue;
    const route = world.routes.get(v.routeId);
    if (!route) continue;

    const insideCell = insideJunctionCell(route, v.arcDistance);
    const aheadCell = approachingJunctionCell(route, v.arcDistance);

    offer(v, route, insideCell, true);
    if (aheadCell !== insideCell) offer(v, route, aheadCell, false);

    if (aheadCell >= 0 && aheadCell !== insideCell) {
      const ahead = route.cells[aheadCell];
      approaching.set(v.id, junctionKey(ahead.gx, ahead.gy));
    }
  }

  return { byJunction, approaching };
}

/**
 * How close to the end of its route a vehicle must get to count as arrived: half a tile,
 * which is the destination cell's own near boundary.
 *
 * It cannot be the route's end arc. `nearestConstraint` makes the destination a stop line
 * at `route.length`, so the headway model parks the vehicle `s0` short of it and it never
 * reaches the end at all — measured, a 3-tile route ends with the car resting 13.72px
 * short of 120. Testing for `arcDistance >= route.length` would mean no vehicle in the game
 * ever arrives. Half a tile is the arc at which the vehicle enters the destination cell,
 * which is what "arrived" means to the adapter, and it is derived from the grid rather than
 * from an IDM tuning value that a later pass may move.
 */
const ARRIVAL_SLACK = TILE_SIZE / 2;

interface Scratch {
  laneIndex: LaneIndex;
  accelerations: number[];
}

/**
 * Per-world scratch space, so two worlds stepped in the same process never share state.
 *
 * The lane index pools its bucket arrays across rebuilds, so it wants to outlive a single
 * tick — but making it a module-level singleton would make `step` non-reentrant, and the
 * determinism tests step two worlds alternately. Keyed by world, it gets the pooling
 * without the coupling.
 */
const scratchByWorld = new WeakMap<TrafficWorld, Scratch>();

function scratchFor(world: TrafficWorld): Scratch {
  let s = scratchByWorld.get(world);
  if (!s) {
    s = { laneIndex: new LaneIndex(), accelerations: [] };
    scratchByWorld.set(world, s);
  }
  return s;
}

/**
 * Advance the world by `dt`.
 *
 * Two passes, deliberately. Pass one reads only frame-start state and computes every
 * acceleration; pass two integrates and writes. No vehicle's outcome depends on its index
 * in `world.vehicles`, which is what makes a seeded run reproducible and what the old
 * `CarSystem` broke by mutating one shared occupancy map as it walked the array.
 */
export function step(world: TrafficWorld, dt: number): TrafficEvent[] {
  const events: TrafficEvent[] = [];
  const { laneIndex, accelerations } = scratchFor(world);

  // Once per tick, before anything reads it. A rebuild per vehicle would be quadratic, and
  // a rebuild mid-pass would feed later vehicles a half-written frame.
  laneIndex.rebuild(world);

  // Junction -> admitted vehicle ids. Keyed this way round because `admit` already returns
  // exactly that set per junction, and because a car mid-crossing A while entering B is
  // admitted to *both* — which a vehicle-keyed map cannot express. Membership in a flat
  // set would instead mean "exempt from every stop line ahead": adjacent cells can both be
  // junctions (`_isIntersection` is `cardinalConnectionCount >= 3`), so a car admitted to A
  // would skip B's stop line and exit straight into B's cross traffic.
  //
  // `admit` is called once **per junction cell**. Feeding two junctions' candidates into
  // one call would compute conflict geometry between maneuvers through unrelated cells.
  const { byJunction, approaching } = buildJunctionCandidates(world);
  const admitted = new Map<number, Set<string>>();
  for (const [key, candidates] of byJunction) {
    admitted.set(key, admit(candidates));
  }

  // Pass one: decide.
  accelerations.length = world.vehicles.length;
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i];
    if (v.mode === VehicleMode.Parked) { accelerations[i] = 0; continue; }

    const route = world.routes.get(v.routeId);
    if (!route) { accelerations[i] = 0; continue; }

    const constraint = nearestConstraint(world, v, laneIndex, admitted);
    // `Constraint.arc` and `LeaderInfo.gap` are already net of one car length. Subtracting
    // `CAR_LENGTH` again here would double-count it and hold cars a car length too far back.
    const gap = constraint.arc - v.arcDistance;
    const limit = speedLimitAt(route, v.arcDistance);

    const raw = idmAcceleration(v.speed, limit, gap, constraint.speed, DEFAULT_IDM);
    accelerations[i] = Math.max(-MAX_DECELERATION, Math.min(DEFAULT_IDM.a, raw));
  }

  // Pass two: apply.
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i];
    if (v.mode === VehicleMode.Parked) { v.distanceThisTick = 0; continue; }

    const route = world.routes.get(v.routeId);
    if (!route) { v.distanceThisTick = 0; continue; }

    const before = v.arcDistance;
    const limit = speedLimitAt(route, v.arcDistance);
    // Taken before the write, so `leader.gap` is measured from `before` and the ceiling
    // below really is the leader's rear bumper less the standstill gap. The index itself
    // still holds frame-start positions, so this reads nothing another vehicle wrote.
    const leader = laneIndex.findLeader(world, v);

    v.lastAcceleration = accelerations[i];
    v.speed = Math.max(0, Math.min(v.speed + accelerations[i] * dt, limit));
    v.arcDistance = Math.min(v.arcDistance + v.speed * dt, route.length);

    // Safety net. The headway model is collision-free in continuous time, so at a fixed
    // 60Hz timestep this must never bind. It asserts in dev rather than silently
    // correcting, so model drift surfaces as a failure instead of a visual glitch.
    //
    // The line it defends is the leader's rear bumper — physical overlap — and not
    // `bumper - s0`. `s0` is a comfort parameter, and IDM's equilibrium *is* `s0`, which a
    // 60Hz Euler integrator approaches from outside and settles a fraction of a pixel
    // within: measured, 0.281px, on 861 of the 1200 ticks of an ordinary stop behind a
    // parked car. An assertion that fires 861 times on the commonest maneuver in the game
    // is not an assertion, and the matching production correction was rewriting the
    // resting position on every one of those ticks. At the bumper it binds zero times for
    // any approach the model itself set up, and binds only on a state no model produced —
    // a vehicle inserted closer than its own braking distance.
    if (leader !== null) {
      // leader.gap is net of one car length, so this is literally the leader's rear bumper.
      const bumper = before + leader.gap;
      if (v.arcDistance > bumper) {
        if (CAR_DEBUG) {
          throw new Error(
            `traffic: ${v.id} overran leader ${leader.id} ` +
            `(arc ${v.arcDistance.toFixed(2)} > bumper ${bumper.toFixed(2)})`,
          );
        }
        // Recover to a standstill gap behind the bumper, never behind where it started.
        v.arcDistance = Math.max(before, bumper - DEFAULT_IDM.s0);
        v.speed = 0;
      }
    }

    // Track how long this vehicle has been waiting, for the junction arrival-time key.
    // Set on the tick it first comes to rest unadmitted; cleared the moment it is let in.
    //
    // Ages against the junction it is *queueing for*, never against admission in general.
    // A car mid-crossing A while blocked at B is admitted to A every tick, so a flat
    // "admitted anywhere" test would reset its clock forever and starve it at B — the
    // arrival-time key is the whole anti-starvation mechanism, so it must age.
    const queueingFor = approaching.get(v.id);
    const admittedThere = queueingFor !== undefined
      && admitted.get(queueingFor)?.has(v.id) === true;
    if (queueingFor === undefined || admittedThere) {
      v.arrivalTime = 0;
    } else if (v.arrivalTime === 0 && v.speed <= STOPPED_SPEED) {
      v.arrivalTime = world.time;
    }

    v.distanceThisTick = v.arcDistance - before;
    // An edge rather than a level: `arcDistance` never decreases, so a vehicle crosses the
    // arrival arc exactly once however many ticks it then spends sitting on the far side.
    const arrivalArc = route.length - Math.min(ARRIVAL_SLACK, route.length / 2);
    if (v.arcDistance >= arrivalArc && before < arrivalArc) {
      events.push({ kind: TrafficEventKind.Arrived, vehicleId: v.id });
    }
  }

  world.time += dt;
  return events;
}
