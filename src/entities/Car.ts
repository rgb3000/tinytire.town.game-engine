import type { GameColor, GridPos, PixelPos } from '../types';
import { generateId, gridToPixelCenter } from '../utils/math';

export const CarState = {
  Idle: 0,
  GoingToBusiness: 1,
  GoingHome: 2,
  Stranded: 3,
  Unloading: 4,
  GoingToGasStation: 8,
  Refueling: 9,
} as const;
export type CarState = (typeof CarState)[keyof typeof CarState];

/**
 * A car as the rest of the game sees it: who it belongs to, what it is doing and where it
 * is being drawn.
 *
 * Deliberately *not* here: the route, the progress along it and every derived quantity —
 * lane geometry, arc distance, speed, leader, junction timers. Those live in the traffic
 * world (`src/traffic/`), keyed by vehicle, and `TrafficAdapter` is the only thing that
 * reads or writes them. Holding a second copy on the car is what let position, route and
 * dependency answers drift apart from each other; there is now one representation and the
 * car is a mirror of it, refreshed by `TrafficAdapter.writeBack`.
 */
export class Car {
  readonly id: string;
  readonly color: GameColor;
  readonly homeHouseId: string;
  state: CarState = CarState.Idle;
  targetBusinessId: string | null = null;
  destination: GridPos | null = null;
  renderAngle = 0;      // radians: 0=Right, PI/2=Down, PI=Left, -PI/2=Up
  prevRenderAngle = 0;  // previous frame's angle for render interpolation

  // Highway state
  onHighway = false;
  elevationY = 0;
  prevElevationY = 0;

  // Unloading
  unloadTimer = 0;

  // Cargo
  hasLoad = false;

  // Fuel
  fuel: number;
  /**
   * This car's full tank, in the tile-units `computePathFuelCost` measures — i.e. its range.
   *
   * Carried on the car rather than read from the module constant so that the fuel gauge
   * (`CarRouteLayer`), the debug sidebar and the refuel target cannot disagree with the
   * map's `FUEL_CAPACITY`. They used to divide simulated fuel by the *module* capacity, so
   * a map that lowered it rendered a full tank as a half-empty amber arc.
   */
  readonly fuelCapacity: number;
  targetGasStationId: string | null = null;
  refuelTimer = 0;
  postRefuelIntent: 'business' | 'home' = 'business';

  // Rendering interpolation
  pixelPos: PixelPos;
  prevPixelPos: PixelPos;

  constructor(homeHouseId: string, color: GameColor, startPos: GridPos, fuelCapacity: number) {
    this.id = generateId();
    this.color = color;
    this.homeHouseId = homeHouseId;
    this.fuelCapacity = fuelCapacity;
    this.fuel = fuelCapacity;
    const center = gridToPixelCenter(startPos);
    this.pixelPos = { ...center };
    this.prevPixelPos = { ...center };
  }

  /**
   * Reset all driving state back to idle defaults.
   *
   * Deliberately does *not* touch `fuel` — a car that reaches home keeps whatever is left
   * in the tank and must still visit a gas station.
   *
   * Route state is no longer reset here: it lives in the traffic world, and
   * `TrafficAdapter.removeVehicle` is what clears it. This method used to have a
   * `clearPathState` sibling precisely because route bookkeeping was scattered across the
   * car; there is nothing left to scatter.
   */
  resetToIdle(homePos: GridPos): void {
    this.state = CarState.Idle;
    this.targetBusinessId = null;
    this.destination = null;
    this.renderAngle = 0;
    this.prevRenderAngle = 0;
    this.onHighway = false;
    this.elevationY = 0;
    this.prevElevationY = 0;
    this.unloadTimer = 0;
    this.hasLoad = false;
    this.targetGasStationId = null;
    this.refuelTimer = 0;
    this.postRefuelIntent = 'business';

    const center = gridToPixelCenter(homePos);
    this.pixelPos = { ...center };
    this.prevPixelPos = { ...center };
  }
}
