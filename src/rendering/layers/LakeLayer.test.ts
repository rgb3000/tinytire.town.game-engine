import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { GROUND_Y_POSITION, TILE_SIZE, LAKE_COLOR, LAKE_SHORE_COLOR } from '../../constants';
import { STEP_TILES } from '../../terrain';
import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { LakeLayer, LAKE_CLIFF_NAME } from './LakeLayer';

// Three.js geometry is pure maths — `Shape`, `ExtrudeGeometry`, `rotateX` and the whole
// `src/terrain` pipeline run under plain Node. Only the *renderer* needs a GPU, and a
// `Scene` is a bare object graph, so a layer can be built and inspected headless.

const LAYER_HEIGHT = 4;

/**
 * Duplicated rather than imported: `LakeLayer` keeps this private, and a test that read the
 * implementation's own constant would pass for any value it was retuned to. Retuning the
 * lakebed is meant to fail here and be confirmed here.
 */
const MAX_DEPTH_DARKEN = 0.85;

// ---------------------------------------------------------------------------- fixtures

/** A solid `size` x `size` lake, anchored at the grid origin. */
function block(size: number): GridPos[] {
  const cells: GridPos[] = [];
  for (let gx = 0; gx < size; gx++) {
    for (let gy = 0; gy < size; gy++) cells.push({ gx, gy });
  }
  return cells;
}

/**
 * 7x7 of water with the middle 3x3 left dry — the island the human reported as broken.
 *
 * Grid [2, 4] is land. The old code chained boundary segments and then kept only the longest
 * loop, so the island's loop was thrown away and the water paved straight over it.
 */
const RING_SIZE = 7;
const ISLAND_MIN = 2;
const ISLAND_MAX = 4;

function isIsland(gx: number, gy: number): boolean {
  return gx >= ISLAND_MIN && gx <= ISLAND_MAX && gy >= ISLAND_MIN && gy <= ISLAND_MAX;
}

function ringCells(): GridPos[] {
  return block(RING_SIZE).filter(c => !isIsland(c.gx, c.gy));
}

/** World-space bounds of the island square, in pixels. */
const ISLAND_LO = ISLAND_MIN * TILE_SIZE;
const ISLAND_HI = (ISLAND_MAX + 1) * TILE_SIZE;

/**
 * 13x13 of water with a 7x7 dry patch holding a 3x3 pond — one nesting level deeper.
 *
 * This is the case that separates subtracting the level above by containment *parity* from
 * spelling the cases out; water reaches it through exactly the same code path mountains do.
 */
const NESTED_SIZE = 13;
const NESTED_LAND = [3, 9] as const;
const NESTED_POND = [5, 7] as const;

function inSquare(gx: number, gy: number, [lo, hi]: readonly [number, number]): boolean {
  return gx >= lo && gx <= hi && gy >= lo && gy <= hi;
}

function nestedCells(): GridPos[] {
  return block(NESTED_SIZE).filter(
    c => !inSquare(c.gx, c.gy, NESTED_LAND) || inSquare(c.gx, c.gy, NESTED_POND),
  );
}

/**
 * A cell carrying triangle flags that activate no quadrant.
 *
 * The map format permits this — `top: false` is an explicitly-present flag — so it rasterises
 * to all-zero coverage and `buildTerrainContours` returns null with a non-empty cell list.
 */
function blankTriangles(cells: GridPos[]): LakeTriangles {
  return new Map(cells.map(c => [`${c.gx},${c.gy}`, { top: false, right: false, bottom: false, left: false }]));
}

/**
 * Sample point for grid cell `(gx, gy)`, nudged off its centre.
 *
 * A cell centre sits exactly 0.5 tiles from the nearest edge. That is not a terrace
 * threshold — those are multiples of `STEP_TILES = 0.3` — but it is a coordinate the contour
 * tracer produces, so the nudge keeps samples away from region boundaries, where "is this
 * point covered" has no honest answer.
 */
function sampleIn(gx: number, gy: number): [number, number] {
  return [gx * TILE_SIZE + TILE_SIZE / 2 + 3.7, gy * TILE_SIZE + TILE_SIZE / 2 + 5.3];
}

// ---------------------------------------------------------------------------- helpers

function meshesOf(scene: THREE.Scene): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.traverse(obj => {
    if (obj instanceof THREE.Mesh) found.push(obj);
  });
  return found;
}

/** The terrace meshes: water is the only thing this layer colours per vertex. */
function waterMeshes(scene: THREE.Scene): THREE.Mesh[] {
  return meshesOf(scene).filter(m => (m.material as THREE.MeshPhysicalMaterial).vertexColors);
}

function cliffMesh(scene: THREE.Scene): THREE.Mesh | undefined {
  return meshesOf(scene).find(m => m.name === LAKE_CLIFF_NAME);
}

/** World-space y of a mesh, which for these layers is set on the mesh or on its parent. */
function worldY(mesh: THREE.Mesh): number {
  mesh.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).y;
}

/** Distinct terrace heights, deepest last. */
function terraceYs(scene: THREE.Scene): number[] {
  return [...new Set(waterMeshes(scene).map(worldY))].sort((a, b) => b - a);
}

/**
 * Whether any of `mesh`'s cap triangles covers `(x, z)`.
 *
 * Area alone cannot prove a shape was punched: Three silently ignores a hole lying outside
 * its shape, so a dropped hole and a correct ring can report plausible areas. Asking which
 * points are actually covered is the assertion that pins it down. Every mesh these layers
 * build is translated in y only, so geometry coordinates are world x/z.
 *
 * This answers per *mesh*, not per triangle. A point on the diagonal earcut happened to
 * split a cap along is claimed by both of its triangles, which says nothing about the
 * geometry; a point claimed by two *meshes* is two terraces stacked on the same ground.
 *
 * Only cap triangles count — all three vertices at local y 0. The cliff skirt has none, so
 * it never contributes to a coverage count.
 */
function covers(mesh: THREE.Mesh, x: number, z: number): boolean {
  const position = mesh.geometry.getAttribute('position');

  for (let t = 0; t < position.count; t += 3) {
    const ys = [position.getY(t), position.getY(t + 1), position.getY(t + 2)];
    if (ys.some(y => Math.abs(y) > 1e-6)) continue;

    const ax = position.getX(t), az = position.getZ(t);
    const bx = position.getX(t + 1), bz = position.getZ(t + 1);
    const cx = position.getX(t + 2), cz = position.getZ(t + 2);
    const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
    const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
    const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
    const negative = d1 < 0 || d2 < 0 || d3 < 0;
    const positive = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(negative && positive)) return true;
  }
  return false;
}

/** How many of `meshes` claim `(x, z)`. Anything but 0 or 1 is a bug in the geometry. */
function coverCountAcross(meshes: THREE.Mesh[], x: number, z: number): number {
  return meshes.reduce((total, mesh) => total + (covers(mesh, x, z) ? 1 : 0), 0);
}

function boundsOf(meshes: THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!);
  }
  return box;
}

/**
 * Materials constructed since `cursor`, counted without knowing what the layer builds.
 *
 * Every `THREE.Material` takes the next value of one global id counter, so the gap between
 * two throwaway materials is exactly the number constructed in between. That is what makes
 * the leak test independent of the implementation: it never has to be told how many
 * materials a build *should* have created.
 *
 * `Material` defines `id` with `Object.defineProperty` in its constructor and `@types/three`
 * does not declare it, hence the cast.
 */
function materialIdCursor(): number {
  return (new THREE.MeshBasicMaterial() as unknown as { id: number }).id;
}

function createdSince(cursor: number): number {
  return materialIdCursor() - cursor - 1;
}

/**
 * Every vertex of every water mesh, as world x/z with the red channel of its colour.
 *
 * `terrace` identifies which step the vertex was drawn into. Depth alone no longer determines
 * colour — the ramp is banded per terrace on purpose — so anything checking the ramp's shape
 * has to be able to tell two meshes apart. World y is the terrace index scaled by the step
 * height, and reading it off the mesh keeps the helper from having to be told the layout.
 */
interface Shaded { x: number; z: number; terrace: number; brightness: number }

function shadedVertices(scene: THREE.Scene): Shaded[] {
  const out: Shaded[] = [];
  for (const mesh of waterMeshes(scene)) {
    const position = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color');
    expect(color, 'every water mesh carries a colour attribute').toBeDefined();
    expect(color.count).toBe(position.count);
    const terrace = Math.round((GROUND_Y_POSITION - worldY(mesh)) / LAYER_HEIGHT);
    for (let i = 0; i < position.count; i++) {
      out.push({ x: position.getX(i), z: position.getZ(i), terrace, brightness: color.getX(i) });
    }
  }
  return out;
}

/** How far below the base colour a brightness sits, as a fraction. */
function darkening(brightness: number, base: THREE.Color): number {
  return 1 - brightness / base.r;
}

/** Euclidean distance in tiles from `(x, z)` to the edge of an axis-aligned square. */
function distanceToSquare(x: number, z: number, lo: number, hi: number): number {
  const centre = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const dx = Math.abs(x - centre) - half;
  const dz = Math.abs(z - centre) - half;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
  return (outside > 0 ? outside : Math.max(dx, dz)) / TILE_SIZE;
}

interface Band { depth: number; brightness: number; spread: number }

/**
 * Group `(depth, brightness)` samples into bands, shallowest first.
 *
 * Cap vertices sit *on* the contours — earcut adds none of its own — so the honest bucket
 * width is the contour spacing. Rounding finer splits one contour across two buckets, which
 * a monotonicity check then reads as a tie; rounding coarser merges contours and hides one.
 */
function brightnessByDepth(samples: { depth: number; brightness: number }[]): Band[] {
  const bands = new Map<number, number[]>();
  for (const s of samples) {
    const key = Math.round(s.depth / STEP_TILES);
    const bucket = bands.get(key);
    if (bucket) bucket.push(s.brightness);
    else bands.set(key, [s.brightness]);
  }
  return [...bands.entries()]
    .map(([step, values]) => ({
      depth: step * STEP_TILES,
      brightness: values.reduce((a, b) => a + b, 0) / values.length,
      spread: Math.max(...values) - Math.min(...values),
    }))
    .sort((a, b) => a.depth - b.depth);
}

/** The same bucketing, but keyed by terrace as well, so no bucket straddles a step edge. */
function bandsPerTerrace(samples: { depth: number; terrace: number; brightness: number }[]): Band[] {
  const terraces = new Set(samples.map(s => s.terrace));
  return [...terraces].flatMap(t => brightnessByDepth(samples.filter(s => s.terrace === t)));
}

// ---------------------------------------------------------------------------- tests

describe('LakeLayer', () => {
  let scene: THREE.Scene;
  let layer: LakeLayer;
  let disposed: THREE.Material[];
  let disposedGeometries: THREE.BufferGeometry[];
  let spies: { mockRestore(): void }[];

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new LakeLayer();
    disposed = [];
    disposedGeometries = [];

    const disposeMaterial = THREE.Material.prototype.dispose;
    const disposeGeometry = THREE.BufferGeometry.prototype.dispose;
    spies = [
      vi.spyOn(THREE.Material.prototype, 'dispose').mockImplementation(function (this: THREE.Material) {
        disposed.push(this);
        disposeMaterial.call(this);
      }),
      vi.spyOn(THREE.BufferGeometry.prototype, 'dispose').mockImplementation(function (this: THREE.BufferGeometry) {
        disposedGeometries.push(this);
        disposeGeometry.call(this);
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  describe('degenerate input', () => {
    it('renders nothing, and creates nothing, for an empty cell list', () => {
      const cursor = materialIdCursor();
      expect(() => layer.build(scene, [])).not.toThrow();

      expect(scene.children).toHaveLength(0);
      expect(createdSince(cursor)).toBe(0);
    });

    it('renders nothing when no contour can be traced', () => {
      // Non-empty cells, but nothing traceable: `buildTerrainContours` returns null, and
      // reading `contours.levels[0]` off it would be a TypeError at map load.
      const cells = block(3);
      const cursor = materialIdCursor();

      expect(() => layer.build(scene, cells, blankTriangles(cells))).not.toThrow();

      expect(scene.children).toHaveLength(0);
      expect(createdSince(cursor)).toBe(0);
    });

    it('builds a single cell into one terrace, a shoreline and a cliff', () => {
      layer.build(scene, block(1));

      expect(scene.children).toHaveLength(1);
      const meshes = meshesOf(scene);
      expect(meshes.length).toBeGreaterThanOrEqual(3);
      expect(coverCountAcross(meshes, ...sampleIn(0, 0))).toBe(1);
      expect(cliffMesh(scene)).toBeDefined();
    });
  });

  describe('terrace stack', () => {
    it('adds exactly one group, and replaces it rather than accumulating', () => {
      layer.build(scene, block(4));
      expect(scene.children).toHaveLength(1);
      const first = scene.children[0];

      layer.build(scene, block(5));
      expect(scene.children).toHaveLength(1);
      expect(scene.children[0]).not.toBe(first);
    });

    it('puts the water surface exactly on the ground plane and steps down from it', () => {
      layer.build(scene, block(6));

      // `direction: -1, baseOffset: 0`. Getting either wrong floats the lake above the map
      // or sinks the surface a step below it, and both look like "the lake is missing".
      const ys = terraceYs(scene);
      expect(ys.length).toBeGreaterThanOrEqual(3);
      ys.forEach((y, i) => expect(y).toBeCloseTo(GROUND_Y_POSITION - i * LAYER_HEIGHT, 6));
    });

    it('puts level 0s top *face* at ground level, not just its origin', () => {
      layer.build(scene, block(6));

      // The mesh origin is its top face only because `terrainMesh` extrudes downward after
      // the rotate. Assert on the vertices so a change of convention there cannot pass.
      const capYs: number[] = [];
      for (const mesh of waterMeshes(scene)) {
        const position = mesh.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) capYs.push(worldY(mesh) + position.getY(i));
      }
      expect(Math.max(...capYs)).toBeCloseTo(GROUND_Y_POSITION, 6);
      expect(Math.min(...capYs))
        .toBeCloseTo(GROUND_Y_POSITION - terraceYs(scene).length * LAYER_HEIGHT, 6);
    });

    it('covers every point of a solid footprint exactly once', () => {
      // Terraces are rings, not stacked solids: each level has the level above subtracted
      // from it. Two levels claiming the same point means the subtraction was skipped.
      layer.build(scene, block(6));
      const meshes = meshesOf(scene);

      for (let gx = 0; gx < 6; gx++) {
        for (let gy = 0; gy < 6; gy++) {
          expect(coverCountAcross(meshes, ...sampleIn(gx, gy))).toBe(1);
        }
      }
    });
  });

  describe('an island in the water', () => {
    it('punches a visible hole, without shrinking the footprint', () => {
      layer.build(scene, ringCells());
      const meshes = meshesOf(scene);

      // Footprint first: a hole proven only by "nothing covers the middle" is also what a
      // mesh that collapsed to a sliver would report. The geometry must still span the whole
      // 7x7 block — plus the shoreline, which is outset a little further.
      const bounds = boundsOf(meshes);
      expect(bounds.min.x).toBeLessThanOrEqual(0);
      expect(bounds.min.z).toBeLessThanOrEqual(0);
      expect(bounds.max.x).toBeGreaterThanOrEqual(RING_SIZE * TILE_SIZE);
      expect(bounds.max.z).toBeGreaterThanOrEqual(RING_SIZE * TILE_SIZE);

      // Then the hole. Three silently drops a hole that lies outside its shape, so this is
      // the assertion that catches a hole punched into the wrong band — and the one the old
      // `loops[0]` code, which kept only the longest boundary loop, could never pass.
      for (let gx = ISLAND_MIN; gx <= ISLAND_MAX; gx++) {
        for (let gy = ISLAND_MIN; gy <= ISLAND_MAX; gy++) {
          expect(coverCountAcross(meshes, ...sampleIn(gx, gy))).toBe(0);
        }
      }
    });

    it('still covers every water cell exactly once', () => {
      layer.build(scene, ringCells());
      const meshes = meshesOf(scene);

      for (const cell of ringCells()) {
        expect(coverCountAcross(meshes, ...sampleIn(cell.gx, cell.gy))).toBe(1);
      }
    });

    it('handles a pond standing inside the island', () => {
      layer.build(scene, nestedCells());
      const meshes = meshesOf(scene);
      const water = new Set(nestedCells().map(c => `${c.gx},${c.gy}`));

      const mismatches: string[] = [];
      for (let gx = 0; gx < NESTED_SIZE; gx++) {
        for (let gy = 0; gy < NESTED_SIZE; gy++) {
          const want = water.has(`${gx},${gy}`) ? 1 : 0;
          const got = coverCountAcross(meshes, ...sampleIn(gx, gy));
          if (got !== want) mismatches.push(`(${gx}, ${gy}) want ${want} got ${got}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('depth ramp', () => {
    it('colours the water per vertex, not per material', () => {
      layer.build(scene, block(6));

      const materials = [...new Set(waterMeshes(scene).map(m => m.material as THREE.MeshPhysicalMaterial))];
      expect(materials.length).toBeGreaterThan(1);
      for (const material of materials) {
        expect(material.vertexColors).toBe(true);
        // White, so the ramp is the only thing tinting the water. A coloured material here
        // would multiply the ramp and wash it out.
        expect(material.color.getHex()).toBe(0xffffff);
      }
    });

    it('darkens monotonically from shore to centre', () => {
      const size = 8;
      layer.build(scene, block(size));

      // For a square, distance-to-shore is exactly `min(x, W - x, z, W - z)`, so the expected
      // depth of every vertex is known without asking the field — which is what makes this
      // an independent check rather than a restatement of the implementation.
      const width = size * TILE_SIZE;
      const samples = shadedVertices(scene).map(v => ({
        depth: Math.min(v.x, width - v.x, v.z, width - v.z) / TILE_SIZE,
        terrace: v.terrace,
        brightness: v.brightness,
      }));

      const bands = brightnessByDepth(samples);
      expect(bands.length).toBeGreaterThanOrEqual(4);
      expect(bands[0].depth).toBe(0);

      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].brightness).toBeLessThan(bands[i - 1].brightness);
      }

      // Within one terrace, depth is the only thing colouring a vertex — two vertices the
      // same distance from shore *on the same step* are the same colour. Across terraces they
      // are deliberately not: the ramp is banded, and the band edges are the depth cue. The
      // buckets above already mix the two sides of every step, so spread has to be measured
      // per terrace to say anything.
      for (const band of bandsPerTerrace(samples)) expect(band.spread).toBeLessThan(1e-6);

      // And the ramp has to be worth looking at: the shore is the undarkened base colour and
      // the deepest contour is visibly below it.
      const base = new THREE.Color(LAKE_COLOR);
      expect(bands[0].brightness).toBeCloseTo(base.r, 6);
      expect(bands[bands.length - 1].brightness).toBeLessThan(base.r * 0.9);
    });

    it('steps down a visible band at every terrace edge, and ramps within each', () => {
      // Both halves of the split are load-bearing and each fails silently without the other.
      // Terrace index alone gives flat plateaus; the per-vertex ramp alone gives one tone
      // across everything past 1.5 tiles, where earcut stops producing vertices.
      layer.build(scene, block(8));

      const base = new THREE.Color(LAKE_COLOR);
      const ranges = new Map<number, { lo: number; hi: number }>();
      for (const v of shadedVertices(scene)) {
        const d = darkening(v.brightness, base);
        const range = ranges.get(v.terrace);
        if (range) { range.lo = Math.min(range.lo, d); range.hi = Math.max(range.hi, d); }
        else ranges.set(v.terrace, { lo: d, hi: d });
      }
      const terraces = [...ranges.keys()].sort((a, b) => a - b);
      expect(terraces).toEqual([0, 1, 2, 3, 4, 5]);

      // The notch: a terrace's shallowest tone against the *deepest* tone of the terrace
      // above. This is the gap the internal ramp is deliberately not allowed to close — let
      // it spend a whole step and the banding disappears into a continuous ramp.
      for (let i = 1; i < terraces.length; i++) {
        const notch = ranges.get(terraces[i])!.lo - ranges.get(terraces[i - 1])!.hi;
        expect(notch, `notch below terrace ${terraces[i]}`).toBeGreaterThan(0.02);
      }

      // The gradient: every terrace but the deepest varies across its own width. The deepest
      // is saturated at the cap by construction and has nowhere left to go.
      for (const t of terraces.slice(0, -1)) {
        const { lo, hi } = ranges.get(t)!;
        expect(hi - lo, `gradient across terrace ${t}`).toBeGreaterThan(0.02);
      }
      expect(ranges.get(5)!.hi - ranges.get(5)!.lo).toBe(0);
    });

    it('darkens the deepest terrace to the full cap at every lake size', () => {
      // The defect this pins: darkening used to be normalised by the lake's own maximum depth
      // while `MAX_TERRACES` pinned the deepest contour at 1.5 tiles, so bigger lakes came out
      // *lighter* — 36% at 3x3 falling to 14% at 12x12. Driving the band from the terrace
      // index instead makes the floor of the deepest terrace independent of size.
      const base = new THREE.Color(LAKE_COLOR);
      const cases: [string, GridPos[]][] = [
        ['3x3', block(3)], ['4x4', block(4)], ['8x8', block(8)],
        ['12x12', block(12)], ['20x20', block(20)],
        // Island lakes as well: their deepest terrace is bounded by the island's isoline as
        // well as the bank's, and bilinear sampling lands a few float-epsilons *past* that
        // threshold. Unclamped, those vertices come out fractionally darker than the cap —
        // which is what the `Math.min` in `applyDepthColors` is there for, and why the bound
        // below is asserted exactly rather than approximately.
        ['ring', ringCells()], ['nested', nestedCells()],
      ];

      for (const [name, cells] of cases) {
        layer.build(scene, cells);
        const brightness = shadedVertices(scene).map(v => v.brightness);

        // The shore is still the untouched base colour at every size.
        expect(darkening(Math.max(...brightness), base), `${name} shore`).toBeCloseTo(0, 6);
        // And the bed reaches the cap — never short of it...
        expect(darkening(Math.min(...brightness), base), `${name} bed`)
          .toBeCloseTo(MAX_DEPTH_DARKEN, 6);
        // ...and never past it, to the last bit.
        expect(darkening(Math.min(...brightness), base), `${name} cap`)
          .toBeLessThanOrEqual(MAX_DEPTH_DARKEN);
      }
    });

    it('leaves a single-terrace lake finite and un-blackened', () => {
      // A one-cell lake's field never reaches `STEP_TILES`, so it gets exactly one terrace and
      // there are zero steps between shallowest and deepest. Dividing the band by that step
      // count is `0 / 0`, and `NaN` in a colour buffer does not throw — it renders the water
      // black or white with nothing in the logs to point at.
      layer.build(scene, block(1));

      const base = new THREE.Color(LAKE_COLOR);
      const meshes = waterMeshes(scene);
      expect(meshes).toHaveLength(1);

      for (const mesh of meshes) {
        const color = mesh.geometry.getAttribute('color');
        expect(color.count).toBeGreaterThan(0);
        for (let i = 0; i < color.count * 3; i++) {
          const channel = (color.array as ArrayLike<number>)[i];
          expect(Number.isFinite(channel), `channel ${i}`).toBe(true);
        }
      }

      // A puddle has no depth to express, so it stays at the surface colour rather than
      // being promoted to "deepest terrace" and painted at the full cap.
      const brightness = shadedVertices(scene).map(v => v.brightness);
      expect(darkening(Math.min(...brightness), base)).toBeCloseTo(0, 6);
    });

    it('shallows again as it approaches an island', () => {
      layer.build(scene, ringCells());

      const width = RING_SIZE * TILE_SIZE;
      const vertices = shadedVertices(scene);

      // Distance to the *nearest* shore, outer bank or island alike. If the ramp were driven
      // by anything but the distance field — a centroid, or the outer loop alone — the water
      // hugging the island would come out at its darkest here instead of its brightest.
      const samples = vertices.map(v => ({
        depth: Math.min(
          Math.min(v.x, width - v.x, v.z, width - v.z) / TILE_SIZE,
          distanceToSquare(v.x, v.z, ISLAND_LO, ISLAND_HI),
        ),
        brightness: v.brightness,
      }));

      const bands = brightnessByDepth(samples);
      expect(bands.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].brightness).toBeLessThan(bands[i - 1].brightness);
      }

      // Spelled out for the island specifically: the ring of water touching it is as bright
      // as the ring touching the outer bank.
      const base = new THREE.Color(LAKE_COLOR);
      const touchingIsland = vertices.filter(
        v => distanceToSquare(v.x, v.z, ISLAND_LO, ISLAND_HI) < 0.05
          && Math.min(v.x, width - v.x, v.z, width - v.z) > 0.5 * TILE_SIZE,
      );
      expect(touchingIsland.length).toBeGreaterThan(3);
      for (const v of touchingIsland) expect(v.brightness).toBeCloseTo(base.r, 2);
    });

    it('ramps from a custom water colour', () => {
      layer.build(scene, block(4), undefined, '#804020');

      const base = new THREE.Color('#804020');
      const brightest = Math.max(...shadedVertices(scene).map(v => v.brightness));
      expect(brightest).toBeCloseTo(base.r, 4);
      expect(brightest).not.toBeCloseTo(new THREE.Color(LAKE_COLOR).r, 3);
    });
  });

  describe('cliff ring', () => {
    /** Local-space vertices of the cliff skirt, paired per world x/z. */
    function cliffVertices(): { x: number; y: number; z: number }[] {
      const mesh = cliffMesh(scene)!;
      const position = mesh.geometry.getAttribute('position');
      const out: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < position.count; i++) {
        out.push({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
      }
      return out;
    }

    it('hangs from the water surface down past the deepest terrace', () => {
      layer.build(scene, block(6));

      const mesh = cliffMesh(scene)!;
      expect(worldY(mesh)).toBe(GROUND_Y_POSITION);

      const ys = cliffVertices().map(v => v.y);
      expect(Math.max(...ys)).toBe(0);
      // The whole stack: the deepest terrace's *floor*, not its top face, or the wall stops
      // short and the lake shows daylight under its own bed.
      expect(Math.min(...ys)).toBeCloseTo(-terraceYs(scene).length * LAYER_HEIGHT, 6);
    });

    it('is a wall, contributing no cap of its own', () => {
      // If the skirt ever grew a floor it would paint over the terraces from above, and the
      // coverage assertions elsewhere in this file would stop meaning anything.
      layer.build(scene, block(4));
      const mesh = cliffMesh(scene)!;

      expect(covers(mesh, ...sampleIn(2, 2))).toBe(false);
      expect(mesh.geometry.getAttribute('position').count % 3).toBe(0);
    });

    it('follows the outer bank', () => {
      layer.build(scene, block(4));
      const bounds = new THREE.Box3();
      cliffMesh(scene)!.geometry.computeBoundingBox();
      bounds.union(cliffMesh(scene)!.geometry.boundingBox!);

      // The footprint contour, not the outset shoreline: the wall drops where the water ends.
      expect(bounds.min.x).toBeCloseTo(0, 1);
      expect(bounds.min.z).toBeCloseTo(0, 1);
      expect(bounds.max.x).toBeCloseTo(4 * TILE_SIZE, 1);
      expect(bounds.max.z).toBeCloseTo(4 * TILE_SIZE, 1);
    });

    it('wraps the island too, not only the outer boundary', () => {
      layer.build(scene, ringCells());

      // Dropping `polygon.holes` from the wall loop is the easy mistake, and it leaves the
      // island floating with no bank — the exact cue this whole ring exists to provide.
      const inner = cliffVertices().filter(
        v => v.x > ISLAND_LO - 4 && v.x < ISLAND_HI + 4 && v.z > ISLAND_LO - 4 && v.z < ISLAND_HI + 4,
      );
      expect(inner.length).toBeGreaterThan(8);

      // Those vertices are the island's shore, at its full depth, on all four sides.
      expect(Math.min(...inner.map(v => v.y)))
        .toBeCloseTo(-terraceYs(scene).length * LAYER_HEIGHT, 6);
      expect(Math.min(...inner.map(v => v.x))).toBeLessThan(ISLAND_LO + 4);
      expect(Math.max(...inner.map(v => v.x))).toBeGreaterThan(ISLAND_HI - 4);
      expect(Math.min(...inner.map(v => v.z))).toBeLessThan(ISLAND_LO + 4);
      expect(Math.max(...inner.map(v => v.z))).toBeGreaterThan(ISLAND_HI - 4);
    });

    it('is earth-coloured, and takes the theme shoreline colour when given one', () => {
      layer.build(scene, block(3));
      const material = cliffMesh(scene)!.material as THREE.MeshPhysicalMaterial;
      expect(material.color.getHex()).toBe(new THREE.Color(LAKE_SHORE_COLOR).getHex());
      // Coplanar with the water's own level-0 wall; without the offset the two z-fight.
      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetFactor).toBeLessThan(0);

      layer.build(scene, block(3), undefined, undefined, '#ff0000');
      expect((cliffMesh(scene)!.material as THREE.MeshPhysicalMaterial).color.getHex())
        .toBe(new THREE.Color('#ff0000').getHex());
    });
  });

  describe('shoreline', () => {
    function shorelineMeshes(): THREE.Mesh[] {
      return meshesOf(scene).filter(
        m => worldY(m) === GROUND_Y_POSITION
          && m.name !== LAKE_CLIFF_NAME
          && !(m.material as THREE.MeshPhysicalMaterial).vertexColors,
      );
    }

    it('outsets the footprint by a fraction of a tile, not by tiles', () => {
      // `buildTerrainContours` takes the shoreline width in *tiles*. The old constant was
      // `TILE_SIZE * 0.15` in pixels; handed over unconverted it asks for a six-tile beach.
      layer.build(scene, block(4));
      const bounds = boundsOf(meshesOf(scene));
      const outset = -bounds.min.x;

      expect(outset).toBeGreaterThan(0.1 * TILE_SIZE);
      expect(outset).toBeLessThan(0.2 * TILE_SIZE);
      expect(-bounds.min.z).toBeCloseTo(outset, 6);
      expect(bounds.max.x - 4 * TILE_SIZE).toBeCloseTo(outset, 6);
    });

    it('is built as a ring, leaving the footprint to the terraces', () => {
      layer.build(scene, block(4));
      const shore = shorelineMeshes();
      expect(shore.length).toBeGreaterThan(0);

      expect(coverCountAcross(shore, ...sampleIn(1, 1))).toBe(0);
      expect(coverCountAcross(shore, -3, 2 * TILE_SIZE + 7)).toBe(1);
    });

    it('honours a custom shoreline colour, defaulting to the sand colour', () => {
      layer.build(scene, block(4));
      expect((shorelineMeshes()[0].material as THREE.MeshPhysicalMaterial).color.getHex())
        .toBe(new THREE.Color(LAKE_SHORE_COLOR).getHex());

      layer.build(scene, block(4), undefined, undefined, '#00ff00');
      expect((shorelineMeshes()[0].material as THREE.MeshPhysicalMaterial).color.getHex())
        .toBe(new THREE.Color('#00ff00').getHex());
    });
  });

  describe('materials', () => {
    it('disposes every material it created, exactly once', () => {
      const cursor = materialIdCursor();
      layer.build(scene, ringCells());
      const created = createdSince(cursor);

      // Shoreline, cliff and several terrace levels; if this ever drops the fixture stopped
      // exercising the thing being tested.
      expect(created).toBeGreaterThan(3);

      const inScene = new Set(meshesOf(scene).map(m => m.material as THREE.Material));
      expect(inScene.size).toBeGreaterThan(0);

      layer.dispose(scene);

      // Length *and* set size: a `dispose` that walked the meshes instead of the builder's
      // materials array would double-free the material a level shares across its shapes
      // (length too high) and miss any level that contributed no mesh (set size too low).
      expect(new Set(disposed).size).toBe(created);
      expect(disposed).toHaveLength(created);
      for (const material of inScene) expect(disposed).toContain(material);
    });

    it('disposes every geometry it added to the scene', () => {
      // The nested-mesh shoreline is the one that gets missed by a shallow walk: its extra
      // contours are children of the first mesh, not of the group.
      layer.build(scene, ringCells());
      const geometries = meshesOf(scene).map(m => m.geometry);
      expect(geometries.length).toBeGreaterThan(3);

      layer.dispose(scene);

      for (const geometry of geometries) expect(disposedGeometries).toContain(geometry);
    });

    it('frees the previous build even when the next one bails out', () => {
      // The material loop lives above the `group` guard for this case: erasing the last lake
      // calls `build` with no cells, which disposes and then returns early.
      layer.build(scene, block(3));
      const built = new Set(meshesOf(scene).map(m => m.material as THREE.Material));
      expect(built.size).toBeGreaterThan(0);
      disposed.length = 0;

      layer.build(scene, []);

      for (const material of built) expect(disposed).toContain(material);
      expect(scene.children).toHaveLength(0);
    });

    it('empties the scene on dispose, and tolerates a second call', () => {
      layer.build(scene, block(3));
      layer.dispose(scene);

      expect(scene.children).toHaveLength(0);
      const count = disposed.length;

      expect(() => layer.dispose(scene)).not.toThrow();
      expect(scene.children).toHaveLength(0);
      expect(disposed).toHaveLength(count);
    });

    it('disposes on a layer that was never built', () => {
      expect(() => layer.dispose(scene)).not.toThrow();
      expect(scene.children).toHaveLength(0);
    });

    it('frees materials even with no group to walk', () => {
      // `dispose` keeps its material loop *above* the `group` guard, and its comment says
      // why. Today's `build` never leaves materials behind without a group — every path that
      // creates one creates the other — so the guard is defensive and no public call can
      // reach the state. Reaching in is the only way to pin the ordering the ruling protects
      // against a future `build` that grows a path between the two.
      layer.build(scene, block(3));
      const built = new Set(meshesOf(scene).map(m => m.material as THREE.Material));
      const reachIn = layer as unknown as { group: THREE.Group | null };
      scene.remove(reachIn.group!);
      reachIn.group = null;
      disposed.length = 0;

      layer.dispose(scene);

      for (const material of built) expect(disposed).toContain(material);
    });
  });
});
