import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Business } from '../../entities/Business';
import type { House } from '../../entities/House';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { CarRouter } from './CarRouter';
import type { GasStationSystem } from '../GasStationSystem';
import type { CarTuning } from './CarTuning';

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

  /**
   * A car has reached the end of a route it was driving to a gas station.
   *
   * Both ways of failing to find that station strand it, including the one that used to
   * return with the state untouched. `CarSystem` relies on every outcome here being a state
   * a car is no longer driving in — that is what lets it repath blocked cars after arrivals
   * without having to ask which of them arrived — and a bare `return` was the single branch
   * that broke the property. It is not reachable today, since nothing can put a car into
   * `GoingToGasStation` without the same `GasStationSystem` this checks for, but an
   * invariant that holds only by reachability is one a later change silently costs.
   */
  handleGasStationArrival(car: Car): void {
    const station = car.targetGasStationId
      ? this.gasStationSystem?.getGasStationById(car.targetGasStationId)
      : undefined;
    if (!station) {
      car.state = CarState.Stranded;
      return;
    }

    // Car arrived at gas station tile — start refueling directly. It keeps its route, so it
    // keeps blocking the tile it is physically standing on; `CarSystem` parks it.
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
          return;
        }
      }
    }

    // If no path found, strand the car where it stands — still parked on the station tile.
    car.state = CarState.Stranded;
  }
}
