import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Business } from '../../entities/Business';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { CarRouter } from './CarRouter';
import { stepGridPos } from './CarRouter';
import type { PendingDeletionSystem } from '../PendingDeletionSystem';
import type { GasStationSystem } from '../GasStationSystem';
import type { HighwaySystem } from '../HighwaySystem';
import type { CarTuning } from './CarTuning';
import { computePathFuelCost } from '../../pathfinding/pathCost';
import { getDirection, directionAngle } from '../../utils/direction';

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

    // Car arrived at connector cell — start unloading
    car.outboundPath = [...car.path];
    car.path = [];
    car.pathIndex = 0;
    car.segmentProgress = 0;
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
      car.state = CarState.Stranded;
      car.outboundPath = [];
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
          car.outboundPath = [];
          car.targetGasStationId = result.station.id;
          car.postRefuelIntent = 'home';
          car.destination = result.station.pos;
          this.router.assignPath(car, stationPath);
          this.snapCarToSmoothStart(car, stationPath);
          return;
        }
      }
    }

    car.state = CarState.GoingHome;
    car.outboundPath = [];
    car.targetBusinessId = null;
    car.destination = home.pos;
    this.router.assignPath(car, homePath);

    // Notify pending deletion system
    const gridPath = homePath.filter(s => s.kind === 'grid').map(s => (s as { pos: import('../../types').GridPos }).pos);
    this.pendingDeletionSystem.notifyCarTransitionedHome(car.id, gridPath);

    this.snapCarToSmoothStart(car, homePath);
  }

  private snapCarToSmoothStart(car: Car, path: import('../../highways/types').PathStep[]): void {
    if (car.smoothPath.length >= 2) {
      car.pixelPos.x = car.smoothPath[0].x;
      car.pixelPos.y = car.smoothPath[0].y;
      car.prevPixelPos.x = car.pixelPos.x;
      car.prevPixelPos.y = car.pixelPos.y;
      if (path.length >= 2) {
        const p0 = stepGridPos(path[0]);
        const p1 = stepGridPos(path[1]);
        const initDir = getDirection(p0, p1);
        car.renderAngle = directionAngle(initDir);
        car.prevRenderAngle = car.renderAngle;
      }
    }
  }
}
