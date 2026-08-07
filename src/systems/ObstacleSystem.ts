import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType } from '../types';
// Mountain heights are not `GameConstants` keys, so they are not map-overridable and stay
// module-level. Everything a map *can* override arrives through the constructor's `cfg`.
import { MOUNTAIN_MIN_HEIGHT, MOUNTAIN_MAX_HEIGHT } from '../constants';
import type { ObstacleDefinition, GameConstants, MountainTriangles, LakeTriangles } from '../maps/types';
import { omitUndefined } from '../utils/omitUndefined';

export class ObstacleSystem {
  private grid: Grid;
  private mountainCells: GridPos[] = [];
  private lakeCells: GridPos[] = [];
  private mountainHeightMap = new Map<string, number>();
  private mountainTriangles: MountainTriangles = new Map();
  private lakeTriangles: LakeTriangles = new Map();
  private predefinedObstacles: ObstacleDefinition[] | undefined;
  private cfg: GameConstants;

  /** Takes a resolved `GameConstants` — see the note on {@link SpawnSystem}'s constructor. */
  constructor(grid: Grid, predefinedObstacles: ObstacleDefinition[] | undefined, cfg: GameConstants) {
    this.grid = grid;
    this.predefinedObstacles = predefinedObstacles;
    this.cfg = cfg;
  }

  generate(): void {
    this.mountainCells = [];
    this.lakeCells = [];
    this.mountainHeightMap.clear();
    this.mountainTriangles.clear();
    this.lakeTriangles.clear();

    if (this.predefinedObstacles) {
      this.placePredefined(this.predefinedObstacles);
      return;
    }

    // Generate mountains first
    for (let i = 0; i < this.cfg.MOUNTAIN_CLUSTER_COUNT; i++) {
      const size = this.cfg.MOUNTAIN_CLUSTER_MIN_SIZE + Math.floor(Math.random() * (this.cfg.MOUNTAIN_CLUSTER_MAX_SIZE - this.cfg.MOUNTAIN_CLUSTER_MIN_SIZE + 1));
      const cluster = this.growCluster(size, CellType.Mountain);
      if (cluster.length > 0) {
        // Assign heights — cells near cluster center are taller
        const cx = cluster.reduce((s, p) => s + p.gx, 0) / cluster.length;
        const cy = cluster.reduce((s, p) => s + p.gy, 0) / cluster.length;
        const maxDist = Math.max(...cluster.map(p => Math.hypot(p.gx - cx, p.gy - cy)), 1);

        for (const pos of cluster) {
          const dist = Math.hypot(pos.gx - cx, pos.gy - cy);
          const t = 1 - dist / maxDist;
          const height = MOUNTAIN_MIN_HEIGHT + t * (MOUNTAIN_MAX_HEIGHT - MOUNTAIN_MIN_HEIGHT) + (Math.random() - 0.5) * 3;
          this.mountainHeightMap.set(`${pos.gx},${pos.gy}`, Math.max(MOUNTAIN_MIN_HEIGHT, height));
          this.mountainCells.push(pos);
        }
      }
    }

    // Generate lakes (avoid mountains)
    for (let i = 0; i < this.cfg.LAKE_CLUSTER_COUNT; i++) {
      const size = this.cfg.LAKE_CLUSTER_MIN_SIZE + Math.floor(Math.random() * (this.cfg.LAKE_CLUSTER_MAX_SIZE - this.cfg.LAKE_CLUSTER_MIN_SIZE + 1));
      const cluster = this.growCluster(size, CellType.Lake);
      this.lakeCells.push(...cluster);
    }
  }

  private placePredefined(obstacles: ObstacleDefinition[]): void {
    for (const obs of obstacles) {
      if (!this.grid.inBounds(obs.gx, obs.gy)) continue;
      const cell = this.grid.getCell(obs.gx, obs.gy);
      if (!cell || cell.type !== CellType.Empty) continue;

      if (obs.type === 'mountain') {
        this.grid.setCell(obs.gx, obs.gy, { type: CellType.Mountain });
        const height = obs.height ?? (MOUNTAIN_MIN_HEIGHT + Math.random() * (MOUNTAIN_MAX_HEIGHT - MOUNTAIN_MIN_HEIGHT));
        this.mountainHeightMap.set(`${obs.gx},${obs.gy}`, height);
        this.mountainCells.push({ gx: obs.gx, gy: obs.gy });
        // Store triangle data if any triangle field is specified
        if (obs.top !== undefined || obs.right !== undefined || obs.bottom !== undefined || obs.left !== undefined) {
          this.mountainTriangles.set(`${obs.gx},${obs.gy}`, omitUndefined({
            top: obs.top, right: obs.right, bottom: obs.bottom, left: obs.left,
          }));
        }
      } else {
        this.grid.setCell(obs.gx, obs.gy, { type: CellType.Lake });
        this.lakeCells.push({ gx: obs.gx, gy: obs.gy });
        // Store triangle data if any triangle field is specified
        if (obs.top !== undefined || obs.right !== undefined || obs.bottom !== undefined || obs.left !== undefined) {
          this.lakeTriangles.set(`${obs.gx},${obs.gy}`, omitUndefined({
            top: obs.top, right: obs.right, bottom: obs.bottom, left: obs.left,
          }));
        }
      }
    }
  }

  getMountainCells(): GridPos[] {
    return this.mountainCells;
  }

  getLakeCells(): GridPos[] {
    return this.lakeCells;
  }

  getMountainHeightMap(): Map<string, number> {
    return this.mountainHeightMap;
  }

  getMountainTriangles(): MountainTriangles {
    return this.mountainTriangles;
  }

  getLakeTriangles(): LakeTriangles {
    return this.lakeTriangles;
  }

  private growCluster(targetSize: number, cellType: CellType): GridPos[] {
    const centerX = this.grid.cols / 2;
    const centerY = this.grid.rows / 2;
    const margin = this.cfg.OBSTACLE_EDGE_MARGIN;
    const exclusion = this.cfg.OBSTACLE_CENTER_EXCLUSION;

    // Try to find a valid seed cell
    for (let attempt = 0; attempt < 100; attempt++) {
      const seedX = margin + Math.floor(Math.random() * (this.grid.cols - 2 * margin));
      const seedY = margin + Math.floor(Math.random() * (this.grid.rows - 2 * margin));

      // Must be empty
      const cell = this.grid.getCell(seedX, seedY);
      if (!cell || cell.type !== CellType.Empty) continue;

      // Must be outside center exclusion zone
      if (Math.abs(seedX - centerX) < exclusion && Math.abs(seedY - centerY) < exclusion) continue;

      // Must not be adjacent to existing obstacles
      if (this.hasAdjacentObstacle(seedX, seedY)) continue;

      // Grow cluster from seed
      const cluster: GridPos[] = [{ gx: seedX, gy: seedY }];
      const used = new Set<string>([`${seedX},${seedY}`]);
      this.grid.setCell(seedX, seedY, { type: cellType });

      while (cluster.length < targetSize) {
        // Collect all valid frontier cells
        const frontier: GridPos[] = [];
        for (const pos of cluster) {
          for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
            const nx = pos.gx + dx;
            const ny = pos.gy + dy;
            const key = `${nx},${ny}`;
            if (used.has(key)) continue;
            if (!this.grid.inBounds(nx, ny)) continue;
            if (nx < margin || nx >= this.grid.cols - margin) continue;
            if (ny < margin || ny >= this.grid.rows - margin) continue;
            const neighborCell = this.grid.getCell(nx, ny);
            if (!neighborCell || neighborCell.type !== CellType.Empty) continue;
            frontier.push({ gx: nx, gy: ny });
            used.add(key);
          }
        }

        if (frontier.length === 0) break;

        // Pick a random frontier cell
        const pick = frontier[Math.floor(Math.random() * frontier.length)];
        this.grid.setCell(pick.gx, pick.gy, { type: cellType });
        cluster.push(pick);
      }

      return cluster;
    }

    return [];
  }

  private hasAdjacentObstacle(gx: number, gy: number): boolean {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const cell = this.grid.getCell(gx + dx, gy + dy);
      if (cell && (cell.type === CellType.Mountain || cell.type === CellType.Lake)) {
        return true;
      }
    }
    return false;
  }
}
