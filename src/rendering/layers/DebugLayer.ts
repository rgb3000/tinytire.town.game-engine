import * as THREE from 'three';
import { TILE_SIZE } from '../../constants';

export class DebugLayer {
  private line: THREE.LineSegments | null = null;

  update(
    scene: THREE.Scene,
    bounds: { minX: number; maxX: number; minY: number; maxY: number } | null,
  ): void {
    // Remove old line
    if (this.line) {
      scene.remove(this.line);
      this.line.geometry.dispose();
      (this.line.material as THREE.Material).dispose();
      this.line = null;
    }

    if (!bounds) return;

    const x0 = bounds.minX * TILE_SIZE;
    const x1 = (bounds.maxX + 1) * TILE_SIZE;
    const z0 = bounds.minY * TILE_SIZE;
    const z1 = (bounds.maxY + 1) * TILE_SIZE;
    const y = 2;

    // Rectangle as 4 line segments
    const vertices = new Float32Array([
      x0, y, z0, x1, y, z0,
      x1, y, z0, x1, y, z1,
      x1, y, z1, x0, y, z1,
      x0, y, z1, x0, y, z0,
    ]);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const material = new THREE.LineDashedMaterial({
      color: 0xff0000,
      dashSize: 20,
      gapSize: 10,
    });

    this.line = new THREE.LineSegments(geometry, material);
    this.line.computeLineDistances();
    scene.add(this.line);
  }

  dispose(scene: THREE.Scene): void {
    if (this.line) {
      scene.remove(this.line);
      this.line.geometry.dispose();
      (this.line.material as THREE.Material).dispose();
      this.line = null;
    }
  }
}
