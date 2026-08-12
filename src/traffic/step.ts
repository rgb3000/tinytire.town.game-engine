import { CAR_DEBUG } from '../constants';
import { getDirection } from '../utils/direction';
import { idmAcceleration } from './headway';
import { LaneIndex, edgeIndexAt, laneKeyForEdge } from './lanes';
import { admit } from './junction';
import type { JunctionCandidate } from './junction';
import { nearestConstraint, junctionKey } from './obstacles';
import { segmentAt, speedLimitAt } from './route';
import { ARRIVAL_SLACK, DEFAULT_IDM, MAX_DECELERATION, STOPPED_SPEED } from './tuning';
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
 * The midpoint form is also the one `junctionEntryArc` uses, so the boundary at which a
 * car becomes `inside` is the boundary its stop line is derived from. The stop constraint
 * itself sits `s0 - STOP_LINE_SETBACK` past it — placed so the IDM rest lands
 * `STOP_LINE_SETBACK` *short* of the boundary — which keeps an unadmitted car outside;
 * `tuning.ts` sizes that margin against the worst forced stop.
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
 *
 * Distinct from the exported `isInsideJunction`, which asks the narrower question "is this
 * arc in intersection terrain" straight off the segment. That one cannot drive admission;
 * the note on it in `obstacles.ts` explains why.
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
 * This is the don't-block-the-intersection rule, and it is what keeps a ring of junctions
 * from gridlocking under its own traffic: a car is not let into a box whose far side is
 * already at a standstill. The old model had no notion of this at all — cars entered and
 * stopped dead inside, blocking every crossing stream until the deadlock timeout fired.
 *
 * It is a **rule about admission, not a guarantee that the far side drains**, and three
 * paths through the model make the stronger claim false. A route that ends at or just past
 * the junction has no exit lane and returns `true` unconditionally. A car that is *moving*
 * through the exit lane does not count as occupying it, deliberately — counting it turned a
 * plain corridor's stopped vehicle-ticks from 69 to 3999, which `expectFreeFlowing` in
 * `invariants.test.ts` now guards. And a candidate already `inside` is exempt in `admit`,
 * because stopping a car mid-junction is the very thing this rule exists to prevent. On top
 * of those, the game may park a car anywhere at all — `TrafficAdapter.setParked` — including
 * in an exit cell, and a queue behind a parked car is *supposed* to stand still for ever.
 * What the rule buys is that no car adds itself to that jam from inside a junction.
 *
 * "Room" is asked of the exit **lane** — the directed edge this route follows out of the
 * junction — and never of the exit cell. Cells are shared ground: the two directions of a
 * two-way road occupy the same cells, offset by `LANE_OFFSET`, so a stopped car in the
 * *oncoming* lane says nothing about whether this car can clear the box. Asking the cell
 * instead deadlocks the whole network with two vehicles: each waits at the same junction's
 * stop line from opposite sides, each therefore rests `s0` inside the other's exit cell,
 * and neither is ever admitted — measured, both stood for the full 20s run, and every car
 * that later queued behind them inherited the stall. Their maneuvers do not even conflict;
 * `admit` never got to ask, because the room test runs first. A stopped car in a *crossing*
 * lane of the exit cell is not this rule's business either: two lanes crossing in one cell
 * means three or more connections, which makes that cell a junction of its own, and its
 * admission — not this room test — is what serialises them.
 */
function exitHasRoom(world: TrafficWorld, route: Route, junctionCell: number): boolean {
  const exitLane = laneKeyForEdge(route, junctionCell + 1);
  if (exitLane === null) return true;

  for (const other of world.vehicles) {
    const theirRoute = world.routes.get(other.routeId);
    if (!theirRoute) continue;
    if (other.speed > STOPPED_SPEED) continue;

    const edge = edgeIndexAt(theirRoute, other.arcDistance);
    if (laneKeyForEdge(theirRoute, edge) === exitLane) return false;
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
 * `_isIntersection` is `connectionCount >= 3`, over all eight directions.
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
    // No predecessor means the route *begins* inside the junction, so there is no approach
    // to yield on and no entry direction to describe one with. `nextJunctionCell` looks
    // strictly ahead and so imposes no stop line there either: the vehicle crosses
    // unregulated, which is a gap, but a consistent one that cannot strand anybody.
    if (before === undefined) return;

    const entry = getDirection(before, junction);
    // A route that *ends* in a junction cell has no exit cell — but skipping the candidate
    // strands the vehicle for ever: `nextJunctionCell` still imposes the stop line, and with
    // no candidate no admission can ever arrive to lift it. Measured on `[R,R,R,X]`, the car
    // parked at arc 86.28 and never arrived in 3000 ticks.
    //
    // So it is offered with a straight-through maneuver instead. The vehicle actually stops
    // at the cell centre, so the full-width chord over-reserves rather than under-reserves:
    // it may yield to a crossing stream it would not quite have met, and can never fail to
    // yield to one it would. Conservative in the safe direction, and it lets the vehicle be
    // admitted and arrive.
    const exit = after !== undefined ? getDirection(junction, after) : entry;

    const candidate: JunctionCandidate = {
      vehicleId: v.id,
      entry,
      exit,
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
 * The arrival threshold lives in `tuning.ts` (`ARRIVAL_SLACK`), derived from `s0` so that
 * it always stays wider than the distance the model parks short of the destination — the
 * inequality this stepper depends on to declare arrival at all. `parks closer to the route
 * end than the arrival threshold` in `step.test.ts` pins it behaviourally.
 *
 * The `route.length / 2` floor below keeps the arrival arc strictly inside the route and
 * in its far half, however short the route is; a highway span carries an arbitrary
 * polyline, so a route may be shorter than any fixed threshold.
 */

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
  // junctions (`_isIntersection` is `connectionCount >= 3`, over all eight directions), so a
  // car admitted to A would skip B's stop line and exit straight into B's cross traffic.
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
    // Set on the tick it first comes to rest with a junction ahead it has not been let into.
    //
    // Ages against the junction it is *queueing for*, never against admission in general.
    // A car mid-crossing A while blocked at B is admitted to A every tick, so a flat
    // "admitted anywhere" test would reset its clock forever and starve it at B — the
    // arrival-time key is the whole anti-starvation mechanism, so it must age.
    //
    // It is emphatically **not** cleared on admission, and that is the whole of a car's grip
    // on its place in the queue. `admit` runs from scratch every tick: clearing the stamp the
    // moment a car is let in dropped it back to the sentinel, which since the sentinel sorts
    // *last* meant it lost its turn on the very next tick, braked, stopped, and re-stamped
    // itself as the newest arrival. The result was not a stall — it inched forward a few
    // millimetres per cycle — so a standstill bound could not see it: measured, a car took
    // 41s to cross one junction it should clear in 1s, and the crossing-city sweep's
    // throughput fell from 27-30 arrivals to 17-20 with a 19.93s standstill behind the crawl.
    // Keeping the stamp makes admission sticky across ticks, which is what a queue *is*.
    //
    // The stamp is cleared on `queueingFor === undefined`, and that covers **entering the
    // junction** as well as running out of junctions: `approachingJunctionCell` looks strictly
    // ahead by cell centre, so from the moment a car crosses the near boundary until it passes
    // the centre, the cell ahead *is* the cell it is inside, `approaching` is not set, and the
    // stamp goes. Traced on a two-junction route: stamped t=2.350 at arc 45.9, cleared t=3.183
    // at arc 60.6 — the boundary — and stamped afresh at t=8.267 approaching the next one.
    //
    // So a stamp dates from a car's last stop since its last junction entry, not from its
    // first stop anywhere. Near enough to per-junction FIFO; the residue is that a car which
    // stopped *between* junctions, behind a queue, carries that earlier time into the next
    // junction and can pre-empt cars already waiting there.
    //
    // No vehicle can be starved by this, and the argument is **monotonicity, not permanence**.
    // `world.time` only increases, so any re-stamp is strictly later than the one it replaced,
    // and a car still rolling carries the sentinel, which `arrivalKey` sorts last. For a car
    // holding stamp T, the set that can outrank it on the arrival key — those holding a stamp
    // in (0, T) — is fixed at T, and only leaves it: a member is removed when it crosses, and
    // no vehicle can join, because every later stamp is greater than T. Membership never grows.
    //
    // Fresh arrivals are not *entirely* excluded, and an earlier version of this note said
    // they were. A car stamping in (T, T+EPS] **does** enter T's yield rank, which is the key
    // that sorts first. What bounds it is that the window closes for *joining*: once
    // `world.time` is past T+EPS no later stamp can be simultaneous with T, so no vehicle can
    // join T's rank after that, and the finite set already in it drains as its members cross.
    // The passage of time alone changes nothing — `yieldRank` takes no clock and reads only
    // stamps, so a car that stamped at T+0.04 before the window closed stays in T's rank until
    // it crosses or re-stamps. The bound is therefore the window plus the drain of a set that
    // cannot grow, which is finite; it is not that the rank returns to zero on a timer.
    //
    // The sentinel itself is a property of `arrivalKey` in `junction.ts`, and by convention
    // every consumer of `arrivalTime` there goes through it. Convention is all it is —
    // `JunctionCandidate.arrivalTime` is a plain number, so a new consumer comparing raw times
    // would typecheck happily. `yieldRank` doing exactly that while the comparator mapped them
    // is how a whole class of starvation stayed invisible; see the note on `arrivalKey`.
    const queueingFor = approaching.get(v.id);
    if (queueingFor === undefined) {
      v.arrivalTime = 0;
    } else if (v.arrivalTime === 0 && v.speed <= STOPPED_SPEED) {
      v.arrivalTime = world.time;
    }

    v.distanceThisTick = v.arcDistance - before;
    // Once per route, latched on the vehicle rather than inferred from the arc it held last
    // tick. `arcDistance` never decreases within a route, so for a vehicle that *drives* over
    // the threshold a rising edge and a latch fire on the same tick; they part company for a
    // vehicle whose first arc on the route is already past it. `installRoute` writes the arc
    // directly, so a reroute that lands a car inside the last half-tile of its new route had
    // no edge to offer — and a car that never reports arrival is never despawned or parked,
    // which is an immovable obstacle plus a watchdog firing on it for the rest of the session.
    //
    // The `route.length / 2` floor keeps the arrival arc strictly inside the route, and in
    // its far half, however short the route is. A grid span is at least two cells and so at
    // least a tile long, but a highway span carries an arbitrary polyline: on a 30px route a
    // flat half-tile threshold would fire at arc 10, nearer the origin than the destination,
    // and at 20px or less it would land at or behind zero, where the edge test can never
    // fire at all.
    const arrivalArc = route.length - Math.min(ARRIVAL_SLACK, route.length / 2);
    if (v.arcDistance >= arrivalArc && !v.arrivedReported) {
      v.arrivedReported = true;
      events.push({ kind: TrafficEventKind.Arrived, vehicleId: v.id });
    }
  }

  world.time += dt;
  return events;
}
