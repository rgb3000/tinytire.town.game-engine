/**
 * Covers the "a car just became stranded" alert, and the contract `CarSystem` owes the
 * traffic simulation now that the simulation, and not `CarMovement`, is what moves cars.
 *
 * The snapshot → run → diff dance behind it was written out three times — around the
 * periodic rescue, around a road change, and around movement — and the interesting rule is
 * the same in all three: alert on the *transition*, not on the state. A car that is already
 * stranded must stay quiet, or a permanently cut-off car buzzes once a second forever.
 *
 * Observable without a canvas: a `CarSystem` needs only a grid, a pathfinder and a config,
 * as `src/constants.test.ts` also relies on.
 */
import { describe, it, expect } from 'vitest';

import { buildConfig, DEFAULT_GAME_CONSTANTS, TILE_SIZE } from '../constants';
import { Grid } from '../core/Grid';
import { CellType, GameColor } from '../types';
import type { GridPos } from '../types';
import type { GameConstants } from '../maps/types';
import { House } from '../entities/House';
import { Business } from '../entities/Business';
import { Car, CarState } from '../entities/Car';
import { CarSystem } from './CarSystem';
import { RoadSystem } from './RoadSystem';
import { PendingDeletionSystem } from './PendingDeletionSystem';
import { HighwaySystem } from './HighwaySystem';
import type { TrafficAdapter } from './car/TrafficAdapter';
import { STALL_WATCHDOG_SECONDS, STOPPED_SPEED, TrafficEventKind } from '../traffic';
import { Pathfinder } from '../pathfinding/Pathfinder';
import { gridToPixelCenter } from '../utils/math';

const TICK = 1 / 60;

/**
 * A house with cars, on a grid with no roads at all — so any route the simulation looks for
 * fails, which is what makes stranding reachable in a unit test.
 */
function makeSystem(): { carSystem: CarSystem; house: House; cars: Car[]; stranded: () => number } {
  const cfg = buildConfig();
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);
  const carSystem = new CarSystem(
    new Pathfinder(grid, cfg, new HighwaySystem()),
    grid,
    new PendingDeletionSystem(grid, roadSystem),
    cfg,
  );

  const house = new House({ gx: 10, gy: 10 }, GameColor.Red);
  carSystem.registerHouse(house);

  let count = 0;
  carSystem.onStranded = () => { count++; };
  return { carSystem, house, cars: carSystem.getCars(), stranded: () => count };
}

/**
 * Park a car far from its house, which is what makes it unrescuable.
 *
 * Distance matters: `findPath` short-circuits when start and goal are the same tile, so a
 * car left standing on its own doorstep gets "rescued" onto a zero-length path home no
 * matter how roadless the grid is.
 */
function setAdrift(car: Car, state: CarState = CarState.GoingToBusiness): void {
  car.state = state;
  const center = gridToPixelCenter({ gx: 40, gy: 40 });
  car.pixelPos = { ...center };
  car.prevPixelPos = { ...center };
}

describe('CarSystem stranded alerts', () => {
  it('alerts when a car becomes stranded', () => {
    const { carSystem, house, cars, stranded } = makeSystem();
    setAdrift(cars[0]);

    carSystem.update(TICK, [house], []);

    expect(cars[0].state).toBe(CarState.Stranded);
    expect(stranded()).toBe(1);
  });

  it('alerts only once when several cars strand in the same tick', () => {
    const { carSystem, house, cars, stranded } = makeSystem();
    expect(cars.length).toBeGreaterThan(1);
    for (const car of cars) setAdrift(car);

    carSystem.update(TICK, [house], []);

    expect(cars.every(c => c.state === CarState.Stranded)).toBe(true);
    expect(stranded()).toBe(1);
  });

  it('stays quiet on later frames for a car that is still stranded', () => {
    const { carSystem, house, cars, stranded } = makeSystem();
    setAdrift(cars[0]);

    carSystem.update(TICK, [house], []);
    expect(stranded()).toBe(1);

    for (let i = 0; i < 10; i++) carSystem.update(TICK, [house], []);

    expect(cars[0].state).toBe(CarState.Stranded);
    expect(stranded()).toBe(1);
  });

  it('stays quiet when a road change fails to rescue an already-stranded car', () => {
    const { carSystem, house, cars, stranded } = makeSystem();
    setAdrift(cars[0], CarState.Stranded);

    carSystem.onRoadsChanged([house]);

    expect(cars[0].state).toBe(CarState.Stranded);
    expect(stranded()).toBe(0);
  });

  it('does not alert while every car is idle at home', () => {
    const { carSystem, house, stranded } = makeSystem();

    for (let i = 0; i < 5; i++) carSystem.update(TICK, [house], []);

    expect(stranded()).toBe(0);
  });

  it('runs the wrapped work even with no listener attached', () => {
    const { carSystem, house, cars } = makeSystem();
    carSystem.onStranded = null;
    setAdrift(cars[0]);

    carSystem.update(TICK, [house], []);

    expect(cars[0].state).toBe(CarState.Stranded);
  });
});

/**
 * A one-house, one-business town with a real road between them, so a car can be dispatched,
 * drive, arrive, unload and come home entirely inside a Node test.
 *
 * Only the cells the pathfinder reads are materialised: the house, the road run and the
 * business's connector. The business's other three cells never take part in a route.
 */
interface Town {
  carSystem: CarSystem;
  adapter: TrafficAdapter;
  pathfinder: Pathfinder;
  grid: Grid;
  pending: PendingDeletionSystem;
  house: House;
  biz: Business;
  cars: Car[];
  tick(n?: number): void;
  /** Advance until `done()` or `limit` ticks; returns the ticks actually run. */
  runUntil(done: () => boolean, limit?: number): number;
}

const STRAIGHT: GridPos[] = Array.from({ length: 8 }, (_, i) => ({ gx: 3 + i, gy: 5 }));
/** Same start and end count, but with a right-angle turn in it. */
const CORNER: GridPos[] = [
  { gx: 3, gy: 5 }, { gx: 4, gy: 5 }, { gx: 5, gy: 5 }, { gx: 6, gy: 5 },
  { gx: 6, gy: 6 }, { gx: 6, gy: 7 }, { gx: 6, gy: 8 }, { gx: 6, gy: 9 },
];

function makeTown(road: GridPos[] = STRAIGHT, overrides: Partial<GameConstants> = {}): Town {
  const cfg = buildConfig(overrides);
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);
  const pending = new PendingDeletionSystem(grid, roadSystem);
  const pathfinder = new Pathfinder(grid, cfg, new HighwaySystem());
  const carSystem = new CarSystem(pathfinder, grid, pending, cfg);

  const housePos = { gx: road[0].gx - 1, gy: road[0].gy };
  const last = road[road.length - 1];
  const connectorPos = { gx: last.gx, gy: last.gy + 1 };

  const house = new House(housePos, GameColor.Red);
  grid.setCell(housePos.gx, housePos.gy, { type: CellType.House, entityId: house.id, color: GameColor.Red });
  for (const c of road) roadSystem.placeRoad(c.gx, c.gy);

  // The connector is the business's own cell, so it is placed directly rather than by
  // `RoadSystem`, which only ever creates plain road.
  grid.setCell(connectorPos.gx, connectorPos.gy, { type: CellType.Connector, color: GameColor.Red });

  const chain = [housePos, ...road, connectorPos];
  for (let i = 0; i < chain.length - 1; i++) {
    roadSystem.connectRoads(chain[i].gx, chain[i].gy, chain[i + 1].gx, chain[i + 1].gy);
  }
  grid.recomputeIntersectionFlags();

  // Rotation 0 puts the connector one cell below the anchor.
  const biz = new Business({ gx: connectorPos.gx, gy: connectorPos.gy - 1 }, GameColor.Red, 0);
  expect(biz.connectorPos).toEqual(connectorPos);

  carSystem.registerHouse(house);

  // `PendingDeletionSystem.update` runs every frame in `Game`, and it is what actually
  // finalises a deletion once no car depends on the cell any more. Without it here, a cell
  // would stay pending however many cars drove clear of it.
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      carSystem.update(TICK, [house], [biz]);
      pending.update();
    }
  };

  return {
    carSystem, adapter: carSystem.getTrafficAdapter(), pathfinder, grid, pending, house, biz,
    cars: carSystem.getCars(), tick,
    runUntil(done, limit = 6000) {
      for (let i = 0; i < limit; i++) {
        if (done()) return i;
        tick();
      }
      return limit;
    },
  };
}

/** The car the dispatcher actually sent out, once it has one. */
function dispatched(town: Town): Car {
  town.runUntil(() => town.cars.some(c => c.state !== CarState.Idle), 120);
  const car = town.cars.find(c => c.state !== CarState.Idle);
  expect(car, 'the dispatcher never sent a car out').toBeDefined();
  return car!;
}

describe('CarSystem drives cars from the simulation', () => {
  it('sends a car to a business, unloads it and brings it home', () => {
    const town = makeTown();
    const car = dispatched(town);
    expect(car.state).toBe(CarState.GoingToBusiness);

    town.runUntil(() => car.state === CarState.Idle);

    expect(car.state).toBe(CarState.Idle);
    expect(car.hasLoad).toBe(false);
    expect(town.carSystem.getScore()).toBe(1);
    expect(town.biz.demandPins).toBe(0);
    expect(town.house.deliveryCount).toBe(1);
  });

  it('advances the simulation exactly once per update, however many cars there are', () => {
    const town = makeTown();
    // Two cars per house by default, and the point of the assertion is that the count does
    // not scale with them: the simulation rebuilds its lane index inside `update`, so one
    // call per car would be quadratic in the number of cars on the board.
    expect(town.cars.length).toBeGreaterThan(1);
    dispatched(town);

    const adapter = town.adapter;
    const real = adapter.update.bind(adapter);
    let calls = 0;
    adapter.update = (dt: number) => { calls++; return real(dt); };

    town.tick();
    expect(calls).toBe(1);
    town.tick(5);
    expect(calls).toBe(6);
  });
});

describe('CarSystem fuel', () => {
  it('charges the distance the simulation moved, not one unit per grid step', () => {
    // The old model charged 1 (or root two) per path step on the grid and the arc it really
    // covered on a highway, so the two disagreed about what a journey cost. A route with a
    // corner in it is where the disagreement shows on the grid alone: the smoothed lane path
    // is not the tile count.
    const town = makeTown(CORNER);
    const car = dispatched(town);

    town.runUntil(() => car.state === CarState.Unloading);
    expect(car.state).toBe(CarState.Unloading);

    const route = town.adapter.getRouteFor(car);
    expect(route, 'an unloading car keeps its route').not.toBeNull();
    // The arc really covered, which is the sum of every tick's `distanceThisTick`.
    const travelled = town.adapter.getArc(car) / TILE_SIZE;
    const stepCost = route!.cells.length - 1;

    // The premise: on this road the two answers really are different, so the assertion below
    // discriminates between them rather than agreeing with both.
    expect(Math.abs(travelled - stepCost)).toBeGreaterThan(0.05);
    expect(DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY - car.fuel).toBeCloseTo(travelled, 5);
  });

  it('bills the tick a car arrives home on, because arrivals are handled after fuel', () => {
    // Handling arrivals before the fuel pass would despawn the vehicle first, and
    // `getDistanceThisTick` of a despawned car is zero — so the final stretch of every
    // journey home would be free. The tick a car goes idle on must still cost it fuel.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.GoingHome);

    let before = car.fuel;
    for (let i = 0; i < 6000 && car.state !== CarState.Idle; i++) {
      before = car.fuel;
      town.tick();
    }

    expect(car.state).toBe(CarState.Idle);
    expect(car.fuel).toBeLessThan(before);
  });

  it('strands a car that runs dry mid-journey, and leaves it blocking the road', () => {
    const town = makeTown(STRAIGHT, { FUEL_CAPACITY: 2 });
    const car = dispatched(town);

    town.runUntil(() => car.state === CarState.Stranded, 600);

    expect(car.state).toBe(CarState.Stranded);
    expect(car.fuel).toBe(0);
    // Parked, not despawned: the car is physically still on that road.
    expect(town.adapter.isParked(car)).toBe(true);
    expect(town.adapter.debugCounts().vehicles).toBeGreaterThan(0);
  });
});

describe('CarSystem arrivals', () => {
  it('parks a car that reaches a business, so it keeps blocking the connector', () => {
    const town = makeTown();
    const car = dispatched(town);

    town.runUntil(() => car.state === CarState.Unloading);

    expect(car.state).toBe(CarState.Unloading);
    expect(town.adapter.isParked(car)).toBe(true);
    expect(town.adapter.getRouteFor(car)).not.toBeNull();
  });

  it('despawns a car that reaches home, leaving no route behind it', () => {
    // Leaving the vehicle in place is the Task 7 deadlock: an arrived car that is neither
    // parked nor removed stands in the road with nothing able to pass it. Home is the
    // despawn half — and the route must go with the vehicle, or every completed journey
    // leaks a few hundred points for the rest of the session.
    const town = makeTown();
    const car = dispatched(town);

    town.runUntil(() => car.state === CarState.Idle);

    expect(car.state).toBe(CarState.Idle);
    expect(town.adapter.getRouteFor(car)).toBeNull();
    const counts = town.adapter.debugCounts();
    expect(counts.vehicles).toBe(0);
    expect(counts.routes).toBe(0);
  });

  it('does not lose a delivery when a car is reported blocked on the tick it arrives', () => {
    // The one construction where the order of the arrivals pass and the repathing pass is
    // observable, and it is not a curiosity: it is what happens whenever the road under a
    // destination goes away as a car reaches it, which is the branch `CarRouter.rerouteCar`
    // exists for. Repathing first sends the car home, `handleArrival` then takes the
    // `GoingHome` branch and resets it to idle standing at the business, and the delivery
    // evaporates — no unload, no score, no pin.
    //
    // The watchdog's twelve seconds are not what makes it reachable. A `Blocked` report is
    // just an entry in the list the adapter returns, so injecting one through the same seam
    // the tick-count test uses reaches the code path with no timing to arrange at all.
    const town = makeTown();
    const car = dispatched(town);
    expect(car.state).toBe(CarState.GoingToBusiness);
    expect(town.biz.demandPins).toBe(1);

    const adapter = town.adapter;
    const real = adapter.update.bind(adapter);
    let injected = false;
    adapter.update = (dt: number) => {
      const events = real(dt);
      if (injected) return events;
      if (!events.some(e => e.kind === TrafficEventKind.Arrived && e.vehicleId === car.id)) return events;
      injected = true;
      // The connector goes on the tick the car reaches it, so there is no longer a route to
      // the destination the repath would try to re-establish.
      town.grid.clearCell(town.biz.connectorPos.gx, town.biz.connectorPos.gy);
      town.pathfinder.clearCache();
      events.push({ kind: TrafficEventKind.Blocked, vehicleId: car.id });
      return events;
    };

    town.runUntil(() => injected, 900);
    // Premise: the arrival really happened and a report really was injected alongside it.
    expect(injected).toBe(true);

    // Arrivals are settled before reports are read, so the arrival wins and the car unloads.
    expect(car.state).toBe(CarState.Unloading);

    town.tick(120);
    expect(town.carSystem.getScore()).toBe(1);
    expect(town.biz.demandPins).toBe(0);
  });

  it('leaves no arrival in a driving state, including the ones that fail', () => {
    // What the repath-after-arrivals order rests on. A car sent to a gas station on a board
    // with no gas stations reaches the end of its route and finds nothing there; the old
    // code returned with the state untouched, which left it driving and blocked with no
    // route to drive. Every arrival outcome has to be a state the blocked pass ignores.
    const town = makeTown();
    const car = dispatched(town);
    car.state = CarState.GoingToGasStation;
    car.targetGasStationId = 'no-such-station';

    town.runUntil(() => car.state !== CarState.GoingToGasStation, 900);

    expect(car.state).toBe(CarState.Stranded);
    expect(town.adapter.isParked(car)).toBe(true);
  });

  it('releases a homebound car from a pending cell as it drives clear of it', () => {
    // `PendingDeletionSystem` finalises a deletion when the last car depending on the cell
    // has passed. Nothing else ever tells it that has happened, so without this the road a
    // player deleted under a homebound car stays faded for the rest of the run.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.GoingHome);

    const behind = STRAIGHT[STRAIGHT.length - 2];
    town.pending.markPending(behind.gx, behind.gy, [car.id]);
    expect(town.pending.isPending(behind.gx, behind.gy)).toBe(true);

    town.runUntil(() => !town.pending.isPending(behind.gx, behind.gy), 600);

    expect(town.pending.isPending(behind.gx, behind.gy)).toBe(false);
    // Still on the road, so the release came from driving past the cell and not from
    // reaching home and being despawned.
    expect(car.state).toBe(CarState.GoingHome);
  });
});

describe('CarSystem repairs', () => {
  it('reroutes a car the simulation reports as permanently stopped', () => {
    // The simulation offers no guarantee that a road ever drains: a stranded car with
    // nowhere to go stands in it for the rest of the session, and the car behind it will
    // wait for ever. The watchdog can measure that; only the game can end it, because
    // repathing needs the pathfinder, the destination and the fuel model.
    const town = makeTown();
    town.biz.demandPins = 2;
    town.runUntil(() => town.cars.every(c => c.state !== CarState.Idle), 300);
    const [a, b] = town.cars;
    const lead = town.adapter.getArc(a) > town.adapter.getArc(b) ? a : b;
    const follower = lead === a ? b : a;

    town.runUntil(() => town.adapter.getArc(lead) > 200, 600);

    // Strand the leader in the middle of the road, and take the house off the board so no
    // rescue can ever move it. That is the shape the watchdog exists for.
    lead.state = CarState.Stranded;
    lead.destination = null;
    town.adapter.setParked(lead, true);
    const homeless = (n: number): void => {
      for (let i = 0; i < n; i++) town.carSystem.update(TICK, [], [town.biz]);
    };

    // The follower closes on it and settles at a standstill gap behind its rear bumper.
    for (let i = 0; i < 600 && town.adapter.getSpeed(follower) >= STOPPED_SPEED; i++) homeless(1);
    expect(town.adapter.getSpeed(follower)).toBeLessThan(STOPPED_SPEED);
    const before = town.adapter.getRouteFor(follower);
    expect(before).not.toBeNull();

    // Short of the watchdog: nothing has been reported, so nothing has been repathed.
    homeless(Math.floor((STALL_WATCHDOG_SECONDS - 3) * 60));
    expect(town.adapter.getRouteFor(follower)).toBe(before);

    // Past it. `buildRoute` returns a fresh object every time, so a new route is a repath.
    homeless(240);
    expect(town.adapter.getRouteFor(follower)).not.toBe(before);
    // The premise the whole test rests on: the blocker never moved.
    expect(lead.state).toBe(CarState.Stranded);
    expect(town.adapter.getSpeed(lead)).toBe(0);
  });

  it('never leaves a car in a driving state parked', () => {
    // A route install that fails after the state has already changed leaves a car meant to
    // be driving with the simulation holding it still — and parked vehicles are exempt from
    // the stall watchdog, so it cannot even report itself.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => town.adapter.getArc(car) > 60, 600);

    town.adapter.setParked(car, true);
    expect(town.adapter.isParked(car)).toBe(true);

    town.tick();

    expect(car.state).toBe(CarState.GoingToBusiness);
    expect(town.adapter.isParked(car)).toBe(false);
  });

  it('reroutes a car the simulation holds no route for', () => {
    // Replaces `CarMovement`'s `path.length < 2` check. Without it a car dispatched onto a
    // path the route builder refused would sit at its house for ever in a driving state.
    const town = makeTown();
    const car = dispatched(town);
    town.adapter.removeVehicle(car);
    expect(town.adapter.getRouteFor(car)).toBeNull();

    town.tick();

    expect(town.adapter.getRouteFor(car)).not.toBeNull();
    expect(car.state).toBe(CarState.GoingToBusiness);
  });
});

describe('CarSystem dispatch', () => {
  it('does not put a car on a tile the last one it sent has not left yet', () => {
    // The dispatcher sends at most one car per house per pass, so the collision it has to
    // avoid is with the car it sent *last* time: passes are ten ticks apart and a car has
    // barely cleared its own doorstep by then.
    const town = makeTown();
    town.biz.demandPins = 2;
    expect(town.cars).toHaveLength(2);

    town.runUntil(() => town.cars.some(c => c.state !== CarState.Idle), 60);
    const first = town.cars.find(c => c.state !== CarState.Idle)!;
    const house = town.house.pos;

    // Premise: the first car is still standing on the house tile when the next pass runs.
    town.tick(10);
    expect(town.adapter.getCurrentCell(first)).toEqual(house);
    expect(town.adapter.isCellOccupied(house.gx, house.gy)).toBe(true);
    expect(town.cars.filter(c => c.state !== CarState.Idle)).toHaveLength(1);

    // Once it has driven off the tile, the second car follows it out.
    town.runUntil(() => town.cars.every(c => c.state !== CarState.Idle), 300);
    expect(town.cars.filter(c => c.state !== CarState.Idle)).toHaveLength(2);
  });
});

describe('CarSystem and roads the player has marked for deletion', () => {
  /** What `Game` does after an edit: the cached paths no longer describe the board. */
  function markAndNotify(town: Town, cell: GridPos, carId: string): void {
    town.pending.markPending(cell.gx, cell.gy, [carId]);
    town.pathfinder.clearCache();
    town.carSystem.onRoadsChanged([town.house]);
  }

  it('sends an outbound car looking for another way round', () => {
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => town.adapter.getArc(car) > 80, 600);
    expect(car.state).toBe(CarState.GoingToBusiness);

    const before = town.adapter.getRouteFor(car);
    markAndNotify(town, STRAIGHT[5], car.id);

    // There is no other way to the business on this road, so it turns for home instead.
    expect(town.adapter.getRouteFor(car)).not.toBe(before);
    expect(car.state).toBe(CarState.GoingHome);
  });

  it('leaves a homebound car on the road it is already crossing', () => {
    // Pending deletion exists *for* this car: the cell stays on the board until it has
    // passed. Rerouting it could only move it onto road the player did not ask to remove.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.GoingHome);
    town.runUntil(() => town.adapter.getArc(car) > 40, 600);

    const ahead = STRAIGHT[1];
    expect(town.adapter.crossesPendingDeletionAhead(car)).toBe(false);
    const before = town.adapter.getRouteFor(car);
    markAndNotify(town, ahead, car.id);

    // Premise: the marked cell really is in front of it.
    expect(town.adapter.crossesPendingDeletionAhead(car)).toBe(true);
    expect(town.adapter.getRouteFor(car)).toBe(before);
    expect(car.state).toBe(CarState.GoingHome);
  });
});

describe('CarSystem.carsDependingOn', () => {
  /**
   * The question `Game.handleTryErase` asks before it deletes a road cell: an empty answer
   * removes the cell outright, a non-empty one marks it pending until those cars are clear.
   *
   * It used to be answered in `Game` by walking `car.path`, `car.pathIndex` and
   * `car.outboundPath`. The simulation stopped writing all three when it took over movement,
   * which made the answer permanently empty — roads deleted out from under moving cars — and
   * nothing about that was a type error. Every positive assertion below is what rejects that
   * model: the car itself holds no route, so only the simulation can answer.
   */
  it('leaves nothing on the car for a road-deleter to walk', () => {
    // The premise under every positive assertion below, and the reason they cannot be
    // satisfied by reading the car. Those three fields are gone now, so the old loops no
    // longer compile — but this is what makes bringing them back visible here rather than
    // in a silently-empty answer: a route is a sequence, so any route bookkeeping put back
    // on the car is a list, and a mid-route car has none.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => town.adapter.getArc(car) > 3 * TILE_SIZE, 600);

    const listFields = Object.entries(car).filter(([, value]) => Array.isArray(value));
    expect(listFields).toEqual([]);
    for (const name of ['path', 'outboundPath', 'pathIndex', 'smoothPath']) {
      expect(Object.keys(car)).not.toContain(name);
    }
    // ...and yet the car is demonstrably somewhere along a real route.
    expect(town.adapter.getRouteFor(car)).not.toBeNull();
    expect(town.adapter.getArc(car)).toBeGreaterThan(3 * TILE_SIZE);
  });

  it('reports an outbound car on the road behind it, and not on the road ahead', () => {
    // How an outbound car gets home again: the cells it has already crossed are the ones it
    // will need back. Deleting one ahead of it merely costs it a reroute.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => town.adapter.getArc(car) > 3 * TILE_SIZE, 600);
    expect(car.state).toBe(CarState.GoingToBusiness);

    expect(town.carSystem.carsDependingOn(STRAIGHT[0].gx, STRAIGHT[0].gy)).toEqual([car.id]);
    expect(town.carSystem.carsDependingOn(STRAIGHT[7].gx, STRAIGHT[7].gy)).toEqual([]);
  });

  it('reports a homebound car on the road ahead of it, and not on the road behind', () => {
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.GoingHome);
    town.runUntil(() => town.adapter.getArc(car) > 3 * TILE_SIZE, 600);
    expect(car.state).toBe(CarState.GoingHome);

    // Homebound, so the route runs the other way: STRAIGHT[0] is what is still ahead.
    expect(town.carSystem.carsDependingOn(STRAIGHT[0].gx, STRAIGHT[0].gy)).toEqual([car.id]);
    expect(town.carSystem.carsDependingOn(STRAIGHT[7].gx, STRAIGHT[7].gy)).toEqual([]);
  });

  it('reports a parked car on its whole route, both ends of it', () => {
    // Unloading is the one state with no direction: the car is standing on the connector
    // and needs every cell it came in on to get out again.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.Unloading);

    expect(town.carSystem.carsDependingOn(STRAIGHT[0].gx, STRAIGHT[0].gy)).toEqual([car.id]);
    expect(town.carSystem.carsDependingOn(STRAIGHT[7].gx, STRAIGHT[7].gy)).toEqual([car.id]);
  });

  it('reports nobody for a cell no car is routed through', () => {
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => town.adapter.getArc(car) > 3 * TILE_SIZE, 600);

    // Premise: cars are out on the road, so an empty answer is not "no cars at all".
    expect(town.cars.some(c => c.state !== CarState.Idle)).toBe(true);
    expect(town.carSystem.carsDependingOn(20, 20)).toEqual([]);
  });

  it('does not confuse a cell in the same column on a different row', () => {
    // The road runs along gy = 5. A dependency check that compared only the column would
    // refuse for ever to delete the parallel row above it, which no car ever touches.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.Unloading);
    expect(town.carSystem.carsDependingOn(STRAIGHT[0].gx, STRAIGHT[0].gy)).toEqual([car.id]);

    for (const cell of STRAIGHT) {
      expect(town.carSystem.carsDependingOn(cell.gx, 0)).toEqual([]);
      expect(town.carSystem.carsDependingOn(cell.gx, cell.gy - 1)).toEqual([]);
    }
  });

  it('keeps a cell pending exactly as long as the car it named still depends on it', () => {
    // End to end through the two calls `Game.handleTryErase` makes: ask, then mark pending
    // with the answer. A cell marked with an empty list is finalised on the very next
    // `PendingDeletionSystem.update`, which is the shape the regression took — the road went
    // while the car was still on it.
    const town = makeTown();
    const car = dispatched(town);
    town.runUntil(() => car.state === CarState.GoingHome);
    town.runUntil(() => town.adapter.getArc(car) > TILE_SIZE, 600);

    const ahead = STRAIGHT[1];
    const dependents = town.carSystem.carsDependingOn(ahead.gx, ahead.gy);
    expect(dependents).toEqual([car.id]);

    town.pending.markPending(ahead.gx, ahead.gy, dependents);
    town.tick();
    // Still pending: the car has not reached it yet, so it must stay on the board.
    expect(town.pending.isPending(ahead.gx, ahead.gy)).toBe(true);
    expect(car.state).toBe(CarState.GoingHome);

    // And it drains once the car is clear, which is what `consumePassedCells` is for.
    town.runUntil(() => !town.pending.isPending(ahead.gx, ahead.gy), 900);
    expect(town.pending.isPending(ahead.gx, ahead.gy)).toBe(false);
  });
});
