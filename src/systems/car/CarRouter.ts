import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { Grid } from '../../core/Grid';
import type { House } from '../../entities/House';
import type { GridPos } from '../../types';
import type { PathStep } from '../../highways/types';
import { pixelToGrid } from '../../utils/math';
import type { GasStationSystem } from '../GasStationSystem';
import type { TrafficAdapter } from './TrafficAdapter';
import { CAR_DEBUG } from '../../constants';
import { CarEventLog } from '../../debug/CarEventLog';

/** Get the grid position of a path step */
export function stepGridPos(step: PathStep): GridPos {
  if (step.kind === 'grid') return step.pos;
  return step.to;
}

export class CarRouter {
  private pathfinder: Pathfinder;
  private grid: Grid;
  private adapter: TrafficAdapter;
  private gasStationSystem: GasStationSystem | null;
  private elapsedTime = 0;

  constructor(pathfinder: Pathfinder, grid: Grid, adapter: TrafficAdapter, gasStationSystem?: GasStationSystem) {
    this.pathfinder = pathfinder;
    this.grid = grid;
    this.adapter = adapter;
    this.gasStationSystem = gasStationSystem ?? null;
  }

  setElapsedTime(t: number): void { this.elapsedTime = t; }

  /**
   * The tile this car is on, as the pathfinder would name it.
   *
   * The simulation's own answer, with `car.pixelPos` as the fallback for a car it holds no
   * route for — a car that has never been dispatched, or one stranded before a route could
   * be installed. That fallback is the only case where the mirror is the sole record of
   * where a car is.
   */
  getCarCurrentTile(car: Car): GridPos {
    return this.adapter.getCurrentCell(car) ?? pixelToGrid(car.pixelPos.x, car.pixelPos.y);
  }

  /**
   * Start this car on a new journey, from the head of the path.
   *
   * Returns false when the path cannot form a curve; see `TrafficAdapter.installRoute`. No
   * caller acts on that today, and none needs to: a car left in a driving state with no
   * route is picked up by `CarSystem`'s next tick and rerouted or stranded, which is the
   * same remedy each caller would have to write for itself.
   */
  assignPath(car: Car, path: PathStep[]): boolean {
    return this.adapter.installRoute(car, path, false);
  }

  /** Keep a moving car where it is and find that point on the new route. */
  reassignPath(car: Car, path: PathStep[]): boolean {
    const ok = this.adapter.installRoute(car, path, true);
    if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reassign', message: `new path len=${path.length}, ok=${ok}, arcDist=${this.adapter.getArc(car).toFixed(1)}`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
    return ok;
  }

  /**
   * Find this car a new way to wherever it was going, or strand it where it stands.
   *
   * **A car standing inside a junction is left alone for a tick.** A route installed on such
   * a car begins on the junction cell, and a grid span's first cell is deliberately demoted
   * to plain road (`TrafficAdapter.describeCell`) — so the box the car is physically sitting
   * in reserves nothing, and a conflicting stream on another route can be admitted straight
   * into it. Skipping is free: the car keeps its old route for one more tick, and every
   * caller of this either runs again next tick (`CarSystem`'s no-route and `Blocked` paths)
   * or is reacting to an edit whose consequences the same paths will pick up.
   */
  rerouteCar(car: Car, houseMap: Map<string, House>): void {
    if (car.state === CarState.Unloading || car.state === CarState.Refueling) return;

    const currentTile = this.getCarCurrentTile(car);
    if (this.grid.getCell(currentTile.gx, currentTile.gy)?._isIntersection) {
      if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-deferred', message: `standing in the junction at (${currentTile.gx},${currentTile.gy})` });
      return;
    }

    if (CAR_DEBUG) {
      CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-start', message: `state=${car.state}, tile=(${currentTile.gx},${currentTile.gy}), dest=${car.destination ? `(${car.destination.gx},${car.destination.gy})` : 'none'}`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
    }

    // GoingToGasStation: try to reroute to same station or find a new one
    if (car.state === CarState.GoingToGasStation && this.gasStationSystem && car.targetGasStationId) {
      const station = this.gasStationSystem.getGasStationById(car.targetGasStationId);
      if (station) {
        const path = this.pathfinder.findPath(currentTile, station.pos);
        if (path && this.reassignPath(car, path)) return;
      }
      // Try to find a different gas station
      const result = this.gasStationSystem.findNearestReachable(currentTile, this.pathfinder);
      if (result) {
        const path = this.pathfinder.findPath(currentTile, result.station.pos);
        if (path && this.reassignPath(car, path)) {
          car.targetGasStationId = result.station.id;
          car.destination = result.station.pos;
          return;
        }
      }
      // Fall through to standard stranded logic below
    }

    const home = houseMap.get(car.homeHouseId);

    // Each branch commits only once the route is actually installed. `reassignPath` refuses
    // a path that cannot form a curve — a single step is the reachable case, a car already
    // standing on the tile it is being sent to — and a car left in a driving state with a
    // route it did not get is a car driving the wrong way down its old one.
    if (car.destination) {
      const path = this.pathfinder.findPath(currentTile, car.destination);
      if (path && this.reassignPath(car, path)) {
        if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-ok', message: `rerouted to dest, pathLen=${path.length}` });
        return;
      }
    }

    if (car.state === CarState.GoingToBusiness) {
      car.targetBusinessId = null;
    }

    if (home) {
      const homePath = this.pathfinder.findPath(currentTile, home.pos, true);
      if (homePath && this.reassignPath(car, homePath)) {
        if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-ok', message: `rerouted home, pathLen=${homePath.length}` });
        car.state = CarState.GoingHome;
        car.destination = home.pos;
        return;
      }
    }

    if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-stranded', message: `no path found from (${currentTile.gx},${currentTile.gy})` });
    // Strand in place. The old code snapped to a tile centre here, which was a visible jump
    // at exactly the moment the player was watching the car fail. Parked rather than
    // despawned, because the car is physically still on that road and still blocks it.
    car.state = CarState.Stranded;
    this.adapter.setParked(car, true);
    if (home) car.destination = home.pos;
  }
}
