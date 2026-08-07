import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { MountainTriangles } from '../../maps/types';
import { TILE_SIZE, MOUNTAIN_COLOR, GROUND_Y_POSITION } from '../../constants';
import { lerp } from '../../utils/math';
import {
  findClusters,
  collectBoundarySegments,
  chainSegments,
  roughSmooth,
  insetLoop,
  makeShape,
  makePath,
  getTerraceCount,
} from './terrainContourUtils';

const LAYER_HEIGHT = 12;
const SHORELINE_WIDTH = TILE_SIZE * 0.15;

const defaultBaseColor = new THREE.Color(MOUNTAIN_COLOR);

export class ObstacleLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(scene: THREE.Scene, mountainCells: GridPos[], mountainColor?: string, mountainTriangles?: MountainTriangles, mountainShorelineColor?: string): void {
    this.dispose(scene);
    if (mountainCells.length === 0) return;

    const baseColor = mountainColor ? new THREE.Color(mountainColor) : defaultBaseColor;

    this.group = new THREE.Group();

    const cellSet = new Set(mountainCells.map(p => `${p.gx},${p.gy}`));
    const clusters = findClusters(mountainCells);

    for (const cluster of clusters) {
      // Cluster seed for unique noise offset
      let minGx = Infinity, minGy = Infinity;
      for (const c of cluster) {
        if (c.gx < minGx) minGx = c.gx;
        if (c.gy < minGy) minGy = c.gy;
      }
      const seed = minGx * 73 + minGy * 137;

      const segments = collectBoundarySegments(cluster, cellSet, mountainTriangles);
      const loops = chainSegments(segments);
      if (loops.length === 0) continue;

      // Use the longest loop as the outer boundary
      loops.sort((a, b) => b.length - a.length);
      const smoothed = roughSmooth(loops[0], seed);
      if (smoothed.length < 3) continue;

      const numTerraces = getTerraceCount(cluster.length);
      this.buildTerraces(smoothed, baseColor, numTerraces, mountainShorelineColor);
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
        color: shorelineColor ? new THREE.Color(shorelineColor) : baseColor.clone().multiplyScalar(0.85),
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
      const isTop = t === numTerraces - 1;

      // Lighten toward peak: blend base → white (up to 35%)
      const colorT = numTerraces > 1 ? t / (numTerraces - 1) : 0;
      const lighten = colorT * 0.35;
      const color = new THREE.Color(
        lerp(baseColor.r, 1, lighten),
        lerp(baseColor.g, 1, lighten),
        lerp(baseColor.b, 1, lighten),
      );

      const mat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.6,
        metalness: 0.0,
        sheen: 0.15,
        sheenRoughness: 0.8,
        sheenColor: new THREE.Color(0xccbbaa),
        clearcoat: 0.3,
        clearcoatRoughness: 0.4,
        side: THREE.DoubleSide,
      });
      this.materials.push(mat);

      // Build shape from outer points
      const shape = makeShape(outerPts);

      // Punch a hole for the next terrace (unless this is the top)
      if (!isTop) {
        shape.holes.push(makePath(innerPts));
      }

      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: LAYER_HEIGHT,
        bevelEnabled: false,
      });

      // Shape is in XY plane, extrusion along +Z.
      // Rotate so shape lies in XZ plane, extrusion goes along -Y (upward after flip).
      geom.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(geom, mat);
      // Position so bottom face is at GROUND_Y_POSITION, stepping up per terrace
      mesh.position.y = GROUND_Y_POSITION + (t + 1) * LAYER_HEIGHT;
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
