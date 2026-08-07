/**
 * Covers the "a car just became stranded" alert.
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

import { buildConfig } from '../constants';
import { Grid } from '../core/Grid';
import { GameColor } from '../types';
import { House } from '../entities/House';
import { Car, CarState } from '../entities/Car';
import { CarSystem } from './CarSystem';
import { RoadSystem } from './RoadSystem';
import { PendingDeletionSystem } from './PendingDeletionSystem';
import { HighwaySystem } from './HighwaySystem';
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
