import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { Grid } from '../../core/Grid';
import type { CarRouter } from './CarRouter';
import type { GasStationSystem } from '../GasStationSystem';
import type { HighwaySystem } from '../HighwaySystem';
import { computePathFuelCost } from '../../pathfinding/pathCost';
import { CAR_DEBUG } from '../../constants';
import { CarEventLog } from '../../debug/CarEventLog';

export class CarRescueManager {
  private pathfinder: Pathfinder;
  private grid: Grid;
  private router: CarRouter;
  private gasStationSystem: GasStationSystem | null;
  private highwaySystem: HighwaySystem | null;
  private elapsedTime = 0;

  setElapsedTime(t: number): void { this.elapsedTime = t; }

  constructor(
    pathfinder: Pathfinder, grid: Grid, router: CarRouter,
    gasStationSystem?: GasStationSystem, highwaySystem?: HighwaySystem,
  ) {
    this.pathfinder = pathfinder;
    this.grid = grid;
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
      let rescuePath: typeof car.path | null = null;
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
        if (fuelCost <= car.fuel) {
          // Enough fuel — send car on its way
          if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'rescued', message: `rescued with pathLen=${rescuePath.length}, state→${rescueState}` });
          car.state = rescueState;
          this.router.reassignPath(car, rescuePath);
          continue;
        }
        // Not enough fuel — fall through to gas station routing
      }

      // Car needs fuel (no path found, or not enough fuel for path) — try gas station
      if (this.gasStationSystem) {
        const result = this.gasStationSystem.findNearestReachable(currentTile, this.pathfinder, this.highwaySystem);
        if (result) {
          const stationPath = this.pathfinder.findPath(currentTile, result.station.pos);
          if (stationPath) {
            car.state = CarState.GoingToGasStation;
            car.targetGasStationId = result.station.id;
            car.postRefuelIntent = car.targetBusinessId ? 'business' : 'home';
            if (!car.targetBusinessId && home) car.destination = home.pos;
            this.router.reassignPath(car, stationPath);
            continue;
          }
        }
      }

      // No rescue possible — car stays stranded
    }
  }

  rerouteActiveCars(cars: Car[], houseMap: Map<string, House>): void {
    for (const car of cars) {
      if (car.path.length === 0) continue;
      if (car.state !== CarState.GoingToBusiness && car.state !== CarState.GoingHome && car.state !== CarState.GoingToGasStation) continue;
      if (car.onHighway) continue;

      let crossesPending = false;
      for (let i = car.pathIndex; i < car.path.length; i++) {
        const step = car.path[i];
        if (step.kind !== 'grid') continue;
        const c = this.grid.getCell(step.pos.gx, step.pos.gy);
        if (c?.pendingDeletion) {
          if (car.state === CarState.GoingHome) { crossesPending = false; break; }
          crossesPending = true;
          break;
        }
      }
      if (crossesPending) {
        if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-pending', message: `path crosses pending deletion, triggering reroute` });
        this.router.rerouteCar(car, houseMap);
      }
    }
  }
}
