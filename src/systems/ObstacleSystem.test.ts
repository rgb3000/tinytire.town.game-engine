import { describe, it, expect } from 'vitest';
import { Grid } from '../core/Grid';
import { buildConfig } from '../constants';
import { ObstacleSystem } from './ObstacleSystem';
import { CellType } from '../types';
import type { GameConstants } from '../maps/types';

function generate(overrides: Partial<GameConstants> = {}, seed = 1) {
  const grid = new Grid();
  const system = new ObstacleSystem(grid, undefined, buildConfig(overrides), seed);
  system.generate();
  return { grid, system };
}

const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Sizes of the empty regions fully enclosed by `cells`, largest first. */
function enclosedRegions(grid: Grid, cells: { gx: number; gy: number }[]): number[] {
  const water = new Set(cells.map(c => `${c.gx},${c.gy}`));

  // Flood the empty cells inwards from a ring outside the grid; whatever that never
  // reaches is enclosed. Checking "empty cell whose four neighbours are all water" would
  // only ever find single-cell pinholes, and an island of one tile is not an island.
  const outside = new Set<string>();
  const queue: [number, number][] = [];
  for (let gx = -1; gx <= grid.cols; gx++) queue.push([gx, -1], [gx, grid.rows]);
  for (let gy = -1; gy <= grid.rows; gy++) queue.push([-1, gy], [grid.cols, gy]);
  for (const [gx, gy] of queue) outside.add(`${gx},${gy}`);
  while (queue.length > 0) {
    const [gx, gy] = queue.pop()!;
    for (const [dx, dy] of ORTHOGONAL) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < -1 || ny < -1 || nx > grid.cols || ny > grid.rows) continue;
      const key = `${nx},${ny}`;
      if (outside.has(key) || water.has(key)) continue;
      outside.add(key);
      queue.push([nx, ny]);
    }
  }

  const remaining = new Set<string>();
  for (let gy = 0; gy < grid.rows; gy++) {
    for (let gx = 0; gx < grid.cols; gx++) {
      const key = `${gx},${gy}`;
      if (!water.has(key) && !outside.has(key)) remaining.add(key);
    }
  }

  const sizes: number[] = [];
  while (remaining.size > 0) {
    const [start] = remaining;
    remaining.delete(start);
    const stack = [start];
    let size = 0;
    while (stack.length > 0) {
      const key = stack.pop()!;
      size++;
      const [gx, gy] = key.split(',').map(Number);
      for (const [dx, dy] of ORTHOGONAL) {
        const next = `${gx + dx},${gy + dy}`;
        if (remaining.delete(next)) stack.push(next);
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

describe('ObstacleSystem generation', () => {
  it('is deterministic for a given seed', () => {
    const a = generate({}, 42).system.getMountainCells();
    const b = generate({}, 42).system.getMountainCells();
    expect(a).toEqual(b);
  });

  it('differs between seeds', () => {
    const a = generate({}, 1).system.getMountainCells();
    const b = generate({}, 2).system.getMountainCells();
    expect(a).not.toEqual(b);
  });

  it('randomises when constructed without a seed', () => {
    // Unseeded construction must still vary run to run — a seed is a test affordance, not
    // a change to how the game plays.
    const runs = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const grid = new Grid();
      const system = new ObstacleSystem(grid, undefined, buildConfig(), undefined);
      system.generate();
      runs.add(JSON.stringify(system.getMountainCells()));
    }
    expect(runs.size).toBeGreaterThan(1);
  });

  it('produces nothing when both counts are zero', () => {
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 0, LAKE_CLUSTER_COUNT: 0 });
    expect(system.getMountainCells()).toHaveLength(0);
    expect(system.getLakeCells()).toHaveLength(0);
  });

  it('produces terrain when counts are non-zero', () => {
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 2 });
    expect(system.getMountainCells().length).toBeGreaterThan(0);
    expect(system.getLakeCells().length).toBeGreaterThan(0);
  });

  it('grows one landform per requested cluster', () => {
    // MOUNTAIN_CLUSTER_COUNT keeps its old meaning — how many landforms, not how many
    // cells — so the `0` in narrow-pass and lakeland still means "no terrain".
    for (const count of [1, 2, 5]) {
      const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: count, LAKE_CLUSTER_COUNT: 0 }, 3);
      const cells = system.getMountainCells();
      const remaining = new Set(cells.map(c => `${c.gx},${c.gy}`));
      let components = 0;
      while (remaining.size > 0) {
        const [start] = remaining;
        remaining.delete(start);
        const queue = [start];
        while (queue.length > 0) {
          const key = queue.pop()!;
          const [gx, gy] = key.split(',').map(Number);
          for (const [dx, dy] of ORTHOGONAL) {
            const next = `${gx + dx},${gy + dy}`;
            if (remaining.delete(next)) queue.push(next);
          }
        }
        components++;
      }
      expect(components).toBe(count);
    }
  });

  it('scales landform area with the configured size bounds', () => {
    // MIN_SIZE/MAX_SIZE are target areas now rather than exact cell counts, but a bigger
    // target must still make a bigger landform.
    const small = generate({ MOUNTAIN_CLUSTER_COUNT: 1, LAKE_CLUSTER_COUNT: 0, MOUNTAIN_CLUSTER_MIN_SIZE: 4, MOUNTAIN_CLUSTER_MAX_SIZE: 6 }, 11);
    const large = generate({ MOUNTAIN_CLUSTER_COUNT: 1, LAKE_CLUSTER_COUNT: 0, MOUNTAIN_CLUSTER_MIN_SIZE: 80, MOUNTAIN_CLUSTER_MAX_SIZE: 100 }, 11);
    expect(large.system.getMountainCells().length).toBeGreaterThan(
      small.system.getMountainCells().length * 3,
    );
  });

  it('spreads landforms apart rather than clumping them', () => {
    // Poisson-disc seeding: with four landforms on an 80x50 grid no two centroids should
    // land on top of each other.
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 4, LAKE_CLUSTER_COUNT: 0 }, 5);
    const cells = system.getMountainCells();
    const remaining = new Set(cells.map(c => `${c.gx},${c.gy}`));
    const centroids: { x: number; y: number }[] = [];
    while (remaining.size > 0) {
      const [start] = remaining;
      remaining.delete(start);
      const queue = [start];
      const component: { gx: number; gy: number }[] = [];
      while (queue.length > 0) {
        const key = queue.pop()!;
        const [gx, gy] = key.split(',').map(Number);
        component.push({ gx, gy });
        for (const [dx, dy] of ORTHOGONAL) {
          const next = `${gx + dx},${gy + dy}`;
          if (remaining.delete(next)) queue.push(next);
        }
      }
      centroids.push({
        x: component.reduce((s, c) => s + c.gx, 0) / component.length,
        y: component.reduce((s, c) => s + c.gy, 0) / component.length,
      });
    }
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        expect(Math.hypot(centroids[i].x - centroids[j].x, centroids[i].y - centroids[j].y))
          .toBeGreaterThan(6);
      }
    }
  });

  it('never overlaps mountains and lakes', () => {
    // Large landforms of both kinds, so that they really do meet: at default sizes they
    // are too small and too few to collide, and the check passes vacuously.
    for (let seed = 1; seed <= 10; seed++) {
      const { system } = generate({
        MOUNTAIN_CLUSTER_COUNT: 8, LAKE_CLUSTER_COUNT: 8,
        MOUNTAIN_CLUSTER_MIN_SIZE: 40, MOUNTAIN_CLUSTER_MAX_SIZE: 70,
        LAKE_CLUSTER_MIN_SIZE: 40, LAKE_CLUSTER_MAX_SIZE: 70,
      }, seed);
      const mountains = new Set(system.getMountainCells().map(c => `${c.gx},${c.gy}`));
      for (const c of system.getLakeCells()) {
        expect(mountains.has(`${c.gx},${c.gy}`)).toBe(false);
      }
    }
  });

  it('writes every generated cell into the grid, and nothing else', () => {
    const { grid, system } = generate({ MOUNTAIN_CLUSTER_COUNT: 4, LAKE_CLUSTER_COUNT: 4 });
    for (const c of system.getMountainCells()) {
      expect(grid.getCell(c.gx, c.gy)!.type).toBe(CellType.Mountain);
    }
    for (const c of system.getLakeCells()) {
      expect(grid.getCell(c.gx, c.gy)!.type).toBe(CellType.Lake);
    }
    // The reported cells are the whole story: a cell carved out for an island must be
    // returned to Empty, not left as stale terrain the renderer would still draw.
    let occupied = 0;
    for (let gy = 0; gy < grid.rows; gy++) {
      for (let gx = 0; gx < grid.cols; gx++) {
        if (grid.getCell(gx, gy)!.type !== CellType.Empty) occupied++;
      }
    }
    expect(occupied).toBe(system.getMountainCells().length + system.getLakeCells().length);
  });

  it('reports no cell twice', () => {
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 6, LAKE_CLUSTER_COUNT: 6 });
    for (const cells of [system.getMountainCells(), system.getLakeCells()]) {
      expect(new Set(cells.map(c => `${c.gx},${c.gy}`)).size).toBe(cells.length);
    }
  });

  it('respects the edge margin', () => {
    const cfg = { OBSTACLE_EDGE_MARGIN: 4, MOUNTAIN_CLUSTER_COUNT: 6, LAKE_CLUSTER_COUNT: 6 };
    const { grid, system } = generate(cfg);
    for (const c of [...system.getMountainCells(), ...system.getLakeCells()]) {
      expect(c.gx).toBeGreaterThanOrEqual(0);
      expect(c.gy).toBeGreaterThanOrEqual(0);
      expect(c.gx).toBeLessThan(grid.cols);
      expect(c.gy).toBeLessThan(grid.rows);
      // The margin is a mask, not a rejection test: nothing may land inside it at all.
      expect(Math.min(c.gx, c.gy, grid.cols - 1 - c.gx, grid.rows - 1 - c.gy))
        .toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the map centre clear', () => {
    const { grid, system } = generate({ MOUNTAIN_CLUSTER_COUNT: 8, LAKE_CLUSTER_COUNT: 8, OBSTACLE_CENTER_EXCLUSION: 8 });
    const cx = grid.cols / 2;
    const cy = grid.rows / 2;
    for (const c of [...system.getMountainCells(), ...system.getLakeCells()]) {
      const inCentre = Math.abs(c.gx - cx) < 4 && Math.abs(c.gy - cy) < 4;
      expect(inCentre).toBe(false);
    }
  });

  it('keeps the centre clear even for landforms far larger than the exclusion ramp', () => {
    // The mask has to be a hard floor, not a penalty a big enough falloff can outvote.
    for (let seed = 1; seed <= 10; seed++) {
      const { grid, system } = generate({
        MOUNTAIN_CLUSTER_COUNT: 8, LAKE_CLUSTER_COUNT: 8,
        MOUNTAIN_CLUSTER_MIN_SIZE: 300, MOUNTAIN_CLUSTER_MAX_SIZE: 400,
        LAKE_CLUSTER_MIN_SIZE: 300, LAKE_CLUSTER_MAX_SIZE: 400,
        OBSTACLE_CENTER_EXCLUSION: 8, OBSTACLE_EDGE_MARGIN: 3,
      }, seed);
      const cx = grid.cols / 2;
      const cy = grid.rows / 2;
      for (const c of [...system.getMountainCells(), ...system.getLakeCells()]) {
        expect(Math.max(Math.abs(c.gx - cx), Math.abs(c.gy - cy))).toBeGreaterThan(8);
        expect(Math.min(c.gx, c.gy, grid.cols - 1 - c.gx, grid.rows - 1 - c.gy))
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('produces landforms that are compact rather than stringy', () => {
    // A random walk produces many cells with a single neighbour. A radial landform
    // produces very few. This is the shape-quality regression test.
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 4, LAKE_CLUSTER_COUNT: 0 });
    const cells = system.getMountainCells();
    const set = new Set(cells.map(c => `${c.gx},${c.gy}`));
    let lonely = 0;
    for (const c of cells) {
      let neighbours = 0;
      for (const [dx, dy] of ORTHOGONAL) {
        if (set.has(`${c.gx + dx},${c.gy + dy}`)) neighbours++;
      }
      if (neighbours <= 1) lonely++;
    }
    expect(lonely / cells.length).toBeLessThan(0.2);
  });

  it('stays compact across many seeds', () => {
    // One seed can get lucky. Measured against the random walk this replaces, the same
    // sweep gives a mean of 0.33 and not one run under 0.2 — this is the bar it fails.
    //
    // Headroom is thinner than the mean suggests: over 500 seeds this implementation
    // averages 0.006 but peaks at 0.190, just under the bar. The 25 seeds pinned here are
    // safe, so a failure means a retune has eaten what little slack there is — check the
    // radius floor and the noise fade-in before touching the threshold.
    const ratios: number[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 4, LAKE_CLUSTER_COUNT: 0 }, seed);
      const cells = system.getMountainCells();
      expect(cells.length).toBeGreaterThan(0);
      const set = new Set(cells.map(c => `${c.gx},${c.gy}`));
      let lonely = 0;
      for (const c of cells) {
        let neighbours = 0;
        for (const [dx, dy] of ORTHOGONAL) {
          if (set.has(`${c.gx + dx},${c.gy + dy}`)) neighbours++;
        }
        if (neighbours <= 1) lonely++;
      }
      ratios.push(lonely / cells.length);
    }
    expect(Math.max(...ratios)).toBeLessThan(0.2);
    expect(ratios.reduce((a, b) => a + b, 0) / ratios.length).toBeLessThan(0.1);
  });

  it('leaves no speckle of pinholes inside a landform', () => {
    // Interior noise dips punch scattered one-cell holes. Unfilled they read as noise and
    // are indistinguishable from a carved island. A wide crater in a huge landform is
    // legitimate terrain; a one- or two-cell pockmark is not.
    for (const [min, max] of [[4, 8], [40, 80], [120, 200]] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const { grid, system } = generate({
          MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 0,
          MOUNTAIN_CLUSTER_MIN_SIZE: min, MOUNTAIN_CLUSTER_MAX_SIZE: max,
        }, seed);
        for (const size of enclosedRegions(grid, system.getMountainCells())) {
          expect(size).toBeGreaterThan(2);
        }
      }
    }
  });

  it('leaves no detached debris around a landform', () => {
    // Noise flings cells clear of the edge of a big landform, which is the same one-tile
    // debris in another guise. A large satellite is a foothill and may stay; a speck of
    // one or two cells may not.
    for (const [min, max] of [[40, 80], [120, 200]] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const { system } = generate({
          MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 0,
          MOUNTAIN_CLUSTER_MIN_SIZE: min, MOUNTAIN_CLUSTER_MAX_SIZE: max,
        }, seed);
        const remaining = new Set(system.getMountainCells().map(c => `${c.gx},${c.gy}`));
        const components: number[] = [];
        while (remaining.size > 0) {
          const [start] = remaining;
          remaining.delete(start);
          const stack = [start];
          let size = 0;
          while (stack.length > 0) {
            const key = stack.pop()!;
            size++;
            const [gx, gy] = key.split(',').map(Number);
            for (const [dx, dy] of ORTHOGONAL) {
              const next = `${gx + dx},${gy + dy}`;
              if (remaining.delete(next)) stack.push(next);
            }
          }
          components.push(size);
        }
        expect(components.length).toBeGreaterThanOrEqual(3);
        for (const size of components) expect(size).toBeGreaterThan(2);
      }
    }
  });

  it('can give a lake an island', () => {
    const { grid, system } = generate({ LAKE_ISLAND_CHANCE: 1, LAKE_CLUSTER_COUNT: 4, LAKE_CLUSTER_MIN_SIZE: 40, LAKE_CLUSTER_MAX_SIZE: 60, MOUNTAIN_CLUSTER_COUNT: 0 }, 7);
    expect(enclosedRegions(grid, system.getLakeCells()).length).toBeGreaterThan(0);
  });

  it('carves islands as one solid mass, not a speckle of single-cell holes', () => {
    // Carving cell by cell against a shrinking lake set yields scattered pinholes, which
    // reads as noise rather than as an island. A forced island must be one contiguous
    // region of several cells.
    const { grid, system } = generate({
      LAKE_ISLAND_CHANCE: 1, LAKE_CLUSTER_COUNT: 4,
      LAKE_CLUSTER_MIN_SIZE: 90, LAKE_CLUSTER_MAX_SIZE: 120, MOUNTAIN_CLUSTER_COUNT: 0,
    }, 7);
    const regions = enclosedRegions(grid, system.getLakeCells());
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0]).toBeGreaterThanOrEqual(4);
  });

  it('grows an island lake big enough to hold one', () => {
    // The default lake target area is 5-12 cells. Punching a hole in nine cells leaves a
    // ring, not an island, so a lake that has been chosen to carry one is grown past the
    // configured target instead.
    for (let seed = 1; seed <= 10; seed++) {
      const { grid, system } = generate({ LAKE_ISLAND_CHANCE: 1, LAKE_CLUSTER_COUNT: 2, MOUNTAIN_CLUSTER_COUNT: 0 }, seed);
      expect(system.getLakeCells().length).toBeGreaterThan(40);
      expect(enclosedRegions(grid, system.getLakeCells()).length).toBeGreaterThan(0);
    }
  });

  it('offers an island to most large lakes when the chance is one', () => {
    let withIsland = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { grid, system } = generate({
        LAKE_ISLAND_CHANCE: 1, LAKE_CLUSTER_COUNT: 3,
        LAKE_CLUSTER_MIN_SIZE: 60, LAKE_CLUSTER_MAX_SIZE: 90, MOUNTAIN_CLUSTER_COUNT: 0,
      }, seed);
      if (enclosedRegions(grid, system.getLakeCells()).length >= 3) withIsland++;
    }
    // Every lake is above the size threshold, so every lake should get one.
    expect(withIsland).toBe(12);
  });

  it('never carves an island when the chance is zero', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { grid, system } = generate({
        LAKE_ISLAND_CHANCE: 0, LAKE_CLUSTER_COUNT: 3,
        LAKE_CLUSTER_MIN_SIZE: 60, LAKE_CLUSTER_MAX_SIZE: 90, MOUNTAIN_CLUSTER_COUNT: 0,
      }, seed);
      // Noise alone can still dip below zero inside a lake, but a carved island is a
      // several-cell disc; nothing that big may appear when the chance is off.
      for (const size of enclosedRegions(grid, system.getLakeCells())) {
        expect(size).toBeLessThan(4);
      }
    }
  });

  it('lets mountains and lakes touch', () => {
    // The old generator rejected any seed adjacent to existing terrain. A range meeting a
    // shore is now allowed — only overlap is forbidden.
    let touching = 0;
    for (let seed = 1; seed <= 40 && touching === 0; seed++) {
      const { system } = generate({
        MOUNTAIN_CLUSTER_COUNT: 8, LAKE_CLUSTER_COUNT: 8,
        MOUNTAIN_CLUSTER_MIN_SIZE: 40, MOUNTAIN_CLUSTER_MAX_SIZE: 70,
        LAKE_CLUSTER_MIN_SIZE: 40, LAKE_CLUSTER_MAX_SIZE: 70,
      }, seed);
      const lakes = new Set(system.getLakeCells().map(c => `${c.gx},${c.gy}`));
      for (const c of system.getMountainCells()) {
        for (const [dx, dy] of ORTHOGONAL) {
          if (lakes.has(`${c.gx + dx},${c.gy + dy}`)) touching++;
        }
      }
    }
    expect(touching).toBeGreaterThan(0);
  });

  it('responds to the noise scale', () => {
    const a = generate({ MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 0, TERRAIN_NOISE_SCALE: 0.1 }, 4);
    const b = generate({ MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 0, TERRAIN_NOISE_SCALE: 0.9 }, 4);
    expect(a.system.getMountainCells()).not.toEqual(b.system.getMountainCells());
  });

  it('gives each landform its own noise, not one shape repeated', () => {
    const { system } = generate({
      MOUNTAIN_CLUSTER_COUNT: 3, LAKE_CLUSTER_COUNT: 0,
      MOUNTAIN_CLUSTER_MIN_SIZE: 50, MOUNTAIN_CLUSTER_MAX_SIZE: 50,
    }, 6);
    const cells = system.getMountainCells();
    const remaining = new Set(cells.map(c => `${c.gx},${c.gy}`));
    const shapes = new Set<string>();
    while (remaining.size > 0) {
      const [start] = remaining;
      remaining.delete(start);
      const stack = [start];
      const component: { gx: number; gy: number }[] = [];
      while (stack.length > 0) {
        const key = stack.pop()!;
        const [gx, gy] = key.split(',').map(Number);
        component.push({ gx, gy });
        for (const [dx, dy] of ORTHOGONAL) {
          const next = `${gx + dx},${gy + dy}`;
          if (remaining.delete(next)) stack.push(next);
        }
      }
      const minX = Math.min(...component.map(c => c.gx));
      const minY = Math.min(...component.map(c => c.gy));
      shapes.add(component.map(c => `${c.gx - minX},${c.gy - minY}`).sort().join('|'));
    }
    expect(shapes.size).toBe(3);
  });

  it('does not repeat the same shape when a landform lands on the same cell', () => {
    // The noise field is sampled at grid coordinates, so without a per-landform offset a
    // landform's shape would be a pure function of where it sits: the same spot would
    // always grow the identical mountain. These two seeds place their single mountain on
    // the same cell — the shapes still have to differ.
    const landform = (seed: number) => generate({ MOUNTAIN_CLUSTER_COUNT: 1, LAKE_CLUSTER_COUNT: 0 }, seed)
      .system.getMountainCells();
    const centroid = (cells: { gx: number; gy: number }[]) => [
      cells.reduce((t, c) => t + c.gx, 0) / cells.length,
      cells.reduce((t, c) => t + c.gy, 0) / cells.length,
    ];
    const a = landform(2);
    const b = landform(137);
    expect(centroid(a)).toEqual(centroid(b));
    expect(a.map(c => `${c.gx},${c.gy}`).sort())
      .not.toEqual(b.map(c => `${c.gx},${c.gy}`).sort());
  });

  it('still places predefined obstacles verbatim', () => {
    const grid = new Grid();
    const system = new ObstacleSystem(grid, [
      { gx: 5, gy: 5, type: 'mountain' },
      { gx: 6, gy: 6, type: 'lake' },
    ], buildConfig(), 1);
    system.generate();
    expect(system.getMountainCells()).toEqual([{ gx: 5, gy: 5 }]);
    expect(system.getLakeCells()).toEqual([{ gx: 6, gy: 6 }]);
  });

  it('generates nothing when predefined obstacles are supplied, even an empty list', () => {
    // MapDesigner passes `[]` to mean "no random terrain".
    const grid = new Grid();
    const system = new ObstacleSystem(grid, [], buildConfig(), 1);
    system.generate();
    expect(system.getMountainCells()).toHaveLength(0);
    expect(system.getLakeCells()).toHaveLength(0);
  });

  it('clears previous output when generate is called again', () => {
    const grid = new Grid();
    const system = new ObstacleSystem(grid, undefined, buildConfig(), 3);
    system.generate();
    const first = [...system.getMountainCells()];
    expect(first.length).toBeGreaterThan(0);

    for (let gy = 0; gy < grid.rows; gy++) {
      for (let gx = 0; gx < grid.cols; gx++) grid.clearCell(gx, gy);
    }
    system.generate();
    // Same seed, same blank grid — so the second run must reproduce the first exactly
    // rather than append to it.
    expect(system.getMountainCells()).toEqual(first);
  });
});
