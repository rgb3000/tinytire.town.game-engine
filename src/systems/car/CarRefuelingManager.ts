import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Business } from '../../entities/Business';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { CarRouter } from './CarRouter';
import { stepGridPos } from './CarRouter';
import type { GasStationSystem } from '../GasStationSystem';
import type { CarTuning } from './CarTuning';
import { getDirection, directionAngle } from '../../utils/direction';

export class CarRefuelingManager {
  private pathfinder: Pathfinder;
  private router: CarRouter;
  private gasStationSystem: GasStationSystem | null;
  private cfg: Pick<CarTuning, 'REFUEL_TIME'>;

  constructor(pathfinder: Pathfinder, router: CarRouter, cfg: Pick<CarTuning, 'REFUEL_TIME'>, gasStationSystem?: GasStationSystem) {
    this.pathfinder = pathfinder;
    this.router = router;
    this.cfg = cfg;
    this.gasStationSystem = gasStationSystem ?? null;
  }

  handleGasStationArrival(car: Car): void {
    if (!this.gasStationSystem) return;
    const station = car.targetGasStationId ? this.gasStationSystem.getGasStationById(car.targetGasStationId) : undefined;
    if (!station) {
      car.state = CarState.Stranded;
      return;
    }

    // Car arrived at gas station tile — start refueling directly
    car.path = [];
    car.pathIndex = 0;
    car.segmentProgress = 0;
    car.smoothPath = [];
    car.smoothCumDist = [];
    car.smoothCellDist = [];
    car.state = CarState.Refueling;
    car.refuelTimer = 0;
  }

  updateRefuelingCar(
    car: Car, dt: number,
    bizMap: Map<string, Business>,
    houseMap: Map<string, House>,
  ): void {
    car.refuelTimer += dt;
    if (car.refuelTimer < this.cfg.REFUEL_TIME) return;

    // Refueling complete
    car.fuel = car.fuelCapacity;
    car.refuelTimer = 0;

    // Route to next destination directly (no WaitingToExit or ParkingOut)
    this.routeAfterGasStation(car, bizMap, houseMap);
  }

  /** Route car after refueling — to business or home. */
  routeAfterGasStation(
    car: Car,
    bizMap: Map<string, Business>,
    houseMap: Map<string, House>,
  ): void {
    if (!this.gasStationSystem) {
      car.state = CarState.Stranded;
      return;
    }

    const station = car.targetGasStationId ? this.gasStationSystem.getGasStationById(car.targetGasStationId) : undefined;
    const startPos = station?.pos;
    car.targetGasStationId = null;

    if (car.postRefuelIntent === 'business') {
      // Find highest-demand business of matching color
      let bestBiz: Business | null = null;
      let bestDemand = 0;
      for (const [, biz] of bizMap) {
        if (biz.color === car.color && biz.demandPins > bestDemand) {
          bestDemand = biz.demandPins;
          bestBiz = biz;
        }
      }

      if (bestBiz && startPos) {
        const path = this.pathfinder.findPath(startPos, bestBiz.connectorPos);
        if (path && path.length >= 2) {
          car.state = CarState.GoingToBusiness;
          car.targetBusinessId = bestBiz.id;
          car.destination = bestBiz.connectorPos;
          this.router.assignPath(car, path);
          this.snapCarToSmoothStart(car, path);
          return;
        }
      }
    } else {
      // Going home
      const home = houseMap.get(car.homeHouseId);
      if (home && startPos) {
        const homePath = this.pathfinder.findPath(startPos, home.pos, true);
        if (homePath && homePath.length >= 2) {
          car.state = CarState.GoingHome;
          car.targetBusinessId = null;
          car.destination = home.pos;
          this.router.assignPath(car, homePath);
          this.snapCarToSmoothStart(car, homePath);
          return;
        }
      }
    }

    // If no path found, strand the car
    car.state = CarState.Stranded;
    car.path = [];
    car.pathIndex = 0;
    car.segmentProgress = 0;
    car.smoothPath = [];
    car.smoothCumDist = [];
    car.smoothCellDist = [];
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
