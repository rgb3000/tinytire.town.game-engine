import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType } from '../types';
import type { ObstacleDefinition, GameConstants, MountainTriangles, LakeTriangles } from '../maps/types';
import { omitUndefined } from '../utils/omitUndefined';
import { mulberry32 } from '../utils/rng';
import { smoothNoise2D } from '../utils/math';

/** How far a landform's shape may stray beyond its nominal radius, as a fraction of it. */
const NOISE_AMPLITUDE = 0.55;

/**
 * Smallest radius a landform may be grown at, in cells.
 *
 * `MIN_SIZE`/`MAX_SIZE` are target areas, and the smallest of them (4 cells) works out at
 * a radius of 1.1 — a plus of five tiles, every arm of which is a one-tile spur. Rounding
 * the floor up to a 3x3-ish disc is what makes the smallest landform still read as one.
 */
const MIN_LANDFORM_RADIUS = 1.6;

/**
 * Radius at which boundary noise reaches full amplitude, in cells.
 *
 * The noise is a fraction of the radius, so on a small landform it is a large fraction of
 * the whole shape and tears it into fragments. Fading it in with size keeps small
 * landforms coherent while large ones still get bays and peninsulas.
 */
const FULL_NOISE_RADIUS = 4;

/** Cells over which the edge and centre masks ramp from fully blocked to fully open. */
const MASK_RAMP = 3;

/**
 * Smallest lake that may keep an island, and the radius a lake chosen to have one is grown
 * to, in cells.
 *
 * The default lake target area is 5-12 cells, and a hole punched in nine cells is a ring,
 * not an island — so a lake that has been picked to carry one is grown past its target
 * first. `MIN_ISLAND_HOST_SIZE` then catches the cases where it could not be: a lake
 * clipped by the map edge, the centre exclusion or a mountain keeps its water instead.
 */
const MIN_ISLAND_HOST_SIZE = 25;
const ISLAND_LAKE_MIN_RADIUS = 3.2;

/** Seed placement is dart-thrown; give up on a landform after this many misses. */
const SEED_ATTEMPTS = 200;

const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

const ORTHOGONAL_AND_DIAGONAL = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

export class ObstacleSystem {
  private grid: Grid;
  private mountainCells: GridPos[] = [];
  private lakeCells: GridPos[] = [];
  private mountainTriangles: MountainTriangles = new Map();
  private lakeTriangles: LakeTriangles = new Map();
  private predefinedObstacles: ObstacleDefinition[] | undefined;
  private cfg: GameConstants;
  private seed: number;

  /**
   * Takes a resolved `GameConstants` — see the note on {@link SpawnSystem}'s constructor.
   *
   * `seed` is a *generation* seed, not a wire-format field: maps do not carry one, and
   * omitting it still randomises, so gameplay stays varied. Passing it makes generation
   * reproducible, which is the only way the shapes below can be asserted on in a test.
   */
  constructor(
    grid: Grid,
    predefinedObstacles: ObstacleDefinition[] | undefined,
    cfg: GameConstants,
    seed?: number,
  ) {
    this.grid = grid;
    this.predefinedObstacles = predefinedObstacles;
    this.cfg = cfg;
    this.seed = seed ?? Math.floor(Math.random() * 0xffffffff);
  }

  generate(): void {
    this.mountainCells = [];
    this.lakeCells = [];
    this.mountainTriangles.clear();
    this.lakeTriangles.clear();

    if (this.predefinedObstacles) {
      this.placePredefined(this.predefinedObstacles);
      return;
    }

    const rng = mulberry32(this.seed);

    // Mountains first. Lakes then skip anything already claimed, so the two may share a
    // border — a range meeting a shore — but never a cell.
    this.growLandforms(
      rng,
      CellType.Mountain,
      this.cfg.MOUNTAIN_CLUSTER_COUNT,
      this.cfg.MOUNTAIN_CLUSTER_MIN_SIZE,
      this.cfg.MOUNTAIN_CLUSTER_MAX_SIZE,
      this.mountainCells,
      false,
    );

    this.growLandforms(
      rng,
      CellType.Lake,
      this.cfg.LAKE_CLUSTER_COUNT,
      this.cfg.LAKE_CLUSTER_MIN_SIZE,
      this.cfg.LAKE_CLUSTER_MAX_SIZE,
      this.lakeCells,
      true,
    );
  }

  /**
   * Grow `count` landforms by noise-modulated radial falloff.
   *
   * This replaces a random-walk frontier growth: that picked a uniformly random cell from
   * the growth frontier each step, which is exactly the process that grows one-tile
   * tendrils and spurs, and no renderer can make those look like a landform. Here a cell
   * joins when its radial falloff plus a noise sample clears zero. The falloff makes the
   * shape coherent and the noise gives it bays and peninsulas; {@link tidy} then closes
   * the pockmarks the same noise leaves behind, and {@link carveIsland} puts back the one
   * hole that is meant to be there.
   *
   * `minSize`/`maxSize` are read as a target *area* rather than an exact cell count, so
   * the radius is derived from them; the noise then decides the true count.
   */
  private growLandforms(
    rng: () => number,
    cellType: CellType,
    count: number,
    minSize: number,
    maxSize: number,
    out: GridPos[],
    allowIslands: boolean,
  ): void {
    const placed: GridPos[] = [];
    // Poisson-disc dart throwing: landforms spread over the map instead of clumping.
    const minSeparation = Math.min(this.grid.cols, this.grid.rows) / Math.max(count, 1);
    const scale = this.cfg.TERRAIN_NOISE_SCALE;

    for (let i = 0; i < count; i++) {
      const seedPos = this.pickSeed(rng, placed, minSeparation);
      if (!seedPos) continue;
      placed.push(seedPos);

      // Rolled before growing, because a lake that is to have an island has to be grown
      // large enough to hold one: at the default 5-12 target area a lake is nine cells,
      // and punching a hole in that leaves a ring, not an island.
      const wantsIsland = allowIslands && rng() < this.cfg.LAKE_ISLAND_CHANCE;
      const targetArea = minSize + rng() * Math.max(0, maxSize - minSize);
      const floor = wantsIsland ? Math.max(MIN_LANDFORM_RADIUS, ISLAND_LAKE_MIN_RADIUS) : MIN_LANDFORM_RADIUS;
      const radius = Math.max(floor, Math.sqrt(targetArea / Math.PI));
      // Each landform samples a different patch of the shared noise field, so three
      // landforms of the same size are three different shapes rather than one repeated.
      const noiseOffsetX = rng() * 512;
      const noiseOffsetY = rng() * 512;
      const amplitude = NOISE_AMPLITUDE * Math.min(1, radius / FULL_NOISE_RADIUS);

      const claimed: GridPos[] = [];
      const reach = Math.ceil(radius * (1 + NOISE_AMPLITUDE) + 1);

      for (let gy = seedPos.gy - reach; gy <= seedPos.gy + reach; gy++) {
        for (let gx = seedPos.gx - reach; gx <= seedPos.gx + reach; gx++) {
          const cell = this.grid.getCell(gx, gy);
          if (!cell || cell.type !== CellType.Empty) continue;

          const openness = this.openness(gx, gy);
          if (openness <= 0) continue;

          const falloff = 1 - Math.hypot(gx - seedPos.gx, gy - seedPos.gy) / radius;
          const noise = (smoothNoise2D(gx * scale + noiseOffsetX, gy * scale + noiseOffsetY) - 0.5) * 2 * amplitude;
          if (falloff + noise - (1 - openness) <= 0) continue;

          this.grid.setCell(gx, gy, { type: cellType });
          claimed.push({ gx, gy });
        }
      }

      this.tidy(claimed, cellType);

      // The size check is a safety net: a lake clipped by the map edge, the centre
      // exclusion or a mountain can still come out too small to lose cells.
      if (wantsIsland && claimed.length >= MIN_ISLAND_HOST_SIZE) {
        this.carveIsland(rng, claimed, seedPos, radius);
      }

      out.push(...claimed);
    }
  }

  /**
   * Close pinholes and shave spurs on one landform, in place.
   *
   * The noise that gives a landform its bays also dips below zero at scattered interior
   * cells and pushes lone cells out past its edge. Left alone those read as speckle and
   * one-tile debris — the very artefacts this rewrite exists to remove — and they would
   * also be indistinguishable from a deliberately carved island. Filling any gap with
   * three landform neighbours and dropping any cell with fewer than two leaves the bays
   * and peninsulas intact, because those are several cells wide.
   */
  private tidy(claimed: GridPos[], cellType: CellType): void {
    // Counted off the grid rather than off `claimed`, so that a gap enclosed between this
    // landform and one grown earlier is seen as enclosed and closed too.
    const neighbourCount = (gx: number, gy: number): number => {
      let n = 0;
      for (const [dx, dy] of ORTHOGONAL) {
        if (this.grid.getCell(gx + dx, gy + dy)?.type === cellType) n++;
      }
      return n;
    };

    // Run to a fixed point (bounded): filling one gap can complete the ring around the
    // next, so a fixed number of passes leaves the last one open.
    for (let pass = 0; pass < 8; pass++) {
      const candidates = new Set<string>();
      for (const c of claimed) {
        for (const [dx, dy] of ORTHOGONAL) candidates.add(`${c.gx + dx},${c.gy + dy}`);
      }
      const filled: GridPos[] = [];
      for (const key of candidates) {
        const [gx, gy] = key.split(',').map(Number);
        const cell = this.grid.getCell(gx, gy);
        if (!cell || cell.type !== CellType.Empty) continue;
        if (this.openness(gx, gy) <= 0) continue;
        if (neighbourCount(gx, gy) < 3) continue;
        filled.push({ gx, gy });
      }
      if (filled.length === 0) break;
      for (const pos of filled) {
        this.grid.setCell(pos.gx, pos.gy, { type: cellType });
        claimed.push(pos);
      }
    }

    for (let pass = 0; pass < 3; pass++) {
      const shaved = claimed.filter(c => neighbourCount(c.gx, c.gy) <= 1);
      // Never erode a landform out of existence: a small one is all edge.
      if (shaved.length === 0 || claimed.length - shaved.length < 4) break;
      for (const pos of shaved) this.grid.clearCell(pos.gx, pos.gy);
      const removed = new Set(shaved.map(c => `${c.gx},${c.gy}`));
      for (let i = claimed.length - 1; i >= 0; i--) {
        if (removed.has(`${claimed[i].gx},${claimed[i].gy}`)) claimed.splice(i, 1);
      }
    }
  }

  /**
   * Punch an island out of a lake, removing the carved cells from `claimed` in place.
   *
   * Left to chance an interior noise dip is rare, and islands are a headline feature — so
   * above a size threshold one is forced rather than hoped for.
   */
  private carveIsland(rng: () => number, claimed: GridPos[], centre: GridPos, radius: number): void {
    // Decided against the whole lake as it stands: eroding as we carve would make each
    // removed cell disqualify its neighbours, leaving a speckle of single-cell pinholes
    // instead of one island.
    const water = new Set(claimed.map(c => `${c.gx},${c.gy}`));
    const interior = (c: GridPos): boolean =>
      ORTHOGONAL_AND_DIAGONAL.every(([dx, dy]) => water.has(`${c.gx + dx},${c.gy + dy}`));

    const islandRadius = Math.max(1, radius * (0.2 + rng() * 0.15));
    const angle = rng() * Math.PI * 2;
    const offset = radius * 0.3 * rng();
    const ix = centre.gx + Math.cos(angle) * offset;
    const iy = centre.gy + Math.sin(angle) * offset;

    for (let i = claimed.length - 1; i >= 0; i--) {
      const c = claimed[i];
      if (Math.hypot(c.gx - ix, c.gy - iy) > islandRadius) continue;
      // Only carve cells fully inside the lake, so the island never breaches the shore.
      if (!interior(c)) continue;
      this.grid.clearCell(c.gx, c.gy);
      claimed.splice(i, 1);
    }
  }

  private pickSeed(rng: () => number, placed: GridPos[], minSeparation: number): GridPos | null {
    for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt++) {
      const gx = Math.floor(rng() * this.grid.cols);
      const gy = Math.floor(rng() * this.grid.rows);
      // Seeds sit only where the map is fully open, so a landform grows outwards into the
      // mask rather than starting inside it.
      if (this.openness(gx, gy) < 1) continue;

      const cell = this.grid.getCell(gx, gy);
      if (!cell || cell.type !== CellType.Empty) continue;

      let tooClose = false;
      for (const p of placed) {
        if (Math.hypot(p.gx - gx, p.gy - gy) < minSeparation) { tooClose = true; break; }
      }
      if (tooClose) continue;

      return { gx, gy };
    }
    return null;
  }

  /**
   * How available a cell is to terrain, from 0 (blocked outright) to 1 (fully open).
   *
   * The edge margin and centre exclusion used to reject candidate seeds, which let a
   * cluster grown from a legal seed still sprawl into the excluded zone, and cut terrain
   * off along a straight invisible line at the margin. As a mask they do neither: zero is
   * a hard floor no falloff can outvote, and the ramp above it lets landforms fade out.
   */
  private openness(gx: number, gy: number): number {
    const fromEdge = Math.min(gx, gy, this.grid.cols - 1 - gx, this.grid.rows - 1 - gy);
    // The `+ 1` keeps the old hard limit exactly: growth used to be clamped at
    // `nx >= margin`, so a cell `margin` from the edge is the last legal one and the floor
    // has to fall on `margin - 1`. Without it the mask eats a row the margin allowed.
    const edge = ramp(fromEdge - this.cfg.OBSTACLE_EDGE_MARGIN + 1, MASK_RAMP);

    const cx = this.grid.cols / 2;
    const cy = this.grid.rows / 2;
    const fromCentre = Math.max(Math.abs(gx - cx), Math.abs(gy - cy));
    const centre = ramp(fromCentre - this.cfg.OBSTACLE_CENTER_EXCLUSION, MASK_RAMP);

    return Math.min(edge, centre);
  }

  private placePredefined(obstacles: ObstacleDefinition[]): void {
    for (const obs of obstacles) {
      if (!this.grid.inBounds(obs.gx, obs.gy)) continue;
      const cell = this.grid.getCell(obs.gx, obs.gy);
      if (!cell || cell.type !== CellType.Empty) continue;

      if (obs.type === 'mountain') {
        this.grid.setCell(obs.gx, obs.gy, { type: CellType.Mountain });
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

  getMountainTriangles(): MountainTriangles {
    return this.mountainTriangles;
  }

  getLakeTriangles(): LakeTriangles {
    return this.lakeTriangles;
  }
}

/** 0 below the threshold, 1 at `width` and above, smoothstepped in between. */
function ramp(value: number, width: number): number {
  if (value <= 0) return 0;
  if (value >= width) return 1;
  const t = value / width;
  return t * t * (3 - 2 * t);
}
