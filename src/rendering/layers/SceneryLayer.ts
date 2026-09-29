import * as THREE from 'three';
import { GRID_COLS, GRID_ROWS, TILE_SIZE, FOLIAGE_COLOR } from '../../constants';
import { SceneryKind, planScenery, visibleScenery, type SceneryItem } from './scenery';

const TRUNK_COLOR = 0x8a6a4f;
const PEBBLE_COLOR = 0xb9b3a2;

/** How far `tint` may move a colour's lightness, either way. */
const TINT_LIGHTNESS = 0.07;
/** Pines sit darker and slightly bluer than the broadleaf trees around them. */
const PINE_SHIFT = { h: 0.03, s: -0.05, l: -0.08 };
/** Bushes sit a touch lighter and yellower. */
const BUSH_SHIFT = { h: -0.02, s: 0.02, l: 0.05 };

interface Part {
  mesh: THREE.InstancedMesh;
  /** How many instances `mesh` was allocated for. */
  capacity: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Which kinds contribute an instance to this part. */
  kinds: readonly SceneryKind[];
  /** Local transform of this part relative to the item's base, before item scale/rotation. */
  offsetY: number;
  /** Colour source: foliage-derived, or a fixed colour. */
  color: 'foliage' | number;
}

/**
 * Trees, bushes and pebbles on empty ground.
 *
 * The plan (`scenery.ts`) follows the map's forest, and is remade only when that changes
 * ({@link setForest}) — once per game, and once per brush stroke in the designer. Otherwise
 * only visibility changes: {@link refresh} hides every item whose cell is no longer free,
 * which is how drawing a road or spawning a house clears the land under it. Every part is one
 * `InstancedMesh` sized for the whole plan, so a refresh rewrites matrices and never
 * allocates GPU buffers; a replan that outgrows a part reallocates it, with headroom.
 */
export class SceneryLayer {
  private readonly seed: number;
  private items: SceneryItem[];
  private readonly parts: Part[] = [];
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private foliage = new THREE.Color(FOLIAGE_COLOR);
  private visible: SceneryItem[] = [];

  /** Starts with no forest: bushes and pebbles only, until {@link setForest}. */
  constructor(scene: THREE.Scene, seed: number) {
    this.seed = seed;
    this.items = planScenery(GRID_COLS, GRID_ROWS, TILE_SIZE, seed, () => false);

    const foliageMat = this.material(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }));
    const trunkMat = this.material(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
    const pebbleMat = this.material(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));

    const trunkGeom = this.geometry(new THREE.CylinderGeometry(1.1, 1.5, 6, 5));
    const roundGeom = this.geometry(new THREE.IcosahedronGeometry(7.5, 1));
    roundGeom.scale(1, 0.85, 1);
    const pineLowGeom = this.geometry(new THREE.ConeGeometry(6.8, 10, 7));
    const pineHighGeom = this.geometry(new THREE.ConeGeometry(4.8, 8, 7));
    const bushGeom = this.geometry(new THREE.IcosahedronGeometry(4.6, 1));
    const pebbleGeom = this.geometry(new THREE.DodecahedronGeometry(2.6, 0));
    pebbleGeom.scale(1, 0.55, 1);

    const trees = [SceneryKind.RoundTree, SceneryKind.Pine] as const;
    const add = (
      geometry: THREE.BufferGeometry, material: THREE.Material, kinds: readonly SceneryKind[],
      offsetY: number, color: Part['color'],
    ): void => {
      const capacity = Math.max(1, this.countOf(kinds));
      const mesh = createMesh(geometry, material, capacity);
      this.group.add(mesh);
      this.parts.push({ mesh, capacity, geometry, material, kinds, offsetY, color });
    };

    add(trunkGeom, trunkMat, trees, 3, TRUNK_COLOR);
    add(roundGeom, foliageMat, [SceneryKind.RoundTree], 11, 'foliage');
    add(pineLowGeom, foliageMat, [SceneryKind.Pine], 9, 'foliage');
    add(pineHighGeom, foliageMat, [SceneryKind.Pine], 14.5, 'foliage');
    add(bushGeom, foliageMat, [SceneryKind.Bush], 2.5, 'foliage');
    add(pebbleGeom, pebbleMat, [SceneryKind.Pebble], 0.8, PEBBLE_COLOR);

    this.group.name = 'scenery';
    scene.add(this.group);
  }

  setFoliageColor(color: string): void {
    this.foliage.set(color);
    this.writeInstances();
  }

  /**
   * Replan for a new forest. Nothing shows until the next {@link refresh}, which the caller
   * owes: the old visible set belongs to the old plan.
   */
  setForest(isForest: (gx: number, gy: number) => boolean): void {
    this.items = planScenery(GRID_COLS, GRID_ROWS, TILE_SIZE, this.seed, isForest);
    this.visible = [];
    for (const part of this.parts) {
      const needed = this.countOf(part.kinds);
      if (needed <= part.capacity) continue;
      // Doubling, so painting a forest out stroke by stroke reallocates a handful of times
      // rather than on every stroke.
      const capacity = Math.max(needed, part.capacity * 2);
      this.group.remove(part.mesh);
      part.mesh.dispose();
      part.mesh = createMesh(part.geometry, part.material, capacity);
      part.capacity = capacity;
      this.group.add(part.mesh);
    }
    this.writeInstances();
  }

  /** Hide everything standing on a cell for which `isFree` is false. */
  refresh(isFree: (gx: number, gy: number) => boolean): void {
    this.visible = visibleScenery(this.items, isFree);
    this.writeInstances();
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const part of this.parts) part.mesh.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private writeInstances(): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };
    this.foliage.getHSL(hsl);

    for (const part of this.parts) {
      let n = 0;
      for (const item of this.visible) {
        if (!part.kinds.includes(item.kind)) continue;
        quaternion.setFromAxisAngle(up, item.rotation);
        position.set(item.x, part.offsetY * item.scale, item.z);
        scale.setScalar(item.scale);
        matrix.compose(position, quaternion, scale);
        part.mesh.setMatrixAt(n, matrix);

        if (part.color === 'foliage') {
          const shift = item.kind === SceneryKind.Pine ? PINE_SHIFT
            : item.kind === SceneryKind.Bush ? BUSH_SHIFT : null;
          color.setHSL(
            hsl.h + (shift?.h ?? 0),
            clamp01(hsl.s + (shift?.s ?? 0)),
            clamp01(hsl.l + (shift?.l ?? 0) + item.tint * TINT_LIGHTNESS),
          );
        } else {
          color.set(part.color);
          color.offsetHSL(0, 0, item.tint * TINT_LIGHTNESS * 0.5);
        }
        part.mesh.setColorAt(n, color);
        n++;
      }
      part.mesh.count = n;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  private countOf(kinds: readonly SceneryKind[]): number {
    let n = 0;
    for (const item of this.items) if (kinds.includes(item.kind)) n++;
    return n;
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private material<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}

function createMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  // Allocated up front, not left to the first `setColorAt`: whether a program reads
  // instance colours is fixed when it compiles, and a part that starts with no visible
  // items would otherwise compile without them and draw every later instance black.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  // Instances span the whole map; the default bounding sphere is the geometry's own,
  // which would cull every tree the moment the origin leaves the frustum.
  mesh.frustumCulled = false;
  return mesh;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
