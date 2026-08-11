/**
 * The two rules `rerouteCar` gained when the simulation took over movement.
 *
 * Both are about *not* installing a route. A car standing inside a junction must keep the
 * one it has, because a route that begins on a junction cell reserves nothing while the car
 * physically occupies the box. And a car whose new route the simulation refused must not be
 * left in a driving state pointed at it, because what it would then drive is the old one.
 */
import { describe, it, expect } from 'vitest';

import { buildConfig } from '../../constants';
import { Grid } from '../../core/Grid';
import { GameColor } from '../../types';
import type { GridPos } from '../../types';
import { Car, CarState } from '../../entities/Car';
import type { House } from '../../entities/House';
import { RoadSystem } from '../RoadSystem';
import { HighwaySystem } from '../HighwaySystem';
import { Pathfinder } from '../../pathfinding/Pathfinder';
import { CarRouter } from './CarRouter';
import { TrafficAdapter } from './TrafficAdapter';
import type { PathStep } from '../../highways/types';

const TICK = 1 / 60;

/**
 * A straight road with a side turning, so the cell in the middle of it is a real junction.
 *
 *     (5,3)
 *       |
 *     (5,4)
 *       |
 *  (3,5)-(4,5)-(5,5)-(6,5)-(7,5)
 */
const MAIN: GridPos[] = [
  { gx: 3, gy: 5 }, { gx: 4, gy: 5 }, { gx: 5, gy: 5 }, { gx: 6, gy: 5 }, { gx: 7, gy: 5 },
];
const SIDE: GridPos[] = [{ gx: 5, gy: 4 }, { gx: 5, gy: 3 }];
const JUNCTION: GridPos = { gx: 5, gy: 5 };

function makeRouter(): { router: CarRouter; adapter: TrafficAdapter; grid: Grid; car: Car } {
  const cfg = buildConfig();
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);

  for (const c of [...MAIN, ...SIDE]) roadSystem.placeRoad(c.gx, c.gy);
  for (let i = 0; i < MAIN.length - 1; i++) {
    roadSystem.connectRoads(MAIN[i].gx, MAIN[i].gy, MAIN[i + 1].gx, MAIN[i + 1].gy);
  }
  roadSystem.connectRoads(JUNCTION.gx, JUNCTION.gy, SIDE[0].gx, SIDE[0].gy);
  roadSystem.connectRoads(SIDE[0].gx, SIDE[0].gy, SIDE[1].gx, SIDE[1].gy);
  grid.recomputeIntersectionFlags();

  const adapter = new TrafficAdapter(grid, cfg);
  const router = new CarRouter(new Pathfinder(grid, cfg, new HighwaySystem()), grid, adapter);

  const car = new Car('house-1', GameColor.Red, MAIN[0], cfg.FUEL_CAPACITY);
  car.state = CarState.GoingToBusiness;
  car.destination = MAIN[MAIN.length - 1];

  const path: PathStep[] = MAIN.map(pos => ({ kind: 'grid', pos } as PathStep));
  expect(router.assignPath(car, path)).toBe(true);

  return { router, adapter, grid, car };
}

const noHouses = new Map<string, House>();

describe('CarRouter.rerouteCar and the junction it may be standing in', () => {
  it('leaves a car standing in a junction on the route it already has', () => {
    const { router, adapter, grid, car } = makeRouter();

    for (let i = 0; i < 600; i++) {
      const cell = adapter.getCurrentCell(car);
      if (cell && cell.gx === JUNCTION.gx && cell.gy === JUNCTION.gy) break;
      adapter.update(TICK);
    }

    // Both premises, inline: the car really is on that cell, and that cell really is a
    // junction. Either one silently false would make the assertion below vacuous.
    expect(adapter.getCurrentCell(car)).toEqual(JUNCTION);
    expect(grid.getCell(JUNCTION.gx, JUNCTION.gy)?._isIntersection).toBe(true);

    const before = adapter.getRouteFor(car);
    router.rerouteCar(car, noHouses);

    expect(adapter.getRouteFor(car)).toBe(before);
    expect(car.state).toBe(CarState.GoingToBusiness);
  });

  it('reroutes the same car one cell earlier, where it is only on plain road', () => {
    // The contrast. Without it the test above passes for a router that never reroutes at
    // all, which is the shape of the mistake it is guarding.
    const { router, adapter, grid, car } = makeRouter();

    for (let i = 0; i < 600; i++) {
      const cell = adapter.getCurrentCell(car);
      if (cell && cell.gx === 4 && cell.gy === 5) break;
      adapter.update(TICK);
    }

    expect(adapter.getCurrentCell(car)).toEqual({ gx: 4, gy: 5 });
    expect(grid.getCell(4, 5)?._isIntersection).toBe(false);

    const before = adapter.getRouteFor(car);
    router.rerouteCar(car, noHouses);

    expect(adapter.getRouteFor(car)).not.toBe(before);
    expect(car.state).toBe(CarState.GoingToBusiness);
  });

  it('strands a car whose replacement route the simulation refused', () => {
    // `findPath` short-circuits a journey to the tile the car is already on, and one step is
    // not a curve — so `installRoute` says no. Treating that as success would leave the car
    // driving the route it was supposed to have left.
    const { router, adapter, car } = makeRouter();
    adapter.update(TICK);

    const here = adapter.getCurrentCell(car);
    expect(here).toEqual(MAIN[0]);
    car.destination = here;

    const before = adapter.getRouteFor(car);
    router.rerouteCar(car, noHouses);

    expect(car.state).toBe(CarState.Stranded);
    expect(adapter.isParked(car)).toBe(true);
    expect(adapter.getRouteFor(car)).toBe(before);
  });
});
