import type { InputHandler } from './InputHandler';
import type { HighwaySystem } from '../systems/HighwaySystem';
import type { Grid } from '../core/Grid';
import type { InventorySlot } from './RoadDrawer';
import type { GridPos } from '../types';
import { CellType, Tool } from '../types';
import { TILE_SIZE } from '../constants';
import { defaultControlPoints } from '../highways/highwayGeometry';

export type HighwayPhase = 'idle' | 'awaiting-second-click' | 'placing' | 'editing';

export interface HighwayPlacementState {
  phase: HighwayPhase;
  firstPos: GridPos | null;
  activeHighwayId: string | null;
  draggingCp: 'cp1' | 'cp2' | null;
}

const CP_HIT_RADIUS = 20; // px
const ENDPOINT_HIT_RADIUS = TILE_SIZE * 0.5;

export class HighwayDrawer {
  private input: InputHandler;
  private highwaySystem: HighwaySystem;
  private grid: Grid;
  private stock: InventorySlot;
  private getActiveTool: () => Tool;

  private phase: HighwayPhase = 'idle';
  private firstPos: GridPos | null = null;
  private activeHighwayId: string | null = null;
  private draggingCp: 'cp1' | 'cp2' | null = null;
  private draggingEndpoint: 'from' | 'to' | null = null;
  private wasLeftDown = false;
  private wasRightDown = false;

  onHighwayPlace: (() => void) | null = null;
  onHighwayDelete: (() => void) | null = null;

  constructor(
    input: InputHandler,
    highwaySystem: HighwaySystem,
    grid: Grid,
    stock: InventorySlot,
    getActiveTool: () => Tool,
  ) {
    this.input = input;
    this.highwaySystem = highwaySystem;
    this.grid = grid;
    this.stock = stock;
    this.getActiveTool = getActiveTool;
  }

  getPlacementState(): HighwayPlacementState | null {
    if (this.getActiveTool() !== Tool.Highway) return null;
    return {
      phase: this.phase,
      firstPos: this.firstPos,
      activeHighwayId: this.activeHighwayId,
      draggingCp: this.draggingCp,
    };
  }

  update(): void {
    if (this.getActiveTool() !== Tool.Highway) {
      // If we were mid-placement, finalize
      if (this.phase !== 'idle') {
        this.finalize();
      }
      return;
    }

    const { gridPos, leftDown, rightDown, canvasX, canvasY } = this.input.state;

    // Right-click cancels
    if (rightDown && !this.wasRightDown) {
      if (this.phase === 'awaiting-second-click') {
        this.phase = 'idle';
        this.firstPos = null;
      } else if (this.phase === 'placing' && this.activeHighwayId) {
        // Cancel: remove the highway and refund
        this.highwaySystem.removeHighway(this.activeHighwayId);
        this.stock.restore(1);
        this.phase = 'idle';
        this.activeHighwayId = null;
        this.draggingCp = null;
      } else if (this.phase === 'editing') {
        this.finalize();
      }
      this.wasLeftDown = leftDown;
      this.wasRightDown = rightDown;
      return;
    }

    if (this.phase === 'idle') {
      if (leftDown && !this.wasLeftDown) {
        // First: hit-test control points of all existing highways
        const cpHit = this.hitTestAllControlPoints(canvasX, canvasY);
        if (cpHit) {
          this.activeHighwayId = cpHit.highwayId;
          this.draggingCp = cpHit.cp;
          this.phase = 'editing';
        } else {
          // Second: hit-test endpoints of all existing highways
          const epHit = this.hitTestAllEndpoints(canvasX, canvasY);
          if (epHit) {
            this.activeHighwayId = epHit.highwayId;
            this.draggingEndpoint = epHit.which;
            this.phase = 'editing';
          } else {
            // Neither hit — start new highway creation
            if (this.isValidEndpoint(gridPos.gx, gridPos.gy)) {
              this.firstPos = { ...gridPos };
              this.phase = 'awaiting-second-click';
            }
          }
        }
      }
    } else if (this.phase === 'awaiting-second-click') {
      if (leftDown && !this.wasLeftDown) {
        if (this.isValidEndpoint(gridPos.gx, gridPos.gy) && this.firstPos &&
            !(gridPos.gx === this.firstPos.gx && gridPos.gy === this.firstPos.gy)) {
          // Check we can afford it
          if (!this.stock.hasStock(1)) {
            this.wasLeftDown = leftDown;
            this.wasRightDown = rightDown;
            return;
          }

          // Create highway with default control points
          const { cp1, cp2 } = defaultControlPoints(this.firstPos, gridPos);
          const hw = this.highwaySystem.addHighway(this.firstPos, gridPos, cp1, cp2);
          this.stock.consume(1);
          this.activeHighwayId = hw.id;
          this.phase = 'placing';
          this.onHighwayPlace?.();
        }
      }
    } else if (this.phase === 'placing') {
      if (leftDown && !this.wasLeftDown) {
        // Check if clicking on a control point
        if (this.activeHighwayId) {
          const hw = this.highwaySystem.getById(this.activeHighwayId);
          if (hw) {
            const cp = this.hitTestControlPoint(canvasX, canvasY, hw.cp1, hw.cp2);
            if (cp) {
              this.draggingCp = cp;
            } else {
              // Click elsewhere → finalize
              this.finalize();
            }
          }
        }
      } else if (leftDown && this.draggingCp && this.activeHighwayId) {
        // Dragging control point
        const hw = this.highwaySystem.getById(this.activeHighwayId);
        if (hw) {
          const newCp1 = this.draggingCp === 'cp1' ? { x: canvasX, y: canvasY } : hw.cp1;
          const newCp2 = this.draggingCp === 'cp2' ? { x: canvasX, y: canvasY } : hw.cp2;
          this.highwaySystem.updateControlPoints(this.activeHighwayId, newCp1, newCp2);
        }
      } else if (!leftDown && this.wasLeftDown && this.draggingCp) {
        // Released drag
        this.draggingCp = null;
      }
    } else if (this.phase === 'editing') {
      if (leftDown && this.activeHighwayId) {
        if (this.draggingCp) {
          // Dragging a control point on an existing highway
          const hw = this.highwaySystem.getById(this.activeHighwayId);
          if (hw) {
            const newCp1 = this.draggingCp === 'cp1' ? { x: canvasX, y: canvasY } : hw.cp1;
            const newCp2 = this.draggingCp === 'cp2' ? { x: canvasX, y: canvasY } : hw.cp2;
            this.highwaySystem.updateControlPoints(this.activeHighwayId, newCp1, newCp2);
          }
        } else if (this.draggingEndpoint) {
          // Dragging an endpoint on an existing highway
          if (this.isValidEndpoint(gridPos.gx, gridPos.gy)) {
            this.highwaySystem.updateEndpoint(this.activeHighwayId, this.draggingEndpoint, { ...gridPos });
          }
        }
      } else if (!leftDown && this.wasLeftDown) {
        // Released drag — go back to idle
        this.draggingCp = null;
        this.draggingEndpoint = null;
        this.activeHighwayId = null;
        this.phase = 'idle';
      }
    }

    this.wasLeftDown = leftDown;
    this.wasRightDown = rightDown;
  }

  /** Try to erase a highway at the given cell */
  tryEraseAtCell(gx: number, gy: number): boolean {
    const highways = this.highwaySystem.getHighwaysAtCell(gx, gy);
    if (highways.length === 0) return false;
    for (const hw of highways) {
      this.highwaySystem.removeHighway(hw.id);
      this.stock.restore(1);
    }
    return highways.length > 0;
  }

  private finalize(): void {
    this.phase = 'idle';
    this.firstPos = null;
    this.activeHighwayId = null;
    this.draggingCp = null;
    this.draggingEndpoint = null;
  }

  private isValidEndpoint(gx: number, gy: number): boolean {
    const cell = this.grid.getCell(gx, gy);
    if (!cell) return false;
    return cell.type === CellType.Empty || cell.type === CellType.Road || cell.type === CellType.Connector;
  }

  private hitTestControlPoint(
    worldX: number, worldY: number,
    cp1: { x: number; y: number }, cp2: { x: number; y: number },
  ): 'cp1' | 'cp2' | null {
    const d1 = Math.sqrt((worldX - cp1.x) ** 2 + (worldY - cp1.y) ** 2);
    const d2 = Math.sqrt((worldX - cp2.x) ** 2 + (worldY - cp2.y) ** 2);
    if (d1 < CP_HIT_RADIUS && d1 <= d2) return 'cp1';
    if (d2 < CP_HIT_RADIUS) return 'cp2';
    return null;
  }

  private hitTestAllControlPoints(
    worldX: number, worldY: number,
  ): { highwayId: string; cp: 'cp1' | 'cp2' } | null {
    let bestDist = CP_HIT_RADIUS;
    let bestResult: { highwayId: string; cp: 'cp1' | 'cp2' } | null = null;

    for (const hw of this.highwaySystem.getAll()) {
      const d1 = Math.sqrt((worldX - hw.cp1.x) ** 2 + (worldY - hw.cp1.y) ** 2);
      const d2 = Math.sqrt((worldX - hw.cp2.x) ** 2 + (worldY - hw.cp2.y) ** 2);
      if (d1 < bestDist) {
        bestDist = d1;
        bestResult = { highwayId: hw.id, cp: 'cp1' };
      }
      if (d2 < bestDist) {
        bestDist = d2;
        bestResult = { highwayId: hw.id, cp: 'cp2' };
      }
    }

    return bestResult;
  }

  private hitTestAllEndpoints(
    worldX: number, worldY: number,
  ): { highwayId: string; which: 'from' | 'to' } | null {
    let bestDist = ENDPOINT_HIT_RADIUS;
    let bestResult: { highwayId: string; which: 'from' | 'to' } | null = null;

    for (const hw of this.highwaySystem.getAll()) {
      const fromX = (hw.fromPos.gx + 0.5) * TILE_SIZE;
      const fromZ = (hw.fromPos.gy + 0.5) * TILE_SIZE;
      const toX = (hw.toPos.gx + 0.5) * TILE_SIZE;
      const toZ = (hw.toPos.gy + 0.5) * TILE_SIZE;

      const dFrom = Math.sqrt((worldX - fromX) ** 2 + (worldY - fromZ) ** 2);
      const dTo = Math.sqrt((worldX - toX) ** 2 + (worldY - toZ) ** 2);

      if (dFrom < bestDist) {
        bestDist = dFrom;
        bestResult = { highwayId: hw.id, which: 'from' };
      }
      if (dTo < bestDist) {
        bestDist = dTo;
        bestResult = { highwayId: hw.id, which: 'to' };
      }
    }

    return bestResult;
  }
}
