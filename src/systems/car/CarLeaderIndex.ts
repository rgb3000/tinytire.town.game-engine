import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import { getDirection, directionToLane } from '../../utils/direction';
import { stepGridPos } from './CarRouter';
import { occupancyKey } from './CarTrafficManager';

const LEADER_SCAN_TILES = 3;

interface BucketEntry {
  carId: string;
  arcDist: number;
  px: number;
  py: number;
}

export class CarLeaderIndex {
  private buckets = new Map<number, BucketEntry[]>();
  private entryPool: BucketEntry[][] = [];
  private _entryObjPool: BucketEntry[] = [];
  private _entryObjCount = 0;

  private getEntry(carId: string, arcDist: number, px: number, py: number): BucketEntry {
    if (this._entryObjCount < this._entryObjPool.length) {
      const e = this._entryObjPool[this._entryObjCount++];
      e.carId = carId;
      e.arcDist = arcDist;
      e.px = px;
      e.py = py;
      return e;
    }
    const e = { carId, arcDist, px, py };
    this._entryObjPool.push(e);
    this._entryObjCount++;
    return e;
  }

  rebuild(cars: Car[]): void {
    // Recycle arrays
    for (const list of this.buckets.values()) {
      list.length = 0;
      this.entryPool.push(list);
    }
    this.buckets.clear();
    this._entryObjCount = 0;

    for (const car of cars) {
      if (car.state === CarState.Idle ||
          car.state === CarState.Unloading || car.state === CarState.Refueling) continue;
      if (car.onHighway) continue;
      if (car.path.length < 2 || car.pathIndex >= car.path.length - 1) continue;

      const curStep = car.path[car.pathIndex];
      if (curStep.kind !== 'grid') continue;

      const curTile = curStep.pos;
      const nxtTile = stepGridPos(car.path[car.pathIndex + 1]);
      const dir = getDirection(curTile, nxtTile);
      const lane = directionToLane(dir);

      // Register car in the tile it currently occupies (based on segmentProgress)
      const tile = car.segmentProgress < 0.5 ? curTile : nxtTile;
      const key = occupancyKey(tile.gx, tile.gy, lane);
      let list = this.buckets.get(key);
      if (!list) {
        list = this.entryPool.pop() ?? [];
        this.buckets.set(key, list);
      }
      list.push(this.getEntry(car.id, car.arcDistance, car.pixelPos.x, car.pixelPos.y));
    }

    // Sort each bucket by arcDist ascending
    for (const list of this.buckets.values()) {
      if (list.length > 1) {
        list.sort((a, b) => a.arcDist - b.arcDist);
      }
    }
  }

  private scanBucket(key: number, car: Car, carPx: number, carPy: number, offset: number, bestGapSq: number): { id: string | null; gapSq: number } {
    const bucket = this.buckets.get(key);
    if (!bucket) return { id: null, gapSq: bestGapSq };

    let bestId: string | null = null;
    for (const entry of bucket) {
      if (entry.carId === car.id) continue;
      if (offset === 0 && entry.arcDist <= car.arcDistance) continue;

      const dx = entry.px - carPx;
      const dy = entry.py - carPy;
      const distSq = dx * dx + dy * dy;

      if (distSq < bestGapSq) {
        bestId = entry.carId;
        bestGapSq = distSq;
      }
    }
    return { id: bestId, gapSq: bestGapSq };
  }

  findLeader(car: Car): void {
    car.leaderId = null;
    car.leaderGap = Infinity;

    if (car.path.length < 2 || car.pathIndex >= car.path.length - 1) return;
    if (car.onHighway) return;

    const curStep = car.path[car.pathIndex];
    if (curStep.kind !== 'grid') return;

    const carPx = car.pixelPos.x;
    const carPy = car.pixelPos.y;
    let bestGapSq = Infinity;
    let bestId: string | null = null;

    // Scan forward along the car's path tiles looking for the nearest car ahead on the same lane
    for (let offset = 0; offset < LEADER_SCAN_TILES; offset++) {
      const idx = car.pathIndex + offset;
      if (idx >= car.path.length - 1) break;

      const step = car.path[idx];
      if (step.kind !== 'grid') break;
      const nextStep = car.path[idx + 1];
      if (nextStep.kind !== 'grid') break;

      const tile = step.pos;
      const nxtTile = nextStep.pos;
      const dir = getDirection(tile, nxtTile);
      const lane = directionToLane(dir);

      // Check tiles without allocating an array
      if (offset === 0 && car.segmentProgress >= 0.5) {
        // Only next tile
        const r = this.scanBucket(occupancyKey(nxtTile.gx, nxtTile.gy, lane), car, carPx, carPy, offset, bestGapSq);
        if (r.id) { bestId = r.id; bestGapSq = r.gapSq; }
      } else if (offset === 0) {
        // Current tile and next tile
        let r = this.scanBucket(occupancyKey(tile.gx, tile.gy, lane), car, carPx, carPy, offset, bestGapSq);
        if (r.id) { bestId = r.id; bestGapSq = r.gapSq; }
        r = this.scanBucket(occupancyKey(nxtTile.gx, nxtTile.gy, lane), car, carPx, carPy, offset, bestGapSq);
        if (r.id) { bestId = r.id; bestGapSq = r.gapSq; }
      } else {
        // Only current tile
        const r = this.scanBucket(occupancyKey(tile.gx, tile.gy, lane), car, carPx, carPy, offset, bestGapSq);
        if (r.id) { bestId = r.id; bestGapSq = r.gapSq; }
      }

      // If we found a leader on this tile segment, no need to scan further
      if (bestId !== null) break;
    }

    if (bestId !== null) {
      car.leaderId = bestId;
      car.leaderGap = Math.sqrt(bestGapSq);
    }
  }
}
