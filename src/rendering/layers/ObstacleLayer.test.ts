import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { GROUND_Y_POSITION, TILE_SIZE, MOUNTAIN_COLOR } from '../../constants';
import type { GridPos } from '../../types';
import type { MountainTriangles } from '../../maps/types';
import { ObstacleLayer, MOSS_COLOR, MOSS_MIX, SNOW_COLOR } from './ObstacleLayer';
import { SNOW_MIN_LEVELS } from './terrainDecor';

// Three.js geometry is pure maths — `Shape`, `ExtrudeGeometry`, `rotateX` and the whole
// `src/terrain` pipeline run under plain Node. Only the *renderer* needs a GPU, and a
// `Scene` is a bare object graph, so a layer can be built and inspected headless.

const LAYER_HEIGHT = 12;

// ---------------------------------------------------------------------------- fixtures

/** A solid `size` x `size` square of terrain, anchored at the grid origin. */
function block(size: number): GridPos[] {
  const cells: GridPos[] = [];
  for (let gx = 0; gx < size; gx++) {
    for (let gy = 0; gy < size; gy++) cells.push({ gx, gy });
  }
  return cells;
}

/** 7x7 of mountain with the middle 3x3 left out — a crater. Grid [2,5) is the hole. */
const RING_SIZE = 7;
const CRATER_MIN = 2;
const CRATER_MAX = 4;

function isCrater(gx: number, gy: number): boolean {
  return gx >= CRATER_MIN && gx <= CRATER_MAX && gy >= CRATER_MIN && gy <= CRATER_MAX;
}

function ringCells(): GridPos[] {
  return block(RING_SIZE).filter(c => !isCrater(c.gx, c.gy));
}

/**
 * 13x13 with a 7x7 crater and a 3x3 island standing in the middle of it.
 *
 * One nesting level deeper than a plain crater, and the case that separates subtracting the
 * level above by containment *parity* from spelling the cases out: the island's contours put
 * a cutout's outer loop inside a cutout's hole, which a hand-written rule punches out of the
 * wrong band.
 */
const ISLAND_SIZE = 13;
const ISLAND_CRATER = [3, 9] as const;
const ISLAND_LAND = [5, 7] as const;

function inSquare(gx: number, gy: number, [lo, hi]: readonly [number, number]): boolean {
  return gx >= lo && gx <= hi && gy >= lo && gy <= hi;
}

function islandCells(): GridPos[] {
  return block(ISLAND_SIZE).filter(
    c => !inSquare(c.gx, c.gy, ISLAND_CRATER) || inSquare(c.gx, c.gy, ISLAND_LAND),
  );
}

/**
 * A cell carrying triangle flags that activate no quadrant.
 *
 * The map format permits this — `top: false` is an explicitly-present flag — so it rasterises
 * to all-zero coverage and `buildTerrainContours` returns null with a non-empty cell list.
 */
function blankTriangles(cells: GridPos[]): MountainTriangles {
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

/** World-space y of a mesh, which for these layers is set on the mesh or on its parent. */
function worldY(mesh: THREE.Mesh): number {
  mesh.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld).y;
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
 * geometry; a point claimed by two *meshes* is two terraces stacked on the same ground,
 * which is the failure this is here to catch.
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

// ---------------------------------------------------------------------------- tests

describe('ObstacleLayer', () => {
  let scene: THREE.Scene;
  let layer: ObstacleLayer;
  let disposed: THREE.Material[];
  let disposedGeometries: THREE.BufferGeometry[];
  let spies: { mockRestore(): void }[];

  beforeEach(() => {
    scene = new THREE.Scene();
    layer = new ObstacleLayer();
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

      expect(() => layer.build(scene, cells, undefined, blankTriangles(cells))).not.toThrow();

      expect(scene.children).toHaveLength(0);
      expect(createdSince(cursor)).toBe(0);
    });

    it('builds a single cell into one terrace and a shoreline', () => {
      layer.build(scene, block(1));

      expect(scene.children).toHaveLength(1);
      const meshes = meshesOf(scene);
      expect(meshes.length).toBeGreaterThanOrEqual(2);
      expect(coverCountAcross(meshes, ...sampleIn(0, 0))).toBe(1);
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

    it('steps terraces upward from ground level, one LAYER_HEIGHT apart', () => {
      layer.build(scene, block(6));

      // Every mesh above the shoreline sits at GROUND + (level + 1) * LAYER_HEIGHT: the
      // `baseOffset: 1` lifts the lowest step clear of the ground, and `direction: 1` is
      // what keeps a mountain out of the basement.
      const levelYs = [...new Set(meshesOf(scene).map(worldY))]
        .filter(y => y > GROUND_Y_POSITION + 1e-6)
        .sort((a, b) => a - b);

      expect(levelYs.length).toBeGreaterThanOrEqual(2);
      levelYs.forEach((y, i) => {
        expect(y).toBeCloseTo(GROUND_Y_POSITION + (i + 1) * LAYER_HEIGHT, 6);
      });
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

  describe('a ring of cells', () => {
    it('punches a visible hole, without shrinking the footprint', () => {
      layer.build(scene, ringCells());
      const meshes = meshesOf(scene);

      // Footprint first: a hole proven only by "nothing covers the middle" is also what a
      // mesh that collapsed to a sliver would report. The geometry must still span the
      // whole 7x7 block — plus the shoreline, which is outset a little further.
      const bounds = boundsOf(meshes);
      expect(bounds.min.x).toBeLessThanOrEqual(0);
      expect(bounds.min.z).toBeLessThanOrEqual(0);
      expect(bounds.max.x).toBeGreaterThanOrEqual(RING_SIZE * TILE_SIZE);
      expect(bounds.max.z).toBeGreaterThanOrEqual(RING_SIZE * TILE_SIZE);

      // Then the hole. Three silently drops a hole that lies outside its shape, so this is
      // the assertion that catches a hole punched into the wrong band — the defect that
      // broke mountains-with-craters until `buildTerraceMeshes` started subtracting by
      // containment parity.
      for (let gx = CRATER_MIN; gx <= CRATER_MAX; gx++) {
        for (let gy = CRATER_MIN; gy <= CRATER_MAX; gy++) {
          expect(coverCountAcross(meshes, ...sampleIn(gx, gy))).toBe(0);
        }
      }
    });

    it('still covers every walled cell exactly once', () => {
      layer.build(scene, ringCells());
      const meshes = meshesOf(scene);

      for (const cell of ringCells()) {
        expect(coverCountAcross(meshes, ...sampleIn(cell.gx, cell.gy))).toBe(1);
      }
    });

    it('handles an island standing inside the crater', () => {
      layer.build(scene, islandCells());
      const meshes = meshesOf(scene);
      const land = new Set(islandCells().map(c => `${c.gx},${c.gy}`));

      const mismatches: string[] = [];
      for (let gx = 0; gx < ISLAND_SIZE; gx++) {
        for (let gy = 0; gy < ISLAND_SIZE; gy++) {
          const want = land.has(`${gx},${gy}`) ? 1 : 0;
          const got = coverCountAcross(meshes, ...sampleIn(gx, gy));
          if (got !== want) mismatches.push(`(${gx}, ${gy}) want ${want} got ${got}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('shoreline', () => {
    it('sits at ground level, below every terrace', () => {
      layer.build(scene, block(4));
      const ys = meshesOf(scene).map(worldY);

      expect(ys).toContain(GROUND_Y_POSITION);
      expect(Math.min(...ys)).toBe(GROUND_Y_POSITION);
    });

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
      const shoreMeshes = meshesOf(scene).filter(m => worldY(m) === GROUND_Y_POSITION);
      expect(shoreMeshes.length).toBeGreaterThan(0);

      // Inside the footprint the shoreline contributes nothing; just outside it, it does.
      expect(coverCountAcross(shoreMeshes, ...sampleIn(1, 1))).toBe(0);
      expect(coverCountAcross(shoreMeshes, -3, 2 * TILE_SIZE + 7)).toBe(1);
    });
  });

  describe('materials', () => {
    it('disposes every material it created, exactly once', () => {
      const cursor = materialIdCursor();
      layer.build(scene, ringCells());
      const created = createdSince(cursor);

      // A ring gets a shoreline plus several terrace levels; if this ever drops to one the
      // fixture stopped exercising the thing being tested.
      expect(created).toBeGreaterThan(2);

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
      // The material loop lives above the `group` guard for this case: erasing the last
      // mountain calls `build` with no cells, which disposes and then returns early.
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

  describe('colour', () => {
    function materialsAt(y: number): THREE.MeshPhysicalMaterial[] {
      return [...new Set(meshesOf(scene)
        .filter(m => Math.abs(worldY(m) - y) < 1e-6)
        .map(m => m.material as THREE.MeshPhysicalMaterial))];
    }

    it('defaults to the mountain colour, darkened for the shoreline', () => {
      layer.build(scene, block(4));

      // The foot terrace is the mountain colour grown over with moss.
      const base = new THREE.Color(MOUNTAIN_COLOR);
      expect(materialsAt(GROUND_Y_POSITION + LAYER_HEIGHT)[0].color.getHex())
        .toBe(base.clone().lerp(MOSS_COLOR, MOSS_MIX).getHex());
      expect(materialsAt(GROUND_Y_POSITION)[0].color.getHex())
        .toBe(base.clone().multiplyScalar(0.85).getHex());
    });

    it('honours a custom mountain colour and shoreline colour', () => {
      layer.build(scene, block(4), '#204080', undefined, '#ff0000');

      expect(materialsAt(GROUND_Y_POSITION + LAYER_HEIGHT)[0].color.getHex())
        .toBe(new THREE.Color('#204080').lerp(MOSS_COLOR, MOSS_MIX).getHex());
      expect(materialsAt(GROUND_Y_POSITION)[0].color.getHex())
        .toBe(new THREE.Color('#ff0000').getHex());
    });

    it('derives the shoreline from a custom mountain colour when none is given', () => {
      layer.build(scene, block(4), '#204080');

      expect(materialsAt(GROUND_Y_POSITION)[0].color.getHex())
        .toBe(new THREE.Color('#204080').clone().multiplyScalar(0.85).getHex());
    });

    /** Terrace colours, foot first, as built. */
    function terraceColors(): THREE.Color[] {
      const levelYs = [...new Set(meshesOf(scene).map(worldY))]
        .filter(y => y > GROUND_Y_POSITION + 1e-6)
        .sort((a, b) => a - b);
      return levelYs.map(y => materialsAt(y)[0].color);
    }

    it('lightens toward the peak in alternating strata, under a snow cap', () => {
      layer.build(scene, block(6), '#000000');
      const colors = terraceColors();
      expect(colors.length).toBeGreaterThanOrEqual(SNOW_MIN_LEVELS);

      expect(colors[colors.length - 1].getHex()).toBe(SNOW_COLOR.getHex());
      // Between the mossy foot and the snow, each terrace is lighter than the one two below
      // it: the lightening ramp, read within one stratum so the banding cannot mask it.
      const rock = colors.slice(1, -1).map(c => c.getHSL({ h: 0, s: 0, l: 0 }).l);
      for (let i = 2; i < rock.length; i++) expect(rock[i]).toBeGreaterThan(rock[i - 2]);
      // And adjacent terraces differ, which is the banding.
      for (let i = 1; i < rock.length; i++) expect(rock[i]).not.toBeCloseTo(rock[i - 1], 3);
    });

    it('keeps hills too small for snow earthy to the top', () => {
      layer.build(scene, block(2), '#000000');
      const colors = terraceColors();
      expect(colors.length).toBeLessThan(SNOW_MIN_LEVELS);
      for (const c of colors) expect(c.getHex()).not.toBe(SNOW_COLOR.getHex());
    });

    it('does not mutate the shared default colour across builds', () => {
      // The shoreline is `baseColor.clone().multiplyScalar(0.85)`; dropping the clone would
      // darken the module-level default a little more on every rebuild.
      layer.build(scene, block(3));
      layer.build(scene, block(3));
      layer.build(scene, block(3));

      const materials = meshesOf(scene)
        .filter(m => Math.abs(worldY(m) - GROUND_Y_POSITION) < 1e-6)
        .map(m => m.material as THREE.MeshPhysicalMaterial);
      expect(materials[0].color.getHex())
        .toBe(new THREE.Color(MOUNTAIN_COLOR).multiplyScalar(0.85).getHex());
    });
  });
});
