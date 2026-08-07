import type { Grid } from '../core/Grid';
import type { Cell } from '../types';

interface CellSnapshot {
  gx: number;
  gy: number;
  cell: Cell; // deep copy
}

interface InventoryDelta {
  roads: number;
  highways: number;
  gasStations: number;
}

interface UndoGroup {
  cellSnapshots: Map<string, CellSnapshot>;
  inventoryDelta: InventoryDelta;
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

  addInventoryDelta(slot: 'roads' | 'highways' | 'gasStations', delta: number): void {
    if (!this.currentGroup) return;
    this.currentGroup.inventoryDelta[slot] += delta;
  }

  endGroup(): void {
    if (!this.currentGroup) return;
    if (this.currentGroup.cellSnapshots.size === 0) {
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
