import type { House } from '../../entities/House';
import type { Business } from '../../entities/Business';
import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { CarRouter } from './CarRouter';
import { manhattanDist, gridToPixelCenter } from '../../utils/math';
import { computePathFuelCost } from '../../pathfinding/pathCost';
import type { GasStationSystem } from '../GasStationSystem';
import type { HighwaySystem } from '../HighwaySystem';
import type { TrafficAdapter } from './TrafficAdapter';
import { CAR_DEBUG } from '../../constants';
import { CarEventLog } from '../../debug/CarEventLog';

const DISPATCH_INTERVAL = 10; // only dispatch every N ticks (~6 Hz)

export class CarDispatcher {
  private pathfinder: Pathfinder;
  private router: CarRouter;
  private _carsEnRoute = new Map<string, number>();
  private _tickCounter = 0;

  private adapter: TrafficAdapter;
  private gasStationSystem: GasStationSystem | null;
  private highwaySystem: HighwaySystem | null;

  constructor(pathfinder: Pathfinder, router: CarRouter, adapter: TrafficAdapter, gasStationSystem?: GasStationSystem, highwaySystem?: HighwaySystem) {
    this.pathfinder = pathfinder;
    this.router = router;
    this.adapter = adapter;
    this.gasStationSystem = gasStationSystem ?? null;
    this.highwaySystem = highwaySystem ?? null;
  }

  dispatch(cars: Car[], houses: House[], businesses: Business[]): void {
    if (++this._tickCounter < DISPATCH_INTERVAL) return;
    this._tickCounter = 0;

    const demandBusinesses = businesses.filter(b => b.demandPins > 0)
      .sort((a, b) => b.demandPins - a.demandPins);
    if (demandBusinesses.length === 0) return;

    const carsEnRoute = this._carsEnRoute;
    carsEnRoute.clear();
    for (const car of cars) {
      if (car.targetBusinessId && (
        car.state === CarState.GoingToBusiness ||
        car.state === CarState.Unloading ||
        (car.state === CarState.GoingToGasStation && car.postRefuelIntent === 'business')
      )) {
        carsEnRoute.set(car.targetBusinessId, (carsEnRoute.get(car.targetBusinessId) ?? 0) + 1);
      }
    }

    // Build index of idle cars per house
    const idleByHouse = new Map<string, Car[]>();
    for (const car of cars) {
      if (car.state === CarState.Idle) {
        let list = idleByHouse.get(car.homeHouseId);
        if (!list) {
          list = [];
          idleByHouse.set(car.homeHouseId, list);
        }
        list.push(car);
      }
    }

    for (const biz of demandBusinesses) {
      const enRouteCount = carsEnRoute.get(biz.id) ?? 0;
      const neededCars = biz.demandPins - enRouteCount;
      if (neededCars <= 0) continue;

      const availableHouses = houses
        .filter(h => h.color === biz.color && (idleByHouse.get(h.id)?.length ?? 0) > 0)
        .sort((a, b) => manhattanDist(a.pos, biz.connectorPos) - manhattanDist(b.pos, biz.connectorPos));

      let dispatched = 0;
      for (const house of availableHouses) {
        if (dispatched >= neededCars) break;

        const idleCars = idleByHouse.get(house.id);
        if (!idleCars || idleCars.length === 0) continue;

        const path = this.pathfinder.findPath(house.pos, biz.connectorPos);
        if (!path || path.length < 2) continue;

        // Do not spawn a car inside one that is already there. Asked of the simulation,
        // which is the only thing that knows where cars are between `writeBack`s, and
        // asked in world space along the new route's opening — a cell-keyed test misses a
        // body straddling the cell boundary. See {@link TrafficAdapter.spawnBlocked}.
        if (this.adapter.spawnBlocked(path)) continue;

        // Pop an idle car from the house's idle list
        const car = idleCars.pop()!;

        // Set pixel position to house location
        const houseCenter = gridToPixelCenter(house.pos);
        car.pixelPos.x = houseCenter.x;
        car.pixelPos.y = houseCenter.y;
        car.prevPixelPos.x = houseCenter.x;
        car.prevPixelPos.y = houseCenter.y;

        // Check if car has enough fuel for the trip
        const fuelCost = computePathFuelCost(path, this.highwaySystem);

        if (fuelCost > car.fuel && this.gasStationSystem) {
          // Need to refuel first — find nearest gas station
          const result = this.gasStationSystem.findNearestReachable(house.pos, this.pathfinder, this.highwaySystem);
          if (result) {
            const stationPath = this.pathfinder.findPath(house.pos, result.station.pos);
            if (stationPath && stationPath.length >= 2) {
              car.state = CarState.GoingToGasStation;
              car.targetBusinessId = biz.id;
              car.targetGasStationId = result.station.id;
              car.postRefuelIntent = 'business';
              car.destination = result.station.pos;
              this.router.assignPath(car, stationPath);
            } else {
              // No path to gas station — dispatch anyway; car will strand when fuel runs out
              car.state = CarState.GoingToBusiness;
              car.targetBusinessId = biz.id;
              car.destination = biz.connectorPos;
              this.router.assignPath(car, path);
            }
          } else {
            // No gas station reachable — dispatch anyway; car will strand when fuel runs out
            car.state = CarState.GoingToBusiness;
            car.targetBusinessId = biz.id;
            car.destination = biz.connectorPos;
            this.router.assignPath(car, path);
          }
        } else {
          car.state = CarState.GoingToBusiness;
          car.targetBusinessId = biz.id;
          car.destination = biz.connectorPos;
          this.router.assignPath(car, path);
        }

        if (CAR_DEBUG) CarEventLog.log({ time: 0, carId: car.id, type: 'dispatched', message: `to biz ${biz.id.slice(0, 6)} (${biz.color}), state=${car.state === CarState.GoingToGasStation ? 'GoingToGas' : 'GoingToBiz'}` });

        carsEnRoute.set(biz.id, (carsEnRoute.get(biz.id) ?? 0) + 1);
        dispatched++;
      }
    }
  }
}
