import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Pathfinder } from '../../pathfinding/Pathfinder';
import type { Grid } from '../../core/Grid';
import type { House } from '../../entities/House';
import { CellType } from '../../types';
import type { GridPos } from '../../types';
import type { PathStep } from '../../highways/types';
import { gridToPixelCenter, pixelToGrid } from '../../utils/math';
import { computeSmoothLanePath } from '../../utils/roadGeometry';
import type { GasStationSystem } from '../GasStationSystem';
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
  private gasStationSystem: GasStationSystem | null;
  private elapsedTime = 0;

  constructor(pathfinder: Pathfinder, grid: Grid, gasStationSystem?: GasStationSystem) {
    this.pathfinder = pathfinder;
    this.grid = grid;
    this.gasStationSystem = gasStationSystem ?? null;
  }

  setElapsedTime(t: number): void { this.elapsedTime = t; }

  getCarCurrentTile(car: Car): GridPos {
    if (car.onHighway) {
      return pixelToGrid(car.pixelPos.x, car.pixelPos.y);
    }
    if (car.path.length >= 2 && car.pathIndex < car.path.length - 1) {
      const curPos = stepGridPos(car.path[car.pathIndex]);
      const nxtPos = stepGridPos(car.path[car.pathIndex + 1]);
      return car.segmentProgress >= 0.5 ? nxtPos : curPos;
    }
    if (car.path.length > 0 && car.pathIndex < car.path.length) {
      return stepGridPos(car.path[car.pathIndex]);
    }
    return pixelToGrid(car.pixelPos.x, car.pixelPos.y);
  }

  /** Assign a new path to a car that is already moving on a road.
   *  Unlike assignPath(), this snaps arcDistance to the closest point on the
   *  new smooth path instead of teleporting the car to the path start. */
  reassignPath(car: Car, path: PathStep[]): void {
    this.assignPath(car, path);
    if (car.smoothPath.length >= 2) {
      car.arcDistance = this.findClosestArcDistance(car.pixelPos, car.smoothPath, car.smoothCumDist);
    }
    if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reassign', message: `new path len=${path.length}, arcDist=${car.arcDistance.toFixed(1)}, smoothLen=${car.smoothPath.length}`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
  }

  assignPath(car: Car, path: PathStep[]): void {
    car.path = path;
    car.pathIndex = 0;
    car.segmentProgress = 0;
    car.onHighway = false;
    car.highwayPolyline = null;
    car.highwayCumDist = null;
    car.highwayProgress = 0;
    car.sameLaneWaitTime = 0;
    car.stuckTimer = 0;
    car.lastAdvancedPathIndex = 0;
    car.arcDistance = 0;
    car.currentSpeed = 0;
    car.leaderId = null;
    car.leaderGap = Infinity;

    if (path.length >= 2) {
      const gridPositions = this.extractLeadingGridPositions(path, 0);
      this.computeAndAssignSmoothPath(car, gridPositions, 0);
    } else {
      car.smoothPath = [];
      car.smoothCumDist = [];
      car.smoothCellDist = [];
    }
  }

  /** Extract grid positions from path starting at startIdx up to (but not including) the next highway step */
  private extractLeadingGridPositions(path: PathStep[], startIdx: number): GridPos[] {
    const positions: GridPos[] = [];
    for (let i = startIdx; i < path.length; i++) {
      const step = path[i];
      if (step.kind === 'highway') break;
      positions.push(step.pos);
    }
    return positions;
  }

  /** Compute smooth lane path for a grid segment and assign to car */
  private computeAndAssignSmoothPath(car: Car, gridPositions: GridPos[], pathStartIdx: number): void {
    if (gridPositions.length >= 2) {
      let startTrim = 0;
      let endTrim = gridPositions.length;
      while (startTrim < gridPositions.length) {
        const cell = this.grid.getCell(gridPositions[startTrim].gx, gridPositions[startTrim].gy);
        if (cell && cell.type !== CellType.Business) break;
        startTrim++;
      }
      while (endTrim > startTrim) {
        const cell = this.grid.getCell(gridPositions[endTrim - 1].gx, gridPositions[endTrim - 1].gy);
        if (cell && cell.type !== CellType.Business) break;
        endTrim--;
      }
      const smoothPath = gridPositions.slice(startTrim, endTrim);
      if (smoothPath.length >= 2) {
        const smooth = computeSmoothLanePath(smoothPath);
        car.smoothPath = smooth.points;
        car.smoothCumDist = smooth.cumDist;
        const padded = new Array(pathStartIdx + startTrim).fill(0);
        car.smoothCellDist = padded.concat(smooth.cellDist);
      } else {
        car.smoothPath = [];
        car.smoothCumDist = [];
        car.smoothCellDist = [];
      }
    } else {
      car.smoothPath = [];
      car.smoothCumDist = [];
      car.smoothCellDist = [];
    }
  }

  /** Recompute smooth path for the grid segment starting after a highway exit */
  recomputeSmoothPathFromIndex(car: Car, startIdx: number): void {
    const gridPositions = this.extractLeadingGridPositions(car.path, startIdx);
    this.computeAndAssignSmoothPath(car, gridPositions, startIdx);
  }

  rerouteCar(car: Car, houseMap: Map<string, House>): void {
    if (car.state === CarState.Unloading || car.state === CarState.Refueling) return;

    if (CAR_DEBUG) {
      const tile = this.getCarCurrentTile(car);
      CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-start', message: `state=${car.state}, tile=(${tile.gx},${tile.gy}), dest=${car.destination ? `(${car.destination.gx},${car.destination.gy})` : 'none'}`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
    }

    // GoingToGasStation: try to reroute to same station or find a new one
    if (car.state === CarState.GoingToGasStation && this.gasStationSystem && car.targetGasStationId) {
      const currentTile = this.getCarCurrentTile(car);
      const station = this.gasStationSystem.getGasStationById(car.targetGasStationId);
      if (station) {
        const path = this.pathfinder.findPath(currentTile, station.pos);
        if (path) {
          this.reassignPath(car, path);
          return;
        }
      }
      // Try to find a different gas station
      const result = this.gasStationSystem.findNearestReachable(this.getCarCurrentTile(car), this.pathfinder);
      if (result) {
        const path = this.pathfinder.findPath(currentTile, result.station.pos);
        if (path) {
          car.targetGasStationId = result.station.id;
          car.destination = result.station.pos;
          this.reassignPath(car, path);
          return;
        }
      }
      // Fall through to standard stranded logic below
    }

    const currentTile = this.getCarCurrentTile(car);
    const home = houseMap.get(car.homeHouseId);

    if (car.destination) {
      const path = this.pathfinder.findPath(currentTile, car.destination);
      if (path) {
        if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-ok', message: `rerouted to dest, pathLen=${path.length}` });
        this.reassignPath(car, path);
        return;
      }
    }

    if (car.state === CarState.GoingToBusiness) {
      car.targetBusinessId = null;
    }

    if (home) {
      const homePath = this.pathfinder.findPath(currentTile, home.pos, true);
      if (homePath) {
        if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-ok', message: `rerouted home, pathLen=${homePath.length}` });
        car.state = CarState.GoingHome;
        car.destination = home.pos;
        this.reassignPath(car, homePath);
        return;
      }
    }

    if (CAR_DEBUG) CarEventLog.log({ time: this.elapsedTime, carId: car.id, type: 'reroute-stranded', message: `no path found, teleporting to tile center (${currentTile.gx},${currentTile.gy})` });
    car.state = CarState.Stranded;
    car.path = [];
    car.pathIndex = 0;
    car.segmentProgress = 0;
    car.onHighway = false;
    car.highwayPolyline = null;
    car.highwayCumDist = null;
    car.highwayProgress = 0;
    car.smoothPath = [];
    car.smoothCumDist = [];
    car.smoothCellDist = [];
    car.arcDistance = 0;
    car.currentSpeed = 0;
    car.leaderId = null;
    car.leaderGap = Infinity;
    const center = gridToPixelCenter(currentTile);
    car.pixelPos.x = center.x;
    car.pixelPos.y = center.y;
    if (home) {
      car.destination = home.pos;
    }
  }

  /** Find the arcDistance on a smooth path closest to a given pixel position */
  private findClosestArcDistance(
    pos: { x: number; y: number },
    smoothPath: { x: number; y: number }[],
    cumDist: number[]
  ): number {
    let bestDist = Infinity;
    let bestArc = 0;

    for (let i = 0; i < smoothPath.length - 1; i++) {
      const ax = smoothPath[i].x;
      const ay = smoothPath[i].y;
      const bx = smoothPath[i + 1].x;
      const by = smoothPath[i + 1].y;
      const dx = bx - ax;
      const dy = by - ay;
      const segLenSq = dx * dx + dy * dy;

      let t = 0;
      if (segLenSq > 0) {
        t = ((pos.x - ax) * dx + (pos.y - ay) * dy) / segLenSq;
        t = Math.max(0, Math.min(1, t));
      }

      const projX = ax + t * dx;
      const projY = ay + t * dy;
      const distSq = (pos.x - projX) * (pos.x - projX) + (pos.y - projY) * (pos.y - projY);

      if (distSq < bestDist) {
        bestDist = distSq;
        const segLen = Math.sqrt(segLenSq);
        bestArc = cumDist[i] + t * segLen;
      }
    }

    return bestArc;
  }
}
