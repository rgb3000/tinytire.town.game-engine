import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../constants';
import { type Cell, CellType, Direction, type GridPos, type PixelPos } from '../types';
import { ALL_DIRECTIONS, CARDINAL_DIRECTIONS, DIRECTION_OFFSETS, cardinalConnectionCount } from '../utils/direction';

export class Grid {
  readonly cols: number;
  readonly rows: number;
  private cells: Cell[];

  constructor(cols: number = GRID_COLS, rows: number = GRID_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = { type: CellType.Empty, entityId: null, roadConnections: 0, color: null, connectorDir: null, pendingDeletion: false, _isIntersection: false, _isTIntersection: false };
    }
  }

  inBounds(gx: number, gy: number): boolean {
    return gx >= 0 && gx < this.cols && gy >= 0 && gy < this.rows;
  }

  getCell(gx: number, gy: number): Cell | null {
    if (!this.inBounds(gx, gy)) return null;
    return this.cells[gy * this.cols + gx];
  }

  setCell(gx: number, gy: number, cell: Partial<Cell>): void {
    if (!this.inBounds(gx, gy)) return;
    const existing = this.cells[gy * this.cols + gx];
    Object.assign(existing, cell);
  }

  /**
   * Return a cell to the empty state, every field of it.
   *
   * Five copies of this object literal used to sit in `RoadSystem`, `GasStationSystem` and
   * `MapDesigner`, and they disagreed: the gas-station one omitted `pendingDeletion`, so
   * erasing a station from a cell that was mid-pending-deletion left the flag set and the
   * cell rendering as faded forever. One definition, matching the constructor's defaults.
   */
  clearCell(gx: number, gy: number): void {
    if (!this.inBounds(gx, gy)) return;
    const cell = this.cells[gy * this.cols + gx];
    cell.type = CellType.Empty;
    cell.entityId = null;
    cell.roadConnections = 0;
    cell.color = null;
    cell.connectorDir = null;
    cell.pendingDeletion = false;
    cell._isIntersection = false;
    cell._isTIntersection = false;
  }

  pixelToGrid(px: number, py: number): GridPos {
    return {
      gx: Math.floor(px / TILE_SIZE),
      gy: Math.floor(py / TILE_SIZE),
    };
  }

  gridToPixelCenter(pos: GridPos): PixelPos {
    return {
      x: pos.gx * TILE_SIZE + TILE_SIZE / 2,
      y: pos.gy * TILE_SIZE + TILE_SIZE / 2,
    };
  }

  getNeighbor(gx: number, gy: number, dir: Direction): { gx: number; gy: number; cell: Cell } | null {
    const offset = DIRECTION_OFFSETS[dir];
    const nx = gx + offset.gx;
    const ny = gy + offset.gy;
    const cell = this.getCell(nx, ny);
    if (!cell) return null;
    return { gx: nx, gy: ny, cell };
  }

  getRoadNeighbors(gx: number, gy: number): { dir: Direction; gx: number; gy: number }[] {
    const results: { dir: Direction; gx: number; gy: number }[] = [];
    for (const dir of ALL_DIRECTIONS) {
      const n = this.getNeighbor(gx, gy, dir);
      if (!n) continue;
      if (n.cell.type === CellType.Road || n.cell.type === CellType.Connector || n.cell.type === CellType.House || n.cell.type === CellType.GasStation) {
        results.push({ dir, gx: n.gx, gy: n.gy });
      }
    }
    return results;
  }

  getEmptyCells(): GridPos[] {
    const empty: GridPos[] = [];
    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        if (this.cells[gy * this.cols + gx].type === CellType.Empty) {
          empty.push({ gx, gy });
        }
      }
    }
    return empty;
  }

  getAllDirections(): readonly Direction[] {
    return ALL_DIRECTIONS;
  }

  getCardinalDirections(): readonly Direction[] {
    return CARDINAL_DIRECTIONS;
  }

  getDirectionOffset(dir: Direction): GridPos {
    return DIRECTION_OFFSETS[dir];
  }

  /** Get bounding box of active gameplay cells (excludes Empty, Mountain, Lake) */
  getActiveArea(): { minGx: number; minGy: number; maxGx: number; maxGy: number } | null {
    let minGx = this.cols;
    let minGy = this.rows;
    let maxGx = -1;
    let maxGy = -1;

    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        const cell = this.cells[gy * this.cols + gx];
        if (cell.type !== CellType.Empty && cell.type !== CellType.Mountain && cell.type !== CellType.Lake) {
          if (gx < minGx) minGx = gx;
          if (gx > maxGx) maxGx = gx;
          if (gy < minGy) minGy = gy;
          if (gy > maxGy) maxGy = gy;
        }
      }
    }

    if (maxGx < 0) return null;
    return { minGx, minGy, maxGx, maxGy };
  }

  /** Recompute cached _isIntersection and _isTIntersection flags for all road cells */
  recomputeIntersectionFlags(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell.type === CellType.Road) {
        const count = cardinalConnectionCount(cell.roadConnections);
        cell._isIntersection = count >= 3;
        cell._isTIntersection = count === 3;
      } else {
        cell._isIntersection = false;
        cell._isTIntersection = false;
      }
    }
  }
}
