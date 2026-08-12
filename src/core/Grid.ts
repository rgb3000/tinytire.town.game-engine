import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../constants';
import { type Cell, CellType, Direction, type GridPos, type PixelPos } from '../types';
import { ALL_DIRECTIONS, CARDINAL_DIRECTIONS, DIRECTION_OFFSETS, connectionCount } from '../utils/direction';

export class Grid {
  readonly cols: number;
  readonly rows: number;
  private cells: Cell[];

  constructor(cols: number = GRID_COLS, rows: number = GRID_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = { type: CellType.Empty, entityId: null, roadConnections: 0, color: null, connectorDir: null, pendingDeletion: false, _isIntersection: false };
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

  /**
   * Recompute the cached `_isIntersection` flag for every road cell.
   *
   * The count is over **all eight** connections, not the four cardinal ones. Diagonal roads
   * are first-class here — `RoadSystem.connectRoads` accepts any Chebyshev-1 neighbour,
   * `RoadDrawer` places them deliberately and `Pathfinder` traverses them — so a cell wired
   * `Left | Right | UpLeft` is a genuine three-way merge. Counting cardinals only scored it
   * 2 and left it plain road, which put it outside junction admission entirely; and the
   * following model cannot see the merge either, because a lane is a *directed* edge
   * (`laneKey`) and the two converging cars sit in different buckets until each has passed
   * the cell centre. Both safety mechanisms missed the same ground, which is exactly the
   * thing the two of them together are supposed to make impossible.
   */
  recomputeIntersectionFlags(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      cell._isIntersection = cell.type === CellType.Road
        && connectionCount(cell.roadConnections) >= 3;
    }
  }
}
