import type { House } from '../entities/House';
import type { Business } from '../entities/Business';
import { Car, CarState } from '../entities/Car';
import type { Pathfinder } from '../pathfinding/Pathfinder';
import type { Grid } from '../core/Grid';
import { CAR_DEBUG, TILE_SIZE } from '../constants';
import type { CarTuning } from './car/CarTuning';
import { CarEventLog } from '../debug/CarEventLog';
import { CarRouter } from './car/CarRouter';
import { CarParkingManager } from './car/CarParkingManager';
import { CarDispatcher } from './car/CarDispatcher';
import { CarRefuelingManager } from './car/CarRefuelingManager';
import { CarRescueManager } from './car/CarRescueManager';
import { TrafficAdapter } from './car/TrafficAdapter';
import { TrafficEventKind } from '../traffic';
import type { PendingDeletionSystem } from './PendingDeletionSystem';
import type { HighwaySystem } from './HighwaySystem';
import type { GasStationSystem } from './GasStationSystem';

/**
 * The game half of the car simulation.
 *
 * Everything about *where a car is* now lives in `src/traffic/`, reached through
 * {@link TrafficAdapter}. What stays here is everything the simulation must not learn:
 * fuel, score, which building a car is going to, and what "arrived" means.
 *
 * The tick has a fixed shape, and each part of it is load-bearing:
 *
 * 1. **Dispatch**, before anything moves, so a car spawned this frame is simulated this
 *    frame rather than standing still for one.
 * 2. **One `adapter.update(dt)`**, before anything reads a position. The simulation rebuilds
 *    its lane index once per call; asking it per vehicle would be quadratic.
 * 3. **One pass over the cars**, for the game rules that follow from how far each moved.
 * 4. **Arrivals last.** `handleArrival` may reset a car to idle or install a new route, and
 *    doing that inside step 3 would have the fuel deduction bill a car for a route it had
 *    already left.
 */
export class CarSystem {
  private cars: Car[] = [];
  private carsById = new Map<string, Car>();
  private score = 0;
  onHomeReturn: (() => void) | null = null;
  onStranded: (() => void) | null = null;

  private adapter: TrafficAdapter;
  private router: CarRouter;
  private parkingManager: CarParkingManager;
  private dispatcher: CarDispatcher;
  private refuelingManager: CarRefuelingManager;
  private rescueManager: CarRescueManager;
  private pendingDeletionSystem: PendingDeletionSystem;

  private _rescueTimer = 0;
  private static readonly RESCUE_INTERVAL = 1; // seconds

  // Reusable collections
  private _businessMap = new Map<string, Business>();
  private _houseMap = new Map<string, House>();
  private _arrivedThisTick = new Set<string>();

  private cfg: CarTuning;

  /**
   * `cfg` fans out from here: this is the one place that holds the whole {@link CarTuning}
   * slice, and each sub-manager receives only the keys it observes.
   */
  constructor(pathfinder: Pathfinder, grid: Grid, pendingDeletionSystem: PendingDeletionSystem, cfg: CarTuning, highwaySystem?: HighwaySystem, gasStationSystem?: GasStationSystem) {
    this.cfg = cfg;
    this.pendingDeletionSystem = pendingDeletionSystem;
    this.adapter = new TrafficAdapter(grid, cfg, highwaySystem);
    this.router = new CarRouter(pathfinder, grid, this.adapter, gasStationSystem);
    this.dispatcher = new CarDispatcher(pathfinder, this.router, this.adapter, gasStationSystem, highwaySystem);
    this.parkingManager = new CarParkingManager(pathfinder, this.router, pendingDeletionSystem, cfg, gasStationSystem, highwaySystem);
    this.refuelingManager = new CarRefuelingManager(pathfinder, this.router, cfg, gasStationSystem);
    this.rescueManager = new CarRescueManager(pathfinder, this.adapter, this.router, gasStationSystem, highwaySystem);
  }

  getCars(): Car[] {
    return this.cars;
  }

  /**
   * The simulation seam, for `Game` — road deletion asks it which cells cars depend on, and
   * the debug overlay reads positions and stall times off it.
   */
  getTrafficAdapter(): TrafficAdapter {
    return this.adapter;
  }

  getScore(): number {
    return this.score;
  }

  setElapsedTime(t: number): void {
    this.router.setElapsedTime(t);
    this.rescueManager.setElapsedTime(t);
  }

  /** Create cars for a newly spawned house and register them permanently. */
  registerHouse(house: House): void {
    for (let i = 0; i < this.cfg.CARS_PER_HOUSE; i++) {
      const car = new Car(house.id, house.color, house.pos, this.cfg.FUEL_CAPACITY);
      house.carIds.push(car.id);
      this.cars.push(car);
      this.carsById.set(car.id, car);
    }
  }

  update(dt: number, houses: House[], businesses: Business[]): void {
    // Build house lookup map
    const houseMap = this._houseMap;
    houseMap.clear();
    for (const h of houses) houseMap.set(h.id, h);

    this.dispatcher.dispatch(this.cars, houses, businesses);

    this.moveCars(dt, houses, businesses, houseMap);

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

  private moveCars(
    dt: number, houses: House[], businesses: Business[], houseMap: Map<string, House>,
  ): void {
    const bizMap = this._businessMap;
    bizMap.clear();
    for (const biz of businesses) bizMap.set(biz.id, biz);

    this.withStrandedDetection(() => {
      const events = this.adapter.update(dt);
      this.adapter.writeBack(this.cars);

      const arrived = this._arrivedThisTick;
      arrived.clear();
      for (const event of events) {
        if (event.kind === TrafficEventKind.Arrived) arrived.add(event.vehicleId);
      }

      for (const car of this.cars) {
        if (car.state === CarState.Idle || car.state === CarState.Stranded) continue;

        // Fuel is a game rule, so it is deducted here rather than inside the simulation —
        // and from one distance, so road and highway can no longer disagree about cost.
        // They did: the grid path charged a whole tile per step while the highway charged
        // the arc it actually covered, on a road the map had made faster.
        if (car.state !== CarState.Refueling) {
          car.fuel = Math.max(0, car.fuel - this.adapter.getDistanceThisTick(car) / TILE_SIZE);
        }

        if (car.state === CarState.Refueling) {
          this.refuelingManager.updateRefuelingCar(car, dt, bizMap, houseMap);
        } else if (car.state === CarState.Unloading) {
          this.parkingManager.updateUnloadingCar(car, dt, bizMap, houseMap, () => { this.score++; });
        } else if (car.fuel <= 0 && car.state !== CarState.GoingToGasStation && !arrived.has(car.id)) {
          // Reaching the destination on the last drop is an arrival, not a breakdown — the
          // old movement code made the same exception for a car that ran dry on its final
          // step. The arrival is handled below; stranding here would pre-empt it.
          this.strand(car);
        } else {
          this.driving(car, houseMap);
        }
      }

      // Arrivals after the per-car pass: `handleArrival` may reset a car to idle or install
      // a new route, and doing that mid-loop would have the fuel pass above read a route the
      // car has already left.
      for (const event of events) {
        if (event.kind !== TrafficEventKind.Arrived) continue;
        const car = this.carsById.get(event.vehicleId);
        if (car) this.handleArrival(car, houses, bizMap, houseMap);
      }

      // Repathing comes after arrivals, and the order is the whole of the safety argument.
      //
      // A car can be reported blocked on the very tick it arrives — it need only have been
      // crawling below `STOPPED_SPEED` while the watchdog counted. Repathing it *first*
      // would install a new route and then let `handleArrival` declare it arrived at a
      // destination it is no longer heading for. Running arrivals first makes that
      // impossible rather than merely unlikely: every outcome of `handleArrival` is a state
      // this loop does not touch, so the car has already been dealt with by the time the
      // report is read. That exhaustiveness is why the loop needs no separate "did it also
      // arrive?" test, and it is why `handleGasStationArrival` strands a car it cannot place
      // rather than leaving it in a driving state.
      for (const event of events) {
        if (event.kind !== TrafficEventKind.Blocked) continue;
        const car = this.carsById.get(event.vehicleId);
        // The simulation cannot end a standstill it did not cause — a car parked across the
        // exit of the junction this one is queueing for may never move again. Repathing is
        // the remedy, and it needs the pathfinder, the destination and the fuel model, none
        // of which exist below this line.
        if (car && this.isDriving(car)) this.router.rerouteCar(car, houseMap);
      }
    });
  }

  private isDriving(car: Car): boolean {
    return car.state === CarState.GoingToBusiness
      || car.state === CarState.GoingHome
      || car.state === CarState.GoingToGasStation;
  }

  /** Stop a car dead where it stands. It keeps its route, so it keeps blocking the road. */
  private strand(car: Car): void {
    car.state = CarState.Stranded;
    this.adapter.setParked(car, true);
  }

  /**
   * The per-tick rules for a car that is supposed to be moving.
   *
   * Two of the three are repairs, and both used to be spread across `CarMovement`: a car in
   * a driving state that the simulation is not driving, and a car in a driving state the
   * simulation has parked. Either leaves a car motionless for ever, and neither is visible
   * from inside `src/traffic/`, which has no notion of a car that ought to be going
   * somewhere.
   */
  private driving(car: Car, houseMap: Map<string, House>): void {
    if (this.adapter.getRouteFor(car) === null) {
      // No route at all: dispatched onto a path the simulation refused, or rerouted while
      // it had none. `rerouteCar` strands it if there is nowhere to go. This replaces
      // `CarMovement`'s `path.length < 2` check, which is what made a car with no path
      // strandable at all.
      this.router.rerouteCar(car, houseMap);
      return;
    }

    if (this.adapter.isParked(car)) {
      // Parked but meant to be driving — a route install that failed after the state had
      // already been changed. Releasing it here is what stops a car that finished unloading
      // from standing on the connector for the rest of the session.
      this.adapter.setParked(car, false);
    }

    if (car.state === CarState.GoingHome) {
      // A homebound car shrinks its claim on the road behind it as it drives. Without this
      // the cells a player deleted under it stay pending for ever, because nothing else
      // ever removes a car from a pending cell's dependent set.
      this.adapter.consumePassedCells(car, (gx, gy) => {
        if (this.pendingDeletionSystem.isPending(gx, gy)) {
          this.pendingDeletionSystem.notifyCarPassed(car.id, gx, gy);
        }
      });
    }
  }

  /**
   * What a car does when it reaches the end of its route — and, either way, what becomes of
   * the vehicle underneath it.
   *
   * **Every arrival must either despawn or park, in the same tick.** A vehicle left driving
   * at the end of its route never moves again and nothing can pass it: measured on a Task 7
   * fixture as a follower stopped at 240.56 of 280 for the remaining 22 seconds. The
   * simulation cannot make the choice, because "arrived at a business" and "arrived home"
   * are game concepts, so it is made here — once, from the state the car ends up in, rather
   * than branch by branch. A car that has gone `Idle` has left the board and its vehicle
   * goes with it; anything else is still physically standing on the road it stopped on.
   *
   * Stating it as one rule over the outcome rather than as a call in each branch is
   * deliberate: the branches include two failure paths (the business is gone, the gas
   * station is gone) and `CarRouter` adds a third, and those are exactly the ones a
   * per-branch obligation gets forgotten on.
   *
   * Every branch below leaves the car in `Idle`, `Unloading`, `Refueling` or `Stranded` —
   * never in a driving state. `moveCars` depends on that when it repaths blocked cars after
   * this runs, so a new branch here that leaves a car driving needs that loop looked at too.
   *
   * That ordering needs a second property, which holds on the other side of the tick: **the
   * per-car pass cannot un-arrive a car.** An `Arrived` report is only meaningful against
   * the route the car was on when the simulation stepped, so anything installing a *new*
   * route between the report and this method would leave the report describing a journey
   * the car is no longer making. Nothing does. A car that has just arrived necessarily has
   * a route, which rules out `driving()`'s no-route repath; the out-of-fuel branch skips
   * cars that arrived this tick; and `updateUnloadingCar` and `updateRefuelingCar`, the two
   * per-car branches that do install routes, are reachable only from `Unloading` and
   * `Refueling` — states this method is what puts a car into, so a car cannot be in one of
   * them on the tick it arrives.
   */
  private handleArrival(car: Car, _houses: House[], bizMap: Map<string, Business>, houseMap: Map<string, House>): void {
    if (car.state === CarState.GoingToGasStation) {
      this.refuelingManager.handleGasStationArrival(car);
    } else if (car.state === CarState.GoingToBusiness) {
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

    if (car.state === CarState.Idle) {
      this.adapter.removeVehicle(car);
      this.pendingDeletionSystem.notifyCarRemoved(car.id);
    } else {
      this.adapter.setParked(car, true);
    }
  }
}
