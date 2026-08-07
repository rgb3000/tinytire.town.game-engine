import type { InputHandler } from './InputHandler';
import type { GasStationSystem } from '../systems/GasStationSystem';
import type { Grid } from '../core/Grid';
import type { InventorySlot } from './RoadDrawer';
import { CellType, Tool } from '../types';
import type { GridPos } from '../types';

export class GasStationPlacer {
  private input: InputHandler;
  private gasStationSystem: GasStationSystem;
  private grid: Grid;
  private stock: InventorySlot;
  private getActiveTool: () => Tool;
  private wasLeftDown = false;
  private previewCells: GridPos[] | null = null;

  onGasStationPlace: (() => void) | null = null;

  constructor(
    input: InputHandler,
    gasStationSystem: GasStationSystem,
    grid: Grid,
    stock: InventorySlot,
    getActiveTool: () => Tool,
  ) {
    this.input = input;
    this.gasStationSystem = gasStationSystem;
    this.grid = grid;
    this.stock = stock;
    this.getActiveTool = getActiveTool;
  }

  getPreviewCells(): GridPos[] | null {
    return this.previewCells;
  }

  update(): void {
    if (this.getActiveTool() !== Tool.GasStation) {
      this.wasLeftDown = this.input.state.leftDown;
      this.previewCells = null;
      return;
    }

    const { gridPos, leftDown } = this.input.state;
    const pos = { gx: gridPos.gx, gy: gridPos.gy };

    // Single-tile preview
    if (this.canPlace(pos)) {
      this.previewCells = [pos];
    } else {
      this.previewCells = null;
    }

    if (leftDown && !this.wasLeftDown) {
      if (!this.stock.hasStock(1)) {
        this.wasLeftDown = leftDown;
        return;
      }

      if (this.canPlace(pos)) {
        const station = this.gasStationSystem.placeGasStation(pos);
        if (station) {
          this.stock.consume(1);
          this.onGasStationPlace?.();
        }
      }
    }

    this.wasLeftDown = leftDown;
  }

  private canPlace(pos: GridPos): boolean {
    if (!this.grid.inBounds(pos.gx, pos.gy)) return false;
    const cell = this.grid.getCell(pos.gx, pos.gy);
    return !!cell && cell.type === CellType.Empty;
  }
}
