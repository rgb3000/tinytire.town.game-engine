import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType } from '../types';
import { directionFromDelta } from '../utils/direction';
import { PriorityQueue } from '../utils/PriorityQueue';
import { octileDist } from '../utils/math';
import { GRID_COLS, GRID_ROWS } from '../constants';

const SQRT2 = Math.SQRT2;

const NEIGHBORS = [
  { dx: 0, dy: -1, cost: 1, cardinal: true },   // Up
  { dx: 0, dy: 1, cost: 1, cardinal: true },    // Down
  { dx: -1, dy: 0, cost: 1, cardinal: true },   // Left
  { dx: 1, dy: 0, cost: 1, cardinal: true },    // Right
  { dx: -1, dy: -1, cost: SQRT2, cardinal: false }, // UpLeft
  { dx: 1, dy: -1, cost: SQRT2, cardinal: false },  // UpRight
  { dx: -1, dy: 1, cost: SQRT2, cardinal: false },  // DownLeft
  { dx: 1, dy: 1, cost: SQRT2, cardinal: false },   // DownRight
];

/** Passability rule shared by road-placement pathfinding and drag drawing. */
export function isRoadPassable(grid: Grid, gx: number, gy: number): boolean {
  const cell = grid.getCell(gx, gy);
  if (!cell) return false;
  const t = cell.type;
  return t === CellType.Empty || t === CellType.Road || t === CellType.Connector;
}

/** Whether a diagonal road segment from (gx,gy) by (dx,dy) may pass the
 *  shared corner. Terrain (mountain/lake) on either flanking cell blocks it,
 *  as does an existing diagonal connection between the two flanks, which the
 *  new segment would cross mid-corner. Buildings do NOT block: a road may
 *  squeeze between two diagonally adjacent houses. Shared by the A*
 *  pathfinder and drag drawing so both draw the same diagonals. */
export function isDiagonalCutAllowed(grid: Grid, gx: number, gy: number, dx: number, dy: number): boolean {
  const a = grid.getCell(gx + dx, gy);
  const b = grid.getCell(gx, gy + dy);
  if (!a || !b) return false;
  if (a.type === CellType.Mountain || a.type === CellType.Lake) return false;
  if (b.type === CellType.Mountain || b.type === CellType.Lake) return false;
  // Connections are mutual; check both flanks anyway
  return (a.roadConnections & directionFromDelta(-dx, dy)) === 0
    && (b.roadConnections & directionFromDelta(dx, -dy)) === 0;
}

interface Node {
  gx: number;
  gy: number;
  f: number;
}

export function findRoadPlacementPath(grid: Grid, start: GridPos, end: GridPos): GridPos[] | null {
  if (start.gx === end.gx && start.gy === end.gy) return [{ ...start }];

  const cols = GRID_COLS;
  const total = GRID_COLS * GRID_ROWS;

  // Flat arrays for g-costs and parent tracking
  const gCost = new Float64Array(total).fill(Infinity);
  const parentIdx = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);

  const startIdx = start.gy * cols + start.gx;
  const endIdx = end.gy * cols + end.gx;

  gCost[startIdx] = 0;

  const open = new PriorityQueue<Node>((a, b) => a.f - b.f);
  open.push({ gx: start.gx, gy: start.gy, f: octileDist(start, end) });

  while (open.size > 0) {
    const current = open.pop()!;
    const ci = current.gy * cols + current.gx;

    if (ci === endIdx) {
      // Reconstruct path
      const path: GridPos[] = [];
      let idx = endIdx;
      while (idx !== -1) {
        path.push({ gx: idx % cols, gy: (idx / cols) | 0 });
        idx = parentIdx[idx];
      }
      path.reverse();
      return path;
    }

    if (closed[ci]) continue;
    closed[ci] = 1;

    const cg = gCost[ci];

    for (const n of NEIGHBORS) {
      const nx = current.gx + n.dx;
      const ny = current.gy + n.dy;
      if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;

      const ni = ny * cols + nx;
      if (closed[ni]) continue;

      // Check passability (start and end are always passable)
      const isEndpoint = ni === startIdx || ni === endIdx;
      if (!isEndpoint && !isRoadPassable(grid, nx, ny)) continue;

      // Diagonal corner-cutting prevention
      if (!n.cardinal && !isDiagonalCutAllowed(grid, current.gx, current.gy, n.dx, n.dy)) continue;

      const ng = cg + n.cost;
      if (ng < gCost[ni]) {
        gCost[ni] = ng;
        parentIdx[ni] = ci;
        const pos: GridPos = { gx: nx, gy: ny };
        open.push({ gx: nx, gy: ny, f: ng + octileDist(pos, end) });
      }
    }
  }

  return null;
}
