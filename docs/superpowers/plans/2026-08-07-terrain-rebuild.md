# Terrain Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mountain and water geometry pipeline with a distance-field-plus-marching-squares approach, and replace random-walk terrain generation with seeded noise-shaped landforms, so that silhouettes are sane, lakes read as deep, and both can contain islands.

**Architecture:** A new pure `src/terrain/` module turns grid cells into terrace contours with no Three.js dependency, making the geometry unit-testable in Node for the first time. Rendering layers become thin consumers of that output plus a shared extrusion helper. `ObstacleSystem` grows landforms from Poisson-disc seeds shaped by noise-modulated radial falloff, driven by a seeded PRNG.

**Tech Stack:** TypeScript (no build step — the package ships raw sources), Three.js for meshes, Vitest in a Node environment with no DOM and no WebGL.

**Spec:** `docs/superpowers/specs/2026-08-07-terrain-rebuild-design.md`

## Global Constraints

- **Public API is unchanged.** Nothing in `src/index.ts` may be added, removed, or moved.
- **No new runtime dependencies.** The package ships raw TypeScript; consumers transpile it.
- **No `enum`.** `erasableSyntaxOnly` is on. Use `as const` objects, matching `src/types.ts`.
- **Configurable constants are read only through the resolved `cfg`.** A key of `DEFAULT_GAME_CONSTANTS` must never be imported from `src/constants` by any engine file. `src/constants.test.ts` enforces this statically, including through re-exports.
- **Tests are Node-only.** No DOM, no WebGL, no canvas. Anything requiring a canvas is verified by running the demo.
- **Every task ends green.** `npm test`, `npm run typecheck`, and `npm run lint` all pass, and the demo still runs, at every commit.
- **Commit style:** no `Co-Authored-By` line is required by the repo, but including one is harmless. Do not commit outside the steps below.
- Work happens on the already-checked-out `terrain-rebuild` branch.

## Deviations from the spec

Two spec statements were wrong on closer inspection. The plan follows the corrected versions.

1. **The spec says `serializeMap` stops emitting `height`.** It must not. `src/maps/narrow-pass/narrow-pass.json` carries `height` on all 123 obstacles and `src/maps/schema.test.ts:218` asserts it survives a whole-config round trip. `fromObstacle`'s passthrough (`serializeMap.ts:30`) stays exactly as it is. Only `MapDesigner` stops *producing* heights, and only `ObstacleSystem` stops *storing* them. `height` remains a deprecated, ignored, passed-through field.
2. **The spec says new `GameConstants` keys must be added to the zod schema.** They register automatically: `constantsSchema` is built from `Object.keys(DEFAULT_GAME_CONSTANTS)` (`src/maps/schema.ts:147`). Adding the key to the type and the defaults object is sufficient.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/utils/rng.ts` | `mulberry32` seeded PRNG |
| `src/terrain/field.ts` | grid cells + triangle quadrants -> binary coverage field |
| `src/terrain/distanceField.ts` | coverage -> signed distance field, in tile units |
| `src/terrain/marchingSquares.ts` | signed field + threshold -> closed loops, traced by edge identity |
| `src/terrain/polygons.ts` | signed area, winding, point-in-polygon, Douglas-Peucker, hole nesting |
| `src/terrain/contours.ts` | orchestrates the above -> terrace levels + shoreline |
| `src/rendering/layers/terrainMesh.ts` | shared extruded-terrace mesh builder |

**Modified**

| File | Change |
|---|---|
| `src/constants.ts` | add `LAKE_ISLAND_CHANCE`, `TERRAIN_NOISE_SCALE`; remove `MOUNTAIN_MIN_HEIGHT`, `MOUNTAIN_MAX_HEIGHT` |
| `src/maps/types.ts` | add the two new keys to `GameConstants`; deprecation note on `ObstacleDefinition.height` |
| `src/systems/ObstacleSystem.ts` | new generation; drop the height map, `growCluster`, `hasAdjacentObstacle` |
| `src/rendering/layers/ObstacleLayer.ts` | rewrite onto `contours.ts` + `terrainMesh.ts` |
| `src/rendering/layers/LakeLayer.ts` | rewrite, plus vertex-colour depth ramp |
| `src/rendering/layers/TerrainLayer.ts` | share the contour source; support island holes |
| `src/designer/MapDesigner.ts` | stop writing and reading mountain heights |

**Deleted**

- `src/rendering/layers/terrainContourUtils.ts` in full.

---

### Task 1: Seeded PRNG

**Files:**
- Create: `src/utils/rng.ts`
- Test: `src/utils/rng.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mulberry32(seed: number): () => number` — returns a function yielding floats in `[0, 1)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/rng.test.ts
import { describe, it, expect } from 'vitest';
import { mulberry32 } from './rng';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('stays within [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = mulberry32(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(rng() * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/rng.test.ts`
Expected: FAIL — cannot resolve `./rng`.

- [ ] **Step 3: Write the implementation**

```ts
// src/utils/rng.ts

/**
 * A small deterministic PRNG, used so terrain generation can be pinned in tests.
 *
 * The engine previously called `Math.random()` directly everywhere, which meant generated
 * terrain could not be asserted on at all. `ObstacleSystem` takes a seed and threads this
 * through instead. It is a *generation* seed, not a wire-format field: maps do not carry
 * one, and unseeded construction still randomises so gameplay stays varied.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/rng.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/rng.ts src/utils/rng.test.ts
git commit -m "feat(utils): add a seeded PRNG for terrain generation"
```

---

### Task 2: Coverage field

**Files:**
- Create: `src/terrain/field.ts`
- Test: `src/terrain/field.test.ts`

**Interfaces:**
- Consumes: `GridPos` from `src/types`, `TILE_SIZE` from `src/constants` (not a `GameConstants` key, so importing it is allowed).
- Produces:
  - `const SUBCELL = 4`
  - `interface CoverageField { width: number; height: number; originGx: number; originGy: number; data: Float32Array }`
  - `buildCoverageField(cells: GridPos[], triangles?: TriangleMap): CoverageField | null` — `null` when `cells` is empty.
  - `type TriangleMap = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>`
  - `sampleAt(field: CoverageField, sx: number, sy: number): number` — 0 outside the field.
  - `sampleToWorld(field: CoverageField, sx: number, sy: number): { x: number; y: number }`

**Context for the implementer.** A terrain cell may be subdivided into four triangular quadrants meeting at the cell centre, painted independently in the map designer. The quadrant containing a point at cell-local fractional coords `(u, v)` in `[0,1)` is determined by the two diagonals, matching `MapDesigner.ts:389`: with `d1 = v < u` and `d2 = v < 1 - u`, the quadrant is `top` when `d1 && d2`, `right` when `d1 && !d2`, `bottom` when `!d1 && !d2`, and `left` otherwise. A cell with no entry in the triangle map, or with all four flags set, is a full cell.

The field is padded by one whole cell on every side. This matters: marching squares must never find a crossing on the outermost lattice row, or loops would run off the edge and fail to close.

**Coverage is fractional, and this is not optional.** A single point test per subsample gets quadrant areas badly wrong, because the quadrant diagonals pass exactly through the sample centres of an even lattice. At `SUBCELL = 4` a point test yields top=2, left=4, right=4, bottom=6 subsamples where all four should be 4 — a painted `top` triangle would render at *half* the area of a painted `bottom` one. So each subsample's coverage is the fraction of an 8x8 supersample grid falling inside an active quadrant, which brings all four quadrants to 4.0 +/- 0.25, and the `u` axis carries a tiny epsilon so no supersample lands exactly on a diagonal. Full cells skip all of this and write 1.0 directly, so the cost is paid only by the rare cell the designer has actually subdivided.

- [ ] **Step 1: Write the failing test**

```ts
// src/terrain/field.test.ts
import { describe, it, expect } from 'vitest';
import { buildCoverageField, sampleAt, SUBCELL } from './field';

describe('buildCoverageField', () => {
  it('returns null for no cells', () => {
    expect(buildCoverageField([])).toBeNull();
  });

  it('covers a full cell entirely', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    let inside = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i] > 0) inside++;
    expect(inside).toBe(SUBCELL * SUBCELL);
  });

  it('pads by one cell on every side', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    expect(f.originGx).toBe(4);
    expect(f.originGy).toBe(4);
    expect(f.width).toBe(3 * SUBCELL);
    expect(f.height).toBe(3 * SUBCELL);
  });

  it('leaves the border samples empty so contours always close', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }])!;
    for (let x = 0; x < f.width; x++) {
      expect(sampleAt(f, x, 0)).toBe(0);
      expect(sampleAt(f, x, f.height - 1)).toBe(0);
    }
    for (let y = 0; y < f.height; y++) {
      expect(sampleAt(f, 0, y)).toBe(0);
      expect(sampleAt(f, f.width - 1, y)).toBe(0);
    }
  });

  it('gives a single quadrant about a quarter of the cell', () => {
    const f = buildCoverageField([{ gx: 5, gy: 5 }], new Map([['5,5', { top: true }]]))!;
    let total = 0;
    for (let i = 0; i < f.data.length; i++) total += f.data[i];
    // A quarter of SUBCELL^2 = 4. Supersampling holds this within a rounding margin.
    expect(total).toBeGreaterThan(3.4);
    expect(total).toBeLessThan(4.6);
  });

  it('gives all four quadrants near-equal area', () => {
    // The regression test for point sampling, which skewed these to 2 / 4 / 4 / 6.
    const areas = (['top', 'right', 'bottom', 'left'] as const).map(q => {
      const f = buildCoverageField([{ gx: 5, gy: 5 }], new Map([['5,5', { [q]: true }]]))!;
      let total = 0;
      for (let i = 0; i < f.data.length; i++) total += f.data[i];
      return total;
    });
    for (const area of areas) {
      expect(area).toBeGreaterThan(3.4);
      expect(area).toBeLessThan(4.6);
    }
  });

  it('places the top quadrant above centre and the bottom quadrant below', () => {
    const top = buildCoverageField([{ gx: 0, gy: 0 }], new Map([['0,0', { top: true }]]))!;
    const bottom = buildCoverageField([{ gx: 0, gy: 0 }], new Map([['0,0', { bottom: true }]]))!;
    // Sample just inside the cell, above and below its centre.
    const above = { x: SUBCELL + 2, y: SUBCELL + 0 };
    const below = { x: SUBCELL + 2, y: SUBCELL + 3 };
    expect(sampleAt(top, above.x, above.y)).toBeGreaterThan(0.5);
    expect(sampleAt(top, below.x, below.y)).toBeLessThan(0.5);
    expect(sampleAt(bottom, above.x, above.y)).toBeLessThan(0.5);
    expect(sampleAt(bottom, below.x, below.y)).toBeGreaterThan(0.5);
  });

  it('treats all four flags set as a full cell', () => {
    const tri = new Map([['5,5', { top: true, right: true, bottom: true, left: true }]]);
    const f = buildCoverageField([{ gx: 5, gy: 5 }], tri)!;
    let inside = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i] > 0) inside++;
    expect(inside).toBe(SUBCELL * SUBCELL);
  });

  it('spans the bounding box of disjoint cells', () => {
    const f = buildCoverageField([{ gx: 2, gy: 3 }, { gx: 6, gy: 3 }])!;
    expect(f.originGx).toBe(1);
    expect(f.width).toBe(7 * SUBCELL); // cells 1..7 inclusive
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/terrain/field.test.ts`
Expected: FAIL — cannot resolve `./field`.

- [ ] **Step 3: Write the implementation**

```ts
// src/terrain/field.ts
import type { GridPos } from '../types';
import { TILE_SIZE } from '../constants';

/** Both mountain and lake triangle maps share this structure. */
export type TriangleMap = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>;

/**
 * Samples per cell edge. Four is enough to resolve the half-tile triangle quadrants the
 * designer paints, which are the finest feature the map format can express.
 */
export const SUBCELL = 4;

/** Cells of padding around the bounding box, so no contour crossing lands on the border. */
const PAD_CELLS = 1;

/**
 * Supersamples per axis within one subsample, used only for triangle-subdivided cells.
 *
 * A single point test per subsample is not good enough: the quadrant diagonals run exactly
 * through the sample centres of an even lattice, which skews the four quadrant areas to
 * 2 / 4 / 4 / 6 instead of 4 / 4 / 4 / 4. Averaging an 8x8 grid brings them within 0.25.
 */
const SUPERSAMPLE = 8;

/** Nudges the u axis off the diagonals so no supersample sits exactly on a boundary. */
const U_EPSILON = 1e-4;

export interface CoverageField {
  /** Sample counts, not cell counts. */
  width: number;
  height: number;
  /** Grid coordinate of the field's top-left corner. */
  originGx: number;
  originGy: number;
  /** Row-major, `width * height` entries, each a coverage fraction in `[0, 1]`. */
  data: Float32Array;
}

export function sampleAt(field: CoverageField, sx: number, sy: number): number {
  if (sx < 0 || sy < 0 || sx >= field.width || sy >= field.height) return 0;
  return field.data[sy * field.width + sx];
}

/** World-space pixel position of a sample's centre. */
export function sampleToWorld(field: CoverageField, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (field.originGx + (sx + 0.5) / SUBCELL) * TILE_SIZE,
    y: (field.originGy + (sy + 0.5) / SUBCELL) * TILE_SIZE,
  };
}

/**
 * Rasterise terrain cells into a binary coverage field.
 *
 * Triangle quadrants are not a special case here: a quadrant simply claims the subsamples
 * whose centres fall inside it. Everything downstream sees one uniform field, which is why
 * the old `getTriFlags` branching in the contour extractor is gone.
 */
export function buildCoverageField(cells: GridPos[], triangles?: TriangleMap): CoverageField | null {
  if (cells.length === 0) return null;

  let minGx = Infinity, minGy = Infinity, maxGx = -Infinity, maxGy = -Infinity;
  for (const c of cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gy < minGy) minGy = c.gy;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gy > maxGy) maxGy = c.gy;
  }

  const originGx = minGx - PAD_CELLS;
  const originGy = minGy - PAD_CELLS;
  const cols = maxGx - minGx + 1 + 2 * PAD_CELLS;
  const rows = maxGy - minGy + 1 + 2 * PAD_CELLS;
  const width = cols * SUBCELL;
  const height = rows * SUBCELL;
  const data = new Float32Array(width * height);

  for (const c of cells) {
    const tri = triangles?.get(`${c.gx},${c.gy}`);
    const full = !tri || (tri.top === true && tri.right === true && tri.bottom === true && tri.left === true);

    const baseX = (c.gx - originGx) * SUBCELL;
    const baseY = (c.gy - originGy) * SUBCELL;

    for (let j = 0; j < SUBCELL; j++) {
      for (let i = 0; i < SUBCELL; i++) {
        const coverage = full ? 1 : quadrantCoverage(tri!, i, j);
        if (coverage > 0) data[(baseY + j) * width + (baseX + i)] = coverage;
      }
    }
  }

  return { width, height, originGx, originGy, data };
}

/** Fraction of subsample `(i, j)` covered by the cell's active quadrants. */
function quadrantCoverage(
  tri: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean },
  i: number,
  j: number,
): number {
  let hits = 0;
  for (let n = 0; n < SUPERSAMPLE; n++) {
    for (let m = 0; m < SUPERSAMPLE; m++) {
      const u = (i + (m + 0.5) / SUPERSAMPLE) / SUBCELL + U_EPSILON;
      const v = (j + (n + 0.5) / SUPERSAMPLE) / SUBCELL;
      if (quadrantActive(tri, u, v)) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/**
 * Which quadrant a cell-local point falls in, matching the designer's brush
 * (`MapDesigner.ts:389`) exactly so that what you paint is what gets rasterised.
 */
function quadrantActive(
  tri: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean },
  u: number,
  v: number,
): boolean {
  const aboveDiag1 = v < u;
  const aboveDiag2 = v < 1 - u;
  if (aboveDiag1 && aboveDiag2) return tri.top === true;
  if (aboveDiag1 && !aboveDiag2) return tri.right === true;
  if (!aboveDiag1 && !aboveDiag2) return tri.bottom === true;
  return tri.left === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/terrain/field.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/field.ts src/terrain/field.test.ts
git commit -m "feat(terrain): rasterise cells and triangle quadrants into a coverage field"
```

---

### Task 3: Signed distance field

**Files:**
- Create: `src/terrain/distanceField.ts`
- Test: `src/terrain/distanceField.test.ts`

**Interfaces:**
- Consumes: `CoverageField`, `SUBCELL` from `./field`.
- Produces:
  - `interface SignedField { width: number; height: number; originGx: number; originGy: number; data: Float32Array; maxInside: number }`
  - `buildSignedDistanceField(coverage: CoverageField): SignedField` — `data` is distance in **tile units**, positive inside terrain, negative outside. `maxInside` is the largest positive value.
  - `sampleFieldBilinear(field: SignedField, sx: number, sy: number): number`

**Context for the implementer.** This is a two-pass chamfer distance transform: a forward raster scan propagating from already-visited neighbours, then a backward scan doing the same in reverse. Orthogonal steps cost 1 and diagonal steps cost √2, both in *sample* units, converted to tile units at the end by dividing by `SUBCELL`. It is an approximation to true Euclidean distance, accurate to a few percent, which is far more than terracing needs. Run it twice — once for the inside, once for the outside — and subtract to get a signed field.

Why signed: threshold 0 is the painted footprint, positive thresholds are the terraces stepping inward, and negative thresholds give the shoreline ring outside the footprint. One field serves all three.

- [ ] **Step 1: Write the failing test**

```ts
// src/terrain/distanceField.test.ts
import { describe, it, expect } from 'vitest';
import { buildCoverageField, SUBCELL } from './field';
import { buildSignedDistanceField, sampleFieldBilinear } from './distanceField';

function fieldFor(cells: { gx: number; gy: number }[]) {
  return buildSignedDistanceField(buildCoverageField(cells)!);
}

/** Value at the centre of the given cell. */
function atCellCentre(f: ReturnType<typeof fieldFor>, gx: number, gy: number): number {
  const sx = (gx - f.originGx) * SUBCELL + SUBCELL / 2 - 0.5;
  const sy = (gy - f.originGy) * SUBCELL + SUBCELL / 2 - 0.5;
  return sampleFieldBilinear(f, sx, sy);
}

describe('buildSignedDistanceField', () => {
  it('is positive inside terrain and negative outside', () => {
    const f = fieldFor([{ gx: 5, gy: 5 }]);
    expect(atCellCentre(f, 5, 5)).toBeGreaterThan(0);
    expect(atCellCentre(f, 4, 5)).toBeLessThan(0);
  });

  it('reports a single cell as roughly half a tile thick', () => {
    const f = fieldFor([{ gx: 5, gy: 5 }]);
    expect(f.maxInside).toBeGreaterThan(0.3);
    expect(f.maxInside).toBeLessThan(0.6);
  });

  it('grows with shape width', () => {
    const thin = fieldFor([
      { gx: 1, gy: 1 }, { gx: 2, gy: 1 }, { gx: 3, gy: 1 }, { gx: 4, gy: 1 },
    ]);
    const wide: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 6; x++) for (let y = 1; y <= 6; y++) wide.push({ gx: x, gy: y });
    expect(fieldFor(wide).maxInside).toBeGreaterThan(thin.maxInside * 2);
  });

  it('is symmetric about the centre of a square block', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 2; x <= 6; x++) for (let y = 2; y <= 6; y++) cells.push({ gx: x, gy: y });
    const f = fieldFor(cells);
    const left = atCellCentre(f, 3, 4);
    const right = atCellCentre(f, 5, 4);
    expect(Math.abs(left - right)).toBeLessThan(0.05);
  });

  it('shallows near an interior hole, so islands read correctly', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x === 4 && y === 4) continue; // the island
        cells.push({ gx: x, gy: y });
      }
    }
    const f = fieldFor(cells);
    const besideHole = atCellCentre(f, 3, 4);
    const awayFromHole = atCellCentre(f, 2, 2);
    expect(besideHole).toBeLessThan(awayFromHole);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/terrain/distanceField.test.ts`
Expected: FAIL — cannot resolve `./distanceField`.

- [ ] **Step 3: Write the implementation**

```ts
// src/terrain/distanceField.ts
import type { CoverageField } from './field';
import { SUBCELL } from './field';

const ORTHO = 1;
const DIAG = Math.SQRT2;

export interface SignedField {
  width: number;
  height: number;
  originGx: number;
  originGy: number;
  /** Distance in tile units. Positive inside terrain, negative outside. */
  data: Float32Array;
  /** Largest positive value — how thick the thickest part of the shape is. */
  maxInside: number;
}

/**
 * Signed distance from the terrain boundary, in tile units.
 *
 * Terrace thresholds are read off this field, which is what makes the old collapse bug
 * unrepresentable: a shape two tiles wide simply has no samples above 1.0, so it cannot
 * be assigned six terraces however many cells it contains.
 */
export function buildSignedDistanceField(coverage: CoverageField): SignedField {
  const { width, height, data: cov } = coverage;

  // Coverage is fractional for triangle-subdivided cells, so "inside" is a majority test,
  // not a non-zero test. Half coverage is exactly the quadrant boundary.
  const inside = chamfer(cov, width, height, (v) => v >= 0.5);
  const outside = chamfer(cov, width, height, (v) => v < 0.5);

  const data = new Float32Array(width * height);
  let maxInside = 0;

  for (let i = 0; i < data.length; i++) {
    // Each half measures distance to the *nearest sample of the other kind*. Subtracting
    // half a sample from each side puts the zero crossing on the boundary between them
    // rather than half a sample inside it.
    const d = cov[i] >= 0.5 ? inside[i] - 0.5 : -(outside[i] - 0.5);
    const tiles = d / SUBCELL;
    data[i] = tiles;
    if (tiles > maxInside) maxInside = tiles;
  }

  return { width, height, originGx: coverage.originGx, originGy: coverage.originGy, data, maxInside };
}

/**
 * Two-pass chamfer transform: distance from every sample matching `isSubject` to the
 * nearest sample that does not.
 */
function chamfer(
  cov: Float32Array,
  width: number,
  height: number,
  isSubject: (v: number) => boolean,
): Float32Array {
  const dist = new Float32Array(width * height);
  const BIG = width + height;

  for (let i = 0; i < dist.length; i++) dist[i] = isSubject(cov[i]) ? BIG : 0;

  // Forward pass: north-west neighbourhood.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, dist[i - width - 1] + DIAG);
        best = Math.min(best, dist[i - width] + ORTHO);
        if (x < width - 1) best = Math.min(best, dist[i - width + 1] + DIAG);
      }
      if (x > 0) best = Math.min(best, dist[i - 1] + ORTHO);
      dist[i] = best;
    }
  }

  // Backward pass: south-east neighbourhood.
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y < height - 1) {
        if (x < width - 1) best = Math.min(best, dist[i + width + 1] + DIAG);
        best = Math.min(best, dist[i + width] + ORTHO);
        if (x > 0) best = Math.min(best, dist[i + width - 1] + DIAG);
      }
      if (x < width - 1) best = Math.min(best, dist[i + 1] + ORTHO);
      dist[i] = best;
    }
  }

  return dist;
}

/** Bilinear sample, for reading depth at arbitrary mesh vertices. */
export function sampleFieldBilinear(field: SignedField, sx: number, sy: number): number {
  const { width, height, data } = field;
  const cx = Math.max(0, Math.min(width - 1.001, sx));
  const cy = Math.max(0, Math.min(height - 1.001, sy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/terrain/distanceField.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/terrain/distanceField.ts src/terrain/distanceField.test.ts
git commit -m "feat(terrain): add a signed distance field over the coverage grid"
```

---

### Task 4: Marching squares

**Files:**
- Create: `src/terrain/marchingSquares.ts`
- Test: `src/terrain/marchingSquares.test.ts`

**Interfaces:**
- Consumes: `SignedField` from `./distanceField`, `SUBCELL` from `./field`, `TILE_SIZE` from `src/constants`.
- Produces: `traceIsolines(field: SignedField, threshold: number): number[][][]` — an array of closed loops, each an array of `[x, y]` world-pixel points whose first and last entries are equal.

**Context for the implementer — read this before writing code.** This is the task that replaces the tangling `chainSegments`, so the mechanism matters.

Each 2×2 block of samples is one marching-squares cell with four edges. A contour crossing lies on an edge exactly when its two samples straddle the threshold, so **each edge carries at most one crossing point**. Identify crossings by *edge identity*, never by floating-point position — that is what makes linking exact.

Every edge is shared by exactly two marching-squares cells, and each of those cells contributes exactly one connection through it. So every crossing has degree exactly 2, and walking the graph is unambiguous — there is no arbitrary choice to make. The field's zero-padded border (Task 2) guarantees no crossing lands on an outer edge, so every walk closes.

Two cases are genuinely ambiguous — case 5 (top-left and bottom-right inside) and case 10 (its complement). Resolve both by the average of the four corner values: if the centre is inside, the two inside corners connect through it. This choice is what keeps every degree at 2.

Edge numbering within a cell at `(x, y)`, whose corners are `TL=(x,y)`, `TR=(x+1,y)`, `BR=(x+1,y+1)`, `BL=(x,y+1)`:

| Index | Edge | Between samples |
|---|---|---|
| 0 | top | `(x,y)` – `(x+1,y)` |
| 1 | right | `(x+1,y)` – `(x+1,y+1)` |
| 2 | bottom | `(x,y+1)` – `(x+1,y+1)` |
| 3 | left | `(x,y)` – `(x,y+1)` |

Case index is `(TL≥t?1:0) | (TR≥t?2:0) | (BR≥t?4:0) | (BL≥t?8:0)`. The connection table:

| Case | Connects | Case | Connects |
|---|---|---|---|
| 0 | — | 8 | 2–3 |
| 1 | 3–0 | 9 | 0–2 |
| 2 | 0–1 | 10 | ambiguous |
| 3 | 3–1 | 11 | 1–2 |
| 4 | 1–2 | 12 | 3–1 |
| 5 | ambiguous | 13 | 0–1 |
| 6 | 0–2 | 14 | 3–0 |
| 7 | 3–2 | 15 | — |

Case 5: centre inside → `0–1` and `2–3`; centre outside → `3–0` and `1–2`.
Case 10: centre inside → `3–0` and `1–2`; centre outside → `0–1` and `2–3`.

- [ ] **Step 1: Write the failing test**

```ts
// src/terrain/marchingSquares.test.ts
import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../constants';
import { buildCoverageField } from './field';
import { buildSignedDistanceField } from './distanceField';
import { traceIsolines } from './marchingSquares';

function trace(cells: { gx: number; gy: number }[], threshold = 0) {
  return traceIsolines(buildSignedDistanceField(buildCoverageField(cells)!), threshold);
}

function isClosed(loop: number[][]): boolean {
  const a = loop[0];
  const b = loop[loop.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function bounds(loop: number[][]) {
  const xs = loop.map(p => p[0]);
  const ys = loop.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('traceIsolines', () => {
  it('produces one closed loop for a single cell', () => {
    const loops = trace([{ gx: 5, gy: 5 }]);
    expect(loops).toHaveLength(1);
    expect(isClosed(loops[0])).toBe(true);
  });

  it('every emitted loop is closed', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 6; x++) for (let y = 1; y <= 4; y++) cells.push({ gx: x, gy: y });
    for (const loop of trace(cells)) expect(isClosed(loop)).toBe(true);
  });

  it('traces a painted square close to its painted bounds', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 2; x <= 5; x++) for (let y = 2; y <= 5; y++) cells.push({ gx: x, gy: y });
    const loops = trace(cells);
    expect(loops).toHaveLength(1);
    const b = bounds(loops[0]);
    const tol = TILE_SIZE * 0.3;
    expect(Math.abs(b.minX - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.maxX - 6 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.minY - 2 * TILE_SIZE)).toBeLessThan(tol);
    expect(Math.abs(b.maxY - 6 * TILE_SIZE)).toBeLessThan(tol);
  });

  it('traces a ring as two loops, not one filled disc', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 7; x++) {
      for (let y = 1; y <= 7; y++) {
        if (x >= 3 && x <= 5 && y >= 3 && y <= 5) continue;
        cells.push({ gx: x, gy: y });
      }
    }
    const loops = trace(cells);
    expect(loops).toHaveLength(2);
    for (const loop of loops) expect(isClosed(loop)).toBe(true);
  });

  it('traces two disjoint blobs as two loops', () => {
    const loops = trace([{ gx: 2, gy: 2 }, { gx: 8, gy: 2 }]);
    expect(loops).toHaveLength(2);
  });

  it('resolves a diagonal pinch without dropping or duplicating a loop', () => {
    // Two cells touching only at a corner — the configuration the old walker tangled on.
    const loops = trace([{ gx: 3, gy: 3 }, { gx: 4, gy: 4 }]);
    expect(loops.length).toBeGreaterThanOrEqual(1);
    for (const loop of loops) {
      expect(isClosed(loop)).toBe(true);
      expect(loop.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('shrinks inward as the threshold rises', () => {
    const cells: { gx: number; gy: number }[] = [];
    for (let x = 1; x <= 8; x++) for (let y = 1; y <= 8; y++) cells.push({ gx: x, gy: y });
    const outer = bounds(trace(cells, 0)[0]);
    const inner = bounds(trace(cells, 1.0)[0]);
    expect(inner.minX).toBeGreaterThan(outer.minX);
    expect(inner.maxX).toBeLessThan(outer.maxX);
  });

  it('returns nothing when the threshold exceeds the shape thickness', () => {
    expect(trace([{ gx: 5, gy: 5 }], 5)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/terrain/marchingSquares.test.ts`
Expected: FAIL — cannot resolve `./marchingSquares`.

- [ ] **Step 3: Write the implementation**

```ts
// src/terrain/marchingSquares.ts
import { TILE_SIZE } from '../constants';
import { SUBCELL } from './field';
import type { SignedField } from './distanceField';

/**
 * Trace closed isolines of a signed field at a given threshold.
 *
 * This replaces the old boundary-segment walker, which chose continuations arbitrarily
 * wherever four segments met a vertex — the common case for anything painted freehand in
 * the designer, and the source of the tangled silhouettes.
 *
 * Crossings are identified by *edge identity*, not by position. Every edge is shared by
 * exactly two cells, each contributing one connection through it, so every crossing has
 * degree exactly 2 and the walk is forced. The coverage field's zero-padded border
 * guarantees no crossing sits on an outer edge, so every walk closes.
 *
 * Returns loops of `[x, y]` world-pixel points, first point repeated at the end.
 */
export function traceIsolines(field: SignedField, threshold: number): number[][][] {
  const { width, height, data } = field;
  if (width < 2 || height < 2) return [];

  const hCount = (width - 1) * height;
  const horizontalEdge = (x: number, y: number) => y * (width - 1) + x;
  const verticalEdge = (x: number, y: number) => hCount + y * width + x;

  /** edge id -> the crossing point on it, in world pixels */
  const points = new Map<number, [number, number]>();
  /** edge id -> the up-to-two edge ids it links to */
  const links = new Map<number, number[]>();

  const worldX = (sx: number) => (field.originGx + (sx + 0.5) / SUBCELL) * TILE_SIZE;
  const worldY = (sy: number) => (field.originGy + (sy + 0.5) / SUBCELL) * TILE_SIZE;

  function crossing(id: number, ax: number, ay: number, bx: number, by: number): number {
    if (!points.has(id)) {
      const va = data[ay * width + ax];
      const vb = data[by * width + bx];
      let t = (threshold - va) / (vb - va);
      if (!Number.isFinite(t)) t = 0.5;
      t = Math.max(0, Math.min(1, t));
      points.set(id, [
        worldX(ax + (bx - ax) * t),
        worldY(ay + (by - ay) * t),
      ]);
    }
    return id;
  }

  function connect(a: number, b: number): void {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a)!.push(b);
    links.get(b)!.push(a);
  }

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = data[y * width + x];
      const tr = data[y * width + x + 1];
      const br = data[(y + 1) * width + x + 1];
      const bl = data[(y + 1) * width + x];

      const code =
        (tl >= threshold ? 1 : 0) |
        (tr >= threshold ? 2 : 0) |
        (br >= threshold ? 4 : 0) |
        (bl >= threshold ? 8 : 0);

      if (code === 0 || code === 15) continue;

      // Lazily resolve only the edges this case needs.
      const top = () => crossing(horizontalEdge(x, y), x, y, x + 1, y);
      const right = () => crossing(verticalEdge(x + 1, y), x + 1, y, x + 1, y + 1);
      const bottom = () => crossing(horizontalEdge(x, y + 1), x, y + 1, x + 1, y + 1);
      const left = () => crossing(verticalEdge(x, y), x, y, x, y + 1);

      switch (code) {
        case 1: case 14: connect(left(), top()); break;
        case 2: case 13: connect(top(), right()); break;
        case 3: case 12: connect(left(), right()); break;
        case 4: case 11: connect(right(), bottom()); break;
        case 6: case 9: connect(top(), bottom()); break;
        case 7: case 8: connect(left(), bottom()); break;
        case 5:
        case 10: {
          // Ambiguous saddle. The centre value decides which pair of corners is joined;
          // either choice keeps every crossing at degree 2, but they give different shapes.
          const centreInside = (tl + tr + br + bl) / 4 >= threshold;
          const joinAcross = code === 5 ? centreInside : !centreInside;
          if (joinAcross) {
            connect(top(), right());
            connect(bottom(), left());
          } else {
            connect(left(), top());
            connect(right(), bottom());
          }
          break;
        }
      }
    }
  }

  return walkLoops(points, links);
}

function walkLoops(
  points: Map<number, [number, number]>,
  links: Map<number, number[]>,
): number[][][] {
  const visited = new Set<number>();
  const loops: number[][][] = [];

  for (const start of links.keys()) {
    if (visited.has(start)) continue;

    const loop: number[][] = [];
    let current = start;
    let previous = -1;

    for (;;) {
      visited.add(current);
      const p = points.get(current)!;
      loop.push([p[0], p[1]]);

      const neighbours = links.get(current) ?? [];
      let next = -1;
      for (const n of neighbours) {
        if (n !== previous) { next = n; break; }
      }
      // A degenerate degree-1 crossing would end the walk here; the padded border makes
      // that unreachable, but bailing out is safer than looping forever.
      if (next === -1 || next === start) break;
      if (visited.has(next)) break;
      previous = current;
      current = next;
    }

    if (loop.length >= 3) {
      loop.push([loop[0][0], loop[0][1]]);
      loops.push(loop);
    }
  }

  return loops;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/terrain/marchingSquares.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/terrain/marchingSquares.ts src/terrain/marchingSquares.test.ts
git commit -m "feat(terrain): trace isolines by edge identity instead of chaining segments"
```

---

### Task 5: Polygon utilities

**Files:**
- Create: `src/terrain/polygons.ts`
- Test: `src/terrain/polygons.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `signedArea(loop: number[][]): number` — positive for counter-clockwise in a y-down space.
  - `ensureWinding(loop: number[][], wantPositive: boolean): number[][]`
  - `pointInPolygon(point: number[], loop: number[][]): boolean`
  - `simplifyLoop(loop: number[][], tolerance: number): number[][]` — never returns fewer than 4 points (3 distinct plus the repeated closing point).
  - `interface NestedPolygon { outer: number[][]; holes: number[][][] }`
  - `nestLoops(loops: number[][][]): NestedPolygon[]`

**Context for the implementer.** `nestLoops` decides which loops are outer boundaries and which are holes. Sort by absolute area descending, then for each loop count how many larger loops contain it. Even count means it is an outer boundary; odd means it is a hole belonging to the smallest loop that contains it. This gives arbitrary nesting depth — an island inside a lake, and a pond on that island — which the old `loops[0]` code could not express at all.

`simplifyLoop` is Douglas–Peucker. Open the loop first (drop the duplicated closing point), simplify, then re-close.

- [ ] **Step 1: Write the failing test**

```ts
// src/terrain/polygons.test.ts
import { describe, it, expect } from 'vitest';
import { signedArea, ensureWinding, pointInPolygon, simplifyLoop, nestLoops } from './polygons';

const square = (x: number, y: number, s: number): number[][] => [
  [x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y],
];

const reversed = (loop: number[][]): number[][] => [...loop].reverse();

describe('signedArea', () => {
  it('has magnitude equal to the enclosed area', () => {
    expect(Math.abs(signedArea(square(0, 0, 10)))).toBeCloseTo(100);
  });

  it('flips sign with winding', () => {
    const a = signedArea(square(0, 0, 10));
    const b = signedArea(reversed(square(0, 0, 10)));
    expect(Math.sign(a)).toBe(-Math.sign(b));
  });
});

describe('ensureWinding', () => {
  it('leaves a loop alone when it already winds the wanted way', () => {
    const loop = square(0, 0, 5);
    const positive = signedArea(loop) > 0;
    expect(ensureWinding(loop, positive)).toEqual(loop);
  });

  it('reverses a loop that winds the wrong way', () => {
    const loop = square(0, 0, 5);
    const positive = signedArea(loop) > 0;
    const flipped = ensureWinding(loop, !positive);
    expect(Math.sign(signedArea(flipped))).toBe(positive ? -1 : 1);
  });
});

describe('pointInPolygon', () => {
  it('accepts an interior point', () => {
    expect(pointInPolygon([5, 5], square(0, 0, 10))).toBe(true);
  });

  it('rejects an exterior point', () => {
    expect(pointInPolygon([15, 5], square(0, 0, 10))).toBe(false);
  });

  it('is unaffected by winding direction', () => {
    expect(pointInPolygon([5, 5], reversed(square(0, 0, 10)))).toBe(true);
  });
});

describe('simplifyLoop', () => {
  it('drops collinear points', () => {
    const loop = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyLoop(loop, 0.1).length).toBeLessThan(loop.length);
  });

  it('keeps corners', () => {
    const simplified = simplifyLoop(square(0, 0, 10), 0.1);
    expect(simplified.length).toBe(5);
  });

  it('never falls below a triangle', () => {
    const loop = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const simplified = simplifyLoop(loop, 1000);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });

  it('stays closed', () => {
    const s = simplifyLoop(square(0, 0, 10), 0.1);
    expect(s[0]).toEqual(s[s.length - 1]);
  });
});

describe('nestLoops', () => {
  it('treats a lone loop as an outer boundary', () => {
    const result = nestLoops([square(0, 0, 10)]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(0);
  });

  it('assigns a contained loop as a hole', () => {
    const result = nestLoops([square(0, 0, 20), square(5, 5, 5)]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(1);
  });

  it('treats disjoint loops as separate outers', () => {
    const result = nestLoops([square(0, 0, 10), square(50, 50, 10)]);
    expect(result).toHaveLength(2);
    expect(result[0].holes).toHaveLength(0);
    expect(result[1].holes).toHaveLength(0);
  });

  it('handles an island inside a hole', () => {
    // outer ring, its hole, and a smaller shape sitting inside that hole
    const result = nestLoops([square(0, 0, 40), square(5, 5, 30), square(15, 15, 5)]);
    expect(result).toHaveLength(2);
    const big = result.find(p => Math.abs(signedArea(p.outer)) > 1000)!;
    expect(big.holes).toHaveLength(1);
    const island = result.find(p => Math.abs(signedArea(p.outer)) < 1000)!;
    expect(island.holes).toHaveLength(0);
  });

  it('gives outers and holes opposite winding', () => {
    const [poly] = nestLoops([square(0, 0, 20), square(5, 5, 5)]);
    expect(Math.sign(signedArea(poly.outer))).toBe(-Math.sign(signedArea(poly.holes[0])));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/terrain/polygons.test.ts`
Expected: FAIL — cannot resolve `./polygons`.

- [ ] **Step 3: Write the implementation**

```ts
// src/terrain/polygons.ts

export interface NestedPolygon {
  outer: number[][];
  holes: number[][][];
}

/** Shoelace area. Sign encodes winding; magnitude is the enclosed area. */
export function signedArea(loop: number[][]): number {
  const n = closedCount(loop);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function ensureWinding(loop: number[][], wantPositive: boolean): number[][] {
  const positive = signedArea(loop) > 0;
  return positive === wantPositive ? loop : [...loop].reverse();
}

/** Ray casting, winding-agnostic. */
export function pointInPolygon(point: number[], loop: number[][]): boolean {
  const [px, py] = point;
  const n = closedCount(loop);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    const straddles = (yi > py) !== (yj > py);
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Douglas-Peucker on a closed loop.
 *
 * Terrain contours come off marching squares with a vertex on every crossed lattice edge,
 * which is far more than the mesh needs. Outer silhouettes get a tight tolerance so painted
 * shapes stay recognisable; inner terraces can afford a looser one.
 */
export function simplifyLoop(loop: number[][], tolerance: number): number[][] {
  const n = closedCount(loop);
  if (n <= 3) return loop;

  const open = loop.slice(0, n);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  douglasPeucker(open, 0, n - 1, tolerance, keep);

  const result: number[][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) result.push(open[i]);

  // A closed loop needs three distinct points to bound any area at all.
  if (result.length < 3) return loop;

  result.push([result[0][0], result[0][1]]);
  return result;
}

function douglasPeucker(
  pts: number[][], first: number, last: number, tolerance: number, keep: Uint8Array,
): void {
  if (last <= first + 1) return;

  const [ax, ay] = pts[first];
  const [bx, by] = pts[last];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  let worst = -1;
  let worstIndex = -1;

  for (let i = first + 1; i < last; i++) {
    const [px, py] = pts[i];
    let d: number;
    if (lengthSq === 0) {
      d = Math.hypot(px - ax, py - ay);
    } else {
      let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    if (d > worst) { worst = d; worstIndex = i; }
  }

  if (worst > tolerance && worstIndex !== -1) {
    keep[worstIndex] = 1;
    douglasPeucker(pts, first, worstIndex, tolerance, keep);
    douglasPeucker(pts, worstIndex, last, tolerance, keep);
  }
}

/**
 * Sort loops into outer boundaries with their holes.
 *
 * Containment depth decides the role: a loop contained by an even number of larger loops is
 * an outer boundary, an odd number makes it a hole of the smallest loop containing it. This
 * nests to any depth, so a lake can hold an island that itself holds a pond. The code this
 * replaces kept only the longest loop and discarded the rest, which is why islands were
 * impossible.
 */
export function nestLoops(loops: number[][][]): NestedPolygon[] {
  const sorted = [...loops]
    .filter(l => closedCount(l) >= 3)
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  const parents: number[] = sorted.map(() => -1);
  const depths: number[] = sorted.map(() => 0);

  for (let i = 0; i < sorted.length; i++) {
    // Larger loops come first, so any container is at a lower index.
    for (let j = i - 1; j >= 0; j--) {
      if (pointInPolygon(sorted[i][0], sorted[j])) {
        parents[i] = j;
        depths[i] = depths[j] + 1;
        break;
      }
    }
  }

  const polygons: NestedPolygon[] = [];
  const outerIndex = new Map<number, number>();

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 0) {
      outerIndex.set(i, polygons.length);
      polygons.push({ outer: ensureWinding(sorted[i], true), holes: [] });
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 0) continue;
    const target = outerIndex.get(parents[i]);
    if (target === undefined) continue;
    polygons[target].holes.push(ensureWinding(sorted[i], false));
  }

  return polygons;
}

/** Point count ignoring a repeated closing vertex. */
function closedCount(loop: number[][]): number {
  const n = loop.length;
  if (n < 2) return n;
  const first = loop[0];
  const last = loop[n - 1];
  return first[0] === last[0] && first[1] === last[1] ? n - 1 : n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/terrain/polygons.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/terrain/polygons.ts src/terrain/polygons.test.ts
git commit -m "feat(terrain): classify contour loops into nested polygons with holes"
```

---

### Task 6: Contour orchestrator

**Files:**
- Create: `src/terrain/contours.ts`
- Test: `src/terrain/contours.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `const STEP_TILES = 0.3`, `const MAX_TERRACES = 6`
  - `interface TerraceLevel { index: number; polygons: NestedPolygon[] }`
  - `interface TerrainContours { levels: TerraceLevel[]; shoreline: NestedPolygon[]; field: SignedField; maxDistanceTiles: number }`
  - `buildTerrainContours(cells: GridPos[], triangles?: TriangleMap, shorelineTiles?: number): TerrainContours | null` — `null` for an empty cell list.
  - `worldToSample(field: SignedField, x: number, y: number): { sx: number; sy: number }`

**Context for the implementer — the two rules that fix the reported bugs.**

*Terrace count comes from thickness, not cell count.* `levelCount = clamp(floor(maxDistanceTiles / STEP_TILES), 1, MAX_TERRACES)`. A single cell is about 0.5 tiles thick, giving one level — a flat plateau at its footprint. A two-tile-wide ridge is about 1.0 thick, giving three. Only a genuinely broad massif reaches six. The old code assigned six terraces to any cluster over 25 cells regardless of width, then inset past collapse; that cannot happen here because there are no samples above the threshold to trace.

*The footprint stays faithful.* Level 0 is threshold 0 — the painted boundary — simplified with a tolerance of at most a quarter subcell (`TILE_SIZE / SUBCELL / 4`). Inner levels use a looser tolerance. No blur is applied to the coverage field at any point. This is what keeps a painted wall a wall.

`shorelineTiles` is a positive number; the shoreline is traced at threshold `-shorelineTiles`, outside the footprint.

- [ ] **Step 1: Write the failing test**

```ts
// src/terrain/contours.test.ts
import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../constants';
import { buildTerrainContours, MAX_TERRACES } from './contours';
import { signedArea } from './polygons';

const block = (x0: number, y0: number, x1: number, y1: number) => {
  const cells: { gx: number; gy: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push({ gx: x, gy: y });
  return cells;
};

describe('buildTerrainContours', () => {
  it('returns null for no cells', () => {
    expect(buildTerrainContours([])).toBeNull();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/terrain/contours.test.ts`
Expected: FAIL — cannot resolve `./contours`.

- [ ] **Step 3: Write the implementation**

```ts
// src/terrain/contours.ts
import type { GridPos } from '../types';
import { TILE_SIZE } from '../constants';
import type { TriangleMap } from './field';
import { buildCoverageField, SUBCELL } from './field';
import type { SignedField } from './distanceField';
import { buildSignedDistanceField } from './distanceField';
import { traceIsolines } from './marchingSquares';
import type { NestedPolygon } from './polygons';
import { nestLoops, simplifyLoop } from './polygons';

/** Vertical spacing between terrace contours, in tiles. */
export const STEP_TILES = 0.3;

/** Ceiling on terrace count, so a huge massif does not become a hundred rings. */
export const MAX_TERRACES = 6;

/** Outer silhouettes keep a quarter-subcell tolerance so painted shapes stay recognisable. */
const OUTER_TOLERANCE = TILE_SIZE / SUBCELL / 4;
const INNER_TOLERANCE = TILE_SIZE / SUBCELL / 2;

export interface TerraceLevel {
  /** 0 is the footprint; higher indices step inward, toward the peak or the deepest water. */
  index: number;
  polygons: NestedPolygon[];
}

export interface TerrainContours {
  levels: TerraceLevel[];
  /** Ring outside the footprint. Empty when `shorelineTiles` is omitted or zero. */
  shoreline: NestedPolygon[];
  /** Retained so renderers can sample depth per vertex. */
  field: SignedField;
  maxDistanceTiles: number;
}

/** Sample-space coordinates for a world-space point, for depth lookups. */
export function worldToSample(field: SignedField, x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x / TILE_SIZE - field.originGx) * SUBCELL - 0.5,
    sy: (y / TILE_SIZE - field.originGy) * SUBCELL - 0.5,
  };
}

/**
 * Turn terrain cells into terrace contours.
 *
 * Terrace count is derived from how thick the shape actually is, never from how many cells
 * it contains. That is the fix for the collapsing silhouettes: a narrow ridge has no samples
 * deep enough to support many rings, so it cannot be assigned them.
 */
export function buildTerrainContours(
  cells: GridPos[],
  triangles?: TriangleMap,
  shorelineTiles = 0,
): TerrainContours | null {
  const coverage = buildCoverageField(cells, triangles);
  if (!coverage) return null;

  const field = buildSignedDistanceField(coverage);
  const maxDistanceTiles = field.maxInside;

  const levelCount = Math.max(1, Math.min(MAX_TERRACES, Math.floor(maxDistanceTiles / STEP_TILES)));

  const levels: TerraceLevel[] = [];
  for (let i = 0; i < levelCount; i++) {
    const tolerance = i === 0 ? OUTER_TOLERANCE : INNER_TOLERANCE;
    const polygons = tracePolygons(field, i * STEP_TILES, tolerance);
    // A level that traces to nothing would leave a gap in the stack; stop rather than
    // emit an empty one.
    if (polygons.length === 0) break;
    levels.push({ index: i, polygons });
  }

  // The footprint always exists — guard against a pathological empty stack.
  if (levels.length === 0) {
    levels.push({ index: 0, polygons: tracePolygons(field, 0, OUTER_TOLERANCE) });
  }

  const shoreline = shorelineTiles > 0
    ? tracePolygons(field, -shorelineTiles, OUTER_TOLERANCE)
    : [];

  return { levels, shoreline, field, maxDistanceTiles };
}

function tracePolygons(field: SignedField, threshold: number, tolerance: number): NestedPolygon[] {
  const loops = traceIsolines(field, threshold).map(l => simplifyLoop(l, tolerance));
  return nestLoops(loops);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/terrain/contours.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite and static checks**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. The terrain module is new and unused, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add src/terrain/contours.ts src/terrain/contours.test.ts
git commit -m "feat(terrain): derive terrace contours from shape thickness"
```

---

### Task 7: Shared terrace mesh builder

**Files:**
- Create: `src/rendering/layers/terrainMesh.ts`

**Interfaces:**
- Consumes: `TerraceLevel`, `NestedPolygon` from `src/terrain`.
- Produces:
  - `interface TerraceMeshOptions { direction: 1 | -1; stepHeight: number; baseOffset: number; makeMaterial(levelIndex: number, levelCount: number): THREE.MeshPhysicalMaterial; decorate?(mesh: THREE.Mesh, levelIndex: number): void }`
  - `buildTerraceMeshes(levels: TerraceLevel[], options: TerraceMeshOptions): { meshes: THREE.Mesh[]; materials: THREE.MeshPhysicalMaterial[] }`
  - `buildFlatRing(polygons: NestedPolygon[], y: number, material: THREE.MeshPhysicalMaterial, innerCutouts: NestedPolygon[]): THREE.Mesh | null`
  - `makeShape(outer: number[][], holes: number[][][]): THREE.Shape`

**Context for the implementer.** `ObstacleLayer` and `LakeLayer` are near-duplicates today. This holds the shared part.

A terrace at level `i` must be a ring: its own polygon with holes punched for its own `holes` **and** for every level `i+1` polygon nested inside it. Use `pointInPolygon` from `src/terrain/polygons` on the candidate's first vertex to decide containment. The topmost level punches nothing and renders solid.

Geometry convention, matching the current layers exactly: build the shape in the XY plane, extrude along +Z by `stepHeight`, then `rotateX(Math.PI / 2)` so the shape lies in XZ and extrusion runs along −Y. The mesh's `position.y` is therefore the **top** face. Mountains sit at `GROUND_Y_POSITION + (i + 1) * stepHeight` and water at `GROUND_Y_POSITION - i * stepHeight`, which the `direction`/`baseOffset` pair expresses as `GROUND_Y_POSITION + direction * (i + baseOffset) * stepHeight` — mountains use `direction: 1, baseOffset: 1`, water uses `direction: -1, baseOffset: 0`.

- [ ] **Step 1: Add the terrain barrel export**

Create `src/terrain/index.ts` so rendering imports from one place. This is an *internal*
barrel; it must not be re-exported from `src/index.ts`.

```ts
// src/terrain/index.ts
export { SUBCELL, buildCoverageField, sampleAt, sampleToWorld } from './field';
export type { CoverageField, TriangleMap } from './field';
export { buildSignedDistanceField, sampleFieldBilinear } from './distanceField';
export type { SignedField } from './distanceField';
export { traceIsolines } from './marchingSquares';
export { signedArea, ensureWinding, pointInPolygon, simplifyLoop, nestLoops } from './polygons';
export type { NestedPolygon } from './polygons';
export { buildTerrainContours, worldToSample, STEP_TILES, MAX_TERRACES } from './contours';
export type { TerraceLevel, TerrainContours } from './contours';
```

- [ ] **Step 2: Write the mesh builder**

There is no unit test for this task: it constructs Three.js meshes, and the suite is Node-only with no WebGL. It is verified by the visual pass in Tasks 8 and 9 and by typecheck here.

```ts
// src/rendering/layers/terrainMesh.ts
import * as THREE from 'three';
import { GROUND_Y_POSITION } from '../../constants';
import type { NestedPolygon, TerraceLevel } from '../../terrain';
import { pointInPolygon } from '../../terrain';

export interface TerraceMeshOptions {
  /** +1 builds upward (mountains), -1 downward (water). */
  direction: 1 | -1;
  stepHeight: number;
  /** 1 puts the lowest mountain step above ground; 0 puts the water surface at ground. */
  baseOffset: number;
  makeMaterial(levelIndex: number, levelCount: number): THREE.MeshPhysicalMaterial;
  /** Hook for per-level extras, e.g. the water depth ramp. */
  decorate?(mesh: THREE.Mesh, levelIndex: number): void;
}

export function makeShape(outer: number[][], holes: number[][][]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i][0], outer[i][1]);
  shape.closePath();

  for (const hole of holes) {
    if (hole.length < 4) continue;
    const path = new THREE.Path();
    path.moveTo(hole[0][0], hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }

  return shape;
}

/**
 * Build the stack of extruded terrace rings.
 *
 * Each level punches holes for its own interior loops *and* for the level above nested
 * inside it, so what renders is a ring rather than a stack of overlapping solids. The old
 * code guessed the inner boundary by insetting the outer loop, which is what folded inside
 * out on narrow shapes; here the inner boundary is simply the next contour.
 */
export function buildTerraceMeshes(
  levels: TerraceLevel[],
  options: TerraceMeshOptions,
): { meshes: THREE.Mesh[]; materials: THREE.MeshPhysicalMaterial[] } {
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.MeshPhysicalMaterial[] = [];
  const levelCount = levels.length;

  for (let i = 0; i < levelCount; i++) {
    const above = levels[i + 1]?.polygons ?? [];
    const material = options.makeMaterial(i, levelCount);
    materials.push(material);

    for (const polygon of levels[i].polygons) {
      const cutouts = above
        .filter(candidate => pointInPolygon(candidate.outer[0], polygon.outer))
        .map(candidate => candidate.outer);

      const shape = makeShape(polygon.outer, [...polygon.holes, ...cutouts]);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: options.stepHeight,
        bevelEnabled: false,
      });
      geometry.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = GROUND_Y_POSITION + options.direction * (i + options.baseOffset) * options.stepHeight;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      options.decorate?.(mesh, i);
      meshes.push(mesh);
    }
  }

  return { meshes, materials };
}

/**
 * A thin flat ring at a fixed height — used for the shoreline, which is the shoreline
 * contour with the footprint punched out of it.
 */
export function buildFlatRing(
  polygons: NestedPolygon[],
  y: number,
  material: THREE.MeshPhysicalMaterial,
  innerCutouts: NestedPolygon[],
): THREE.Mesh | null {
  if (polygons.length === 0) return null;

  const geometries: THREE.ExtrudeGeometry[] = [];

  for (const polygon of polygons) {
    const cutouts = innerCutouts
      .filter(candidate => pointInPolygon(candidate.outer[0], polygon.outer))
      .map(candidate => candidate.outer);

    const shape = makeShape(polygon.outer, [...polygon.holes, ...cutouts]);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
    geometries.push(geometry);
  }

  if (geometries.length === 0) return null;

  // One mesh per contour set keeps disposal simple; merge only if profiling asks for it.
  const merged = new THREE.Mesh(geometries[0], material);
  merged.position.y = y;
  merged.receiveShadow = true;
  for (let i = 1; i < geometries.length; i++) {
    const extra = new THREE.Mesh(geometries[i], material);
    extra.receiveShadow = true;
    merged.add(extra);
  }
  return merged;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/layers/terrainMesh.ts src/terrain/index.ts
git commit -m "feat(rendering): add a shared terrace mesh builder"
```

---

### Task 8: Rewrite ObstacleLayer

**Files:**
- Modify: `src/rendering/layers/ObstacleLayer.ts` (full rewrite of `build` and `buildTerraces`)

**Interfaces:**
- Consumes: `buildTerrainContours` from `src/terrain`, `buildTerraceMeshes`/`buildFlatRing` from `./terrainMesh`.
- Produces: `ObstacleLayer.build(scene, mountainCells, mountainColor?, mountainTriangles?, mountainShorelineColor?)` and `dispose(scene)` — **signatures unchanged**, so `Renderer.rebuildTerrain` (`Renderer.ts:353`) needs no edit.

**Context for the implementer.** Keep the existing `dispose` method exactly as it is, including its comment. Its contract — the material loop sits above the `group` guard so a build that bails out on zero cells still frees the previous build's materials — is correct and was a deliberate fix. Do not "tidy" it.

`LAYER_HEIGHT = 12` and `SHORELINE_WIDTH = TILE_SIZE * 0.15` keep their current values. The shoreline width is passed to `buildTerrainContours` in **tiles**, so pass `0.15`, not the pixel value.

- [ ] **Step 1: Replace the imports and the build method**

```ts
// src/rendering/layers/ObstacleLayer.ts
import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { MountainTriangles } from '../../maps/types';
import { MOUNTAIN_COLOR, GROUND_Y_POSITION } from '../../constants';
import { lerp } from '../../utils/math';
import { buildTerrainContours } from '../../terrain';
import { buildTerraceMeshes, buildFlatRing } from './terrainMesh';

const LAYER_HEIGHT = 12;
/** In tiles — `buildTerrainContours` works in tile units, not pixels. */
const SHORELINE_TILES = 0.15;

const defaultBaseColor = new THREE.Color(MOUNTAIN_COLOR);

export class ObstacleLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(
    scene: THREE.Scene,
    mountainCells: GridPos[],
    mountainColor?: string,
    mountainTriangles?: MountainTriangles,
    mountainShorelineColor?: string,
  ): void {
    this.dispose(scene);
    if (mountainCells.length === 0) return;

    const contours = buildTerrainContours(mountainCells, mountainTriangles, SHORELINE_TILES);
    if (!contours) return;

    const baseColor = mountainColor ? new THREE.Color(mountainColor) : defaultBaseColor;
    this.group = new THREE.Group();

    // Shoreline: the outset contour with the footprint punched out of it.
    if (contours.shoreline.length > 0) {
      const shoreMat = new THREE.MeshPhysicalMaterial({
        color: mountainShorelineColor
          ? new THREE.Color(mountainShorelineColor)
          : baseColor.clone().multiplyScalar(0.85),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this.materials.push(shoreMat);
      const ring = buildFlatRing(contours.shoreline, GROUND_Y_POSITION, shoreMat, contours.levels[0].polygons);
      if (ring) this.group.add(ring);
    }

    const { meshes, materials } = buildTerraceMeshes(contours.levels, {
      direction: 1,
      stepHeight: LAYER_HEIGHT,
      baseOffset: 1,
      makeMaterial: (index, count) => makeRockMaterial(baseColor, index, count),
    });

    this.materials.push(...materials);
    for (const mesh of meshes) this.group.add(mesh);

    scene.add(this.group);
  }

  // dispose() is unchanged — keep the existing method and its comment verbatim.
}

/** Lighten toward the peak, as before: base blended up to 35% toward white. */
function makeRockMaterial(baseColor: THREE.Color, index: number, count: number): THREE.MeshPhysicalMaterial {
  const t = count > 1 ? index / (count - 1) : 0;
  const lighten = t * 0.35;
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(
      lerp(baseColor.r, 1, lighten),
      lerp(baseColor.g, 1, lighten),
      lerp(baseColor.b, 1, lighten),
    ),
    roughness: 0.6,
    metalness: 0.0,
    sheen: 0.15,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xccbbaa),
    clearcoat: 0.3,
    clearcoatRoughness: 0.4,
    side: THREE.DoubleSide,
  });
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. `TILE_SIZE` is no longer imported here; remove it if lint flags it unused.

- [ ] **Step 3: Visual verification**

Run: `npm run dev`, then in the demo:
1. Load `classic` and reload a few times. Mountains must be smooth rounded landforms with clean concentric terraces. No spikes, no crossing edges, no shapes turned inside out.
2. Load `narrow-pass` (123 hand-placed mountain cells). The mountain mass must be continuous, with no gaps or slivers.
3. Open the designer and paint a mountain square, a one-tile-wide line, two cells touching only at a corner, and a closed ring. Each must render recognisably; the ring must have a visible hole.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/layers/ObstacleLayer.ts
git commit -m "refactor(rendering): build mountains from distance-field contours"
```

---

### Task 9: Rewrite LakeLayer with a depth gradient

**Files:**
- Modify: `src/rendering/layers/LakeLayer.ts` (full rewrite of `build` and `buildTerraces`)

**Interfaces:**
- Consumes: `buildTerrainContours`, `worldToSample`, `sampleFieldBilinear` from `src/terrain`; `buildTerraceMeshes`/`buildFlatRing` from `./terrainMesh`.
- Produces: `LakeLayer.build(scene, lakeCells, lakeTriangles?, waterColor?, shorelineColor?)` and `dispose(scene)` — **signatures unchanged**.

**Context for the implementer.** Two things differ from mountains.

*Direction.* Water steps down: `direction: -1, baseOffset: 0`, so level 0's top face sits exactly at `GROUND_Y_POSITION` and is the water surface.

*The depth ramp.* Geometric steps alone read as flat on a small lake, which is the reported complaint. After each terrace mesh is built, walk its position attribute and write a per-vertex colour: sample the signed distance field at the vertex's world XZ, normalise by `maxDistanceTiles`, and blend the level's base colour toward a dark deep-water colour. Set `vertexColors: true` on the material. Because the field is distance-to-nearest-non-water, this shallows automatically around an island — the island edge is a zero point in the same field.

Note the coordinate mapping: contours are built in world **XY** (grid space), and after `rotateX(Math.PI / 2)` those become world **XZ**. So sample using the vertex's `x` and `z`.

`LAKE_LAYER_HEIGHT = 4` and the shoreline width keep their current values.

- [ ] **Step 1: Replace the imports and the build method**

```ts
// src/rendering/layers/LakeLayer.ts
import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { GROUND_Y_POSITION, LAKE_COLOR, LAKE_SHORE_COLOR } from '../../constants';
import { lerp } from '../../utils/math';
import type { TerrainContours } from '../../terrain';
import { buildTerrainContours, worldToSample, sampleFieldBilinear } from '../../terrain';
import { buildTerraceMeshes, buildFlatRing } from './terrainMesh';

const LAKE_LAYER_HEIGHT = 4;
const SHORELINE_TILES = 0.15;

/** How far the deepest water is blended toward black. */
const MAX_DEPTH_DARKEN = 0.55;

export class LakeLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(
    scene: THREE.Scene,
    lakeCells: GridPos[],
    lakeTriangles?: LakeTriangles,
    waterColor?: string,
    shorelineColor?: string,
  ): void {
    this.dispose(scene);
    if (lakeCells.length === 0) return;

    const contours = buildTerrainContours(lakeCells, lakeTriangles, SHORELINE_TILES);
    if (!contours) return;

    const baseColor = waterColor ? new THREE.Color(waterColor) : new THREE.Color(LAKE_COLOR);
    this.group = new THREE.Group();

    if (contours.shoreline.length > 0) {
      const shoreMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(shorelineColor ?? LAKE_SHORE_COLOR),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this.materials.push(shoreMat);
      const ring = buildFlatRing(contours.shoreline, GROUND_Y_POSITION, shoreMat, contours.levels[0].polygons);
      if (ring) this.group.add(ring);
    }

    const { meshes, materials } = buildTerraceMeshes(contours.levels, {
      direction: -1,
      stepHeight: LAKE_LAYER_HEIGHT,
      baseOffset: 0,
      makeMaterial: () => makeWaterMaterial(),
      decorate: (mesh) => applyDepthColors(mesh, contours, baseColor),
    });

    this.materials.push(...materials);
    for (const mesh of meshes) this.group.add(mesh);

    scene.add(this.group);
  }

  // dispose() is unchanged — keep the existing method and its comment verbatim.
}

function makeWaterMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    // Colour comes from per-vertex attributes, so the material itself stays white.
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.25,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.3,
    side: THREE.DoubleSide,
  });
}

/**
 * Write a shore-to-centre depth ramp into the mesh's vertex colours.
 *
 * Terraced steps alone read as flat under the top-down camera, and a small lake only fits
 * one step at all — this is what makes depth legible at every lake size. Sampling the same
 * distance field the contours came from means the ramp also shallows correctly around an
 * island, since the island's edge is a zero point in that field.
 */
function applyDepthColors(mesh: THREE.Mesh, contours: TerrainContours, baseColor: THREE.Color): void {
  const position = mesh.geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const maxDepth = Math.max(contours.maxDistanceTiles, 1e-6);

  for (let i = 0; i < position.count; i++) {
    // Contours are built in world XY; rotateX(PI/2) maps that onto world XZ.
    const { sx, sy } = worldToSample(contours.field, position.getX(i), position.getZ(i));
    const depth = Math.max(0, sampleFieldBilinear(contours.field, sx, sy)) / maxDepth;
    const darken = Math.min(1, depth) * MAX_DEPTH_DARKEN;
    colors[i * 3 + 0] = lerp(baseColor.r, 0, darken);
    colors[i * 3 + 1] = lerp(baseColor.g, 0, darken);
    colors[i * 3 + 2] = lerp(baseColor.b, 0, darken);
  }

  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Visual verification**

Run: `npm run dev`, then:
1. Load `lakeland` (174 hand-placed lake cells). Water must darken from shore to centre, with visible stepping in the wider parts.
2. Load `classic` and reload several times. Small generated lakes must still read as water with depth, not as a flat patch.
3. In the designer, paint a lake ring — a closed loop of water around unpainted ground. The enclosed ground must render as an island, and the water must grow shallower as it approaches it.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/layers/LakeLayer.ts
git commit -m "feat(rendering): give water a shore-to-centre depth ramp and island holes"
```

---

### Task 10: Share the contour source with the ground texture

**Files:**
- Modify: `src/rendering/layers/TerrainLayer.ts` — remove the local `findClusters` (`:12`), local `getTriFlags` (`:183`), and `buildLakePath`; draw from `buildTerrainContours` instead.

**Interfaces:**
- Consumes: `buildTerrainContours` from `src/terrain`.
- Produces: `TerrainLayer.render(ctx, lakeCells?, backgroundTiles?, paintPalette?, lakeTriangles?)` — **signature unchanged**.

**Context for the implementer.** `TerrainLayer` paints the ground texture on a 2D canvas and punches transparent holes where water should show through the 3D mesh below. It currently derives that hole shape from its own duplicate copies of the triangle and clustering helpers. If its silhouette and `LakeLayer`'s disagree by even a fraction, a seam appears at every shoreline.

Both must come from `buildTerrainContours(lakeCells, lakeTriangles)` with identical arguments. Note `LakeLayer` passes a shoreline width and this does not; that only adds an extra contour, it does not move level 0, so the footprints match.

Islands make hole support mandatory here: the ground must **not** be punched away inside a lake's hole, or the island would be a transparent gap. Build each `Path2D` as outer boundary plus holes and fill with the `'evenodd'` rule.

Also delete the red 1px debug outline loop (`TerrainLayer.ts` around `:262`, `strokeStyle = '#FF0000'`). It draws a hard-coded red boundary over every lake cell edge — leftover debug output that the new contour path replaces.

- [ ] **Step 1: Replace the lake section of `render`**

```ts
// Replaces everything from "// Paint lake cell outlines" to the end of render().
if (lakeCells && lakeCells.length > 0) {
  const contours = buildTerrainContours(lakeCells, lakeTriangles);
  if (contours) {
    const footprint = contours.levels[0].polygons;

    const path = new Path2D();
    for (const polygon of footprint) {
      addLoop(path, polygon.outer);
      for (const hole of polygon.holes) addLoop(path, hole);
    }

    // Soft inner outline in the water colour, matching the mesh silhouette exactly.
    ctx.save();
    ctx.strokeStyle = this.waterColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
    ctx.restore();

    // Punch transparent holes so the 3D water mesh shows through. The even-odd rule keeps
    // islands opaque — without it the ground under an island would be cut away too.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fill(path, 'evenodd');
    ctx.restore();
  }
}
```

Add this module-level helper alongside the existing ones:

```ts
function addLoop(path: Path2D, loop: number[][]): void {
  if (loop.length < 3) return;
  path.moveTo(loop[0][0], loop[0][1]);
  for (let i = 1; i < loop.length; i++) path.lineTo(loop[i][0], loop[i][1]);
  path.closePath();
}
```

- [ ] **Step 2: Delete the duplicated helpers**

Remove from `TerrainLayer.ts`: the local `findClusters` function, the local `getTriFlags` function, `buildLakePath`, the `Quadrant` type if now unused, and any import of `terrainContourUtils`. Keep `setBackgroundColor`, `setLakeColors`, and the background-tile painting untouched.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 4: Visual verification**

Run: `npm run dev`:
1. Load `lakeland`. There must be no seam, halo, or sliver of background colour between the shoreline and the water mesh at any zoom level.
2. Tilt into isometric view and orbit. The water must stay inside its hole from every angle.
3. In the designer, paint a lake ring. The island must be opaque ground, not a transparent gap.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/layers/TerrainLayer.ts
git commit -m "fix(rendering): draw ground holes from the same contours as the water mesh"
```

---

### Task 11: Delete the old contour utilities

**Files:**
- Delete: `src/rendering/layers/terrainContourUtils.ts`

- [ ] **Step 1: Confirm nothing references it**

Run: `grep -rn "terrainContourUtils\|collectBoundarySegments\|chainSegments\|roughSmooth\|insetLoop\|getTerraceCount" src/`
Expected: no matches. If any appear, that consumer was missed in Tasks 8–10 — fix it before deleting.

- [ ] **Step 2: Delete the file**

```bash
git rm src/rendering/layers/terrainContourUtils.ts
```

- [ ] **Step 3: Full verification**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(rendering): delete the superseded contour utilities"
```

---

### Task 12: New generation constants

**Files:**
- Modify: `src/constants.ts` — add `LAKE_ISLAND_CHANCE` and `TERRAIN_NOISE_SCALE` to the obstacle block and to `DEFAULT_GAME_CONSTANTS`
- Modify: `src/maps/types.ts:119-128` — add both keys to the `GameConstants` interface

**Context for the implementer.** The zod `constants` schema is derived from `Object.keys(DEFAULT_GAME_CONSTANTS)` (`src/maps/schema.ts:147`), so it picks these up with no edit. Do not add them by hand.

Both keys are map-overridable, so `src/constants.test.ts` will fail the build if any engine file imports them from `src/constants`. They must be read only through the resolved `cfg`. Task 13 does exactly that.

- [ ] **Step 1: Add the constants**

In `src/constants.ts`, in the obstacle block near line 100:

```ts
/** Probability that a generated lake large enough to hold one is given an island. */
export const LAKE_ISLAND_CHANCE = 0.45;

/** Spatial frequency of the noise that perturbs landform boundaries. Lower is smoother. */
export const TERRAIN_NOISE_SCALE = 0.35;
```

Add both names to the `DEFAULT_GAME_CONSTANTS` object literal, next to the other obstacle keys.

- [ ] **Step 2: Add them to the type**

In `src/maps/types.ts`, in the `// Obstacles` block:

```ts
  LAKE_ISLAND_CHANCE: number;
  TERRAIN_NOISE_SCALE: number;
```

- [ ] **Step 3: Verify the schema picked them up**

Run: `npm test`
Expected: green. `src/maps/schema.test.ts` already round-trips a `constants` object, and the strict schema now accepts both new keys.

- [ ] **Step 4: Add a test that a map can override them**

Append to `src/maps/schema.test.ts`:

```ts
describe('terrain generation constants', () => {
  it('accepts the new obstacle keys from a map', () => {
    const cfg = buildConfig({ LAKE_ISLAND_CHANCE: 1, TERRAIN_NOISE_SCALE: 0.9 });
    expect(cfg.LAKE_ISLAND_CHANCE).toBe(1);
    expect(cfg.TERRAIN_NOISE_SCALE).toBe(0.9);
  });
});
```

Add `import { buildConfig } from '../constants';` if it is not already imported there.

- [ ] **Step 5: Run and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

```bash
git add src/constants.ts src/maps/types.ts src/maps/schema.test.ts
git commit -m "feat(maps): add LAKE_ISLAND_CHANCE and TERRAIN_NOISE_SCALE constants"
```

---

### Task 13: Rewrite terrain generation

**Files:**
- Modify: `src/systems/ObstacleSystem.ts` — replace `generate`, delete `growCluster` and `hasAdjacentObstacle`
- Test: `src/systems/ObstacleSystem.test.ts` (create)

**Interfaces:**
- Consumes: `mulberry32` from `src/utils/rng`, `smoothNoise2D` from `src/utils/math`, `Grid`, resolved `GameConstants`.
- Produces: `new ObstacleSystem(grid, predefinedObstacles, cfg, seed?)` — the fourth parameter is new and optional, so `Game.ts:188`, `DemoGame.ts:41` and `MapDesigner.ts:128` need no change. `getMountainCells()`, `getLakeCells()`, `getMountainTriangles()`, `getLakeTriangles()` are unchanged. `getMountainHeightMap()` is **removed** in Task 14.

**Context for the implementer — why the old algorithm produced bad shapes.** `growCluster` picked a random seed, then repeatedly picked a uniformly random cell from the growth frontier. That is a random walk, and random walks grow tendrils and one-tile spurs. No renderer can make that look like a landform.

The replacement grows each landform by a noise-modulated radial falloff: a cell joins when `(1 - distance/radius) + noise > 0`. The falloff gives a coherent blob; the noise gives it bays and peninsulas. Where noise pushes an interior cell below zero, the landform gets a hole — which the renderer now draws.

Masks replace rejection sampling. Rather than rejecting seeds near the border or the map centre, subtract a penalty from the field there, so terrain fades out instead of stopping at a straight invisible line.

Read `LAKE_ISLAND_CHANCE` and `TERRAIN_NOISE_SCALE` from `this.cfg`. Importing them from `src/constants` fails `src/constants.test.ts`.

`MOUNTAIN_MIN_HEIGHT` and `MOUNTAIN_MAX_HEIGHT` are no longer imported here — they are deleted in Task 14.

- [ ] **Step 1: Write the failing test**

```ts
// src/systems/ObstacleSystem.test.ts
import { describe, it, expect } from 'vitest';
import { Grid } from '../core/Grid';
import { buildConfig } from '../constants';
import { ObstacleSystem } from './ObstacleSystem';
import { CellType } from '../types';

function generate(overrides = {}, seed = 1) {
  const grid = new Grid();
  const system = new ObstacleSystem(grid, undefined, buildConfig(overrides), seed);
  system.generate();
  return { grid, system };
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

  it('never overlaps mountains and lakes', () => {
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 6, LAKE_CLUSTER_COUNT: 6 });
    const mountains = new Set(system.getMountainCells().map(c => `${c.gx},${c.gy}`));
    for (const c of system.getLakeCells()) {
      expect(mountains.has(`${c.gx},${c.gy}`)).toBe(false);
    }
  });

  it('writes every generated cell into the grid', () => {
    const { grid, system } = generate();
    for (const c of system.getMountainCells()) {
      expect(grid.getCell(c.gx, c.gy)!.type).toBe(CellType.Mountain);
    }
    for (const c of system.getLakeCells()) {
      expect(grid.getCell(c.gx, c.gy)!.type).toBe(CellType.Lake);
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

  it('produces landforms that are compact rather than stringy', () => {
    // A random walk produces many cells with a single neighbour. A radial landform
    // produces very few. This is the shape-quality regression test.
    const { system } = generate({ MOUNTAIN_CLUSTER_COUNT: 4, LAKE_CLUSTER_COUNT: 0 });
    const cells = system.getMountainCells();
    const set = new Set(cells.map(c => `${c.gx},${c.gy}`));
    let lonely = 0;
    for (const c of cells) {
      let neighbours = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (set.has(`${c.gx + dx},${c.gy + dy}`)) neighbours++;
      }
      if (neighbours <= 1) lonely++;
    }
    expect(lonely / cells.length).toBeLessThan(0.2);
  });

  it('can give a lake an island', () => {
    const { system } = generate({ LAKE_ISLAND_CHANCE: 1, LAKE_CLUSTER_COUNT: 4, LAKE_CLUSTER_MIN_SIZE: 40, LAKE_CLUSTER_MAX_SIZE: 60, MOUNTAIN_CLUSTER_COUNT: 0 }, 7);
    const lake = new Set(system.getLakeCells().map(c => `${c.gx},${c.gy}`));
    // An island cell is empty but fully surrounded by water.
    let islands = 0;
    for (const c of system.getLakeCells()) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${c.gx + dx},${c.gy + dy}`;
        if (lake.has(key)) continue;
        const surrounded = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(
          ([ex, ey]) => lake.has(`${c.gx + dx + ex},${c.gy + dy + ey}`),
        );
        if (surrounded) islands++;
      }
    }
    expect(islands).toBeGreaterThan(0);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/systems/ObstacleSystem.test.ts`
Expected: FAIL — the constructor takes three arguments, and generation is still the old algorithm.

- [ ] **Step 3: Rewrite the generation half of ObstacleSystem**

Replace the imports, constructor, `generate`, and delete `growCluster` and `hasAdjacentObstacle`. Leave `placePredefined` and all getters untouched (Task 14 removes the height map from them).

```ts
import type { Grid } from '../core/Grid';
import type { GridPos } from '../types';
import { CellType } from '../types';
import type { ObstacleDefinition, GameConstants, MountainTriangles, LakeTriangles } from '../maps/types';
import { omitUndefined } from '../utils/omitUndefined';
import { mulberry32 } from '../utils/rng';
import { smoothNoise2D } from '../utils/math';

/** How far a landform's shape may stray beyond its nominal radius. */
const NOISE_AMPLITUDE = 0.55;

/** Cells over which the edge and centre masks ramp from fully blocked to fully open. */
const MASK_RAMP = 3;

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
   * `seed` is a *generation* seed, not a wire-format field: maps do not carry one. Passing
   * it makes generation reproducible, which is the only way the shapes below can be
   * asserted on in a test.
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

    // Mountains first; lakes then skip anything already claimed, so the two never overlap.
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
   * This replaces a random-walk frontier growth, which produced the one-tile tendrils that
   * no amount of contour smoothing could rescue. A cell joins when its radial falloff plus
   * a noise sample clears zero: the falloff makes the shape coherent, the noise gives it
   * bays and peninsulas, and an interior dip below zero leaves a hole the renderer now draws.
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
    const minSeparation = Math.min(this.grid.cols, this.grid.rows) / Math.max(count, 1);

    for (let i = 0; i < count; i++) {
      const seedPos = this.pickSeed(rng, placed, minSeparation);
      if (!seedPos) continue;
      placed.push(seedPos);

      const targetArea = minSize + rng() * (maxSize - minSize);
      const radius = Math.max(1, Math.sqrt(targetArea / Math.PI));
      const noiseOffset = rng() * 512;
      const scale = this.cfg.TERRAIN_NOISE_SCALE;

      const claimed: GridPos[] = [];
      const reach = Math.ceil(radius * (1 + NOISE_AMPLITUDE) + 1);

      for (let gy = seedPos.gy - reach; gy <= seedPos.gy + reach; gy++) {
        for (let gx = seedPos.gx - reach; gx <= seedPos.gx + reach; gx++) {
          if (!this.grid.inBounds(gx, gy)) continue;
          const cell = this.grid.getCell(gx, gy);
          if (!cell || cell.type !== CellType.Empty) continue;

          const falloff = 1 - Math.hypot(gx - seedPos.gx, gy - seedPos.gy) / radius;
          const noise = (smoothNoise2D(gx * scale + noiseOffset, gy * scale + noiseOffset) - 0.5) * 2 * NOISE_AMPLITUDE;
          const value = falloff + noise - (1 - this.openness(gx, gy));
          if (value <= 0) continue;

          this.grid.setCell(gx, gy, { type: cellType });
          claimed.push({ gx, gy });
        }
      }

      if (allowIslands && claimed.length >= 12 && rng() < this.cfg.LAKE_ISLAND_CHANCE) {
        this.carveIsland(rng, claimed, seedPos, radius);
      }

      out.push(...claimed);
    }
  }

  /**
   * Punch an island out of a lake.
   *
   * Left to chance, an interior noise dip is rare, and islands were the whole point of the
   * rebuild — so above a size threshold they are forced rather than hoped for.
   */
  private carveIsland(rng: () => number, claimed: GridPos[], centre: GridPos, radius: number): void {
    const islandRadius = Math.max(1, radius * (0.2 + rng() * 0.15));
    const angle = rng() * Math.PI * 2;
    const offset = radius * 0.3 * rng();
    const ix = centre.gx + Math.cos(angle) * offset;
    const iy = centre.gy + Math.sin(angle) * offset;

    for (let i = claimed.length - 1; i >= 0; i--) {
      const c = claimed[i];
      if (Math.hypot(c.gx - ix, c.gy - iy) > islandRadius) continue;
      // Only carve cells fully inside the lake, so the island never breaches the shore.
      if (!this.isInterior(claimed, c)) continue;
      this.grid.clearCell(c.gx, c.gy);
      claimed.splice(i, 1);
    }
  }

  private isInterior(claimed: GridPos[], cell: GridPos): boolean {
    const set = new Set(claimed.map(c => `${c.gx},${c.gy}`));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      if (!set.has(`${cell.gx + dx},${cell.gy + dy}`)) return false;
    }
    return true;
  }

  private pickSeed(rng: () => number, placed: GridPos[], minSeparation: number): GridPos | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      const gx = Math.floor(rng() * this.grid.cols);
      const gy = Math.floor(rng() * this.grid.rows);
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
   * How available a cell is to terrain, from 0 (blocked) to 1 (open).
   *
   * The edge margin and centre exclusion used to reject candidate seeds outright, which cut
   * terrain off along a straight invisible line. Ramping instead lets landforms fade out.
   */
  private openness(gx: number, gy: number): number {
    const margin = this.cfg.OBSTACLE_EDGE_MARGIN;
    const exclusion = this.cfg.OBSTACLE_CENTER_EXCLUSION;

    const fromEdge = Math.min(gx, gy, this.grid.cols - 1 - gx, this.grid.rows - 1 - gy);
    const edge = ramp(fromEdge - margin, MASK_RAMP);

    const cx = this.grid.cols / 2;
    const cy = this.grid.rows / 2;
    const fromCentre = Math.max(Math.abs(gx - cx), Math.abs(gy - cy));
    const centre = ramp(fromCentre - exclusion, MASK_RAMP);

    return Math.min(edge, centre);
  }
}

/** 0 below the threshold, 1 above it plus `width`, smoothly in between. */
function ramp(value: number, width: number): number {
  if (value <= 0) return 0;
  if (value >= width) return 1;
  const t = value / width;
  return t * t * (3 - 2 * t);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/systems/ObstacleSystem.test.ts`
Expected: PASS, 11 tests.

If the island test fails for seed 7, try other seeds until one produces an island with `LAKE_ISLAND_CHANCE: 1` and lakes of 40–60 cells, then pin that seed. Do **not** weaken the assertion — a forced island must appear.

- [ ] **Step 5: Full check**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. `src/constants.test.ts` must still pass — it fails if `LAKE_ISLAND_CHANCE` or `TERRAIN_NOISE_SCALE` was imported rather than read from `cfg`.

- [ ] **Step 6: Visual verification**

Run: `npm run dev`, load `classic`, reload ten times. Landforms must be coherent blobs with organic edges. Occasional lakes must contain islands. No one-tile spurs, no terrain in the central spawn area, no hard straight cut-off near the borders.

- [ ] **Step 7: Commit**

```bash
git add src/systems/ObstacleSystem.ts src/systems/ObstacleSystem.test.ts
git commit -m "feat(systems): grow coherent noise-shaped landforms from a seeded PRNG"
```

---

### Task 14: Remove the mountain height map

**Files:**
- Modify: `src/systems/ObstacleSystem.ts` — delete `mountainHeightMap`, `getMountainHeightMap()`, and the height write in `placePredefined`
- Modify: `src/designer/MapDesigner.ts:417-418`, `:556`, `:733-734` — stop writing and reading heights
- Modify: `src/constants.ts` — delete `MOUNTAIN_MIN_HEIGHT` and `MOUNTAIN_MAX_HEIGHT`
- Modify: `src/maps/types.ts:7` — mark `ObstacleDefinition.height` deprecated

**Context for the implementer.** The height map was written on every painted cell, serialized into map JSON, and never read by any renderer. Terracing is now derived from shape thickness, so it has no possible consumer.

**`serializeMap.ts` is not touched.** Its `fromObstacle` passthrough (`:30`) must stay: `src/maps/narrow-pass/narrow-pass.json` carries `height` on all 123 obstacles and `src/maps/schema.test.ts:218` asserts it survives a round trip. `height` stays a loadable, passed-through, ignored field. Removing it from `MapConfig` would also be a breaking change for the website, which consumes that type.

The consequence is narrow and acceptable: opening a height-carrying map in the designer and re-exporting it drops the heights. They were meaningless, so nothing is lost.

- [ ] **Step 1: Strip it from ObstacleSystem**

Delete the `mountainHeightMap` field, the `.clear()` call in `generate()`, the `getMountainHeightMap()` method, and the `MOUNTAIN_MIN_HEIGHT`/`MOUNTAIN_MAX_HEIGHT` import. In `placePredefined`, delete the two lines computing and storing `height`; keep everything else, including the triangle handling.

- [ ] **Step 2: Strip it from MapDesigner**

At `:417-418`, delete the `const height = ...` line and the `getMountainHeightMap().set(...)` call, keeping the `getMountainCells().push(...)` line.
At `:556`, delete the `getMountainHeightMap().delete(...)` line.
At `:733-734`, delete the `const height = ...` and `if (height !== undefined) def.height = height;` lines.
Remove `MOUNTAIN_MIN_HEIGHT` and `MOUNTAIN_MAX_HEIGHT` from the `../constants` import at `:12`.

- [ ] **Step 3: Delete the constants**

In `src/constants.ts`, delete both `MOUNTAIN_MIN_HEIGHT` and `MOUNTAIN_MAX_HEIGHT`. They are not keys of `DEFAULT_GAME_CONSTANTS`, so nothing else references them once Steps 1–2 are done.

- [ ] **Step 4: Mark the wire field deprecated**

In `src/maps/types.ts`:

```ts
export interface ObstacleDefinition {
  gx: number;
  gy: number;
  type: 'mountain' | 'lake';
  /**
   * @deprecated Ignored since the terrain rebuild — terrace count is derived from a
   * landform's actual thickness, not from a per-cell height. Still accepted by the schema
   * and passed through by `serializeMap` so existing maps keep round-tripping unchanged.
   */
  height?: number;
  top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; // triangle subdivision (mountains & lakes)
}
```

- [ ] **Step 5: Confirm nothing else references it**

Run: `grep -rn "mountainHeightMap\|getMountainHeightMap\|MOUNTAIN_MIN_HEIGHT\|MOUNTAIN_MAX_HEIGHT" src/ demo/`
Expected: no matches.

- [ ] **Step 6: Full check**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green, including the `schema.test.ts` height round-trip assertions, which pass because `serializeMap` was not touched.

- [ ] **Step 7: Commit**

```bash
git add src/systems/ObstacleSystem.ts src/designer/MapDesigner.ts src/constants.ts src/maps/types.ts
git commit -m "refactor: drop the mountain height map, which nothing rendered"
```

---

### Task 15: Final verification and documentation

**Files:**
- Modify: `CLAUDE.md` — correct the stale bridge claim and describe the terrain module

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && npm run lint && npm run build:demo
```
Expected: all four succeed.

- [ ] **Step 2: Full visual pass**

Run `npm run dev` and check every built-in map:

| Map | What to confirm |
|---|---|
| `classic` | Reload ten times. Coherent landforms, organic edges, occasional lake islands, clear centre, no border cut-off. |
| `narrow-pass` | 123 hand-placed mountain cells render as a continuous mass with no gaps or slivers. |
| `lakeland` | 174 lake cells show a shore-to-centre depth ramp with no seam against the ground. |
| `traffic-stress-test` | No terrain, as before. |
| `home-background` | The decorative `DemoGame` backdrop still renders. |

Then in the designer, paint and confirm each renders recognisably: a square, a one-tile line, a diagonal stroke using half-tile quadrants, two cells touching only at a corner, a closed mountain ring, and a lake ring with an island. Erase terrain and confirm it disappears cleanly. Paint 100+ cells in one drag and confirm no lag.

- [ ] **Step 3: Confirm the public API is untouched**

Run: `git diff main --stat -- src/index.ts`
Expected: no output. If `src/index.ts` changed, revert it — the spec forbids public API changes.

- [ ] **Step 4: Update CLAUDE.md**

Under **Architecture**, add:

```markdown
### Terrain (`src/terrain/`)

Pure, canvas-free geometry: grid cells become a coverage field, a signed distance field,
marching-squares isolines, and finally nested terrace polygons. Terrace count derives from a
landform's actual thickness, never its cell count, and holes nest to any depth — which is
what makes lakes-with-islands and mountains-with-craters possible. `rendering/layers/`
consumes this; nothing here imports Three.js, which is why it is the one part of the
geometry the Node-only suite can test.
```

In the **Systems** list, correct the stale entry:

```markdown
- **RoadSystem** — Manages road placement and deletion. (There are no bridges; roads cannot
  cross water. Islands are reached by highway, which only validates its two endpoints.)
```

Under **Key Patterns**, add:

```markdown
- **Seeded generation**: `ObstacleSystem` takes an optional seed driving `mulberry32`
  (`src/utils/rng.ts`) rather than calling `Math.random()`. Unseeded construction still
  randomises; the seed exists so generated terrain can be asserted on in tests.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the terrain module and correct the bridge claim"
```

- [ ] **Step 6: Review the whole change**

Run: `git diff main --stat`
Confirm: `terrainContourUtils.ts` deleted; `src/terrain/` added with five modules, a barrel, and five test files; `src/index.ts` unchanged.
