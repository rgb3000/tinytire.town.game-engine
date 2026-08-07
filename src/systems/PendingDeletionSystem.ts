import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType } from '../types';
import type { RoadSystem } from './RoadSystem';

interface PendingEntry {
  carIds: Set<string>;
  pendingConnections: number;
}

export class PendingDeletionSystem {
  private grid: Grid;
  private roadSystem: RoadSystem;
  /** Map from "gx,gy" cell key to pending entry tracking car IDs and connection bitmask */
  private pendingCells = new Map<string, PendingEntry>();

  constructor(grid: Grid, roadSystem: RoadSystem) {
    this.grid = grid;
    this.roadSystem = roadSystem;
  }

  private cellKey(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }

  markPending(gx: number, gy: number, carIds: string[]): void {
    const cell = this.grid.getCell(gx, gy);
    if (!cell) return;
    cell.pendingDeletion = true;
    const key = this.cellKey(gx, gy);
    const existing = this.pendingCells.get(key);
    if (existing) {
      for (const id of carIds) existing.carIds.add(id);
    } else {
      const set = new Set(carIds);
      this.pendingCells.set(key, {
        carIds: set,
        pendingConnections: cell.roadConnections,
      });
    }
    // Mark roads dirty so renderer shows the faded state
    this.roadSystem.markDirty();
  }

  cancelPending(gx: number, gy: number): void {
    const key = this.cellKey(gx, gy);
    const cell = this.grid.getCell(gx, gy);
    if (cell) cell.pendingDeletion = false;
    this.pendingCells.delete(key);
    this.roadSystem.markDirty();
  }

  rescueConnection(gx: number, gy: number, dir: number): void {
    const key = this.cellKey(gx, gy);
    const entry = this.pendingCells.get(key);
    if (!entry) return;

    entry.pendingConnections &= ~dir;

    const cell = this.grid.getCell(gx, gy);
    if (cell) {
      // Strip still-pending connections from the cell so only rescued ones are active.
      // Neighbor reciprocals are cleaned up later during finalization.
      cell.roadConnections &= ~entry.pendingConnections;
      cell.pendingDeletion = false;
    }

    if (entry.pendingConnections === 0) {
      this.pendingCells.delete(key);
    }
    this.roadSystem.markDirty();
  }

  isPending(gx: number, gy: number): boolean {
    return this.pendingCells.has(this.cellKey(gx, gy));
  }

  notifyCarPassed(carId: string, gx: number, gy: number): void {
    const key = this.cellKey(gx, gy);
    const entry = this.pendingCells.get(key);
    if (!entry) return;
    entry.carIds.delete(carId);
  }

  notifyCarRemoved(carId: string): void {
    for (const entry of this.pendingCells.values()) {
      entry.carIds.delete(carId);
    }
  }

  notifyCarTransitionedHome(carId: string, newPath: GridPos[]): void {
    // Remove carId from all pending cells
    for (const entry of this.pendingCells.values()) {
      entry.carIds.delete(carId);
    }
    // Re-add carId to pending cells that are in the new GoingHome path
    for (const pos of newPath) {
      const key = this.cellKey(pos.gx, pos.gy);
      const entry = this.pendingCells.get(key);
      if (entry) entry.carIds.add(carId);
    }
  }

  update(): void {
    const toFinalize: { gx: number; gy: number; pendingConnections: number }[] = [];
    for (const [key, entry] of this.pendingCells) {
      const [gxStr, gyStr] = key.split(',');
      const gx = parseInt(gxStr, 10);
      const gy = parseInt(gyStr, 10);
      const cell = this.grid.getCell(gx, gy);
      // Reconcile: clean up if cell no longer exists or isn't a road (e.g. undo or fully removed)
      if (!cell || cell.type !== CellType.Road) {
        this.pendingCells.delete(key);
        continue;
      }
      if (entry.carIds.size === 0) {
        toFinalize.push({ gx, gy, pendingConnections: entry.pendingConnections });
      }
    }
    for (const { gx, gy, pendingConnections } of toFinalize) {
      this.pendingCells.delete(this.cellKey(gx, gy));
      this.roadSystem.removeConnections(gx, gy, pendingConnections);
      // Clear pending flag on the cell (it may still exist as Road with remaining connections)
      const cell = this.grid.getCell(gx, gy);
      if (cell) cell.pendingDeletion = false;
    }
  }

  reset(): void {
    this.pendingCells.clear();
  }
}
