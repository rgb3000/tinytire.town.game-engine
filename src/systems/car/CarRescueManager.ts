import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { PathStep } from '../../highways/types';
import type { CarRouter } from './CarRouter';
import type { TrafficAdapter } from './TrafficAdapter';
import type { GasStationSystem } from '../GasStationSystem';
import type { HighwaySystem } from '../HighwaySystem';
import { computePathFuelCost } from '../../pathfinding/pathCost';
import { CAR_DEBUG } from '../../constants';
import { CarEventLog } from '../../debug/CarEventLog';

export class CarRescueManager {
  private pathfinder: Pathfinder;
  private adapter: TrafficAdapter;
  private router: CarRouter;
  private gasStationSystem: GasStationSystem | null;
  private highwaySystem: HighwaySystem | null;
  private elapsedTime = 0;

  setElapsedTime(t: number): void { this.elapsedTime = t; }

  constructor(
    pathfinder: Pathfinder, adapter: TrafficAdapter, router: CarRouter,
    gasStationSystem?: GasStationSystem, highwaySystem?: HighwaySystem,
  ) {
    this.pathfinder = pathfinder;
    this.adapter = adapter;
    this.router = router;
    this.gasStationSystem = gasStationSystem ?? null;
    this.highwaySystem = highwaySystem ?? null;
  }

  rescueStrandedCars(cars: Car[], houseMap: Map<string, House>): void {
    for (const car of cars) {
      if (car.state === CarState.Unloading || car.state === CarState.Refueling) continue;
      if (car.state !== CarState.Stranded) continue;

      const currentTile = this.router.getCarCurrentTile(car);
      const home = houseMap.get(car.homeHouseId);

      // Try to find a path to the car's destination or home
      let rescuePath: PathStep[] | null = null;
      let rescueState: CarState = CarState.Stranded;

      if (car.destination) {
        const path = this.pathfinder.findPath(currentTile, car.destination);
        if (path) {
          rescuePath = path;
          rescueState = home && car.destination.gx === home.pos.gx && car.destination.gy === home.pos.gy
            ? CarState.GoingHome
            : CarState.GoingToBusiness;
        }
      }

      if (!rescuePath && home) {
        const homePath = this.pathfinder.findPath(currentTile, home.pos, true);
        if (homePath) {
          rescuePath = homePath;
          rescueState = CarState.GoingHome;
          car.targetBusinessId = null;
          car.destination = home.pos;
        }
      }

      // Check if the car has enough fuel for the rescue path
      if (rescuePath) {
        const fuelCost = computePathFuelCost(rescuePath, this.highwaySystem);
        // Enough fuel, and a route the simulation will accept — the state change is
        // conditional on the second, or the car drives away on the route it stranded on.
        if (fuelCost <= car.fuel && this.router.reassignPath(car, rescuePath)) {
          if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'rescued', message: `rescued with pathLen=${rescuePath.length}, state→${rescueState}` });
          car.state = rescueState;
          continue;
        }
        // Not enough fuel — fall through to gas station routing
      }

      // Car needs fuel (no path found, or not enough fuel for path) — try gas station
      if (this.gasStationSystem) {
        const result = this.gasStationSystem.findNearestReachable(currentTile, this.pathfinder, this.highwaySystem);
        if (result) {
          const stationPath = this.pathfinder.findPath(currentTile, result.station.pos);
          if (stationPath && this.router.reassignPath(car, stationPath)) {
            car.state = CarState.GoingToGasStation;
            car.targetGasStationId = result.station.id;
            car.postRefuelIntent = car.targetBusinessId ? 'business' : 'home';
            if (!car.targetBusinessId && home) car.destination = home.pos;
            continue;
          }
        }
      }

      // No rescue possible — car stays stranded
    }
  }

  /**
   * Send any car whose remaining road is about to disappear looking for another way.
   *
   * A homebound car is deliberately exempt. Pending deletion exists *for* it: the cell stays
   * on the board until it has passed, and rerouting it would only move it onto road the
   * player has not asked to remove. That asymmetry used to be a `break` out of a scan over
   * `car.path`; the scan now asks the simulation, which holds the only record of where the
   * car is and what is left of its journey.
   */
  rerouteActiveCars(cars: Car[], houseMap: Map<string, House>): void {
    for (const car of cars) {
      if (car.state !== CarState.GoingToBusiness && car.state !== CarState.GoingToGasStation) continue;
      if (car.onHighway) continue;
      if (!this.adapter.crossesPendingDeletionAhead(car)) continue;

      if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-pending', message: `route crosses pending deletion, triggering reroute` });
      this.router.rerouteCar(car, houseMap);
    }
  }
}
