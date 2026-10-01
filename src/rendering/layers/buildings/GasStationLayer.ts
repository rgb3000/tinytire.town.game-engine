import * as THREE from 'three';
import type { GasStation } from '../../../entities/GasStation';
import {
  roundedRectShape,
  createPlateMat,
  addGroundPlate,
  disposeGroup,
  extrudeFlat,
  PLATE_EXTRUDE_OPTIONS,
} from './buildingRenderUtils';
import { computeGroundPlate } from '../../../utils/buildingLayout';

/** Top of the ground plate, where everything standing on it starts. */
const PLATE_TOP = 0.01 + PLATE_EXTRUDE_OPTIONS.depth + PLATE_EXTRUDE_OPTIONS.bevelThickness;

// Canopy: a flat roof over the middle of the tile, pulled back towards the top edge so the
// pumps standing in front of it show from above. Offsets are from the tile centre, in px.
const CANOPY_W = 26;
const CANOPY_D = 18;
const CANOPY_OFFSET_Z = -3;
const CANOPY_BOTTOM = 10;
const CANOPY_THICKNESS = 3.4;
const CANOPY_TOP = CANOPY_BOTTOM + CANOPY_THICKNESS;
const FASCIA = 2;
const ROOF_THICKNESS = 0.5;

const DROP_SIZE = 8;

const PUMP_X = 6;
const PUMP_Z = 7.5;
const PUMP_HEIGHT = 5;

export class GasStationLayer {
  private gasStationMeshes = new Map<string, THREE.Group>();
  private plateGeomCache = new Map<string, THREE.ExtrudeGeometry>();

  private plateMat: THREE.MeshStandardMaterial;
  private plateNoiseTexture: THREE.CanvasTexture;
  private sharedResources = new Set<THREE.Material | THREE.BufferGeometry>();

  private brandMat: THREE.MeshStandardMaterial;
  private roofMat: THREE.MeshStandardMaterial;
  private pumpMat: THREE.MeshStandardMaterial;
  private columnMat: THREE.MeshStandardMaterial;
  private curbMat: THREE.MeshStandardMaterial;

  private fasciaGeom: THREE.ExtrudeGeometry;
  private roofGeom: THREE.ExtrudeGeometry;
  private dropGeom: THREE.ExtrudeGeometry;
  private columnGeom: THREE.BoxGeometry;
  private islandGeom: THREE.ExtrudeGeometry;
  private pumpGeom: THREE.ExtrudeGeometry;
  private pumpDisplayGeom: THREE.BoxGeometry;
  private pylonPostGeom: THREE.BoxGeometry;
  private pylonBoardGeom: THREE.BoxGeometry;
  private pylonCapGeom: THREE.BoxGeometry;
  private pylonStripeGeom: THREE.BoxGeometry;

  constructor() {
    const { mat, tex } = createPlateMat();
    this.plateMat = mat;
    this.plateNoiseTexture = tex;

    // Glossy, like the houses and businesses, so the station reads as one of the buildings.
    this.brandMat = glossy('#2EAA8A');
    this.pumpMat = glossy('#E85D4A');
    // Lifted a little above the plate's white, which it would otherwise sit right on top of.
    this.roofMat = new THREE.MeshStandardMaterial({
      color: '#FFFFFF', roughness: 0.3, emissive: '#FFFFFF', emissiveIntensity: 0.12,
    });
    this.columnMat = new THREE.MeshStandardMaterial({ color: '#D8D6D0', roughness: 0.7 });
    this.curbMat = new THREE.MeshStandardMaterial({ color: '#C9C4B8', roughness: 0.9 });

    // Fascia: the teal band is the slab itself; a white roof sits on it, inset by FASCIA.
    this.fasciaGeom = extrudeFlat(roundedRectShape(CANOPY_W, CANOPY_D, 3), CANOPY_THICKNESS, 0.8);
    this.roofGeom = extrudeFlat(
      roundedRectShape(CANOPY_W - 2 * FASCIA, CANOPY_D - 2 * FASCIA, 2), ROOF_THICKNESS, 0.2,
    );
    this.dropGeom = extrudeFlat(fuelDropShape(DROP_SIZE), 0.6, 0.2);
    // The shape's origin is the centre of its round end; move the drop's middle onto it.
    this.dropGeom.translate(0, 0, (DROP_SIZE - 2 * DROP_SIZE * 0.32) / 2);

    this.columnGeom = new THREE.BoxGeometry(2, CANOPY_BOTTOM - PLATE_TOP, 2);
    this.islandGeom = extrudeFlat(roundedRectShape(5, 3.8, 1.2), 0.7, 0.15);
    this.pumpGeom = extrudeFlat(roundedRectShape(3.6, 2.8, 0.8), PUMP_HEIGHT, 0.4);
    this.pumpDisplayGeom = new THREE.BoxGeometry(2.4, 1.4, 0.3);

    this.pylonPostGeom = new THREE.BoxGeometry(0.9, 9, 0.9);
    this.pylonBoardGeom = new THREE.BoxGeometry(4.6, 5.2, 1.0);
    this.pylonCapGeom = new THREE.BoxGeometry(5.2, 0.8, 1.6);
    this.pylonStripeGeom = new THREE.BoxGeometry(3.6, 1.0, 0.2);

    for (const r of [
      this.plateMat, this.brandMat, this.roofMat, this.pumpMat, this.columnMat, this.curbMat,
      this.fasciaGeom, this.roofGeom, this.dropGeom, this.columnGeom, this.islandGeom,
      this.pumpGeom, this.pumpDisplayGeom, this.pylonPostGeom, this.pylonBoardGeom,
      this.pylonCapGeom, this.pylonStripeGeom,
    ]) this.sharedResources.add(r);
  }

  setPlateColor(color: string): void {
    this.plateMat.color.set(color);
  }

  /** Returns whether a station — every part of which casts a shadow — was added or removed. */
  update(scene: THREE.Scene, gasStations: GasStation[]): boolean {
    let shadowsChanged = false;
    const gsIds = new Set(gasStations.map(gs => gs.id));
    for (const [id, group] of this.gasStationMeshes) {
      if (!gsIds.has(id)) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
        this.gasStationMeshes.delete(id);
        shadowsChanged = true;
      }
    }
    for (const gs of gasStations) {
      if (!this.gasStationMeshes.has(gs.id)) {
        const group = this.createGasStationMesh(gs);
        scene.add(group);
        this.gasStationMeshes.set(gs.id, group);
        shadowsChanged = true;
      }
    }
    return shadowsChanged;
  }

  private createGasStationMesh(gs: GasStation): THREE.Group {
    const group = new THREE.Group();

    const groundPlate = computeGroundPlate([gs.pos]);
    addGroundPlate(group, groundPlate, this.plateMat, this.plateGeomCache);

    // Everything else is built around the tile centre, then moved there in one go.
    const station = new THREE.Group();
    station.position.set(groundPlate.centerX, 0, groundPlate.centerZ);
    group.add(station);

    const add = (geom: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      station.add(mesh);
      return mesh;
    };

    // Pumps on their islands, standing in front of the canopy's leading edge with a lane
    // left clear between them for a car coming in from below.
    const islandTop = PLATE_TOP + 0.7;
    for (const sign of [-1, 1]) {
      add(this.islandGeom, this.curbMat, sign * PUMP_X, PLATE_TOP, PUMP_Z);
      add(this.pumpGeom, this.pumpMat, sign * PUMP_X, islandTop, PUMP_Z);
      add(this.pumpDisplayGeom, this.roofMat, sign * PUMP_X, islandTop + PUMP_HEIGHT - 1.4, PUMP_Z + 1.5);
    }

    // Columns carrying the canopy, one either side of the pumps.
    const columnY = PLATE_TOP + (CANOPY_BOTTOM - PLATE_TOP) / 2;
    for (const sign of [-1, 1]) {
      add(this.columnGeom, this.columnMat, sign * 10.5, columnY, PUMP_Z - 2.5);
    }

    // Canopy: teal slab, white roof on top, and the fuel drop on the roof.
    add(this.fasciaGeom, this.brandMat, 0, CANOPY_BOTTOM, CANOPY_OFFSET_Z);
    add(this.roofGeom, this.roofMat, 0, CANOPY_TOP, CANOPY_OFFSET_Z);
    add(this.dropGeom, this.brandMat, 0, CANOPY_TOP + ROOF_THICKNESS, CANOPY_OFFSET_Z);

    // Price pylon in the bottom-right corner.
    const px = 10.5, pz = 11;
    add(this.pylonPostGeom, this.columnMat, px, PLATE_TOP + 4.5, pz);
    add(this.pylonBoardGeom, this.roofMat, px, PLATE_TOP + 9.6, pz);
    add(this.pylonCapGeom, this.brandMat, px, PLATE_TOP + 12.6, pz);
    add(this.pylonStripeGeom, this.brandMat, px, PLATE_TOP + 10.6, pz + 0.55);
    add(this.pylonStripeGeom, this.pumpMat, px, PLATE_TOP + 8.6, pz + 0.55);

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
    for (const r of this.sharedResources) r.dispose();
    this.sharedResources.clear();
    this.plateNoiseTexture.dispose();
  }
}

function glossy(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, metalness: 0.2, roughness: 0.15, emissive: color, emissiveIntensity: 0.15,
  });
}

/** A fuel drop, point towards the top of the screen, `size` px tall. */
function fuelDropShape(size: number): THREE.Shape {
  const r = size * 0.32;
  const tip = size - r;
  const shape = new THREE.Shape();
  shape.moveTo(0, tip);
  shape.bezierCurveTo(r * 0.35, tip * 0.6, r, r * 0.6, r, 0);
  shape.absarc(0, 0, r, 0, Math.PI, true);
  shape.bezierCurveTo(-r, r * 0.6, -r * 0.35, tip * 0.6, 0, tip);
  return shape;
}
