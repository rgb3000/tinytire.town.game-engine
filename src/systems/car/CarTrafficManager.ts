import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Grid } from '../../core/Grid';
import { INTERSECTION_SPEED_MULTIPLIER, INTERSECTION_DEADLOCK_TIMEOUT, CAR_MIN_GAP, CAR_COMFORT_GAP, INTERSECTION_STOP_DIST, INTERSECTION_DECEL_DIST, T_INTERSECTION_GAP_TIME } from '../../constants';
import type { CarTuning } from './CarTuning';
import { CellType, Direction, LaneId } from '../../types';
import type { GridPos } from '../../types';
import {
  getDirection, directionToLane, opposite,
  isDiagonalDir, DIRECTION_OFFSETS,
} from '../../utils/direction';
import { stepGridPos } from './CarRouter';
import { shouldYield, getTIntersectionRoads, isMinorRoadEntry } from './IntersectionConflicts';

export function occupancyKey(gx: number, gy: number, lane: LaneId): number {
  return gx | (gy << 8) | (lane << 16);
}

export function tileKey(gx: number, gy: number): number {
  return gx | (gy << 8);
}

/** Compute speed multiplier (0..1) based on gap to leader car */
export function followingSpeedMultiplier(gap: number): number {
  if (gap <= CAR_MIN_GAP) return 0;
  if (gap >= CAR_COMFORT_GAP) return 1;
  return (gap - CAR_MIN_GAP) / (CAR_COMFORT_GAP - CAR_MIN_GAP);
}

export function isTIntersection(grid: Grid, gx: number, gy: number): boolean {
  const cell = grid.getCell(gx, gy);
  return cell !== null && cell._isTIntersection;
}

export interface IntersectionEntry {
  carId: string;
  entryDirection: Direction;
  exitDirection: Direction;
  inIntersection: boolean;
  arrivalTime: number;
}

export class CarTrafficManager {
  private grid: Grid;
  private _frameTime = 0;

  // Reusable collections to avoid per-frame allocations
  private _occupiedMap = new Map<number, string>();
  private _intersectionMap = new Map<number, IntersectionEntry[]>();
  private _intersectionEntryPool: IntersectionEntry[][] = [];
  // Object pool for IntersectionEntry instances
  private _entryObjPool: IntersectionEntry[] = [];
  private _entryObjCount = 0;
  // Reusable temp entry for computeIntersectionYield
  private _tempEntry: IntersectionEntry = {
    carId: '', entryDirection: 0 as Direction, exitDirection: 0 as Direction,
    inIntersection: false, arrivalTime: 0,
  };

  private cfg: Pick<CarTuning, 'CAR_SPEED'>;

  constructor(grid: Grid, cfg: Pick<CarTuning, 'CAR_SPEED'>) {
    this.grid = grid;
    this.cfg = cfg;
  }

  advanceFrameTime(dt: number): void {
    this._frameTime += dt;
  }

  buildOccupancyMap(cars: Car[]): Map<number, string> {
    const occupied = this._occupiedMap;
    occupied.clear();
    for (const car of cars) {
      if (car.state === CarState.Idle || car.state === CarState.Unloading || car.state === CarState.Refueling || car.path.length < 2) continue;
      if (car.onHighway) continue; // skip cars on highways

      const currentStep = car.path[car.pathIndex];
      if (currentStep.kind !== 'grid') continue;

      const currentTile = currentStep.pos;
      const nextIdx = Math.min(car.pathIndex + 1, car.path.length - 1);
      const nextTile = stepGridPos(car.path[nextIdx]);
      const dir = getDirection(currentTile, nextTile);
      const lane = directionToLane(dir);

      const occupiedTile = car.segmentProgress < 0.5 ? currentTile : nextTile;
      occupied.set(occupancyKey(occupiedTile.gx, occupiedTile.gy, lane), car.id);
    }
    return occupied;
  }

  /** Get exit direction from an intersection tile for a car, given the intersection's path index */
  private getExitDirection(car: Car, intersectionPathIdx: number): Direction {
    const intTile = stepGridPos(car.path[intersectionPathIdx]);
    // Look at the step after the intersection for exit direction
    if (intersectionPathIdx + 1 < car.path.length) {
      const afterStep = car.path[intersectionPathIdx + 1];
      if (afterStep.kind === 'grid') {
        return getDirection(intTile, afterStep.pos);
      }
    }
    // Fallback: same as entry direction (straight through)
    if (intersectionPathIdx > 0) {
      return getDirection(stepGridPos(car.path[intersectionPathIdx - 1]), intTile);
    }
    return getDirection(intTile, stepGridPos(car.path[Math.min(intersectionPathIdx + 1, car.path.length - 1)]));
  }

  private getPooledEntry(
    carId: string, entryDir: Direction, exitDir: Direction,
    inIntersection: boolean, arrivalTime: number,
  ): IntersectionEntry {
    if (this._entryObjCount < this._entryObjPool.length) {
      const e = this._entryObjPool[this._entryObjCount++];
      e.carId = carId;
      e.entryDirection = entryDir;
      e.exitDirection = exitDir;
      e.inIntersection = inIntersection;
      e.arrivalTime = arrivalTime;
      return e;
    }
    const e = { carId, entryDirection: entryDir, exitDirection: exitDir, inIntersection, arrivalTime };
    this._entryObjPool.push(e);
    this._entryObjCount++;
    return e;
  }

  private addIntersectionEntry(
    intersectionMap: Map<number, IntersectionEntry[]>,
    key: number, carId: string, entryDir: Direction, exitDir: Direction,
    inIntersection: boolean, arrivalTime: number,
  ): void {
    let list = intersectionMap.get(key);
    if (!list) { list = this._intersectionEntryPool.pop() ?? []; intersectionMap.set(key, list); }
    list.push(this.getPooledEntry(carId, entryDir, exitDir, inIntersection, arrivalTime));
  }

  buildIntersectionMap(cars: Car[]): Map<number, IntersectionEntry[]> {
    const intersectionMap = this._intersectionMap;
    for (const list of intersectionMap.values()) {
      list.length = 0;
      this._intersectionEntryPool.push(list);
    }
    intersectionMap.clear();
    this._entryObjCount = 0;

    for (const car of cars) {
      if (car.state === CarState.Idle || car.state === CarState.Unloading || car.state === CarState.Refueling || car.path.length < 2) continue;
      if (car.onHighway) continue;

      const curStep = car.path[car.pathIndex];
      if (curStep.kind !== 'grid') continue;
      const curTile = curStep.pos;
      const nextIdx = Math.min(car.pathIndex + 1, car.path.length - 1);
      const nxtStep = car.path[nextIdx];
      const nxtTile = stepGridPos(nxtStep);

      const nxtCell = nxtStep.kind === 'grid' ? this.grid.getCell(nxtTile.gx, nxtTile.gy) : null;
      const nxtIsInt = nxtCell !== null && nxtCell._isIntersection;

      if (car.segmentProgress >= 0.5 && car.pathIndex + 1 < car.path.length) {
        // Car is past halfway — treat as being on next tile
        if (nxtIsInt) {
          const entryDir = getDirection(curTile, nxtTile);
          const exitDir = this.getExitDirection(car, car.pathIndex + 1);
          this.addIntersectionEntry(intersectionMap, tileKey(nxtTile.gx, nxtTile.gy),
            car.id, entryDir, exitDir, true, car.arrivalTime);
        }
      } else if (car.segmentProgress < 0.5) {
        // Car is on current tile
        const curCell = this.grid.getCell(curTile.gx, curTile.gy);
        if (curCell !== null && curCell._isIntersection) {
          const entryDir = car.pathIndex > 0
            ? getDirection(stepGridPos(car.path[car.pathIndex - 1]), curTile)
            : getDirection(curTile, nxtTile);
          const exitDir = this.getExitDirection(car, car.pathIndex);
          this.addIntersectionEntry(intersectionMap, tileKey(curTile.gx, curTile.gy),
            car.id, entryDir, exitDir, true, car.arrivalTime);
        }

        // Car is approaching next tile
        if (car.pathIndex + 1 < car.path.length && nxtIsInt) {
          const entryDir = getDirection(curTile, nxtTile);
          const exitDir = this.getExitDirection(car, car.pathIndex + 1);
          this.addIntersectionEntry(intersectionMap, tileKey(nxtTile.gx, nxtTile.gy),
            car.id, entryDir, exitDir, false, car.arrivalTime);
        }
      }
    }

    return intersectionMap;
  }

  /**
   * Compute intersection yield speed multiplier (0..1).
   * Returns 1 if no yielding needed, 0 if car should stop, or intermediate for smooth decel.
   */
  computeIntersectionYield(
    car: Car, dt: number,
    nextTile: GridPos,
    dir: Direction,
    isNextIntersection: boolean,
    intersectionMap: Map<number, IntersectionEntry[]>,
  ): number {
    if (!isNextIntersection || car.segmentProgress >= 0.5) {
      car.intersectionWaitTime = 0;
      return 1;
    }

    const entryDir = dir;
    const intKey = tileKey(nextTile.gx, nextTile.gy);
    const entries = intersectionMap.get(intKey);
    let mustYield = false;

    if (entries) {
      // Find this car's own entry to get its exitDirection
      let myExitDir = entryDir; // fallback: straight through
      for (const e of entries) {
        if (e.carId === car.id) { myExitDir = e.exitDirection; break; }
      }
      const nextCell = this.grid.getCell(nextTile.gx, nextTile.gy);
      const isT = nextCell !== null && nextCell._isTIntersection;
      // Reuse temp entry instead of allocating
      const myEntry = this._tempEntry;
      myEntry.carId = car.id;
      myEntry.entryDirection = entryDir;
      myEntry.exitDirection = myExitDir;
      myEntry.inIntersection = false;
      myEntry.arrivalTime = car.arrivalTime;

      for (const other of entries) {
        if (other.carId === car.id) continue;
        if (shouldYield(myEntry, other, isT)) {
          mustYield = true;
          break;
        }
      }

      // T-intersection gap acceptance: minor road must wait for gap in major road traffic
      if (!mustYield && isT) {
        const tInfo = getTIntersectionRoads(this.grid, nextTile.gx, nextTile.gy);
        if (tInfo && isMinorRoadEntry(entryDir, tInfo.minorDir)) {
          mustYield = this.checkMajorRoadApproaching(nextTile, tInfo.majorDirs);
        }
      }
    }

    if (mustYield) {
      // Set arrival time when first starting to wait
      if (car.intersectionWaitTime === 0) {
        car.arrivalTime = this._frameTime;
      }
      car.intersectionWaitTime += dt;

      // Deadlock escape: after timeout, allow through
      if (car.intersectionWaitTime >= INTERSECTION_DEADLOCK_TIMEOUT) {
        return 1;
      }

      // Compute distance to intersection center (in arc-length px)
      // The intersection is on the next tile; distance = remaining progress * segment length
      const segStart = car.smoothCellDist[car.pathIndex] ?? 0;
      const segEnd = car.smoothCellDist[car.pathIndex + 1] ?? segStart;
      const segLen = segEnd - segStart;
      const distToInt = (1 - car.segmentProgress) * segLen + segLen * 0.5; // to center of intersection tile

      if (distToInt <= INTERSECTION_STOP_DIST) return 0;
      if (distToInt >= INTERSECTION_DECEL_DIST) return 1;
      return (distToInt - INTERSECTION_STOP_DIST) / (INTERSECTION_DECEL_DIST - INTERSECTION_STOP_DIST);
    }

    car.intersectionWaitTime = 0;
    return 1;
  }

  /**
   * Check if cars are approaching the intersection from major road directions.
   * Scans tiles along each major direction, checking occupancy for cars heading toward the intersection.
   */
  private checkMajorRoadApproaching(intTile: GridPos, majorDirs: [Direction, Direction]): boolean {
    const scanTiles = Math.ceil(T_INTERSECTION_GAP_TIME * this.cfg.CAR_SPEED); // ~2 tiles at the default speed of 1
    const occupied = this._occupiedMap;

    for (const majorDir of majorDirs) {
      // Scan outward from the intersection along this major direction
      const offset = DIRECTION_OFFSETS[majorDir];
      // Cars approaching FROM this direction travel in opposite(majorDir)
      const approachDir = opposite(majorDir);
      const lane = directionToLane(approachDir);

      for (let dist = 1; dist <= scanTiles; dist++) {
        const gx = intTile.gx + offset.gx * dist;
        const gy = intTile.gy + offset.gy * dist;
        if (!this.grid.inBounds(gx, gy)) break;

        const key = occupancyKey(gx, gy, lane);
        if (occupied.has(key)) return true;
      }
    }
    return false;
  }

  computeEffectiveSpeed(
    currentTile: GridPos, nextTile: GridPos, dir: Direction,
  ): { effectiveSpeed: number; segmentLength: number } {
    const currentCell = this.grid.getCell(currentTile.gx, currentTile.gy);
    const nextCell = this.grid.getCell(nextTile.gx, nextTile.gy);
    const isInt = (currentCell !== null && currentCell._isIntersection)
      || (nextCell !== null && nextCell._isIntersection);
    const isConnector = (currentCell?.type === CellType.Connector) || (nextCell?.type === CellType.Connector);
    const effectiveSpeed = (isInt || isConnector)
      ? this.cfg.CAR_SPEED * INTERSECTION_SPEED_MULTIPLIER : this.cfg.CAR_SPEED;
    const segmentLength = isDiagonalDir(dir) ? Math.SQRT2 : 1;
    return { effectiveSpeed, segmentLength };
  }
}
