/**
 * Covers `Car.clearPathState` and its relationship to `resetToIdle`.
 *
 * Four sites used to clear "the path stuff" by hand — `CarRouter.assignPath`, stranding in
 * `CarRouter`, and both ends of a gas-station visit in `CarRefuelingManager` — each with a
 * different subset. The smaller subsets only worked because the next `assignPath` happened
 * to finish the job.
 *
 * Two invariants are worth pinning: what the primitive clears, and what it deliberately
 * does *not* (traffic and placement state, which `assignPath` has never touched).
 */
import { describe, it, expect } from 'vitest';

import { Car, CarState } from './Car';
import { GameColor } from '../types';

/** A car mid-journey, with every route-derived field set to something non-default. */
function movingCar(): Car {
  const car = new Car('house-1', GameColor.Red, { gx: 2, gy: 2 }, 100);
  car.state = CarState.GoingToBusiness;
  car.path = [{ kind: 'grid', pos: { gx: 2, gy: 2 } }, { kind: 'grid', pos: { gx: 3, gy: 2 } }];
  car.pathIndex = 1;
  car.segmentProgress = 0.4;
  car.smoothPath = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  car.smoothCumDist = [0, 10];
  car.smoothCellDist = [0, 10];
  car.onHighway = true;
  car.highwayPolyline = [{ x: 0, y: 0 }];
  car.highwayCumDist = [0];
  car.highwayProgress = 5;
  car.sameLaneWaitTime = 1.5;
  car.stuckTimer = 2.5;
  car.lastAdvancedPathIndex = 1;
  car.arcDistance = 12;
  car.currentSpeed = 40;
  car.leaderId = 'car-9';
  car.leaderGap = 8;
  // Not route state — see the second test.
  car.intersectionWaitTime = 3;
  car.wasBlocked = true;
  car.arrivalTime = 7;
  return car;
}

describe('Car.clearPathState', () => {
  it('forgets the route and everything derived from progress along it', () => {
    const car = movingCar();

    car.clearPathState();

    expect(car.path).toEqual([]);
    expect(car.pathIndex).toBe(0);
    expect(car.segmentProgress).toBe(0);
    expect(car.smoothPath).toEqual([]);
    expect(car.smoothCumDist).toEqual([]);
    expect(car.smoothCellDist).toEqual([]);
    expect(car.onHighway).toBe(false);
    expect(car.highwayPolyline).toBeNull();
    expect(car.highwayCumDist).toBeNull();
    expect(car.highwayProgress).toBe(0);
    expect(car.sameLaneWaitTime).toBe(0);
    expect(car.stuckTimer).toBe(0);
    expect(car.lastAdvancedPathIndex).toBe(0);
    expect(car.arcDistance).toBe(0);
    expect(car.currentSpeed).toBe(0);
    expect(car.leaderId).toBeNull();
    expect(car.leaderGap).toBe(Infinity);
  });

  it('leaves traffic state, position and cargo alone', () => {
    // `assignPath` has never reset these, and folding them in would change how a car
    // rejoins an intersection queue after a reroute.
    const car = movingCar();
    car.hasLoad = true;
    const { x, y } = car.pixelPos;

    car.clearPathState();

    expect(car.intersectionWaitTime).toBe(3);
    expect(car.wasBlocked).toBe(true);
    expect(car.arrivalTime).toBe(7);
    expect(car.hasLoad).toBe(true);
    expect(car.pixelPos).toEqual({ x, y });
    expect(car.state).toBe(CarState.GoingToBusiness);
  });
});

describe('Car.resetToIdle', () => {
  it('is a superset of clearPathState', () => {
    const viaReset = movingCar();
    viaReset.resetToIdle({ gx: 2, gy: 2 });

    const viaClear = movingCar();
    viaClear.clearPathState();

    // Every field the primitive clears is still cleared by the full reset.
    for (const key of ['path', 'pathIndex', 'segmentProgress', 'smoothPath', 'smoothCumDist',
      'smoothCellDist', 'onHighway', 'highwayPolyline', 'highwayCumDist', 'highwayProgress',
      'sameLaneWaitTime', 'stuckTimer', 'lastAdvancedPathIndex', 'arcDistance', 'currentSpeed',
      'leaderId', 'leaderGap'] as const) {
      expect(viaReset[key], key).toEqual(viaClear[key]);
    }
  });

  it('additionally clears the state a journey leaves behind', () => {
    const car = movingCar();
    car.hasLoad = true;
    car.targetBusinessId = 'biz-1';
    car.targetGasStationId = 'gs-1';

    car.resetToIdle({ gx: 2, gy: 2 });

    expect(car.state).toBe(CarState.Idle);
    expect(car.hasLoad).toBe(false);
    expect(car.targetBusinessId).toBeNull();
    expect(car.targetGasStationId).toBeNull();
    expect(car.intersectionWaitTime).toBe(0);
    expect(car.wasBlocked).toBe(false);
    expect(car.arrivalTime).toBe(0);
  });

  it('keeps the fuel in the tank', () => {
    // A car that reaches home must still visit a gas station.
    const car = movingCar();
    car.fuel = 12;

    car.resetToIdle({ gx: 2, gy: 2 });

    expect(car.fuel).toBe(12);
  });
});
