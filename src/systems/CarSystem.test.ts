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
import { STALL_WATCHDOG_SECONDS, STOPPED_SPEED } from '../traffic';
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
  car.path = [];
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
