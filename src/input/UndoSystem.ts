import type { Grid } from '../core/Grid';
import type { Cell } from '../types';
import type { Inventory } from '../maps/types';
import type { GasStation } from '../entities/GasStation';
import type { Highway } from '../highways/types';

interface CellSnapshot {
  gx: number;
  gy: number;
  cell: Cell; // deep copy
}

/**
 * Signed counts, not stock levels — but exactly the shape of `Inventory`, so it is aliased
 * rather than restated. A hand-written copy is how `addInventoryDelta`'s slot union came to
 * duplicate `keyof Inventory`.
 */
type InventoryDelta = Inventory;

export interface UndoGroup {
  cellSnapshots: Map<string, CellSnapshot>;
  inventoryDelta: InventoryDelta;
  /**
   * Entities destroyed by this edit, held by reference so they can be put back with their
   * original ids — a cell snapshot alone cannot resurrect them, it only restores a cell
   * whose `entityId` points at something that no longer exists.
   *
   * Recorded here but *applied* by the caller, the same way `inventoryDelta` is: that keeps
   * this class's only system dependency `Grid`.
   */
  removedGasStations: GasStation[];
  removedHighways: Highway[];
}

const MAX_UNDO_STACK = 50;

function deepCopyCell(cell: Cell): Cell {
  return {
    type: cell.type,
    entityId: cell.entityId,
    roadConnections: cell.roadConnections,
    color: cell.color,
    connectorDir: cell.connectorDir,
    pendingDeletion: cell.pendingDeletion,
    _isIntersection: cell._isIntersection,
    _isTIntersection: cell._isTIntersection,
  };
}

export class UndoSystem {
  private stack: UndoGroup[] = [];
  private currentGroup: UndoGroup | null = null;
  private grid: Grid;

  constructor(grid: Grid) {
    this.grid = grid;
  }

  beginGroup(): void {
    this.currentGroup = {
      cellSnapshots: new Map(),
      inventoryDelta: { roads: 0, highways: 0, gasStations: 0 },
      removedGasStations: [],
      removedHighways: [],
    };
  }

  snapshotCellAndNeighbors(gx: number, gy: number): void {
    if (!this.currentGroup) return;
    this.snapshotCell(gx, gy);
    for (const dir of this.grid.getAllDirections()) {
      const neighbor = this.grid.getNeighbor(gx, gy, dir);
      if (neighbor) {
        this.snapshotCell(neighbor.gx, neighbor.gy);
      }
    }
  }

  private snapshotCell(gx: number, gy: number): void {
    if (!this.currentGroup) return;
    const key = `${gx},${gy}`;
    if (this.currentGroup.cellSnapshots.has(key)) return; // idempotent
    const cell = this.grid.getCell(gx, gy);
    if (!cell) return;
    this.currentGroup.cellSnapshots.set(key, {
      gx,
      gy,
      cell: deepCopyCell(cell),
    });
  }

  addInventoryDelta(slot: keyof Inventory, delta: number): void {
    if (!this.currentGroup) return;
    this.currentGroup.inventoryDelta[slot] += delta;
  }

  addRemovedGasStation(station: GasStation): void {
    if (!this.currentGroup) return;
    this.currentGroup.removedGasStations.push(station);
  }

  addRemovedHighway(highway: Highway): void {
    if (!this.currentGroup) return;
    this.currentGroup.removedHighways.push(highway);
  }

  /** Whether this group would change anything if undone. */
  private isEmpty(group: UndoGroup): boolean {
    return group.cellSnapshots.size === 0
      && group.removedGasStations.length === 0
      && group.removedHighways.length === 0;
  }

  endGroup(): void {
    if (!this.currentGroup) return;
    // Tests emptiness across everything a group can hold, not just cells. Today every erase
    // is snapshotted by `RoadDrawer` before it delegates, so a group with entities always
    // has cells too; this keeps a future entity-only recorder from being silently dropped.
    if (this.isEmpty(this.currentGroup)) {
      this.currentGroup = null;
      return;
    }
    this.stack.push(this.currentGroup);
    if (this.stack.length > MAX_UNDO_STACK) {
      this.stack.shift();
    }
    this.currentGroup = null;
  }

  undo(): UndoGroup | null {
    const group = this.stack.pop();
    if (!group) return null;

    // Restore all snapshotted cells
    for (const snapshot of group.cellSnapshots.values()) {
      this.grid.setCell(snapshot.gx, snapshot.gy, deepCopyCell(snapshot.cell));
    }

    return group;
  }

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  clear(): void {
    this.stack = [];
    this.currentGroup = null;
  }
}
