import type { Grid } from '../core/Grid';
import { CellType, type GridPos } from '../types';
import { gridPosEqual, gridPosKey, octileDist } from '../utils/math';
import { PriorityQueue } from '../utils/PriorityQueue';
import { opposite, isDiagonalDir, ALL_DIRECTIONS, DIRECTION_OFFSETS } from '../utils/direction';
import type { HighwaySystem } from '../systems/HighwaySystem';
import type { PathStep } from '../highways/types';
import { TILE_SIZE } from '../constants';
import type { GameConstants } from '../maps/types';

interface AStarNode {
  gx: number;
  gy: number;
  g: number;
  f: number;
  parentKey: string | null;
  viaHighwayId: string | null;
}

export class Pathfinder {
  private cache = new Map<string, PathStep[] | null>();
  private grid: Grid;
  private highwaySystem: HighwaySystem | null;
  private cfg: Pick<GameConstants, 'HIGHWAY_SPEED_MULTIPLIER'>;

  constructor(grid: Grid, cfg: Pick<GameConstants, 'HIGHWAY_SPEED_MULTIPLIER'>, highwaySystem?: HighwaySystem) {
    this.grid = grid;
    this.cfg = cfg;
    this.highwaySystem = highwaySystem ?? null;
  }

  clearCache(): void {
    this.cache.clear();
  }

  findPath(from: GridPos, to: GridPos, allowPendingDeletion = false): PathStep[] | null {
    if (gridPosEqual(from, to)) return [{ kind: 'grid', pos: from }];

    const cacheKey = `${gridPosKey(from)}->${gridPosKey(to)}${allowPendingDeletion ? ':pd' : ''}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const result = this.astar(from, to, allowPendingDeletion);
    this.cache.set(cacheKey, result);
    return result;
  }

  private astar(from: GridPos, to: GridPos, allowPendingDeletion = false): PathStep[] | null {
    const open = new PriorityQueue<AStarNode>((a, b) => a.f - b.f);
    const closed = new Map<string, AStarNode>();

    const startNode: AStarNode = {
      gx: from.gx,
      gy: from.gy,
      g: 0,
      f: octileDist(from, to),
      parentKey: null,
      viaHighwayId: null,
    };
    open.push(startNode);

    while (open.size > 0) {
      const current = open.pop()!;
      const currentKey = `${current.gx},${current.gy}`;

      if (current.gx === to.gx && current.gy === to.gy) {
        return this.reconstructPath(current, closed);
      }

      if (closed.has(currentKey)) continue;
      closed.set(currentKey, current);

      const currentCell = this.grid.getCell(current.gx, current.gy);

      // Normal neighbor expansion
      for (const dir of ALL_DIRECTIONS) {
        const off = DIRECTION_OFFSETS[dir];
        const diag = isDiagonalDir(dir);

        if (currentCell && (currentCell.type === CellType.Road || currentCell.type === CellType.Connector || currentCell.type === CellType.House || currentCell.type === CellType.GasStation)) {
          if (!(currentCell.roadConnections & dir)) continue;
        }

        const nx = current.gx + off.gx;
        const ny = current.gy + off.gy;

        const cell = this.grid.getCell(nx, ny);
        if (!cell) continue;
        if (cell.pendingDeletion && !allowPendingDeletion) continue;

        const isDestination = nx === to.gx && ny === to.gy;
        if (cell.type === CellType.Empty) continue;
        if (cell.type === CellType.Business) continue;
        if (cell.type === CellType.GasStation && !isDestination) continue;
        if (cell.type === CellType.House && !isDestination) continue;
        if (cell.type === CellType.House || cell.type === CellType.GasStation) {
          // Can only enter from a direction the endpoint has a road connection toward
          if (!(cell.roadConnections & opposite(dir))) continue;
        }

        const nKey = `${nx},${ny}`;
        if (closed.has(nKey)) continue;

        const g = current.g + (diag ? Math.SQRT2 : 1);
        const h = octileDist({ gx: nx, gy: ny }, to);
        const f = g + h;

        open.push({
          gx: nx,
          gy: ny,
          g,
          f,
          parentKey: currentKey,
          viaHighwayId: null,
        });
      }

      // Highway virtual edge expansion
      if (this.highwaySystem) {
        const highways = this.highwaySystem.getHighwaysAtCell(current.gx, current.gy);
        for (const hw of highways) {
          // Determine the other end of the highway
          let targetPos: GridPos;
          if (hw.fromPos.gx === current.gx && hw.fromPos.gy === current.gy) {
            targetPos = hw.toPos;
          } else {
            targetPos = hw.fromPos;
          }

          const tKey = `${targetPos.gx},${targetPos.gy}`;
          if (closed.has(tKey)) continue;

          // Check target cell is traversable
          const targetCell = this.grid.getCell(targetPos.gx, targetPos.gy);
          if (!targetCell) continue;
          if (targetCell.type !== CellType.Road && targetCell.type !== CellType.Connector) continue;
          if (targetCell.pendingDeletion && !allowPendingDeletion) continue;

          // Cost = arcLength in tiles, reduced by speed multiplier
          const costInTiles = (hw.arcLength / TILE_SIZE) / this.cfg.HIGHWAY_SPEED_MULTIPLIER;
          const g = current.g + costInTiles;
          const h = octileDist(targetPos, to);
          const f = g + h;

          open.push({
            gx: targetPos.gx,
            gy: targetPos.gy,
            g,
            f,
            parentKey: currentKey,
            viaHighwayId: hw.id,
          });
        }
      }
    }

    return null;
  }

  private reconstructPath(endNode: AStarNode, closed: Map<string, AStarNode>): PathStep[] {
    const steps: PathStep[] = [];
    let current: AStarNode | undefined = endNode;

    while (current) {
      if (current.viaHighwayId && current.parentKey) {
        const parent = closed.get(current.parentKey);
        if (parent) {
          // Push grid step for highway destination (will appear AFTER highway step when reversed)
          steps.push({ kind: 'grid', pos: { gx: current.gx, gy: current.gy } });
          steps.push({
            kind: 'highway',
            highwayId: current.viaHighwayId,
            from: { gx: parent.gx, gy: parent.gy },
            to: { gx: current.gx, gy: current.gy },
          });
        } else {
          steps.push({ kind: 'grid', pos: { gx: current.gx, gy: current.gy } });
        }
      } else {
        steps.push({ kind: 'grid', pos: { gx: current.gx, gy: current.gy } });
      }

      if (current.parentKey === null) break;
      current = closed.get(current.parentKey);
    }

    steps.reverse();
    return steps;
  }
}
