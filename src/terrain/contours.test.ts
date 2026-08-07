import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../constants';
import { buildTerrainContours, MAX_TERRACES, STEP_TILES, worldToSample } from './contours';
import type { NestedPolygon } from './polygons';
import { signedArea, pointInPolygon, simplifyLoop } from './polygons';
import type { TriangleMap } from './field';
import { SUBCELL, sampleToWorld } from './field';
import { sampleFieldBilinear } from './distanceField';
import { traceIsolines } from './marchingSquares';

const block = (x0: number, y0: number, x1: number, y1: number) => {
  const cells: { gx: number; gy: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push({ gx: x, gy: y });
  return cells;
};

/** The two tolerances the orchestrator is specified to use, restated independently here. */
const OUTER_TOLERANCE = TILE_SIZE / SUBCELL / 4;
const INNER_TOLERANCE = TILE_SIZE / SUBCELL / 2;

/**
 * A right triangle built from half-cell quadrants, so its hypotenuse is a genuine diagonal
 * rather than a cell-sized staircase. Simplification tolerance is only observable on a shape
 * with subcell-scale detail; an axis-aligned block simplifies to the same rectangle whatever
 * the tolerance, which is why the block-based tests cannot see a tolerance swap.
 */
const diagonalCells = block(1, 1, 8, 8).filter(c => c.gx >= c.gy);
const diagonalTriangles: TriangleMap = new Map(
  Array.from({ length: 8 }, (_, i) => [`${i + 1},${i + 1}`, { top: true, right: true }] as const),
);

function distanceToSegment(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** How far the simplified loop strays from the raw traced isoline it came from. */
function maxDeviation(raw: number[][], simplified: number[][]): number {
  let worst = 0;
  for (const p of raw) {
    let best = Infinity;
    for (let i = 0; i < simplified.length - 1; i++) {
      best = Math.min(best, distanceToSegment(p, simplified[i], simplified[i + 1]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const allLoops = (polygons: NestedPolygon[]): number[][][] =>
  polygons.flatMap(p => [p.outer, ...p.holes]);

describe('buildTerrainContours', () => {
  it('returns null for no cells', () => {
    expect(buildTerrainContours([])).toBeNull();
  });

  it('returns null when the painted cells rasterise to nothing traceable', () => {
    // Reachable straight from the map format: `"top": false` is an explicitly-present flag,
    // so `ObstacleSystem` registers a triangle entry that activates no quadrant and the cell
    // covers no subsample at all. Consumers guard on `!contours`, so `null` is the answer
    // they already handle — an object with an empty `levels` would crash on `levels[0]`.
    const noQuadrants: TriangleMap = new Map([['5,5', {}]]);
    expect(buildTerrainContours([{ gx: 5, gy: 5 }], noQuadrants)).toBeNull();

    const explicitlyOff: TriangleMap = new Map([['5,5', { top: false }]]);
    expect(buildTerrainContours([{ gx: 5, gy: 5 }], explicitlyOff)).toBeNull();

    // Asking for a shoreline must not change the answer, nor reach `levels[0]` on the way.
    expect(buildTerrainContours([{ gx: 5, gy: 5 }], noQuadrants, 0.2)).toBeNull();
    expect(buildTerrainContours(
      [{ gx: 5, gy: 5 }, { gx: 6, gy: 5 }],
      new Map([['5,5', {}], ['6,5', { left: false }]]),
      0.2,
    )).toBeNull();
  });

  it('never returns a contour set without a footprint to draw', () => {
    // The invariant the null above protects: any non-null result has a usable `levels[0]`.
    const inputs: [{ gx: number; gy: number }[], TriangleMap | undefined][] = [
      [[{ gx: 5, gy: 5 }], undefined],
      [[{ gx: 5, gy: 5 }], new Map([['5,5', {}]])],
      [[{ gx: 5, gy: 5 }], new Map([['5,5', { top: true }]])],
      [[{ gx: 5, gy: 5 }], new Map([['5,5', { top: false, right: false }]])],
      [block(1, 1, 4, 4), new Map([['1,1', {}], ['4,4', {}]])],
    ];
    for (const [cells, triangles] of inputs) {
      const c = buildTerrainContours(cells, triangles, 0.2);
      if (c === null) continue;
      expect(c.levels.length).toBeGreaterThan(0);
      expect(c.levels[0].polygons.length).toBeGreaterThan(0);
      expect(c.levels[0].polygons[0].outer.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives a single cell one terrace that does not collapse', () => {
    const c = buildTerrainContours([{ gx: 5, gy: 5 }])!;
    expect(c.levels).toHaveLength(1);
    expect(c.levels[0].polygons).toHaveLength(1);
    expect(Math.abs(signedArea(c.levels[0].polygons[0].outer))).toBeGreaterThan(0);
  });

  it('gives a two-wide ridge a handful of terraces, not the maximum', () => {
    const c = buildTerrainContours(block(1, 1, 20, 2))!;
    expect(c.levels.length).toBeGreaterThanOrEqual(1);
    expect(c.levels.length).toBeLessThanOrEqual(3);
  });

  it('caps a broad massif at MAX_TERRACES', () => {
    const c = buildTerrainContours(block(1, 1, 30, 30))!;
    expect(c.levels).toHaveLength(MAX_TERRACES);
  });

  it('keeps a painted square within tolerance of its painted bounds', () => {
    const c = buildTerrainContours(block(2, 2, 5, 5))!;
    const outer = c.levels[0].polygons[0].outer;
    const xs = outer.map(p => p[0]);
    const ys = outer.map(p => p[1]);
    const tol = TILE_SIZE * 0.3;
    expect(Math.abs(Math.min(...xs) - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(Math.max(...xs) - 6 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(Math.min(...ys) - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(Math.max(...ys) - 6 * TILE_SIZE)).toBeLessThan(tol);
  });

  it('renders a painted ring as a ring, not a filled disc', () => {
    const cells = block(1, 1, 9, 9).filter(c => !(c.gx >= 4 && c.gx <= 6 && c.gy >= 4 && c.gy <= 6));
    const c = buildTerrainContours(cells)!;
    expect(c.levels[0].polygons).toHaveLength(1);
    expect(c.levels[0].polygons[0].holes).toHaveLength(1);
  });

  it('keeps disjoint landforms as separate polygons in one level', () => {
    const cells = [...block(1, 1, 3, 3), ...block(10, 1, 12, 3)];
    const c = buildTerrainContours(cells)!;
    expect(c.levels[0].polygons).toHaveLength(2);
  });

  it('shrinks each level inside the one below it', () => {
    const c = buildTerrainContours(block(1, 1, 12, 12))!;
    for (let i = 1; i < c.levels.length; i++) {
      const below = Math.abs(signedArea(c.levels[i - 1].polygons[0].outer));
      const above = Math.abs(signedArea(c.levels[i].polygons[0].outer));
      expect(above).toBeLessThan(below);
    }
  });

  it('places the shoreline outside the footprint', () => {
    const c = buildTerrainContours(block(3, 3, 7, 7), undefined, 0.15)!;
    expect(c.shoreline).toHaveLength(1);
    const shore = Math.abs(signedArea(c.shoreline[0].outer));
    const foot = Math.abs(signedArea(c.levels[0].polygons[0].outer));
    expect(shore).toBeGreaterThan(foot);
  });

  it('survives a diagonal pinch without throwing or emitting empty levels', () => {
    const c = buildTerrainContours([{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }])!;
    for (const level of c.levels) expect(level.polygons.length).toBeGreaterThan(0);
  });
});

describe('terrace count comes from thickness, not cell count', () => {
  it('pins the step and cap that later stages are built against', () => {
    // Not incidental values: the renderer sizes its terrace heights from these, so a change
    // here is a change to the visual contract, not a tuning tweak.
    expect(STEP_TILES).toBe(0.3);
    expect(MAX_TERRACES).toBe(6);
  });

  // The headline bug: the old code gave any cluster over 25 cells six terraces, then inset
  // each ring until narrow shapes folded through themselves. These two shapes have the same
  // cell count and opposite thicknesses, so a cell-count rule cannot tell them apart.
  it('gives two equal-sized shapes different terrace counts when their thickness differs', () => {
    const strip = buildTerrainContours(block(1, 1, 1, 36))!;
    const square = buildTerrainContours(block(1, 1, 6, 6))!;

    expect(strip.levels).toHaveLength(1);
    expect(square.levels).toHaveLength(MAX_TERRACES);
  });

  it('gives a 36-cell one-wide strip exactly one terrace', () => {
    const c = buildTerrainContours(block(1, 1, 1, 36))!;
    // ~0.375 tiles thick: below two steps, so one level and no more.
    expect(c.maxDistanceTiles).toBeLessThan(2 * STEP_TILES);
    expect(c.levels).toHaveLength(1);
  });

  it('gives a 40-cell two-wide ridge exactly two terraces', () => {
    const c = buildTerrainContours(block(1, 1, 20, 2))!;
    // ~0.875 tiles thick: exactly two steps fit, so `floor` must not round or ceil up to three.
    expect(c.maxDistanceTiles).toBeGreaterThanOrEqual(2 * STEP_TILES);
    expect(c.maxDistanceTiles).toBeLessThan(3 * STEP_TILES);
    expect(c.levels).toHaveLength(2);
  });

  it('never places a contour at or beyond the shape\'s own thickness', () => {
    // Every level's threshold must sit strictly inside the field, with a whole step to
    // spare. This is what makes the collapse unrepresentable rather than merely unlikely.
    for (const cells of [
      [{ gx: 5, gy: 5 }],
      block(1, 1, 1, 36),
      block(1, 1, 20, 2),
      block(1, 1, 3, 3),
      block(1, 1, 6, 6),
      block(1, 1, 30, 30),
    ]) {
      const c = buildTerrainContours(cells)!;
      expect(c.levels.length).toBeGreaterThanOrEqual(1);
      expect(c.levels.length).toBeLessThanOrEqual(MAX_TERRACES);
      if (c.levels.length < MAX_TERRACES) {
        expect(c.levels.length * STEP_TILES).toBeLessThanOrEqual(c.maxDistanceTiles);
      }
    }
  });

  it('still gives a painted half-cell one terrace, thinner than a single step', () => {
    // A quadrant brush stroke is ~0.125 tiles thick, which floors to zero levels. The lower
    // clamp is the only thing keeping a footprint on screen at all.
    const triangles: TriangleMap = new Map([['5,5', { top: true }]]);
    const c = buildTerrainContours([{ gx: 5, gy: 5 }], triangles)!;

    expect(c.maxDistanceTiles).toBeLessThan(STEP_TILES);
    expect(c.levels).toHaveLength(1);
    expect(c.levels[0].polygons.length).toBeGreaterThan(0);
    expect(Math.abs(signedArea(c.levels[0].polygons[0].outer))).toBeGreaterThan(0);
  });

  it('numbers levels consecutively from zero', () => {
    const c = buildTerrainContours(block(1, 1, 12, 12))!;
    expect(c.levels.map(l => l.index)).toEqual(c.levels.map((_, i) => i));
  });
});

describe('the footprint stays faithful to what was painted', () => {
  it('keeps level 0 within a quarter subcell of the traced boundary', () => {
    const c = buildTerrainContours(diagonalCells, diagonalTriangles)!;
    const raw = traceIsolines(c.field, 0);
    expect(raw).toHaveLength(1);
    expect(c.levels[0].polygons).toHaveLength(1);

    expect(maxDeviation(raw[0], c.levels[0].polygons[0].outer)).toBeLessThanOrEqual(OUTER_TOLERANCE);
  });

  it('simplifies away the per-lattice-edge vertices marching squares emits', () => {
    // Faithful is an upper bound on error, not a licence to forward every vertex: the trace
    // puts one on every crossed lattice edge, which a mesh has no use for.
    const c = buildTerrainContours(block(1, 1, 12, 12))!;
    const raw = traceIsolines(c.field, 0);
    expect(raw[0].length).toBeGreaterThan(100);
    // The footprint is a rectangle. Douglas-Peucker on a closed loop pins the first and last
    // points, so it keeps a handful more than the four corners, but nothing like 100.
    expect(c.levels[0].polygons[0].outer.length).toBeLessThanOrEqual(12);

    const diagonal = buildTerrainContours(diagonalCells, diagonalTriangles)!;
    const rawDiagonal = traceIsolines(diagonal.field, 0);
    expect(diagonal.levels[0].polygons[0].outer.length).toBeLessThan(rawDiagonal[0].length / 4);
  });

  it('applies a real tolerance, not merely collinear-point removal', () => {
    // Douglas-Peucker at tolerance zero already drops every exactly-collinear vertex, so a
    // vertex count alone cannot show a tolerance is in effect. Compare against that baseline:
    // the result must be a strict subset of it somewhere.
    const c = buildTerrainContours(diagonalCells, diagonalTriangles)!;
    let anyLooser = false;

    for (const level of c.levels) {
      const raw = traceIsolines(c.field, level.index * STEP_TILES);
      expect(raw).toHaveLength(1);
      const collinearOnly = simplifyLoop(raw[0], 0);
      // Douglas-Peucker is monotone in tolerance, so this can never exceed the baseline.
      expect(level.polygons[0].outer.length).toBeLessThanOrEqual(collinearOnly.length);
      if (level.polygons[0].outer.length < collinearOnly.length) anyLooser = true;
    }

    expect(anyLooser).toBe(true);
  });

  it('keeps inner levels within half a subcell of their traced isolines', () => {
    const c = buildTerrainContours(diagonalCells, diagonalTriangles)!;
    expect(c.levels.length).toBeGreaterThan(1);

    for (const level of c.levels.slice(1)) {
      const raw = traceIsolines(c.field, level.index * STEP_TILES);
      expect(raw).toHaveLength(1);
      expect(maxDeviation(raw[0], level.polygons[0].outer)).toBeLessThanOrEqual(INNER_TOLERANCE);
    }
  });

  it('nests each level strictly inside the one below, not merely smaller', () => {
    const c = buildTerrainContours(diagonalCells, diagonalTriangles)!;
    for (let i = 1; i < c.levels.length; i++) {
      const below = c.levels[i - 1].polygons[0].outer;
      for (const p of c.levels[i].polygons[0].outer) {
        expect(pointInPolygon(p, below)).toBe(true);
      }
    }
  });

  it('keeps a lake island as its own polygon, nested beside the hole that holds it', () => {
    // The second reported bug. A painted ring with an island inside it must survive as two
    // polygons: the ring (one hole) and the island (none).
    const key = (c: { gx: number; gy: number }) => `${c.gx},${c.gy}`;
    const hole = new Set(block(4, 4, 10, 10).map(key));
    const island = new Set(block(6, 6, 8, 8).map(key));
    const cells = block(0, 0, 14, 14).filter(c => !hole.has(key(c)) || island.has(key(c)));

    const c = buildTerrainContours(cells)!;
    expect(c.levels[0].polygons).toHaveLength(2);
    expect(c.levels[0].polygons[0].holes).toHaveLength(1);
    expect(c.levels[0].polygons[1].holes).toHaveLength(0);
    // The island sits inside the ring's hole, not inside its outer boundary's solid part.
    const islandPoint = c.levels[0].polygons[1].outer[0];
    expect(pointInPolygon(islandPoint, c.levels[0].polygons[0].holes[0])).toBe(true);
  });

  it('emits no empty levels and no zero-area loops across a battery of shapes', () => {
    // Deterministic pseudo-random blobs alongside the awkward hand-built cases. Zero-area
    // loops are reachable in principle — `nestLoops` filters by point count, not area — so
    // this is the net that would catch one reaching a `THREE.Shape`.
    const shapes: { gx: number; gy: number }[][] = [
      block(0, 0, 0, 8),
      [...block(0, 0, 0, 8), ...block(0, 8, 8, 8)],
      [...block(4, 0, 5, 9), ...block(0, 4, 9, 5)],
      block(0, 0, 9, 9).filter(c => !(c.gx >= 3 && c.gx <= 6 && c.gy >= 3 && c.gy <= 6)),
      Array.from({ length: 8 }, (_, i) => ({ gx: i, gy: i })),
    ];
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 20; k++) {
      const cells: { gx: number; gy: number }[] = [];
      for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) if (random() < 0.55) cells.push({ gx: x, gy: y });
      if (cells.length > 0) shapes.push(cells);
    }

    for (const cells of shapes) {
      for (const shorelineTiles of [0, 0.2]) {
        const c = buildTerrainContours(cells, undefined, shorelineTiles)!;
        for (const level of c.levels) expect(level.polygons.length).toBeGreaterThan(0);
        for (const loop of [...c.levels.flatMap(l => allLoops(l.polygons)), ...allLoops(c.shoreline)]) {
          expect(Math.abs(signedArea(loop))).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('shoreline', () => {
  it('is empty when no shoreline width is asked for', () => {
    expect(buildTerrainContours(block(3, 3, 7, 7))!.shoreline).toEqual([]);
    expect(buildTerrainContours(block(3, 3, 7, 7), undefined, 0)!.shoreline).toEqual([]);
  });

  it('sits exactly shorelineTiles outward from the painted bounds', () => {
    // Pins both the sign and the magnitude: an inward or doubled offset fails here even
    // though it would still enclose more area than nothing.
    const shorelineTiles = 0.15;
    const c = buildTerrainContours(block(3, 3, 7, 7), undefined, shorelineTiles)!;
    expect(c.shoreline).toHaveLength(1);

    const offset = shorelineTiles * TILE_SIZE;
    const xs = c.shoreline[0].outer.map(p => p[0]);
    const ys = c.shoreline[0].outer.map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(3 * TILE_SIZE - offset, 1);
    expect(Math.max(...xs)).toBeCloseTo(8 * TILE_SIZE + offset, 1);
    expect(Math.min(...ys)).toBeCloseTo(3 * TILE_SIZE - offset, 1);
    expect(Math.max(...ys)).toBeCloseTo(8 * TILE_SIZE + offset, 1);
  });

  it('is a silhouette too, so it keeps the tight outer tolerance', () => {
    const c = buildTerrainContours(diagonalCells, diagonalTriangles, 0.2)!;
    const raw = traceIsolines(c.field, -0.2);
    expect(raw).toHaveLength(1);
    expect(c.shoreline).toHaveLength(1);

    expect(maxDeviation(raw[0], c.shoreline[0].outer)).toBeLessThanOrEqual(OUTER_TOLERANCE);
  });

  it('encloses every point of the footprint', () => {
    const c = buildTerrainContours(block(3, 3, 7, 7), undefined, 0.15)!;
    for (const p of c.levels[0].polygons[0].outer) {
      expect(pointInPolygon(p, c.shoreline[0].outer)).toBe(true);
    }
  });
});

describe('worldToSample', () => {
  it('inverts sampleToWorld, including on a field whose origin is not square', () => {
    const c = buildTerrainContours(block(7, 2, 9, 3))!;
    expect(c.field.originGx).not.toBe(c.field.originGy);

    for (const [sx, sy] of [[0, 0], [3, 7], [5, 2]]) {
      const world = sampleToWorld(c.field, sx, sy);
      const back = worldToSample(c.field, world.x, world.y);
      expect(back.sx).toBeCloseTo(sx, 9);
      expect(back.sy).toBeCloseTo(sy, 9);
    }
  });

  it('reads zero depth on the painted boundary and full depth inside', () => {
    const c = buildTerrainContours(block(2, 3, 9, 10))!;
    const depthAt = (gx: number, gy: number) => {
      const s = worldToSample(c.field, gx * TILE_SIZE, gy * TILE_SIZE);
      return sampleFieldBilinear(c.field, s.sx, s.sy);
    };

    expect(depthAt(2, 6.5)).toBeCloseTo(0, 6);
    expect(depthAt(6, 3)).toBeCloseTo(0, 6);
    expect(depthAt(3, 6.5)).toBeCloseTo(1, 6);
    expect(depthAt(6, 7)).toBeCloseTo(c.maxDistanceTiles, 6);
    expect(depthAt(0.5, 6.5)).toBeLessThan(0);
  });
});
