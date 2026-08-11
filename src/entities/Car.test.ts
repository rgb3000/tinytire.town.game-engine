/**
 * Covers what a `Car` is once the traffic world owns routes: an identity, an errand, and a
 * position to draw it at.
 *
 * This file used to pin `clearPathState` — the primitive four sites called to forget "the
 * path stuff", each previously clearing a different subset of it by hand. There is no path
 * stuff left on the car to forget: `TrafficAdapter.installRoute` replaces a route wholesale
 * and `removeVehicle` drops it, so the primitive went with the fields.
 */
import { describe, it, expect } from 'vitest';

import { Car, CarState } from './Car';
import { GameColor } from '../types';

/** A car mid-errand, with every field a journey touches set to something non-default. */
function movingCar(): Car {
  const car = new Car('house-1', GameColor.Red, { gx: 0, gy: 0 }, 30);
  car.state = CarState.GoingToBusiness;
  car.targetBusinessId = 'biz-1';
  car.destination = { gx: 5, gy: 5 };
  car.hasLoad = true;
  car.onHighway = true;
  car.elevationY = -12;
  car.prevElevationY = -12;
  car.renderAngle = Math.PI;
  car.prevRenderAngle = Math.PI;
  car.unloadTimer = 0.4;
  car.targetGasStationId = 'gs-1';
  car.refuelTimer = 0.2;
  car.postRefuelIntent = 'home';
  car.pixelPos = { x: 200, y: 200 };
  return car;
}

describe('Car', () => {
  it('starts idle with a full tank', () => {
    const car = new Car('house-1', GameColor.Blue, { gx: 1, gy: 1 }, 30);
    expect(car.state).toBe(CarState.Idle);
    expect(car.fuel).toBe(30);
    expect(car.fuelCapacity).toBe(30);
  });

  it('starts at the centre of its home tile', () => {
    const car = new Car('house-1', GameColor.Blue, { gx: 2, gy: 3 }, 30);
    expect(car.pixelPos).toEqual(car.prevPixelPos);
  });

  it('carries no route state of its own', () => {
    // The invariant Task 11 bought: a route is a sequence, so route bookkeeping on the car
    // would be a list. There is none — the world holds the only copy, and every consumer
    // asks `TrafficAdapter` for it.
    const car = new Car('house-1', GameColor.Blue, { gx: 2, gy: 3 }, 30);
    const listFields = Object.entries(car).filter(([, value]) => Array.isArray(value));
    expect(listFields).toEqual([]);
    // By name too, so a field re-declared without an initialiser — still an own key under
    // `useDefineForClassFields` — fails with a legible message rather than on its shape.
    for (const name of ['path', 'outboundPath', 'pathIndex', 'smoothPath']) {
      expect(Object.keys(car)).not.toContain(name);
    }
  });
});

describe('Car.resetToIdle', () => {
  it('clears the state a journey leaves behind', () => {
    const car = movingCar();
    car.resetToIdle({ gx: 2, gy: 2 });

    expect(car.state).toBe(CarState.Idle);
    expect(car.hasLoad).toBe(false);
    expect(car.targetBusinessId).toBeNull();
    expect(car.targetGasStationId).toBeNull();
    expect(car.destination).toBeNull();
    expect(car.onHighway).toBe(false);
    expect(car.elevationY).toBe(0);
    expect(car.prevElevationY).toBe(0);
    expect(car.renderAngle).toBe(0);
    expect(car.prevRenderAngle).toBe(0);
    expect(car.unloadTimer).toBe(0);
    expect(car.refuelTimer).toBe(0);
    expect(car.postRefuelIntent).toBe('business');
  });

  it('moves the car to its home tile centre', () => {
    const car = movingCar();
    car.resetToIdle({ gx: 2, gy: 2 });
    expect(car.pixelPos).toEqual(car.prevPixelPos);
    expect(car.pixelPos.x).not.toBe(200);
  });

  it('keeps the fuel in the tank', () => {
    // A car that reaches home must still visit a gas station.
    const car = movingCar();
    car.fuel = 12;
    car.resetToIdle({ gx: 2, gy: 2 });
    expect(car.fuel).toBe(12);
  });
});
