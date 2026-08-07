import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { Business } from '../../entities/Business';
import type { House } from '../../entities/House';
import type { Grid } from '../../core/Grid';
import { CellType } from '../../types';
import { getDirection, directionToLane } from '../../utils/direction';
import { sampleAtDistance } from '../../utils/roadGeometry';
import type { CarTrafficManager } from './CarTrafficManager';
import { occupancyKey, followingSpeedMultiplier } from './CarTrafficManager';
import type { IntersectionEntry } from './CarTrafficManager';
import type { CarRouter } from './CarRouter';
import { stepGridPos } from './CarRouter';
import type { PendingDeletionSystem } from '../PendingDeletionSystem';
import type { HighwaySystem } from '../HighwaySystem';
import { CAR_DEBUG, TILE_SIZE, GROUND_Y_POSITION, LANE_OFFSET, UNIVERSAL_STUCK_TIMEOUT } from '../../constants';
import type { CarTuning } from './CarTuning';
import { CarEventLog } from '../../debug/CarEventLog';
import { computeHighwayElevation } from '../../highways/highwayGeometry';

export class CarMovement {
  private grid: Grid;
  private trafficManager: CarTrafficManager;
  private router: CarRouter;
  private pendingDeletionSystem: PendingDeletionSystem;
  private highwaySystem: HighwaySystem | null;
  private cfg: Pick<CarTuning, 'CAR_SPEED' | 'HIGHWAY_SPEED_MULTIPLIER'>;
  private elapsedTime = 0;

  constructor(grid: Grid, trafficManager: CarTrafficManager, router: CarRouter, pendingDeletionSystem: PendingDeletionSystem, cfg: Pick<CarTuning, 'CAR_SPEED' | 'HIGHWAY_SPEED_MULTIPLIER'>, highwaySystem?: HighwaySystem) {
    this.grid = grid;
    this.trafficManager = trafficManager;
    this.router = router;
    this.pendingDeletionSystem = pendingDeletionSystem;
    this.cfg = cfg;
    this.highwaySystem = highwaySystem ?? null;
  }

  setElapsedTime(t: number): void { this.elapsedTime = t; }
  private getTime(): number { return this.elapsedTime; }

  interpolateCarPosition(car: Car): void {
    const curStep = car.path[car.pathIndex];
    const nxtStep = car.path[Math.min(car.pathIndex + 1, car.path.length - 1)];
    const curTile = stepGridPos(curStep);
    const nxtTile = stepGridPos(nxtStep);
    const curDir = getDirection(curTile, nxtTile);
    car.direction = curDir;

    if (car.smoothPath.length < 2) return;

    const segStart = car.smoothCellDist[car.pathIndex];
    const segEnd = car.smoothCellDist[Math.min(car.pathIndex + 1, car.smoothCellDist.length - 1)];
    const dist = segStart + car.segmentProgress * (segEnd - segStart);

    const result = sampleAtDistance(car.smoothPath, car.smoothCumDist, dist);
    car.pixelPos.x = result.x;
    car.pixelPos.y = result.y;
    car.renderAngle = result.angle;
  }

  updateSingleCar(
    car: Car, dt: number,
    houses: House[], bizMap: Map<string, Business>,
    occupied: Map<number, string>,
    intersectionMap: Map<number, IntersectionEntry[]>,
    onArrival: (car: Car, houses: House[], bizMap: Map<string, Business>) => void,
    houseMap: Map<string, House>,
  ): void {
    car.prevPixelPos.x = car.pixelPos.x;
    car.prevPixelPos.y = car.pixelPos.y;
    car.prevRenderAngle = car.renderAngle;
    car.prevElevationY = car.elevationY;

    // Highway traversal mode
    if (car.onHighway && car.highwayPolyline && car.highwayCumDist) {
      this.updateHighwayMovement(car, dt, houses);
      return;
    }

    if (car.path.length < 2) {
      if (CAR_DEBUG) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'path-too-short', message: `path.length=${car.path.length}, triggering reroute`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
      this.router.rerouteCar(car, houseMap);
      return;
    }

    // Check if next step is a highway — transition into highway mode immediately
    if (car.pathIndex < car.path.length - 1) {
      const nextStep = car.path[car.pathIndex + 1];
      if (nextStep.kind === 'highway') {
        car.pathIndex++;        // advance TO the highway step
        car.segmentProgress = 0;
        this.enterHighway(car, nextStep.highwayId);
        return;
      }
    }

    const currentStep = car.path[car.pathIndex];
    const nextIdx = Math.min(car.pathIndex + 1, car.path.length - 1);
    const nextStep = car.path[nextIdx];

    // For highway steps that we somehow didn't enter yet, skip grid logic
    if (currentStep.kind === 'highway') {
      this.enterHighway(car, currentStep.highwayId);
      return;
    }

    const currentTile = currentStep.pos;
    const nextTile = stepGridPos(nextStep);
    const dir = getDirection(currentTile, nextTile);
    car.direction = dir;
    const lane = directionToLane(dir);

    // Remove car from old occupancy position
    const oldOccupiedTile = car.segmentProgress < 0.5 ? currentTile : nextTile;
    const oldKey = occupancyKey(oldOccupiedTile.gx, oldOccupiedTile.gy, lane);
    if (occupied.get(oldKey) === car.id) {
      occupied.delete(oldKey);
    }

    const nextCell = car.pathIndex + 1 < car.path.length && nextStep.kind === 'grid'
      ? this.grid.getCell(nextTile.gx, nextTile.gy) : null;
    const isNextIntersection = nextCell !== null && nextCell._isIntersection;
    const { effectiveSpeed, segmentLength } = this.trafficManager.computeEffectiveSpeed(currentTile, nextTile, dir);
    // Apply arc-length following + intersection yield as speed multipliers
    const followingMult = followingSpeedMultiplier(car.leaderGap);
    const intersectionMult = this.trafficManager.computeIntersectionYield(
      car, dt, nextTile, dir, isNextIntersection, intersectionMap,
    );
    const desiredSpeed = effectiveSpeed * Math.min(followingMult, intersectionMult);
    car.currentSpeed = desiredSpeed * TILE_SIZE; // store in px/sec for reference
    const tileDistance = (desiredSpeed * dt) / segmentLength;
    const rawProgress = car.segmentProgress + tileDistance;
    let newProgress = rawProgress;

    car.segmentProgress = newProgress;
    const speedMult = Math.min(followingMult, intersectionMult);
    car.wasBlocked = speedMult < 0.1 || newProgress < rawProgress - 0.001;
    if (CAR_DEBUG && car.wasBlocked) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'blocked', message: `speedMult=${speedMult.toFixed(3)}, followMult=${followingMult.toFixed(3)}, intMult=${intersectionMult.toFixed(3)}`, data: { pathIndex: car.pathIndex, px: car.pixelPos.x, py: car.pixelPos.y } });

    // Advance through path segments
    while (car.segmentProgress >= 1 && car.pathIndex < car.path.length - 1) {
      car.segmentProgress -= 1;
      const leftStep = car.path[car.pathIndex];
      car.pathIndex++;

      // Fuel consumption for grid steps
      if (car.pathIndex < car.path.length) {
        const prevStep = car.path[car.pathIndex - 1];
        const curStep = car.path[car.pathIndex];
        if (prevStep.kind === 'grid' && curStep.kind === 'grid') {
          const dx = Math.abs(curStep.pos.gx - prevStep.pos.gx);
          const dy = Math.abs(curStep.pos.gy - prevStep.pos.gy);
          car.fuel -= (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1;
          car.fuel = Math.max(0, car.fuel);
          if (car.fuel <= 0 && car.state !== CarState.GoingToGasStation) {
            // Allow terminal-arrival handling (e.g., reaching home exactly at 0 fuel).
            if (car.pathIndex < car.path.length - 1) {
              if (CAR_DEBUG) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'fuel-exhausted', message: `fuel=0, pathIndex=${car.pathIndex}/${car.path.length - 1}, setting Stranded` });
              car.state = CarState.Stranded;
              return;
            }
          }
        }
      }

      // Check if we're now at a highway step
      if (car.pathIndex < car.path.length && car.path[car.pathIndex].kind === 'highway') {
        this.enterHighway(car, (car.path[car.pathIndex] as { highwayId: string }).highwayId);
        return;
      }

      // Notify pending deletion system when a GoingHome car leaves a pending cell
      // Use isPending() rather than cell.pendingDeletion because rescued cells clear the
      // flag but still track remaining pending connections for neighbor cleanup.
      if (car.state === CarState.GoingHome && leftStep.kind === 'grid') {
        const leftTile = leftStep.pos;
        if (this.pendingDeletionSystem.isPending(leftTile.gx, leftTile.gy)) {
          this.pendingDeletionSystem.notifyCarPassed(car.id, leftTile.gx, leftTile.gy);
        }
      }
    }

    // Universal stuck safety net
    if (car.pathIndex !== car.lastAdvancedPathIndex) {
      car.lastAdvancedPathIndex = car.pathIndex;
      car.stuckTimer = 0;
    } else {
      car.stuckTimer += dt;
    }
    if (car.stuckTimer >= UNIVERSAL_STUCK_TIMEOUT) {
      if (CAR_DEBUG) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'stuck-timer', message: `stuck for ${UNIVERSAL_STUCK_TIMEOUT}s at pathIndex=${car.pathIndex}, triggering reroute`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
      car.stuckTimer = 0;
      this.router.rerouteCar(car, houseMap);
      return;
    }

    // Check if next tile on path is still traversable
    if (car.pathIndex < car.path.length - 1) {
      const aheadStep = car.path[car.pathIndex + 1];
      if (aheadStep.kind === 'grid') {
        const aheadTile = aheadStep.pos;
        const cell = this.grid.getCell(aheadTile.gx, aheadTile.gy);
        const isFinalTile = car.pathIndex + 1 === car.path.length - 1;
        const isTraversable = cell && (
          cell.type === CellType.Road ||
          cell.type === CellType.Connector ||
          (isFinalTile && cell.type === CellType.House) ||
          (isFinalTile && cell.type === CellType.GasStation)
        ) && (!cell.pendingDeletion || car.state === CarState.GoingHome);

        if (!isTraversable) {
          if (CAR_DEBUG) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'path-blocked', message: `tile (${aheadTile.gx},${aheadTile.gy}) not traversable, cellType=${cell?.type}, pending=${cell?.pendingDeletion}`, data: { px: car.pixelPos.x, py: car.pixelPos.y } });
          this.router.rerouteCar(car, houseMap);
          return;
        }
      }
    }

    if (car.pathIndex >= car.path.length - 1) {
      car.segmentProgress = 0;
      if (car.smoothPath.length > 0) {
        const lastPt = car.smoothPath[car.smoothPath.length - 1];
        car.pixelPos.x = lastPt.x;
        car.pixelPos.y = lastPt.y;
      }
      if (CAR_DEBUG) CarEventLog.log({ time: this.getTime(), carId: car.id, type: 'arrival', message: `state=${car.state === CarState.GoingToBusiness ? 'GoingToBiz' : car.state === CarState.GoingHome ? 'GoingHome' : car.state === CarState.GoingToGasStation ? 'GoingToGas' : String(car.state)}` });
      onArrival(car, houses, bizMap);
      if (car.path.length === 0) return;
    } else {
      this.interpolateCarPosition(car);
      if (car.wasBlocked) {
        car.prevPixelPos.x = car.pixelPos.x;
        car.prevPixelPos.y = car.pixelPos.y;
        car.prevRenderAngle = car.renderAngle;
      }
    }

    // Update arc-length distance along smooth path
    if (car.smoothCellDist.length > car.pathIndex + 1) {
      const segStart = car.smoothCellDist[car.pathIndex];
      const segEnd = car.smoothCellDist[car.pathIndex + 1];
      car.arcDistance = segStart + car.segmentProgress * (segEnd - segStart);
    }

    // Register car in new occupancy position
    const newCurrentStep = car.path[car.pathIndex];
    if (newCurrentStep.kind !== 'grid') return; // on highway now, skip occupancy
    const newCurrentTile = newCurrentStep.pos;
    const newNextIdx = Math.min(car.pathIndex + 1, car.path.length - 1);
    const newNextStep = car.path[newNextIdx];
    const newNextTile = stepGridPos(newNextStep);
    const newDir = car.pathIndex < car.path.length - 1 ? getDirection(newCurrentTile, newNextTile) : dir;
    const newLane = directionToLane(newDir);
    const newOccupiedTile = car.segmentProgress < 0.5 ? newCurrentTile : newNextTile;
    const newKey = occupancyKey(newOccupiedTile.gx, newOccupiedTile.gy, newLane);
    occupied.set(newKey, car.id);
  }

  private enterHighway(car: Car, highwayId: string): void {
    if (!this.highwaySystem) return;
    const hw = this.highwaySystem.getById(highwayId);
    if (!hw) return;

    car.onHighway = true;
    car.highwayProgress = 0;
    car.segmentProgress = 0;
    car.elevationY = GROUND_Y_POSITION; // starts at road level

    // Determine direction using the path step's from/to (more reliable than pixel position)
    const hwStep = car.path[car.pathIndex];
    const enteringFrom = hwStep.kind === 'highway' ? hwStep.from : null;
    if (enteringFrom && enteringFrom.gx === hw.toPos.gx && enteringFrom.gy === hw.toPos.gy) {
      // Reverse the polyline
      car.highwayPolyline = [...hw.polyline].reverse();
      const totalDist = hw.cumDist[hw.cumDist.length - 1];
      car.highwayCumDist = hw.cumDist.map(d => totalDist - d).reverse();
    } else {
      car.highwayPolyline = hw.polyline;
      car.highwayCumDist = hw.cumDist;
    }
  }

  private updateHighwayMovement(car: Car, dt: number, _houses: House[]): void {
    if (!car.highwayPolyline || !car.highwayCumDist) return;

    const totalDist = car.highwayCumDist[car.highwayCumDist.length - 1];
    const progressRatio = car.highwayProgress / totalDist;
    const easedMultiplier = 1 + (this.cfg.HIGHWAY_SPEED_MULTIPLIER - 1) * Math.sin(Math.PI * progressRatio);
    const speed = this.cfg.CAR_SPEED * easedMultiplier * TILE_SIZE;
    car.highwayProgress += speed * dt;

    // Fuel consumption on highway
    car.fuel -= (speed * dt) / TILE_SIZE;
    car.fuel = Math.max(0, car.fuel);
    if (car.fuel <= 0 && car.state !== CarState.GoingToGasStation) {
      car.state = CarState.Stranded;
      car.onHighway = false;
      car.highwayPolyline = null;
      car.highwayCumDist = null;
      car.highwayProgress = 0;
      return;
    }

    if (car.highwayProgress >= totalDist) {
      // Sample the exact final position on the highway polyline
      const finalResult = sampleAtDistance(car.highwayPolyline, car.highwayCumDist, totalDist);
      // Apply lane offset (perpendicular to travel direction, right side)
      const finalPerpX = -Math.sin(finalResult.angle) * LANE_OFFSET;
      const finalPerpY =  Math.cos(finalResult.angle) * LANE_OFFSET;
      finalResult.x += finalPerpX;
      finalResult.y += finalPerpY;

      // Exit highway
      car.onHighway = false;
      car.highwayPolyline = null;
      car.highwayCumDist = null;
      car.highwayProgress = 0;
      car.elevationY = 0;

      // Advance pathIndex past the highway step
      car.pathIndex++;
      car.segmentProgress = 0;

      if (car.pathIndex >= car.path.length - 1) {
        // Arrived at destination
        return;
      }

      // Recompute smooth path for remaining grid segment
      this.router.recomputeSmoothPathFromIndex(car, car.pathIndex);
      if (car.smoothPath.length >= 2) {
        // Replace smoothPath[0] with highway endpoint to avoid lateral jump
        car.smoothPath[0] = { x: finalResult.x, y: finalResult.y };
        // Recompute cumulative distances from the new start
        const dx = car.smoothPath[1].x - car.smoothPath[0].x;
        const dy = car.smoothPath[1].y - car.smoothPath[0].y;
        const newDist01 = Math.sqrt(dx * dx + dy * dy);
        const delta = newDist01 - car.smoothCumDist[1];
        for (let i = 1; i < car.smoothCumDist.length; i++) {
          car.smoothCumDist[i] += delta;
        }
        for (let i = car.pathIndex + 1; i < car.smoothCellDist.length; i++) {
          car.smoothCellDist[i] += delta;
        }
        car.pixelPos.x = finalResult.x;
        car.pixelPos.y = finalResult.y;
      }
      return;
    }

    // Sample position along highway polyline
    const result = sampleAtDistance(car.highwayPolyline, car.highwayCumDist, car.highwayProgress);
    // Apply lane offset (perpendicular to travel direction, right side)
    const perpX = -Math.sin(result.angle) * LANE_OFFSET;
    const perpY =  Math.cos(result.angle) * LANE_OFFSET;
    car.pixelPos.x = result.x + perpX;
    car.pixelPos.y = result.y + perpY;
    car.renderAngle = result.angle;

    // Compute elevation using shared profile
    const t = car.highwayProgress / totalDist;
    car.elevationY = computeHighwayElevation(t, totalDist);
  }
}
