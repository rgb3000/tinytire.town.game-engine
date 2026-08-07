import * as THREE from 'three';
import type { GasStation } from '../../../entities/GasStation';
import { TILE_SIZE } from '../../../constants';
import {
  createPlateMat,
  addGroundPlate,
  disposeGroup,
} from './buildingRenderUtils';
import { computeGroundPlate } from '../../../utils/buildingLayout';

export class GasStationLayer {
  private gasStationMeshes = new Map<string, THREE.Group>();
  private plateGeomCache = new Map<string, THREE.ExtrudeGeometry>();

  private plateMat: THREE.MeshStandardMaterial;
  private plateNoiseTexture: THREE.CanvasTexture;
  private gasStationCanopyMat: THREE.MeshStandardMaterial;
  private gasStationPillarMat: THREE.MeshStandardMaterial;
  private sharedResources = new Set<THREE.Material | THREE.BufferGeometry>();

  constructor() {
    const { mat, tex } = createPlateMat();
    this.plateMat = mat;
    this.plateNoiseTexture = tex;
    this.gasStationCanopyMat = new THREE.MeshStandardMaterial({ color: '#2EAA8A', roughness: 0.4 });
    this.gasStationPillarMat = new THREE.MeshStandardMaterial({ color: '#666666' });

    this.sharedResources.add(this.plateMat);
    this.sharedResources.add(this.gasStationCanopyMat);
    this.sharedResources.add(this.gasStationPillarMat);
  }

  setPlateColor(color: string): void {
    this.plateMat.color.set(color);
  }

  update(scene: THREE.Scene, gasStations: GasStation[]): void {
    const gsIds = new Set(gasStations.map(gs => gs.id));
    for (const [id, group] of this.gasStationMeshes) {
      if (!gsIds.has(id)) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
        this.gasStationMeshes.delete(id);
      }
    }
    for (const gs of gasStations) {
      if (!this.gasStationMeshes.has(gs.id)) {
        const group = this.createGasStationMesh(gs);
        scene.add(group);
        this.gasStationMeshes.set(gs.id, group);
      }
    }
  }

  private createGasStationMesh(gs: GasStation): THREE.Group {
    const group = new THREE.Group();

    // Single-tile ground plate
    const groundPlate = computeGroundPlate([gs.pos]);
    addGroundPlate(group, groundPlate, this.plateMat, this.plateGeomCache);

    // Simple canopy over the single tile
    const cx = gs.pos.gx * TILE_SIZE + TILE_SIZE / 2;
    const cz = gs.pos.gy * TILE_SIZE + TILE_SIZE / 2;
    const canopySize = TILE_SIZE * 0.6;
    const beamThickness = 3;
    const beamHeight = 2;
    const canopyY = 12;

    // Frame beams
    const beamXGeom = new THREE.BoxGeometry(canopySize, beamHeight, beamThickness);
    for (const sign of [-1, 1]) {
      const beam = new THREE.Mesh(beamXGeom, this.gasStationCanopyMat);
      beam.position.set(cx, canopyY, cz + sign * (canopySize / 2 - beamThickness / 2));
      beam.castShadow = true;
      beam.receiveShadow = true;
      group.add(beam);
    }

    const innerZ = canopySize - 2 * beamThickness;
    const beamZGeom = new THREE.BoxGeometry(beamThickness, beamHeight, innerZ);
    for (const sign of [-1, 1]) {
      const beam = new THREE.Mesh(beamZGeom, this.gasStationCanopyMat);
      beam.position.set(cx + sign * (canopySize / 2 - beamThickness / 2), canopyY, cz);
      beam.castShadow = true;
      beam.receiveShadow = true;
      group.add(beam);
    }

    // Corner pillars
    const pillarGeom = new THREE.BoxGeometry(2, canopyY, 2);
    const halfW = canopySize / 2 - 3;
    const halfD = canopySize / 2 - 3;
    for (const [ox, oz] of [[-halfW, -halfD], [halfW, -halfD], [-halfW, halfD], [halfW, halfD]]) {
      const pillar = new THREE.Mesh(pillarGeom, this.gasStationPillarMat);
      pillar.position.set(cx + ox, canopyY / 2, cz + oz);
      pillar.castShadow = true;
      group.add(pillar);
    }

    return group;
  }

  dispose(scene: THREE.Scene): void {
    for (const [, group] of this.gasStationMeshes) {
      scene.remove(group);
      disposeGroup(group, this.sharedResources);
    }
    this.gasStationMeshes.clear();
    for (const geom of this.plateGeomCache.values()) geom.dispose();
    this.plateGeomCache.clear();
    this.plateMat.dispose();
    this.plateNoiseTexture.dispose();
    this.gasStationCanopyMat.dispose();
    this.gasStationPillarMat.dispose();
  }
}
