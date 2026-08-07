import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { TILE_SIZE, GROUND_Y_POSITION, LAKE_COLOR, LAKE_SHORE_COLOR } from '../../constants';
import { lerp } from '../../utils/math';
import {
  findClusters,
  collectBoundarySegments,
  chainSegments,
  chaikinSmooth,
  insetLoop,
  makeShape,
  makePath,
  getTerraceCount,
} from './terrainContourUtils';

const LAKE_LAYER_HEIGHT = 4;
const SHORELINE_WIDTH = TILE_SIZE * 0.15;

export class LakeLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(scene: THREE.Scene, lakeCells: GridPos[], lakeTriangles?: LakeTriangles, waterColor?: string, shorelineColor?: string): void {
    this.dispose(scene);
    if (lakeCells.length === 0) return;

    const baseColor = waterColor ? new THREE.Color(waterColor) : new THREE.Color(LAKE_COLOR);
    this.group = new THREE.Group();

    const lakeSet = new Set(lakeCells.map(p => `${p.gx},${p.gy}`));
    const clusters = findClusters(lakeCells);

    for (const cluster of clusters) {
      const segments = collectBoundarySegments(cluster, lakeSet, lakeTriangles);
      const loops = chainSegments(segments);
      if (loops.length === 0) continue;

      // Use the longest loop as the outer boundary
      loops.sort((a, b) => b.length - a.length);
      const smoothed = chaikinSmooth(loops[0], 3);
      if (smoothed.length < 3) continue;

      const numTerraces = getTerraceCount(cluster.length);
      this.buildTerraces(smoothed, baseColor, numTerraces, shorelineColor);
    }

    scene.add(this.group);
  }

  private buildTerraces(outerLoop: number[][], baseColor: THREE.Color, numTerraces: number, shorelineColor?: string): void {
    // Shoreline ring: outset the outer loop and punch a hole with the original
    const shorelineLoop = insetLoop(outerLoop, -SHORELINE_WIDTH);
    if (shorelineLoop.length >= 3) {
      const shoreShape = makeShape(shorelineLoop);
      shoreShape.holes.push(makePath(outerLoop));

      const shoreMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(shorelineColor ?? LAKE_SHORE_COLOR),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this.materials.push(shoreMat);

      const shoreGeom = new THREE.ExtrudeGeometry(shoreShape, {
        depth: 0.1,
        bevelEnabled: false,
      });
      shoreGeom.rotateX(Math.PI / 2);

      const shoreMesh = new THREE.Mesh(shoreGeom, shoreMat);
      shoreMesh.position.y = GROUND_Y_POSITION;
      shoreMesh.receiveShadow = true;
      this.group!.add(shoreMesh);
    }

    // Create concentric inset shapes (each level insets further toward centroid)
    const INSET_PER_LEVEL = TILE_SIZE * 0.2;
    const levels: number[][][] = [outerLoop];
    for (let i = 1; i <= numTerraces; i++) {
      levels.push(insetLoop(outerLoop, i * INSET_PER_LEVEL));
    }

    for (let t = 0; t < numTerraces; t++) {
      const outerPts = levels[t];
      const innerPts = levels[t + 1];
      const isDeepest = t === numTerraces - 1;

      // Color darkens with depth
      const darken = (numTerraces > 1 ? t / (numTerraces - 1) : 0) * 0.55;
      const color = new THREE.Color(
        lerp(baseColor.r, 0, darken),
        lerp(baseColor.g, 0, darken),
        lerp(baseColor.b, 0, darken),
      );

      const mat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.25,
        metalness: 0.05,
        clearcoat: 0.4,
        clearcoatRoughness: 0.3,
        side: THREE.DoubleSide,
      });
      this.materials.push(mat);

      // Build shape from outer points
      const shape = makeShape(outerPts);

      // Punch a hole for the next terrace (unless this is the deepest)
      if (!isDeepest) {
        shape.holes.push(makePath(innerPts));
      }

      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: LAKE_LAYER_HEIGHT,
        bevelEnabled: false,
      });

      // Shape is in XY plane, extrusion along +Z.
      // Rotate so shape lies in XZ plane, extrusion goes along -Y (downward).
      geom.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(geom, mat);
      // Position so top face is at GROUND_Y_POSITION, stepping down per terrace
      mesh.position.y = GROUND_Y_POSITION - t * LAKE_LAYER_HEIGHT;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      this.group!.add(mesh);
    }
  }


  dispose(scene: THREE.Scene): void {
    if (!this.group) return;
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    scene.remove(this.group);
    this.group = null;
  }

  disposeAll(scene: THREE.Scene): void {
    this.dispose(scene);
    for (const mat of this.materials) mat.dispose();
    this.materials = [];
  }
}
