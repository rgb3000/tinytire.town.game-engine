import type { House } from '../entities/House';
import type { Business } from '../entities/Business';
import { Car, CarState } from '../entities/Car';
import type { Pathfinder } from '../pathfinding/Pathfinder';
import type { Grid } from '../core/Grid';
import { CAR_DEBUG } from '../constants';
import type { CarTuning } from './car/CarTuning';
import { CarEventLog } from '../debug/CarEventLog';
import { CarRouter } from './car/CarRouter';
import { CarTrafficManager } from './car/CarTrafficManager';
import { CarParkingManager } from './car/CarParkingManager';
import { CarDispatcher } from './car/CarDispatcher';
import { CarMovement } from './car/CarMovement';
import { CarLeaderIndex } from './car/CarLeaderIndex';
import { CarRefuelingManager } from './car/CarRefuelingManager';
import { CarRescueManager } from './car/CarRescueManager';
import type { PendingDeletionSystem } from './PendingDeletionSystem';
import type { HighwaySystem } from './HighwaySystem';
import type { GasStationSystem } from './GasStationSystem';

export class CarSystem {
  private cars: Car[] = [];
  private score = 0;
  onHomeReturn: (() => void) | null = null;
  onStranded: (() => void) | null = null;

  private router: CarRouter;
  private trafficManager: CarTrafficManager;
  private parkingManager: CarParkingManager;
  private dispatcher: CarDispatcher;
  private movement: CarMovement;
  private leaderIndex: CarLeaderIndex;
  private refuelingManager: CarRefuelingManager;
  private rescueManager: CarRescueManager;

  private _rescueTimer = 0;
  private static readonly RESCUE_INTERVAL = 1; // seconds

  // Reusable collections
  private _businessMap = new Map<string, Business>();
  private _houseMap = new Map<string, House>();

  private cfg: CarTuning;

  /**
   * `cfg` fans out from here: this is the one place that holds the whole {@link CarTuning}
   * slice, and each sub-manager receives only the keys it observes.
   */
  constructor(pathfinder: Pathfinder, grid: Grid, pendingDeletionSystem: PendingDeletionSystem, cfg: CarTuning, highwaySystem?: HighwaySystem, gasStationSystem?: GasStationSystem) {
    this.cfg = cfg;
    this.router = new CarRouter(pathfinder, grid, gasStationSystem);
    this.trafficManager = new CarTrafficManager(grid, cfg);
    this.dispatcher = new CarDispatcher(pathfinder, this.router, gasStationSystem, highwaySystem);
    this.parkingManager = new CarParkingManager(pathfinder, this.router, pendingDeletionSystem, cfg, gasStationSystem, highwaySystem);
    this.movement = new CarMovement(grid, this.trafficManager, this.router, pendingDeletionSystem, cfg, highwaySystem);
    this.leaderIndex = new CarLeaderIndex();
    this.refuelingManager = new CarRefuelingManager(pathfinder, this.router, cfg, gasStationSystem);
    this.rescueManager = new CarRescueManager(pathfinder, grid, this.router, gasStationSystem, highwaySystem);
  }

  getCars(): Car[] {
    return this.cars;
  }

  getScore(): number {
    return this.score;
  }

  setElapsedTime(t: number): void {
    this.router.setElapsedTime(t);
    this.movement.setElapsedTime(t);
    this.rescueManager.setElapsedTime(t);
  }

  /** Create cars for a newly spawned house and register them permanently. */
  registerHouse(house: House): void {
    for (let i = 0; i < this.cfg.CARS_PER_HOUSE; i++) {
      const car = new Car(house.id, house.color, house.pos, this.cfg.FUEL_CAPACITY);
      house.carIds.push(car.id);
      this.cars.push(car);
    }
  }

  update(dt: number, houses: House[], businesses: Business[]): void {
    // Build house lookup map
    const houseMap = this._houseMap;
    houseMap.clear();
    for (const h of houses) houseMap.set(h.id, h);

    // Build occupancy map before dispatch so spawning checks for existing traffic
    const occupied = this.trafficManager.buildOccupancyMap(this.cars);
    this.dispatcher.dispatch(this.cars, houses, businesses, occupied);

    this.moveCars(dt, houses, businesses, occupied, houseMap);

    // Periodically attempt to rescue stranded cars
    this._rescueTimer += dt;
    if (this._rescueTimer >= CarSystem.RESCUE_INTERVAL) {
      this._rescueTimer = 0;
      if (this.cars.some(c => c.state === CarState.Stranded)) {
        this.withStrandedDetection(() => {
          this.rescueManager.rescueStrandedCars(this.cars, houseMap);
        });
      }
    }
  }

  onRoadsChanged(houses: House[]): void {
    // Build house map for O(1) lookups
    const houseMap = this._houseMap;
    houseMap.clear();
    for (const h of houses) houseMap.set(h.id, h);

    this.withStrandedDetection(() => {
      this.rescueManager.rescueStrandedCars(this.cars, houseMap);
      this.rescueManager.rerouteActiveCars(this.cars, houseMap);
    });
  }

  private _prevStranded = new Set<string>();

  /**
   * Run `fn`, then fire {@link onStranded} once if it left any car newly stranded.
   *
   * "Newly" is the whole point: a car that was already stranded before `fn` ran must not
   * re-alert, or a permanently cut-off car would buzz once a second forever. This was
   * written out three times — around the periodic rescue, around a road change, and around
   * movement — and only the movement copy logged the transition.
   *
   * Reuses one pooled set rather than allocating, because the movement path runs every
   * frame. That is safe only while these calls stay strictly sequential: **do not nest
   * them**, or the inner call will clear the outer call's snapshot.
   */
  private withStrandedDetection(fn: () => void): void {
    if (!this.onStranded) {
      fn();
      return;
    }

    const prevStranded = this._prevStranded;
    prevStranded.clear();
    for (const car of this.cars) {
      if (car.state === CarState.Stranded) prevStranded.add(car.id);
    }

    fn();

    for (const car of this.cars) {
      if (car.state === CarState.Stranded && !prevStranded.has(car.id)) {
        if (CAR_DEBUG) CarEventLog.log({ time: 0, carId: car.id, type: 'stranded-new', message: 'became stranded' });
        this.onStranded();
        break;
      }
    }
  }

  private moveCars(dt: number, houses: House[], businesses: Business[], occupied: Map<number, string>, houseMap: Map<string, House>): void {
    this.trafficManager.advanceFrameTime(dt);

    const bizMap = this._businessMap;
    bizMap.clear();
    for (const biz of businesses) {
      bizMap.set(biz.id, biz);
    }
    const intersectionMap = this.trafficManager.buildIntersectionMap(this.cars);

    // Build leader index and find leader for each car
    this.leaderIndex.rebuild(this.cars);
    for (const car of this.cars) {
      this.leaderIndex.findLeader(car);
    }

    this.withStrandedDetection(() => {
      for (const car of this.cars) {
        if (car.state === CarState.Idle || car.state === CarState.Stranded) continue;
        if (car.state === CarState.Refueling) {
          this.refuelingManager.updateRefuelingCar(car, dt, bizMap, houseMap);
          continue;
        }
        if (car.state === CarState.Unloading) {
          this.parkingManager.updateUnloadingCar(car, dt, bizMap, houseMap, () => {
            this.score++;
          });
          continue;
        }
        this.movement.updateSingleCar(
          car, dt, houses, bizMap, occupied, intersectionMap,
          (c, h, bm) => this.handleArrival(c, h, bm, houseMap),
          houseMap,
        );
      }
    });
  }

  private handleArrival(car: Car, _houses: House[], bizMap: Map<string, Business>, houseMap: Map<string, House>): void {
    if (car.state === CarState.GoingToGasStation) {
      this.refuelingManager.handleGasStationArrival(car);
      return;
    }
    if (car.state === CarState.GoingToBusiness) {
      this.parkingManager.handleBusinessArrival(car, houseMap, bizMap);
    } else if (car.state === CarState.GoingHome) {
      const home = houseMap.get(car.homeHouseId);
      if (home) {
        if (car.hasLoad) home.deliveryCount++;
        if (CAR_DEBUG) CarEventLog.log({ time: 0, carId: car.id, type: 'home-arrival', message: `returned home, hasLoad=${car.hasLoad}` });
        car.resetToIdle(home.pos);
      } else {
        // Home is gone — strand the car
        if (CAR_DEBUG) CarEventLog.log({ time: 0, carId: car.id, type: 'stranded-new', message: 'home house gone' });
        car.state = CarState.Stranded;
      }
      this.onHomeReturn?.();
    }
  }
}
