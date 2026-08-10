/**
 * The invariant sweeps: the file that answers the three bug reports this rebuild exists for.
 *
 *  - *"cars drive on top of each other"* → `minSameRouteGap` and `minWorldGap` stay above one
 *    car length, every tick, in every scenario.
 *  - *"cars jump between positions"* → no vehicle advances further than its own speed carries
 *    it in a tick, and no vehicle's speed changes faster than the model's own acceleration
 *    bounds allow.
 *  - *"cars get stuck entirely"* → no vehicle stands still for fifteen seconds short of its
 *    destination.
 *
 * plus determinism, so any failure above is replayable from a seed rather than a ghost.
 *
 * Five things about how these are written are deliberate:
 *
 * 1. **Vehicles are despawned on their `Arrived` event.** That is what the adapter must do
 *    (Task 7 measured a route-end pile-up stalling a follower for 55.6s otherwise), and
 *    without it the stall sweep would be measuring parked wrecks rather than traffic.
 * 2. **Fixtures are horizontal, vertical, L-shaped and crossing.** Every route in
 *    `route.test.ts`, `routeQueries.test.ts` and `obstacles.test.ts` runs west to east, which
 *    is how a `junctionKey` that dropped `gy` once survived twenty tests.
 * 3. **The gap threshold is `CAR_LENGTH`, and it is physics, not tuning.** `LeaderInfo.gap`
 *    and `Constraint.arc` are already net of one car length, so in arc space two cars fail to
 *    overlap exactly when their centres are more than `CAR_LENGTH` apart. `s0` is a comfort
 *    parameter and a tuning pass may move it; the threshold here may not follow it.
 * 4. **Every sweep asserts its own premises.** A sweep over traffic that never interacts
 *    proves nothing, so each one also asserts that cars arrived, that they came within
 *    interaction range of one another, and — at junctions — that somebody actually had to
 *    yield. Those counters are what stop a fixture going quietly vacuous.
 * 5. **Violations are collected, not asserted per car per tick.** 3600 ticks × 25 cars is
 *    90 000 assertions per scenario; collecting the first few with full context and asserting
 *    once at the end is both faster and a far better failure message.
 */
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../utils/rng';
import { buildRoute, sampleRoute } from './route';
import { step } from './step';
import { SegmentKind, TrafficEventKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { DEFAULT_IDM, MAX_DECELERATION, STOPPED_SPEED } from './tuning';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

const DT = 1 / 60;

/**
 * One speed limit for every cell of every fixture, so the per-tick bounds below can be
 * stated against a single number. Asserted, not assumed: `builds the fixtures it claims to`
 * checks that no route carries a second limit.
 */
const SPEED_LIMIT = 40;

const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

/** The most a speed may change in one tick: the model's own acceleration bounds. */
const MAX_SPEED_CHANGE = Math.max(DEFAULT_IDM.a, MAX_DECELERATION) * DT;

// --- fixtures ---------------------------------------------------------------------------

type Cell = [gx: number, gy: number, kind: SegmentKind];

function span(id: string, cells: Cell[]): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: cells.map(([gx, gy, kind]) => ({
        pos: { gx, gy }, kind, speedLimit: SPEED_LIMIT, pendingDeletion: false,
      })),
    }],
  };
}

/** West to east along `gy`, with a junction every `every` cells. */
function horizontal(id: string, gy: number, n: number, every: number): RouteInput {
  return span(id, Array.from({ length: n }, (_, i) =>
    [i, gy, i > 0 && i % every === 0 ? X : R] as Cell));
}

/** North to south along `gx`. The same corridor rotated — see note 2 in the file header. */
function vertical(id: string, gx: number, n: number, every: number): RouteInput {
  return span(id, Array.from({ length: n }, (_, i) =>
    [gx, i, i > 0 && i % every === 0 ? X : R] as Cell));
}

/** East along a row, then south down a column: a route whose geometry actually turns. */
function elbow(id: string, arm: number): RouteInput {
  const cells: Cell[] = [];
  for (let gx = 0; gx < arm; gx++) cells.push([gx, 0, gx === Math.floor(arm / 2) ? X : R]);
  for (let gy = 1; gy < arm; gy++) cells.push([arm - 1, gy, gy === Math.floor(arm / 2) ? X : R]);
  return span(id, cells);
}

function car(id: string, routeId: string, arc: number, speed: number): Vehicle {
  return {
    id, routeId, arcDistance: arc, speed, mode: VehicleMode.Driving,
    lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0,
  };
}

/**
 * Seed a route with `count` cars, spaced evenly and **numbered against the direction of
 * travel**, so array index order is the reverse of arc order. Order must never matter, and a
 * fixture whose array happens to be sorted cannot show that.
 */
function populate(world: TrafficWorld, routeId: string, count: number, rand: () => number): void {
  const route = world.routes.get(routeId)!;
  const spacing = route.length / (count + 1);
  for (let i = 0; i < count; i++) {
    world.vehicles.push(car(
      `${routeId}#${i}`, routeId, spacing * (count - i), rand() * SPEED_LIMIT,
    ));
  }
}

interface Scenario {
  name: string;
  world: TrafficWorld;
  /** Routes the sweep may feed new cars onto, to keep the load up over a long run. */
  spawnRoutes: string[];
}

function singleRoute(name: string, input: RouteInput, cars: number, seed: number): Scenario {
  const rand = mulberry32(seed);
  const world = createWorld();
  const route = buildRoute(input);
  expect(route, `${name}: fixture must build`).not.toBeNull();
  world.routes.set(input.id, route!);
  populate(world, input.id, cars, rand);
  return { name, world, spawnRoutes: [input.id] };
}

/**
 * Three north-south routes crossed by three west-east ones, junction cells at all nine
 * crossings. This is the shape the junction model exists for: every car meets conflicting
 * traffic it has to be serialised against, and `junctionKey` has to keep nine distinct
 * junctions apart on both axes at once.
 */
function crossingCity(seed: number, carsPerRoute: number): Scenario {
  const rand = mulberry32(seed);
  const world = createWorld();
  const rows = [2, 5, 8];
  const cols = [2, 5, 8];
  const n = 12;

  for (const gy of rows) {
    const input = span(`h${gy}`, Array.from({ length: n }, (_, gx) =>
      [gx, gy, cols.includes(gx) ? X : R] as Cell));
    world.routes.set(input.id, buildRoute(input)!);
  }
  for (const gx of cols) {
    const input = span(`v${gx}`, Array.from({ length: n }, (_, gy) =>
      [gx, gy, rows.includes(gy) ? X : R] as Cell));
    world.routes.set(input.id, buildRoute(input)!);
  }

  for (const id of world.routes.keys()) {
    const route = world.routes.get(id)!;
    const spacing = route.length / (carsPerRoute + 1);
    for (let i = 0; i < carsPerRoute; i++) {
      // A jitter of up to a tile, so crossing routes do not start their cars at matching
      // arcs and hand the junctions a symmetric problem they would never see in play.
      world.vehicles.push(car(
        `${id}#${i}`, id, spacing * (carsPerRoute - i) + rand() * TILE_SIZE, rand() * SPEED_LIMIT,
      ));
    }
  }

  return { name: `crossing city (seed ${seed})`, world, spawnRoutes: [...world.routes.keys()] };
}

// --- the sweep --------------------------------------------------------------------------

interface SweepOptions {
  ticks: number;
  seed: number;
  /**
   * Chance per route per tick of offering a new car at arc 0. Keeps a long run loaded
   * instead of letting it drain and measure an empty board.
   *
   * Deliberately modest. Junction admission has no approach horizon — see
   * `starves a waiting car …` at the foot of this file — so a network offered more traffic
   * than it can clear queues without bound, and the fifteen-second stall bound is a claim
   * about a network that *can* clear its load. The rates here are measured to leave it
   * comfortably satisfied; the counters below assert the load is nonetheless real.
   */
  spawnRate?: number;
  /** Vehicles parked before the run: id -> nothing, they are simply never moved. */
  parked?: string[];
}

interface SweepResult {
  vehicleTicks: number;
  arrivals: number;
  spawned: number;
  minSameRouteGap: number;
  minWorldGap: number;
  maxTickAdvance: number;
  maxSpeedChange: number;
  maxSpeed: number;
  maxStall: number;
  /** Who was standing still for `maxStall`, where, and when. */
  worstStall: string;
  /** Vehicle-ticks with another car on the same route within three tiles ahead. */
  interactions: number;
  /** Vehicle-ticks spent stopped somewhere other than the destination: somebody yielded. */
  yields: number;
  violations: string[];
}

/**
 * Run one scenario and measure everything at once.
 *
 * Every invariant is checked on the same run rather than in a test each, because the
 * expensive part is the simulation and because a violation is far easier to read when the
 * other measurements at that tick come with it.
 */
function sweep(scenario: Scenario, opts: SweepOptions): SweepResult {
  const { world } = scenario;
  const rand = mulberry32(opts.seed);
  const parked = new Set(opts.parked ?? []);
  for (const v of world.vehicles) {
    if (!parked.has(v.id)) continue;
    v.mode = VehicleMode.Parked;
    v.speed = 0;
  }

  const result: SweepResult = {
    vehicleTicks: 0, arrivals: 0, spawned: 0,
    minSameRouteGap: Infinity, minWorldGap: Infinity,
    maxTickAdvance: 0, maxSpeedChange: 0, maxSpeed: 0, maxStall: 0, worstStall: 'nobody',
    interactions: 0, yields: 0, violations: [],
  };
  const note = (msg: string): void => {
    if (result.violations.length < 8) result.violations.push(msg);
  };

  const stalledFor = new Map<string, number>();
  let spawnCounter = 0;

  for (let tick = 0; tick < opts.ticks; tick++) {
    const before = new Map(world.vehicles.map(v => [v.id, { arc: v.arcDistance, speed: v.speed }]));
    const events = step(world, DT);

    // --- per vehicle: advance, speed and bounds
    for (const v of world.vehicles) {
      const prev = before.get(v.id)!;
      const route = world.routes.get(v.routeId)!;
      const moved = v.arcDistance - prev.arc;
      const where = `${scenario.name} tick ${tick} ${v.id}`;

      result.vehicleTicks++;
      result.maxSpeed = Math.max(result.maxSpeed, v.speed);
      result.maxTickAdvance = Math.max(result.maxTickAdvance, moved);
      result.maxSpeedChange = Math.max(result.maxSpeedChange, Math.abs(v.speed - prev.speed));

      if (moved < -1e-9) note(`${where}: went backwards by ${(-moved).toFixed(6)}px`);
      // The bound that matters for "cars jump between positions": a vehicle may never cover
      // more ground than the speed it is actually travelling at carries it in one tick.
      if (moved > v.speed * DT + 1e-9) {
        note(`${where}: advanced ${moved.toFixed(6)}px at ${v.speed.toFixed(3)}px/s`);
      }
      if (v.speed > SPEED_LIMIT + 1e-9) note(`${where}: speed ${v.speed.toFixed(6)} over limit`);
      // Bounded acceleration is the other half of "no jumps": a position that cannot teleport
      // is worth little if the speed behind it can. This also pins that the stepper's
      // overrun clamp — which zeroes a speed outright — never binds.
      if (Math.abs(v.speed - prev.speed) > MAX_SPEED_CHANGE + 1e-9) {
        note(`${where}: speed jumped ${(v.speed - prev.speed).toFixed(4)}px/s in one tick`);
      }
      // The adapter deducts fuel from this field, so it must be the distance actually moved.
      if (Math.abs(v.distanceThisTick - moved) > 1e-12) {
        note(`${where}: distanceThisTick ${v.distanceThisTick} != moved ${moved}`);
      }
      if (v.arcDistance < 0 || v.arcDistance > route.length + 1e-9) {
        note(`${where}: arc ${v.arcDistance.toFixed(3)} outside [0, ${route.length}]`);
      }

      const stall = moved < 1e-6 ? (stalledFor.get(v.id) ?? 0) + DT : 0;
      stalledFor.set(v.id, stall);
      // The stall bound is asserted by the caller rather than noted here: a scenario built
      // around a parked car is *supposed* to leave a queue standing still for ever, so the
      // sweep measures the worst standstill and lets each test say whether it is a fault.
      if (v.mode !== VehicleMode.Parked) {
        if (stall > result.maxStall) {
          result.maxStall = stall;
          result.worstStall = `${where}: ${stall.toFixed(2)}s at arc ${v.arcDistance.toFixed(1)}`;
        }
        if (v.speed <= STOPPED_SPEED) result.yields++;
      }
    }

    // --- pairwise: same route, in arc space
    const byRoute = new Map<string, Vehicle[]>();
    for (const v of world.vehicles) {
      const list = byRoute.get(v.routeId);
      if (list) list.push(v); else byRoute.set(v.routeId, [v]);
    }
    for (const [routeId, list] of byRoute) {
      const sorted = list.slice().sort((a, b) => a.arcDistance - b.arcDistance);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].arcDistance - sorted[i - 1].arcDistance;
        result.minSameRouteGap = Math.min(result.minSameRouteGap, gap);
        if (gap <= 3 * TILE_SIZE) result.interactions++;
        if (gap <= CAR_LENGTH) {
          note(`${scenario.name} tick ${tick}: ${sorted[i - 1].id} and ${sorted[i].id} ` +
            `overlap on ${routeId} (centres ${gap.toFixed(4)}px apart)`);
        }
      }
    }

    // --- pairwise: everybody, in world space
    //
    // Arc space cannot see two cars on *different* routes sharing the same ground, which is
    // exactly what a junction lets happen and exactly what the bug report described. Cross-
    // route pixels carry a few pixels of smoothing error by design (see `LaneIndex`), which
    // is an order of magnitude below the threshold being asserted.
    const points = world.vehicles.map(v => {
      const s = sampleRoute(world.routes.get(v.routeId)!, v.arcDistance);
      return { id: v.id, x: s.x, y: s.y };
    });
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        result.minWorldGap = Math.min(result.minWorldGap, d);
        if (d <= CAR_LENGTH) {
          note(`${scenario.name} tick ${tick}: ${points[i].id} and ${points[j].id} ` +
            `are ${d.toFixed(4)}px apart in world space`);
        }
      }
    }

    // --- arrivals: despawn, exactly as the adapter must
    for (const e of events) {
      if (e.kind !== TrafficEventKind.Arrived) continue;
      result.arrivals++;
      const i = world.vehicles.findIndex(v => v.id === e.vehicleId);
      if (i >= 0) world.vehicles.splice(i, 1);
      stalledFor.delete(e.vehicleId);
    }

    // --- spawns: keep the board loaded
    const rate = opts.spawnRate ?? 0;
    for (const routeId of scenario.spawnRoutes) {
      if (rand() >= rate) continue;
      // Never insert a car on top of one already there; the model owes nothing to a world
      // that starts overlapped, and the clamp in `step` would legitimately fire.
      const clearance = CAR_LENGTH + DEFAULT_IDM.s0;
      const clear = world.vehicles.every(v => v.routeId !== routeId || v.arcDistance > clearance);
      if (!clear) continue;
      world.vehicles.push(car(`+${spawnCounter++}`, routeId, 0, 0));
      result.spawned++;
    }
  }

  return result;
}

/** Assertions every sweep owes, whatever it was set up to stress. */
function expectClean(result: SweepResult, name: string): void {
  expect(result.violations, name).toEqual([]);
  expect(result.minSameRouteGap, `${name}: closest pair on one route`).toBeGreaterThan(CAR_LENGTH);
  expect(result.minWorldGap, `${name}: closest pair in world space`).toBeGreaterThan(CAR_LENGTH);
  expect(result.maxTickAdvance, `${name}: furthest advance in one tick`)
    .toBeLessThanOrEqual(SPEED_LIMIT * DT + 1e-9);
  expect(result.maxSpeedChange, `${name}: largest speed change in one tick`)
    .toBeLessThanOrEqual(MAX_SPEED_CHANGE + 1e-9);
}

/**
 * "Cars get stuck entirely", as an assertion. Fifteen seconds is far longer than any queue
 * or junction wait a clearing network produces — the measured worst across every scenario in
 * this file is well under half of it — so a breach means a car that is never getting there.
 */
function expectNoStall(result: SweepResult, name: string): void {
  expect(result.maxStall, `${name}: longest standstill — ${result.worstStall}`).toBeLessThan(15);
}

/**
 * The premises each sweep depends on. Without these a scenario that quietly stopped
 * producing traffic — a fixture typo, a spawn rate that never fires — would satisfy every
 * invariant above by having nothing to violate them with.
 */
function expectBusy(result: SweepResult, name: string, minArrivals: number): void {
  expect(result.arrivals, `${name}: cars that reached their destination`)
    .toBeGreaterThanOrEqual(minArrivals);
  expect(result.interactions, `${name}: vehicle-ticks within three tiles of another car`)
    .toBeGreaterThan(0);
  expect(result.maxSpeed, `${name}: fastest car seen`).toBeGreaterThan(SPEED_LIMIT * 0.9);
}

// --- the scenarios under sweep ------------------------------------------------------------

/**
 * Two seeds, not four. The four originally swept cost ~400ms of every CI run and differed
 * only in initial spacing and speeds of the same corridor; vertical, L-shaped and
 * nine-junction fixtures cover the shapes that actually differ. What is lost is two more
 * samples of one shape — worth having if a future failure ever looks seed-dependent, and
 * cheap to restore, since the sweep is parameterised by seed.
 */
const CORRIDOR_SEEDS = [1, 42];

describe('traffic invariants', () => {
  it('builds the fixtures it claims to', () => {
    // The premise behind every `SPEED_LIMIT`-based bound in this file: one limit everywhere,
    // so `maxTickAdvance <= SPEED_LIMIT * DT` is a statement about the model rather than
    // about which cell a car happened to be on.
    const scenarios = [
      singleRoute('h', horizontal('r', 0, 60, 7), 4, 1),
      singleRoute('v', vertical('r', 4, 40, 6), 4, 1),
      singleRoute('L', elbow('r', 10), 4, 1),
      crossingCity(1, 2),
    ];
    for (const s of scenarios) {
      for (const route of s.world.routes.values()) {
        for (const segment of route.segments) expect(segment.speedLimit).toBe(SPEED_LIMIT);
      }
    }

    // …and that the shapes really are the shapes claimed. A vertical fixture that silently
    // built horizontally would take the whole `gy` half of `junctionKey` out of the sweep.
    const v = singleRoute('v', vertical('r', 4, 40, 6), 1, 1).world.routes.get('r')!;
    expect(new Set(v.cells.map(c => c.gx))).toEqual(new Set([4]));
    expect(v.cells.map(c => c.gy)).toEqual(Array.from({ length: 40 }, (_, i) => i));

    const l = singleRoute('L', elbow('r', 10), 1, 1).world.routes.get('r')!;
    expect(new Set(l.cells.map(c => c.gx)).size).toBeGreaterThan(1);
    expect(new Set(l.cells.map(c => c.gy)).size).toBeGreaterThan(1);

    const city = crossingCity(1, 1).world;
    const junctions = new Set<string>();
    for (const route of city.routes.values()) {
      route.cells.forEach((c, i) => {
        if (route.segments.some(s => s.kind === X && s.startArc <= route.cellDist[i]
          && route.cellDist[i] <= s.endArc)) junctions.add(`${c.gx},${c.gy}`);
      });
    }
    expect(junctions.size, 'nine distinct crossings, on both axes').toBe(9);

    // No fixture may begin or end a grid span on a junction cell. Task 7 documented three
    // shapes the stepper cannot fully regulate, and two of them are exactly that: a route
    // whose *first* cell is a junction gets no candidate and no stop line, because there is
    // no predecessor to derive an entry direction from and `nextJunctionCell` looks strictly
    // ahead; and a junction opening a grid span that follows a **highway** span is invisible
    // to both, since `segmentAt` at the cell centre lands on the highway segment. (The third,
    // a route *ending* on a junction, is regulated, but only by over-reserving the whole
    // cell.) Crossing an unregulated junction is consistent rather than dangerous on its own,
    // but it is not what these sweeps claim to cover — so the fixtures exclude it, and the
    // adapter owes the same guarantee when it assembles routes.
    for (const s of scenarios) {
      for (const route of s.world.routes.values()) {
        const ends = [0, route.cells.length - 1];
        for (const i of ends) {
          const segment = route.segments.find(
            seg => seg.startArc <= route.cellDist[i] && route.cellDist[i] <= seg.endArc);
          expect(segment?.kind, `${route.id} cell ${i} must not be a junction`).not.toBe(X);
        }
      }
    }
  });

  it.each(CORRIDOR_SEEDS)('holds on a loaded horizontal corridor (seed %i)', (seed) => {
    const scenario = singleRoute(
      `horizontal corridor (seed ${seed})`, horizontal('r', 0, 60, 7), 20, seed,
    );
    const result = sweep(scenario, { ticks: 3600, seed, spawnRate: 0.01 });
    expectClean(result, scenario.name);
    expectBusy(result, scenario.name, 15);
    expectNoStall(result, scenario.name);
  });

  it.each([2, 8])('holds on a loaded vertical corridor (seed %i)', (seed) => {
    const scenario = singleRoute(
      `vertical corridor (seed ${seed})`, vertical('r', 4, 40, 6), 12, seed,
    );
    const result = sweep(scenario, { ticks: 1800, seed, spawnRate: 0.01 });
    expectClean(result, scenario.name);
    expectBusy(result, scenario.name, 8);
    expectNoStall(result, scenario.name);
  });

  it.each([3, 9])('holds on a loaded L-shaped route (seed %i)', (seed) => {
    const scenario = singleRoute(`L route (seed ${seed})`, elbow('r', 10), 12, seed);
    const result = sweep(scenario, { ticks: 1800, seed, spawnRate: 0.01 });
    expectClean(result, scenario.name);
    expectBusy(result, scenario.name, 8);
    expectNoStall(result, scenario.name);
  });

  it.each([4, 10, 21])('holds on a crossing city of nine junctions (seed %i)', (seed) => {
    const scenario = crossingCity(seed, 3);
    const result = sweep(scenario, { ticks: 1800, seed, spawnRate: 0.002 });
    expectClean(result, scenario.name);
    expectBusy(result, scenario.name, 20);
    // The junction premise: somebody actually had to give way, so the sweep covered the
    // admission model rather than nine junctions nobody contested.
    expect(result.yields, `${scenario.name}: vehicle-ticks stopped short of a destination`)
      .toBeGreaterThan(60);
    expectNoStall(result, scenario.name);
  });

  it('keeps everyone off a parked car sitting mid-corridor', () => {
    // No stall bound here, and that is the point: a parked car is an unmovable obstacle, so
    // the queue behind it is *supposed* to stand still forever. What may not happen is anyone
    // ending up on top of it — the failure the old lane index produced by leaving parked cars
    // out of the index entirely.
    const world = createWorld();
    const route = buildRoute(horizontal('r', 0, 20, 7))!;
    world.routes.set('r', route);

    // Placed deliberately, not wherever `populate` happened to put a car. A straight grid
    // span puts cell centres exactly one tile apart, so cell 10 is arc 400 — mid-block, two
    // cells clear of the junction at cell 7 and of that junction's exit cell, cell 8. That
    // matters: park a car in a junction's exit cell instead and the queue is governed by the
    // stop line rather than by the parked car, which is the *next* test, not this one.
    const PARKED_ARC = 400;
    expect(route.cellDist[10], 'cell 10 sits at arc 400').toBe(PARKED_ARC);
    expect(route.segments[7].kind, 'the junction is at cell 7').toBe(X);
    expect(route.segments[10].kind, 'and cell 10 is plain road').toBe(R);

    world.vehicles.push(car('P', 'r', PARKED_ARC, 0));
    for (let i = 0; i < 5; i++) world.vehicles.push(car(`f${i}`, 'r', 200 - i * 40, SPEED_LIMIT));
    const scenario: Scenario = { name: 'parked corridor', world, spawnRoutes: [] };

    const result = sweep(scenario, { ticks: 1800, seed: 3, parked: ['P'] });
    expectClean(result, scenario.name);
    expect(result.interactions, 'cars closed on one another').toBeGreaterThan(0);

    const parked = world.vehicles.find(v => v.id === 'P')!;
    expect(parked.arcDistance, 'a parked car never moves').toBe(PARKED_ARC);
    expect(parked.speed).toBe(0);
    expect(parked.distanceThisTick).toBe(0);

    const queue = world.vehicles
      .filter(v => v.id !== 'P')
      .map(v => PARKED_ARC - v.arcDistance)
      .sort((a, b) => a - b);
    expect(queue.length, 'somebody actually queued behind it').toBe(5);
    expect(queue.every(g => g > 0), 'and nobody drove past it').toBe(true);
    // The car immediately behind rests one car length plus a standstill gap back. IDM
    // approaches `s0` from outside and a 60Hz Euler step settles a fraction of a pixel short
    // of it, so this is a bound with tolerance rather than an equality.
    expect(queue[0]).toBeGreaterThan(CAR_LENGTH);
    expect(queue[0]).toBeLessThan(CAR_LENGTH + DEFAULT_IDM.s0 + 1);
  });

  it('does not make an uncontested car stop at a junction', () => {
    // The other half of the arrival-time sentinel, and the regression this fix could most
    // easily have been: yielding to a queue must not become stopping at every junction.
    // A lone car loses the arrival key to nobody, so it should cross without ever coming near
    // a standstill — measured, it dips to 34.26px/s from a 40px/s limit, which is IDM easing
    // through the geometry rather than the junction holding it.
    const world = createWorld();
    const route = buildRoute(span('r', Array.from({ length: 10 }, (_, gx) =>
      [gx, 5, gx === 5 ? X : R] as Cell)))!;
    world.routes.set('r', route);
    // Premise: there really is a junction on the way, at cell 5.
    expect(route.segments[5].kind).toBe(X);
    world.vehicles.push(car('lone', 'r', 0, SPEED_LIMIT));

    let minSpeed = Infinity;
    let arrived = false;
    for (let tick = 0; tick < 900; tick++) {
      const events = step(world, DT);
      const v = world.vehicles[0];
      // Only while it is short of the destination: a car is *supposed* to stop when it
      // arrives, and the route end is a stop line like any other.
      if (v.arcDistance < route.cellDist[7]) minSpeed = Math.min(minSpeed, v.speed);
      for (const e of events) if (e.kind === TrafficEventKind.Arrived) arrived = true;
    }

    expect(arrived, 'it got there').toBe(true);
    expect(minSpeed, 'never brought near a standstill by the junction')
      .toBeGreaterThan(SPEED_LIMIT * 0.75);
  });

  it('keeps a car off one parked inside a junction exit cell', () => {
    // The don't-block-the-box rule seen from the outside: with the far side permanently
    // occupied, the approaching car must hold at the stop line rather than enter a junction
    // it cannot leave. The queue is expected to stand still — so, again, no stall bound.
    const world = createWorld();
    world.routes.set('down', buildRoute(span('down', Array.from({ length: 10 }, (_, gy) =>
      [5, gy, gy === 5 ? X : R] as Cell)))!);
    // Junction centre at arc 200, its exit cell centre at 240.
    world.vehicles.push(car('W', 'down', 0, SPEED_LIMIT));
    world.vehicles.push(car('P', 'down', 240, 0));
    const scenario: Scenario = { name: 'blocked exit', world, spawnRoutes: [] };

    const result = sweep(scenario, { ticks: 1200, seed: 1, parked: ['P'] });
    expectClean(result, scenario.name);

    const w = world.vehicles.find(v => v.id === 'W')!;
    // Held at the junction's stop line — the midpoint between cell centres, arc 180 — and
    // not inside the box. Asserted as a range because IDM parks `s0` short of the line.
    expect(w.arcDistance).toBeGreaterThan(180 - DEFAULT_IDM.s0 - 1);
    expect(w.arcDistance).toBeLessThan(180);
  });

  it('is deterministic: one seed, two worlds, stepped alternately', () => {
    // Stepped **alternately**, on purpose. `step` keeps its scratch — the lane index and the
    // acceleration array — in a `WeakMap` keyed by world. Running A to completion and then B
    // would never interleave the two and so would not exercise that isolation at all; the
    // module-level singleton it replaced would sail through that version of this test.
    const a = crossingCity(2024, 3);
    const b = crossingCity(2024, 3);
    const randA = mulberry32(2024);
    const randB = mulberry32(2024);

    const serialize = (w: TrafficWorld): string => w.vehicles
      .map(v => `${v.id}|${v.arcDistance}|${v.speed}|${v.lastAcceleration}|${v.arrivalTime}|` +
        `${v.distanceThisTick}|${v.mode}`)
      .join(';');

    let divergedAt = -1;
    let count = 0;
    for (let tick = 0; tick < 1200 && divergedAt < 0; tick++) {
      const eventsA = step(a.world, DT);
      const eventsB = step(b.world, DT);
      count += eventsA.length;

      const keyA = eventsA.map(e => `${e.kind}:${e.vehicleId}`).join(',');
      const keyB = eventsB.map(e => `${e.kind}:${e.vehicleId}`).join(',');
      if (keyA !== keyB || serialize(a.world) !== serialize(b.world)) divergedAt = tick;

      for (const events of [eventsA, eventsB] as const) {
        const world = events === eventsA ? a.world : b.world;
        for (const e of events) {
          const i = world.vehicles.findIndex(v => v.id === e.vehicleId);
          if (i >= 0) world.vehicles.splice(i, 1);
        }
      }
      // Both worlds draw from their own generator seeded identically: same stream, same
      // spawns, and any divergence is the simulation's rather than the harness's.
      for (const [scenario, rand] of [[a, randA], [b, randB]] as const) {
        for (const routeId of scenario.spawnRoutes) {
          if (rand() >= 0.004) continue;
          const clear = scenario.world.vehicles.every(
            v => v.routeId !== routeId || v.arcDistance > CAR_LENGTH + DEFAULT_IDM.s0);
          if (!clear) continue;
          scenario.world.vehicles.push(car(`+${tick}`, routeId, 0, 0));
        }
      }
    }

    expect(divergedAt, 'first tick at which the two worlds differed').toBe(-1);
    // Premises: the run has to have done something, or identical is trivial.
    expect(count, 'arrivals over the run').toBeGreaterThan(10);
    expect(a.world.vehicles.length).toBeGreaterThan(5);
  });

  it('is independent of vehicle array order in free-flowing traffic', () => {
    const forward = singleRoute('order/forward', horizontal('r', 0, 60, 7), 20, 77);
    const reversed = singleRoute('order/reversed', horizontal('r', 0, 60, 7), 20, 77);
    reversed.world.vehicles.reverse();

    for (let tick = 0; tick < 1800; tick++) {
      step(forward.world, DT);
      step(reversed.world, DT);
    }

    // Bit-identical, not merely close: the frame-start snapshot means index order cannot
    // enter the arithmetic at all, so any difference — however small — is a live read.
    for (const v of forward.world.vehicles) {
      const other = reversed.world.vehicles.find(o => o.id === v.id)!;
      expect(other.arcDistance, `${v.id} arc`).toBe(v.arcDistance);
      expect(other.speed, `${v.id} speed`).toBe(v.speed);
    }
    // Premise: dense enough that cars were following one another the whole way.
    const arcs = forward.world.vehicles.map(v => v.arcDistance).sort((x, y) => x - y);
    expect(Math.min(...arcs.slice(1).map((a, i) => a - arcs[i]))).toBeLessThan(3 * TILE_SIZE);
  });

  it('is independent of vehicle array order through junctions', () => {
    // This fixture is not decorative. Task 7's review built a stepper that recomputed
    // junction candidates *per vehicle*, so `exitHasRoom` saw vehicles already moved this
    // tick. It passed all 188 tests of the traffic suite and still diverged by 7.75e-3px
    // between array orders — on exactly this arrangement, and on nothing simpler. Free-
    // flowing traffic cannot show it: the live read is in the junction's exit-clearance
    // check, so it needs two junctions, two conflicting streams, and a stopped car sitting
    // in a junction's exit cell.
    const build = (): TrafficWorld => {
      const w = createWorld();
      // `down`: gx=3, gy 0..7, adjacent junctions at gy=3 and gy=4.
      w.routes.set('down', buildRoute(span('down', Array.from({ length: 8 }, (_, gy) =>
        [3, gy, gy === 3 || gy === 4 ? X : R] as Cell)))!);
      // `across`: gy=3, gx 0..6, crossing the first of them.
      w.routes.set('across', buildRoute(span('across', Array.from({ length: 7 }, (_, gx) =>
        [gx, 3, gx === 3 ? X : R] as Cell)))!);
      w.vehicles.push(car('x', 'down', 20, 20));
      // Parked at arc 200 — the centre of cell gy=5, which is the exit cell of the second
      // junction. This is what makes `exitHasRoom` answer differently.
      w.vehicles.push({ ...car('y', 'down', 200, 0), mode: VehicleMode.Parked });
      w.vehicles.push(car('c', 'across', 20, 20));
      w.vehicles.push(car('d', 'across', 90, 5));
      return w;
    };

    const forward = build();
    const reversed = build();
    reversed.vehicles.reverse();

    for (let tick = 0; tick < 600; tick++) {
      step(forward, DT);
      step(reversed, DT);
    }

    for (const v of forward.vehicles) {
      const other = reversed.vehicles.find(o => o.id === v.id)!;
      expect(other.arcDistance, `${v.id} arc`).toBe(v.arcDistance);
      expect(other.speed, `${v.id} speed`).toBe(v.speed);
      expect(other.arrivalTime, `${v.id} arrivalTime`).toBe(v.arrivalTime);
    }

    // Premises, so this cannot go vacuous. The scenario is only the one that exposed the
    // live read while `y` really is parked in the exit cell and the two streams really do
    // meet: `x` must have been held up by `c`/`d` rather than driving through unimpeded.
    const x = forward.vehicles.find(v => v.id === 'x')!;
    const y = forward.vehicles.find(v => v.id === 'y')!;
    expect(y.arcDistance, 'the parked car stayed in the exit cell').toBe(200);
    expect(x.arcDistance, 'the down-route car was held short of the second junction')
      .toBeLessThan(200);
    expect(x.arcDistance, 'and it did make progress').toBeGreaterThan(20);
  });

  /**
   * The regression test for the defect these sweeps found, and the reason `arrivalTime`'s
   * zero is a sentinel rather than a timestamp.
   *
   * Junction candidacy has **no approach horizon**: `approachingJunctionCell` offers a vehicle
   * to the next junction ahead however far away it is, and the stepper only stamps
   * `arrivalTime` once a vehicle comes to rest. While zero sorted *earliest*, a car still
   * rolling towards the junction therefore outranked one that had been stopped at the line for
   * a minute — and a cross stream whose headway was shorter than its own approach travel time
   * always had somebody upstream carrying a zero. Measured on this exact fixture: the waiter
   * reached the stop line at 6.07s and was still there at 60s, a **53.93s standstill and
   * counting**, with the cross stream flowing the whole time.
   *
   * Sorting the sentinel last closes it: the same fixture now clears the junction with a worst
   * standstill of 1.58s. This test was shipped as `it.fails` for exactly one commit, which is
   * what turned the fix from a claim into a measurement.
   */
  it('does not starve a waiting car against a steady cross stream', () => {
    const world = createWorld();
    world.routes.set('down', buildRoute(span('down', Array.from({ length: 10 }, (_, gy) =>
      [5, gy, gy === 5 ? X : R] as Cell)))!);
    // The junction is the third cell of `across`, so a car joining it is 2 tiles — 2 seconds
    // at 40px/s — of approach away, and is a candidate for that whole time.
    world.routes.set('across', buildRoute(span('across', Array.from({ length: 8 }, (_, i) =>
      [3 + i, 5, i === 2 ? X : R] as Cell)))!);

    world.vehicles.push(car('W', 'down', 0, SPEED_LIMIT));

    let stall = 0;
    let worst = 0;
    let n = 0;
    for (let tick = 0; tick < 3600; tick++) {
      if (tick % 120 === 0) world.vehicles.push(car(`a${n++}`, 'across', 0, SPEED_LIMIT));
      const w = world.vehicles.find(v => v.id === 'W');
      const before = w?.arcDistance ?? 0;
      const events = step(world, DT);
      const after = world.vehicles.find(v => v.id === 'W');
      if (after) {
        stall = after.arcDistance - before < 1e-6 ? stall + DT : 0;
        worst = Math.max(worst, stall);
      }
      for (const e of events) {
        const i = world.vehicles.findIndex(v => v.id === e.vehicleId);
        if (i >= 0) world.vehicles.splice(i, 1);
      }
    }

    // The premise: the cross stream really did keep flowing, so this is starvation and not a
    // jammed board where nobody moves.
    expect(n, 'cars offered to the cross route').toBeGreaterThan(25);
    expect(world.vehicles.filter(v => v.routeId === 'across').length,
      'the cross stream kept clearing').toBeLessThan(n);
    // The invariant the rest of this file asserts, stated here too. Measured worst is 1.58s
    // against a 53.93s standstill before the sentinel was fixed, so the margin is three
    // orders of magnitude of behaviour rather than a tuned threshold.
    expect(worst, 'longest standstill short of the destination').toBeLessThan(15);
    // …and it did not merely wait less: it actually got through.
    expect(world.vehicles.some(v => v.routeId === 'down'), 'the waiter crossed and arrived')
      .toBe(false);
  });
});
