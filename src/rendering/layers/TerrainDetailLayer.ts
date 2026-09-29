import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { LakeTriangles, MountainTriangles } from '../../maps/types';
import { FOLIAGE_COLOR, GROUND_Y_POSITION, LAKE_COLOR } from '../../constants';
import type { NestedPolygon } from '../../terrain';
import { buildTerrainContours } from '../../terrain';
import { makeShape } from './terrainMesh';
import {
  LakeDecorKind, MountainDecorKind, planLakeDecor, planMountainDecor, type DecorItem,
} from './terrainDecor';

/** Must match `ObstacleLayer`'s step: a mountain terrace's top is `(level + 1)` of these up. */
const MOUNTAIN_STEP = 12;

/**
 * Height of the water surface above the lake's top terrace.
 *
 * `LakeLayer` puts its top terrace exactly at `GROUND_Y_POSITION`; the surface floats just
 * above it. That top terrace then reads as the bright shallows seen through a thin film,
 * and each deeper terrace sits a full step further under the same surface — so depth comes
 * out of geometry that already exists, without moving the lakebed.
 */
const WATER_LIFT = 0.35;
const WATER_Y = GROUND_Y_POSITION + WATER_LIFT;

const SHALLOW_OPACITY = 0.3;
const DEEP_OPACITY = 0.62;

/**
 * Detail on top of the terrain layers: the water surface, and the pines,
 * boulders, reeds, lily pads and rocks that sit on mountains and in lakes.
 *
 * Kept apart from `ObstacleLayer` and `LakeLayer`, which own the landform geometry and whose
 * tests pin it exactly; nothing here changes a vertex of theirs. The contours are traced
 * again rather than shared, which costs a few milliseconds per rebuild.
 *
 * Placement is `terrainDecor.ts`, which is pure; this file only turns it into meshes.
 */
export class TerrainDetailLayer {
  private group: THREE.Group | null = null;
  private disposables: { dispose(): void }[] = [];
  build(
    scene: THREE.Scene,
    mountainCells: GridPos[],
    mountainTriangles: MountainTriangles | undefined,
    lakeCells: GridPos[],
    lakeTriangles: LakeTriangles | undefined,
    foliageColor = FOLIAGE_COLOR,
    waterColor = LAKE_COLOR,
  ): void {
    this.dispose(scene);
    this.group = new THREE.Group();
    this.group.name = 'terrain-detail';
    const foliage = new THREE.Color(foliageColor);

    const mountains = mountainCells.length > 0 ? buildTerrainContours(mountainCells, mountainTriangles) : null;
    if (mountains) this.addMountainDecor(planMountainDecor(mountains.field, mountains.levels.length), foliage);

    const lakes = lakeCells.length > 0 ? buildTerrainContours(lakeCells, lakeTriangles) : null;
    if (lakes) {
      const water = new THREE.Color(waterColor);
      this.addWaterSurface(lakes.levels[0].polygons, lakes.levels[1]?.polygons ?? [], water);
      this.addLakeDecor(planLakeDecor(lakes.field), foliage);
    }

    scene.add(this.group);
  }

  dispose(scene: THREE.Scene): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (!this.group) return;
    scene.remove(this.group);
    this.group = null;
  }

  // ---------------------------------------------------------------- water

  /**
   * Two sheets: the shallow band between the shore and the second contour, and everything
   * inside that. The band is paler and thinner, which is the shallow-water rim; a one-terrace
   * lake is all band.
   */
  private addWaterSurface(footprint: NestedPolygon[], deep: NestedPolygon[], water: THREE.Color): void {
    const shallowColor = water.clone().lerp(new THREE.Color(0xe8fbff), 0.45);
    const shallowMat = this.waterMaterial(shallowColor, SHALLOW_OPACITY);
    const deepMat = this.waterMaterial(water.clone().offsetHSL(0, 0.12, -0.12), DEEP_OPACITY);

    for (const polygon of footprint) {
      this.addSheet(makeShape(polygon.outer, polygon.holes), shallowMat, 0);
    }
    // The deep sheet sits a hair above the shallow one rather than being cut out of it, so
    // the two overlap by design and never leave a seam between them.
    for (const polygon of deep) {
      this.addSheet(makeShape(polygon.outer, polygon.holes), deepMat, 0.05);
    }
  }

  private addSheet(shape: THREE.Shape, material: THREE.Material, lift: number): void {
    const geometry = this.track(new THREE.ShapeGeometry(shape));
    // Shapes are traced in world XY; laying them flat maps Y onto +Z.
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = WATER_Y + lift;
    mesh.receiveShadow = true;
    mesh.name = 'water-surface';
    this.group!.add(mesh);
  }

  /**
   * A still, glassy sheet.
   *
   * Deliberately static. Animated ripple glints were tried and removed: animating anything
   * forces the renderer to redraw every frame, bypassing its render-only-when-dirty skip,
   * and the CPU cost of that was not worth a decorative effect.
   */
  private waterMaterial(color: THREE.Color, opacity: number): THREE.MeshStandardMaterial {
    const mat = this.track(new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity,
      roughness: 0.12,
      metalness: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    return mat;
  }

  // ---------------------------------------------------------------- decor

  private addMountainDecor(items: DecorItem<MountainDecorKind>[], foliage: THREE.Color): void {
    const pines = items.filter(i => i.kind === MountainDecorKind.Pine);
    const boulders = items.filter(i => i.kind === MountainDecorKind.Boulder);
    const groundOf = (i: DecorItem<MountainDecorKind>): number => GROUND_Y_POSITION + (i.level + 1) * MOUNTAIN_STEP;

    const pineColor = foliage.clone().offsetHSL(0.03, -0.05, -0.1);
    const lowCone = new THREE.ConeGeometry(6.8, 10, 7);
    lowCone.translate(0, 9, 0);
    const highCone = new THREE.ConeGeometry(4.8, 8, 7);
    highCone.translate(0, 14.5, 0);
    const trunk = new THREE.CylinderGeometry(1.1, 1.5, 6, 5);
    trunk.translate(0, 3, 0);
    const foliageMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }));
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
    this.instanced(lowCone, foliageMat, pines, groundOf, pineColor, 0.07);
    this.instanced(highCone, foliageMat, pines, groundOf, pineColor, 0.07);
    this.instanced(trunk, trunkMat, pines, groundOf, new THREE.Color(0x8a6a4f), 0.03);

    const boulder = new THREE.DodecahedronGeometry(3.2, 0);
    boulder.scale(1, 0.7, 1);
    boulder.translate(0, 1.2, 0);
    const rockMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
    this.instanced(boulder, rockMat, boulders, groundOf, new THREE.Color(0x8c8577), 0.05);
  }

  private addLakeDecor(items: DecorItem<LakeDecorKind>[], foliage: THREE.Color): void {
    const reeds = items.filter(i => i.kind === LakeDecorKind.Reed);
    const pads = items.filter(i => i.kind === LakeDecorKind.LilyPad);
    const rocks = items.filter(i => i.kind === LakeDecorKind.Rock);
    const bed = (): number => GROUND_Y_POSITION - 1;
    const surface = (): number => WATER_Y + 0.12;

    // A reed is three blades leaning apart, merged into one geometry.
    const blades = [-0.35, 0, 0.4].map((lean, k) => {
      const blade = new THREE.ConeGeometry(0.85, 8 + k * 1.5, 4);
      blade.translate(0, 4 + k * 0.75, 0);
      blade.rotateZ(lean);
      blade.translate(k - 1, 0, (k % 2) * 0.8);
      return blade;
    });
    const reed = mergeGeometries(blades);
    const reedMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }));
    this.instanced(reed, reedMat, reeds, bed, foliage.clone().offsetHSL(-0.04, -0.05, 0.02), 0.06);

    const pad = new THREE.CylinderGeometry(2.6, 2.6, 0.25, 10, 1, false, 0.5, Math.PI * 2 - 1.0);
    const padMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }));
    this.instanced(pad, padMat, pads, surface, foliage.clone().offsetHSL(0, 0.05, 0.03), 0.07);

    const flowers = pads.filter(p => p.tint > 0.55);
    const flower = new THREE.IcosahedronGeometry(0.9, 0);
    flower.translate(0.8, 0.5, 0.4);
    const flowerMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.5 }));
    this.instanced(flower, flowerMat, flowers, surface, new THREE.Color(0xf4a7c0), 0.05);

    const rock = new THREE.DodecahedronGeometry(2.4, 0);
    rock.scale(1, 0.6, 1);
    const rockMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
    this.instanced(rock, rockMat, rocks, () => WATER_Y, new THREE.Color(0x9a9384), 0.05);
  }

  private instanced<K>(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    items: DecorItem<K>[],
    baseY: (item: DecorItem<K>) => number,
    color: THREE.Color,
    tintRange: number,
  ): void {
    this.track(geometry);
    if (items.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    items.forEach((item, n) => {
      q.setFromAxisAngle(up, item.rotation);
      matrix.compose(
        new THREE.Vector3(item.x, baseY(item), item.z),
        q,
        new THREE.Vector3(item.scale, item.scale, item.scale),
      );
      mesh.setMatrixAt(n, matrix);
      mesh.setColorAt(n, c.copy(color).offsetHSL(0, 0, item.tint * tintRange));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group!.add(mesh);
    this.disposables.push(mesh);
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }
}

/** Concatenate non-indexed copies of `parts` into one geometry (position and normal only). */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part;
    positions.push(...(g.getAttribute('position').array as Float32Array));
    normals.push(...(g.getAttribute('normal').array as Float32Array));
    if (g !== part) g.dispose();
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}
