import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Business } from '../../entities/Business';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { CarRouter } from './CarRouter';
import type { PendingDeletionSystem } from '../PendingDeletionSystem';
import type { GasStationSystem } from '../GasStationSystem';
import type { HighwaySystem } from '../HighwaySystem';
import type { CarTuning } from './CarTuning';
import { computePathFuelCost } from '../../pathfinding/pathCost';

export class CarParkingManager {
  private pathfinder: Pathfinder;
  private router: CarRouter;
  private pendingDeletionSystem: PendingDeletionSystem;
  private gasStationSystem: GasStationSystem | null;
  private highwaySystem: HighwaySystem | null;
  private cfg: Pick<CarTuning, 'UNLOAD_TIME'>;

  constructor(pathfinder: Pathfinder, router: CarRouter, pendingDeletionSystem: PendingDeletionSystem, cfg: Pick<CarTuning, 'UNLOAD_TIME'>, gasStationSystem?: GasStationSystem, highwaySystem?: HighwaySystem) {
    this.pathfinder = pathfinder;
    this.router = router;
    this.pendingDeletionSystem = pendingDeletionSystem;
    this.cfg = cfg;
    this.gasStationSystem = gasStationSystem ?? null;
    this.highwaySystem = highwaySystem ?? null;
  }

  updateUnloadingCar(
    car: Car, dt: number,
    bizMap: Map<string, Business>,
    houseMap: Map<string, House>,
    onScore: () => void,
  ): void {
    car.unloadTimer += dt;
    if (car.unloadTimer < this.cfg.UNLOAD_TIME) return;

    const biz = car.targetBusinessId ? bizMap.get(car.targetBusinessId) : undefined;
    if (biz && biz.demandPins > 0) {
      biz.demandPins--;
      onScore();
    }
    car.hasLoad = true;
    car.unloadTimer = 0;

    // Route home directly (or via gas station if low fuel)
    this.routeHomeFromBusiness(car, biz, houseMap);
  }

  handleBusinessArrival(
    car: Car, houseMap: Map<string, House>, bizMap: Map<string, Business>,
  ): void {
    const biz = car.targetBusinessId ? bizMap.get(car.targetBusinessId) : undefined;
    if (!biz) {
      const home = houseMap.get(car.homeHouseId);
      if (home) { car.resetToIdle(home.pos); } else { car.state = CarState.Stranded; }
      return;
    }

    // Car arrived at connector cell — start unloading. It keeps its route rather than
    // clearing it: a car sitting on a connector is physically there and still blocks the
    // road, and the route is what `carDependsOnCell` reads to protect the road under it.
    // `outboundPath` was the old copy of the path kept for exactly that reservation.
    // Parking is `CarSystem`'s to do, in one place, for every arrival.
    car.state = CarState.Unloading;
    car.unloadTimer = 0;
  }

  private routeHomeFromBusiness(car: Car, biz: Business | undefined, houseMap: Map<string, House>): void {
    const home = houseMap.get(car.homeHouseId);
    if (!home) {
      car.state = CarState.Stranded;
      return;
    }

    const startPos = biz ? biz.connectorPos : (car.destination ?? home.pos);
    const homePath = this.pathfinder.findPath(startPos, home.pos, true);

    if (!homePath) {
      // Stays parked, which it already is: it is still sitting on the connector.
      car.state = CarState.Stranded;
      car.targetBusinessId = null;
      return;
    }

    // Check fuel before going home
    const fuelCost = computePathFuelCost(homePath, this.highwaySystem);
    if (fuelCost > car.fuel && this.gasStationSystem) {
      const result = this.gasStationSystem.findNearestReachable(startPos, this.pathfinder, this.highwaySystem);
      if (result) {
        const stationPath = this.pathfinder.findPath(startPos, result.station.pos);
        if (stationPath && stationPath.length >= 2) {
          car.state = CarState.GoingToGasStation;
          car.targetGasStationId = result.station.id;
          car.postRefuelIntent = 'home';
          car.destination = result.station.pos;
          this.router.assignPath(car, stationPath);
          return;
        }
      }
    }

    car.state = CarState.GoingHome;
    car.targetBusinessId = null;
    car.destination = home.pos;
    this.router.assignPath(car, homePath);

    // Notify pending deletion system
    const gridPath = homePath.filter(s => s.kind === 'grid').map(s => (s as { pos: import('../../types').GridPos }).pos);
    this.pendingDeletionSystem.notifyCarTransitionedHome(car.id, gridPath);
  }
}
