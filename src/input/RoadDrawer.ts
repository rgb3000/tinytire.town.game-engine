import type { InputState } from './InputHandler';
import type { UndoSystem } from './UndoSystem';
import type { RoadSystem } from '../systems/RoadSystem';
import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType, Tool } from '../types';
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../constants';
import { connectionCount, forEachDirection, directionFromDelta, opposite } from '../utils/direction';
import { findRoadPlacementPath, isRoadPassable } from '../pathfinding/RoadPlacementPathfinder';
import { traceDragCells } from './dragTrace';

export interface InventorySlot {
  hasStock(count: number): boolean;
  consume(count: number): void;
  restore(count: number): void;
}

/** The slice of InputHandler that RoadDrawer reads — structural, so Node
 *  tests can drive update() with a plain object instead of a DOM-bound
 *  InputHandler. */
export interface RoadDrawerInput {
  readonly state: InputState;
  panningActive: boolean;
}

type PlaceResult = 'placed' | 'reused' | 'blocked';

export class RoadDrawer {
  private lastGridPos: GridPos | null = null;
  private wasLeftDown = false;
  private wasRightDown = false;
  private input: RoadDrawerInput;
  private roadSystem: RoadSystem;
  private grid: Grid;
  private stock: InventorySlot;
  private undoSystem: UndoSystem | null;
  private getActiveTool: () => Tool;

  private prevPlacedPos: GridPos | null = null;
  private lastBuiltPos: GridPos | null = null;
  private prevCanvasX: number | null = null;
  private prevCanvasY: number | null = null;
  private redirectSource: GridPos | null = null;
  private pendingDragStart: GridPos | null = null;
  private panInterrupted = false;

  onRoadPlace: (() => void) | null = null;
  onRoadDelete: (() => void) | null = null;
  onTryErase: ((gx: number, gy: number) => boolean) | null = null;
  onRescuePendingConnection: ((gx: number, gy: number, dir: number) => void) | null = null;

  constructor(
    input: RoadDrawerInput, roadSystem: RoadSystem, grid: Grid,
    stock: InventorySlot,
    _getHouses: () => unknown[],
    undoSystem: UndoSystem | null,
    getActiveTool: () => Tool = () => Tool.Road,
  ) {
    this.input = input;
    this.roadSystem = roadSystem;
    this.grid = grid;
    this.stock = stock;
    this.undoSystem = undoSystem;
    this.getActiveTool = getActiveTool;
  }

  getLastBuiltPos(): GridPos | null {
    return this.lastBuiltPos;
  }

  /** Connect two cells and rescue any pending connections involved. */
  private connectAndRescue(gx1: number, gy1: number, gx2: number, gy2: number): boolean {
    const result = this.roadSystem.connectRoads(gx1, gy1, gx2, gy2);
    if (!result) return false;

    const dx = gx2 - gx1;
    const dy = gy2 - gy1;
    const dir = directionFromDelta(dx, dy);
    const oppDir = opposite(dir);

    const cell1 = this.grid.getCell(gx1, gy1);
    if (cell1 && cell1.pendingDeletion) {
      this.onRescuePendingConnection?.(gx1, gy1, dir);
    }
    const cell2 = this.grid.getCell(gx2, gy2);
    if (cell2 && cell2.pendingDeletion) {
      this.onRescuePendingConnection?.(gx2, gy2, oppDir);
    }
    return true;
  }

  update(): void {
    const tool = this.getActiveTool();
    if (tool === Tool.Highway || tool === Tool.GasStation) {
      // Reset drag state so we don't carry stale state into next tool switch
      this.wasLeftDown = this.input.state.leftDown;
      this.wasRightDown = this.input.state.rightDown;
      return;
    }

    const { gridPos } = this.input.state;
    const isEraser = this.getActiveTool() === Tool.Eraser;

    // Remap inputs: eraser tool makes left-click erase
    const leftDown = isEraser ? false : this.input.state.leftDown;
    const rightDown = isEraser
      ? (this.input.state.leftDown || this.input.state.rightDown)
      : this.input.state.rightDown;

    if (leftDown) {
      if (!this.wasLeftDown) {
        // Starting a new left-click
        this.undoSystem?.beginGroup();
        const { canvasX: startCX, canvasY: startCY } = this.input.state;
        this.prevCanvasX = startCX;
        this.prevCanvasY = startCY;

        const cell = this.grid.getCell(gridPos.gx, gridPos.gy);

        if (this.input.state.shiftDown && this.lastBuiltPos) {
          // Shift-click: pathfind road from lastBuiltPos to clicked cell
          const path = findRoadPlacementPath(this.grid, this.lastBuiltPos, gridPos);
          if (path) {
            let prev = { ...path[0] };
            let stopped = false;
            for (let i = 0; i < path.length; i++) {
              if (stopped) break;
              const { gx: x, gy: y } = path[i];
              const c = this.grid.getCell(x, y);
              if (c && (c.type === CellType.House || c.type === CellType.GasStation)) {
                this.prevPlacedPos = prev;
                if (this.tryConnectToEndpoint(x, y)) { stopped = true; break; }
              }
              if (!this.stock.hasStock(1) && !(this.grid.getCell(x, y)?.type === CellType.Road || this.grid.getCell(x, y)?.type === CellType.Connector)) {
                this.lastBuiltPos = { ...prev };
                break;
              }
              this.tryPlace(x, y);
              if (prev.gx !== x || prev.gy !== y) {
                this.connectAndRescue(prev.gx, prev.gy, x, y);
              }
              prev = { gx: x, gy: y };
              this.lastBuiltPos = { ...prev };
            }
            if (!stopped) {
              this.lastBuiltPos = { ...prev };
            }
          }
          this.prevPlacedPos = { ...gridPos };
        } else {
          const isOccupied = cell && (cell.type === CellType.Road || cell.type === CellType.Connector || cell.type === CellType.House || cell.type === CellType.Business || cell.type === CellType.GasStation);

          if (isOccupied) {
            this.prevPlacedPos = { ...gridPos };
            // Detect redirect: house with 1+ connection or connector with 2+ (1 permanent + 1 external)
            if (cell) {
              const isHouseWithConn = cell.type === CellType.House && connectionCount(cell.roadConnections) >= 1;
              const isGasStationWithConn = cell.type === CellType.GasStation && connectionCount(cell.roadConnections) >= 1;
              const isConnectorWithExternal = cell.type === CellType.Connector && connectionCount(cell.roadConnections) >= 1;
              if (isHouseWithConn || isGasStationWithConn || isConnectorWithExternal) {
                this.redirectSource = { ...gridPos };
              }
            }
          } else {
            this.pendingDragStart = { ...gridPos };
            this.prevPlacedPos = null;
          }
          if (isOccupied) {
            this.lastBuiltPos = { ...gridPos };
          }
        }
      } else if (this.input.panningActive) {
        // Camera pan with the button still held: hold the drag. The cursor's
        // world position jumps arbitrarily during a pan, so no cells are
        // processed and the segment origin re-anchors when the pan ends.
        this.panInterrupted = true;
      } else {
        // Dragging — walk exactly the cells the cursor path crossed
        const { canvasX, canvasY } = this.input.state;
        if (this.panInterrupted || this.prevCanvasX == null || this.prevCanvasY == null) {
          // Re-anchor after a pan (or a press under another tool): no road
          // bridges the jump, drawing resumes from the current cursor
          this.panInterrupted = false;
          this.prevCanvasX = canvasX;
          this.prevCanvasY = canvasY;
        } else {
          this.applyDragSteps(traceDragCells(this.prevCanvasX, this.prevCanvasY, canvasX, canvasY, TILE_SIZE));
          this.prevCanvasX = canvasX;
          this.prevCanvasY = canvasY;
        }
      }
    }

    if (rightDown) {
      if (!this.wasRightDown) {
        this.undoSystem?.beginGroup();
        this.lastGridPos = { ...gridPos };

        if (isEraser && this.input.state.shiftDown && this.lastBuiltPos) {
          // Shift-click erase: find A* path and erase along it
          const path = findRoadPlacementPath(this.grid, this.lastBuiltPos, gridPos);
          if (path) {
            for (const p of path) {
              this.tryErase(p.gx, p.gy);
            }
            this.lastBuiltPos = { ...gridPos };
          }
        } else {
          this.tryErase(gridPos.gx, gridPos.gy);
          this.lastBuiltPos = { ...gridPos };
        }
      } else if (this.lastGridPos && (gridPos.gx !== this.lastGridPos.gx || gridPos.gy !== this.lastGridPos.gy)) {
        this.bresenhamLine(this.lastGridPos.gx, this.lastGridPos.gy, gridPos.gx, gridPos.gy, (x, y) => {
          this.tryErase(x, y);
        });
        this.lastGridPos = { ...gridPos };
        this.lastBuiltPos = { ...gridPos };
      }
    }

    if (!leftDown && this.wasLeftDown) {
      this.undoSystem?.endGroup();
    }
    if (!rightDown && this.wasRightDown) {
      this.undoSystem?.endGroup();
    }

    if (!leftDown && !rightDown) {
      this.lastGridPos = null;
      this.prevPlacedPos = null;
      this.prevCanvasX = null;
      this.prevCanvasY = null;
      this.redirectSource = null;
      this.pendingDragStart = null;
      this.panInterrupted = false;
    }

    this.wasLeftDown = leftDown;
    this.wasRightDown = rightDown;
  }

  /** Apply traced drag steps to the grid. The chain anchor (`prevPlacedPos`)
   *  advances only when a placement or connection actually succeeded, so a
   *  blocked cell never silently breaks the chain's bookkeeping. */
  private applyDragSteps(steps: GridPos[]): void {
    for (const step of steps) {
      if (step.gx < 0 || step.gx >= GRID_COLS || step.gy < 0 || step.gy >= GRID_ROWS) continue;

      // Resolve the deferred drag start: the cursor has left the press cell
      if (this.pendingDragStart) {
        const start = this.pendingDragStart;
        this.pendingDragStart = null;
        if (this.tryPlace(start.gx, start.gy) !== 'blocked') {
          this.prevPlacedPos = { ...start };
          this.lastBuiltPos = { ...start };
        }
      }

      // A pending redirect consumes steps until it resolves or the drag ends
      if (this.redirectSource) {
        this.tryRedirect(step);
        continue;
      }

      const cell = this.grid.getCell(step.gx, step.gy);
      if (cell && (cell.type === CellType.House || cell.type === CellType.GasStation)) {
        if (this.tryConnectToEndpoint(step.gx, step.gy)) {
          this.prevPlacedPos = { gx: step.gx, gy: step.gy };
          return; // endpoints cap the chain; drop the rest of this trace
        }
        continue; // full or non-adjacent endpoint: leave the anchor in place
      }

      let from = this.prevPlacedPos;
      const dx = from ? step.gx - from.gx : 0;
      const dy = from ? step.gy - from.gy : 0;
      if (from && dx !== 0 && dy !== 0 && Math.abs(dx) === 1 && Math.abs(dy) === 1) {
        // Diagonal step: don't cut a blocked corner (same rule as the A* pathfinder).
        const sideXOpen = isRoadPassable(this.grid, from.gx + dx, from.gy);
        const sideYOpen = isRoadPassable(this.grid, from.gx, from.gy + dy);
        if (!sideXOpen || !sideYOpen) {
          const mid = sideXOpen ? { gx: from.gx + dx, gy: from.gy }
            : sideYOpen ? { gx: from.gx, gy: from.gy + dy } : null;
          if (mid && this.tryPlace(mid.gx, mid.gy) !== 'blocked') {
            // Staircase through the open side, then treat the step as cardinal
            this.connectAndRescue(from.gx, from.gy, mid.gx, mid.gy);
            this.prevPlacedPos = mid;
            this.lastBuiltPos = { ...mid };
            from = mid;
          } else {
            from = null; // no legal way in: place the step cell unconnected
          }
        }
      }

      if (this.tryPlace(step.gx, step.gy) === 'blocked') continue;
      if (from && (from.gx !== step.gx || from.gy !== step.gy)
        && Math.max(Math.abs(step.gx - from.gx), Math.abs(step.gy - from.gy)) === 1) {
        this.connectAndRescue(from.gx, from.gy, step.gx, step.gy);
      }
      this.prevPlacedPos = { gx: step.gx, gy: step.gy };
      this.lastBuiltPos = { gx: step.gx, gy: step.gy };
    }
  }

  /** Handle one drag step while a connection redirect from a house/connector
   *  is pending. Places the new road before disconnecting the old one, so an
   *  out-of-stock redirect leaves the existing connection untouched. */
  private tryRedirect(target: GridPos): void {
    const src = this.redirectSource!;
    const srcCell = this.grid.getCell(src.gx, src.gy);
    const targetCell = this.grid.getCell(target.gx, target.gy);
    if (!srcCell || !targetCell) return;
    if (targetCell.type !== CellType.Empty && targetCell.type !== CellType.Road) return;
    // Must be adjacent to the redirect source
    if (Math.max(Math.abs(target.gx - src.gx), Math.abs(target.gy - src.gy)) !== 1) return;
    const oldRoad = this.findExternalRoadNeighbor(src.gx, src.gy);
    if (!oldRoad) return;

    // Snapshot for undo
    this.undoSystem?.snapshotCellAndNeighbors(oldRoad.gx, oldRoad.gy);
    this.undoSystem?.snapshotCellAndNeighbors(src.gx, src.gy);
    this.undoSystem?.snapshotCellAndNeighbors(target.gx, target.gy);

    // Place the new road first; existing roads don't need placement
    if (this.tryPlace(target.gx, target.gy) === 'blocked') return;

    // Disconnect source from the old road (don't delete the road cell)
    const oldDir = directionFromDelta(oldRoad.gx - src.gx, oldRoad.gy - src.gy);
    srcCell.roadConnections &= ~oldDir;
    const oldRoadCell = this.grid.getCell(oldRoad.gx, oldRoad.gy);
    if (oldRoadCell) {
      oldRoadCell.roadConnections &= ~opposite(oldDir);
    }
    this.roadSystem.markDirty();

    this.connectAndRescue(src.gx, src.gy, target.gx, target.gy);

    this.redirectSource = null;
    this.prevPlacedPos = { ...target };
    this.lastBuiltPos = { ...target };
  }

  private tryPlace(gx: number, gy: number): PlaceResult {
    if (gx < 0 || gx >= GRID_COLS || gy < 0 || gy >= GRID_ROWS) return 'blocked';

    const cell = this.grid.getCell(gx, gy);
    if (cell && cell.type === CellType.Road && cell.pendingDeletion) {
      this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
      // Don't charge stock — rescue of specific connections happens in connectAndRescue
      return 'reused';
    }
    if (cell && (cell.type === CellType.Road || cell.type === CellType.Connector)) {
      // Already drivable, nothing to place — but snapshot, because the
      // follow-up connect mutates this cell's connections.
      this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
      return 'reused';
    }

    if (!this.stock.hasStock(1)) return 'blocked';
    this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
    if (this.roadSystem.placeRoad(gx, gy)) {
      this.stock.consume(1);
      this.undoSystem?.addInventoryDelta('roads', -1);
      this.onRoadPlace?.();
      return 'placed';
    }
    return 'blocked';
  }

  private tryErase(gx: number, gy: number): void {
    if (gx < 0 || gx >= GRID_COLS || gy < 0 || gy >= GRID_ROWS) return;
    // If a delegate is set, let it decide (immediate delete vs pending)
    if (this.onTryErase) {
      this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
      if (this.onTryErase(gx, gy)) {
        this.onRoadDelete?.();
      }
      return;
    }
    this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
    if (this.roadSystem.removeRoad(gx, gy)) {
      this.stock.restore(1);
      this.undoSystem?.addInventoryDelta('roads', 1);
      this.onRoadDelete?.();
    }
  }

  /** Try to connect an adjacent road to a house or gas station cell. */
  private tryConnectToEndpoint(gx: number, gy: number): boolean {
    const cell = this.grid.getCell(gx, gy);
    if (!cell || (cell.type !== CellType.House && cell.type !== CellType.GasStation) || !cell.entityId) return false;
    if (!this.prevPlacedPos) return false;

    // Must be adjacent (Chebyshev distance 1) from prevPlacedPos
    const dx = gx - this.prevPlacedPos.gx;
    const dy = gy - this.prevPlacedPos.gy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;

    // Connect the road to the house directly
    this.undoSystem?.snapshotCellAndNeighbors(gx, gy);
    this.connectAndRescue(this.prevPlacedPos.gx, this.prevPlacedPos.gy, gx, gy);
    this.lastBuiltPos = { gx, gy };
    return true;
  }

  /** Find the adjacent road cell connected to a house/connector/gas station. */
  private findExternalRoadNeighbor(gx: number, gy: number): GridPos | null {
    const cell = this.grid.getCell(gx, gy);
    if (!cell) return null;
    let result: GridPos | null = null;
    forEachDirection(cell.roadConnections, (dir) => {
      if (result) return;
      const neighbor = this.grid.getNeighbor(gx, gy, dir);
      if (!neighbor) return;
      if (neighbor.cell.type === CellType.Road) {
        result = { gx: neighbor.gx, gy: neighbor.gy };
      }
    });
    return result;
  }

  private bresenhamLine(x0: number, y0: number, x1: number, y1: number, callback: (x: number, y: number) => void): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    while (true) {
      callback(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}
