import type { GridPos, PixelPos } from '../types';
import type { Highway } from '../highways/types';
import { generateId } from '../utils/math';
import { sampleHighwayPolyline } from '../highways/highwayGeometry';
import { gridToPixelCenter } from '../utils/math';

export class HighwaySystem {
  private highways = new Map<string, Highway>();
  isDirty = false;

  addHighway(from: GridPos, to: GridPos, cp1: PixelPos, cp2: PixelPos): Highway {
    const id = generateId();
    const { polyline, cumDist, arcLength } = sampleHighwayPolyline(from, to, cp1, cp2);
    const highway: Highway = {
      id,
      fromPos: { ...from },
      toPos: { ...to },
      cp1: { ...cp1 },
      cp2: { ...cp2 },
      arcLength,
      polyline,
      cumDist,
    };
    this.highways.set(id, highway);
    this.isDirty = true;
    return highway;
  }

  /**
   * Put a previously removed highway back, keeping its original id and geometry.
   *
   * The stored `Highway` already carries its sampled polyline and cumulative distances, so
   * this re-inserts rather than re-deriving: `addHighway` would mint a fresh id, which any
   * `PathStep` still referencing the old one would no longer resolve.
   */
  restore(highway: Highway): void {
    this.highways.set(highway.id, highway);
    this.isDirty = true;
  }

  removeHighway(id: string): boolean {
    const removed = this.highways.delete(id);
    if (removed) this.isDirty = true;
    return removed;
  }

  updateEndpoint(id: string, which: 'from' | 'to', newPos: GridPos): void {
    const hw = this.highways.get(id);
    if (!hw) return;
    const oldPixel = gridToPixelCenter(which === 'from' ? hw.fromPos : hw.toPos);
    const newPixel = gridToPixelCenter(newPos);
    const dx = newPixel.x - oldPixel.x;
    const dy = newPixel.y - oldPixel.y;
    const cp = which === 'from' ? hw.cp1 : hw.cp2;
    cp.x += dx;
    cp.y += dy;
    if (which === 'from') {
      hw.fromPos = { ...newPos };
    } else {
      hw.toPos = { ...newPos };
    }
    const { polyline, cumDist, arcLength } = sampleHighwayPolyline(hw.fromPos, hw.toPos, hw.cp1, hw.cp2);
    hw.polyline = polyline;
    hw.cumDist = cumDist;
    hw.arcLength = arcLength;
    this.isDirty = true;
  }

  updateControlPoints(id: string, cp1: PixelPos, cp2: PixelPos): void {
    const hw = this.highways.get(id);
    if (!hw) return;
    hw.cp1 = { ...cp1 };
    hw.cp2 = { ...cp2 };
    const { polyline, cumDist, arcLength } = sampleHighwayPolyline(hw.fromPos, hw.toPos, cp1, cp2);
    hw.polyline = polyline;
    hw.cumDist = cumDist;
    hw.arcLength = arcLength;
    this.isDirty = true;
  }

  getHighwaysAtCell(gx: number, gy: number): Highway[] {
    const result: Highway[] = [];
    for (const hw of this.highways.values()) {
      if ((hw.fromPos.gx === gx && hw.fromPos.gy === gy) ||
          (hw.toPos.gx === gx && hw.toPos.gy === gy)) {
        result.push(hw);
      }
    }
    return result;
  }

  getAll(): Highway[] {
    return Array.from(this.highways.values());
  }

  getById(id: string): Highway | undefined {
    return this.highways.get(id);
  }

  clearDirty(): void {
    this.isDirty = false;
  }
}
