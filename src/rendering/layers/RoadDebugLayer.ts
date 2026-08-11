import * as THREE from 'three';
import type { Grid } from '../../core/Grid';
import type { Car } from '../../entities/Car';
import { CellType } from '../../types';
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../../constants';
import type { TrafficAdapter } from '../../systems/car/TrafficAdapter';

const OUTLINE_Y = 0.6;

export class RoadDebugLayer {
  private group: THREE.Group | null = null;
  private greenMat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
  private redMat = new THREE.LineBasicMaterial({ color: 0xff0000 });
  private edgesGeom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE));

  // Parking debug materials
  private cyanMat = new THREE.LineBasicMaterial({ color: 0x00ffff });
  private magentaMat = new THREE.LineBasicMaterial({ color: 0xff00ff });
  private yellowMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  private dotGeom = new THREE.SphereGeometry(1.5, 8, 6);

  /**
   * Outline every road and connector cell, red where some car still depends on it.
   *
   * "Depends" is {@link TrafficAdapter.cellsCarDependsOn} — the same query
   * `Game.handleTryErase` asks before it removes a cell — so what draws red here is exactly
   * what the game would refuse to delete outright. Asking the deletion rule rather than
   * restating it is the point: an overlay that disagreed with the rule it exists to show
   * would be worse than no overlay.
   *
   * It used to reproduce the three `car.path`/`car.pathIndex`/`car.outboundPath` loops that
   * `Game.tryRemoveRoad` had. Nothing has written those fields since the simulation took
   * over movement, so the set was permanently empty and every cell drew green.
   *
   * `adapter` is null for a `Renderer` with no simulation behind it — the map designer —
   * where there are no cars to depend on anything and only the outlines are wanted.
   */
  update(scene: THREE.Scene, grid: Grid, cars: Car[], adapter: TrafficAdapter | null): void {
    this.clearFromScene(scene);

    // The cells cars still depend on, straight from the simulation.
    const reserved = new Set<string>();

    if (adapter) {
      for (const car of cars) {
        for (const cell of adapter.cellsCarDependsOn(car)) {
          reserved.add(`${cell.gx},${cell.gy}`);
        }
      }
    }

    const group = new THREE.Group();
    const half = TILE_SIZE / 2;

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const cell = grid.getCell(gx, gy);
        if (!cell || (cell.type !== CellType.Road && cell.type !== CellType.Connector)) continue;

        const mat = reserved.has(`${gx},${gy}`) ? this.redMat : this.greenMat;
        const outline = new THREE.LineSegments(this.edgesGeom, mat);
        outline.rotation.x = -Math.PI / 2;
        outline.position.set(gx * TILE_SIZE + half, OUTLINE_Y, gy * TILE_SIZE + half);
        group.add(outline);
      }
    }

    this.group = group;
    scene.add(group);
  }

  private clearFromScene(scene: THREE.Scene): void {
    if (this.group) {
      scene.remove(this.group);
      this.group = null;
    }
  }

  dispose(scene: THREE.Scene): void {
    this.clearFromScene(scene);
    this.greenMat.dispose();
    this.redMat.dispose();
    this.edgesGeom.dispose();
    this.cyanMat.dispose();
    this.magentaMat.dispose();
    this.yellowMat.dispose();
    this.dotGeom.dispose();
  }
}
