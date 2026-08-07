import * as THREE from 'three';
import type { House } from '../../../entities/House';
import { type Car, CarState } from '../../../entities/Car';
import { TILE_SIZE, COLOR_MAP, CAR_LENGTH, CAR_WIDTH, LANE_OFFSET, GROUND_PLATE_MARGIN } from '../../../constants';
import { computeGroundPlate } from '../../../utils/buildingLayout';
import {
  roundedRectShape,
  createPlateMat,
  addGroundPlate,
  disposeGroup,
} from './buildingRenderUtils';

export class HouseLayer {
  private houseMeshes = new Map<string, THREE.Group>();
  private parkedCarMeshes = new Map<string, THREE.Group[]>();
  private deliveryBallRefs = new Map<string, { mesh: THREE.InstancedMesh; count: number; capacity: number }>();

  private houseHemisphereRadius: number;
  private housePlateSize: number;
  private houseHemisphereGeom: THREE.SphereGeometry;
  private deliveryBallGeom: THREE.SphereGeometry;
  private parkedCabGeom: THREE.ExtrudeGeometry;
  private parkedBedGeom: THREE.ExtrudeGeometry;
  private parkedBedSideGeom: THREE.BoxGeometry;
  private parkedBedRearGeom: THREE.BoxGeometry;

  private plateMat: THREE.MeshStandardMaterial;
  private plateNoiseTexture: THREE.CanvasTexture;
  private plateGeomCache = new Map<string, THREE.ExtrudeGeometry>();
  private sharedResources = new Set<THREE.Material | THREE.BufferGeometry>();

  private gameColors: Record<number, string> = { ...COLOR_MAP };
  private isDirty = false;

  constructor() {
    const housePlate = computeGroundPlate([{ gx: 0, gy: 0 }]);
    this.housePlateSize = housePlate.width;
    this.houseHemisphereRadius = this.housePlateSize / 2 - GROUND_PLATE_MARGIN;
    this.houseHemisphereGeom = new THREE.SphereGeometry(this.houseHemisphereRadius, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    this.deliveryBallGeom = new THREE.SphereGeometry(5, 16, 12);

    const parkedCabLen = CAR_LENGTH * 0.38;
    const parkedCabShape = roundedRectShape(parkedCabLen, CAR_WIDTH, 1);
    this.parkedCabGeom = new THREE.ExtrudeGeometry(parkedCabShape, { depth: 1.8, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 3 });
    this.parkedCabGeom.rotateX(-Math.PI / 2);

    const parkedBedLen = CAR_LENGTH * 0.52;
    const parkedBedShape = roundedRectShape(parkedBedLen, CAR_WIDTH, 0.8);
    this.parkedBedGeom = new THREE.ExtrudeGeometry(parkedBedShape, { depth: 1.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 1, curveSegments: 3 });
    this.parkedBedGeom.rotateX(-Math.PI / 2);

    this.parkedBedSideGeom = new THREE.BoxGeometry(parkedBedLen * 0.9, 2.0, 0.6);
    this.parkedBedRearGeom = new THREE.BoxGeometry(0.6, 2.0, CAR_WIDTH * 0.75);

    const { mat, tex } = createPlateMat();
    this.plateMat = mat;
    this.plateNoiseTexture = tex;

    this.sharedResources.add(this.plateMat);
    this.sharedResources.add(this.houseHemisphereGeom);
    this.sharedResources.add(this.deliveryBallGeom);
    this.sharedResources.add(this.parkedCabGeom);
    this.sharedResources.add(this.parkedBedGeom);
    this.sharedResources.add(this.parkedBedSideGeom);
    this.sharedResources.add(this.parkedBedRearGeom);
  }

  setPlateColor(color: string): void {
    this.plateMat.color.set(color);
  }

  setGameColors(colors: Record<number, string>): void {
    this.gameColors = { ...colors };
    this.isDirty = true;
  }

  update(scene: THREE.Scene, houses: House[], cars: Car[]): void {
    if (this.isDirty) {
      this.isDirty = false;
      for (const [, group] of this.houseMeshes) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
      }
      this.houseMeshes.clear();
      this.parkedCarMeshes.clear();
      this.deliveryBallRefs.clear();
    }

    // Remove meshes for deleted houses
    const houseIds = new Set(houses.map(h => h.id));
    for (const [id, group] of this.houseMeshes) {
      if (!houseIds.has(id)) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
        this.houseMeshes.delete(id);
        this.parkedCarMeshes.delete(id);
        this.deliveryBallRefs.delete(id);
      }
    }

    for (const house of houses) {
      if (!this.houseMeshes.has(house.id)) {
        const { group, parkedCars } = this.createHouseMesh(house);
        scene.add(group);
        this.houseMeshes.set(house.id, group);
        this.parkedCarMeshes.set(house.id, parkedCars);
      }

      // Update parked car visibility
      const parkedCars = this.parkedCarMeshes.get(house.id);
      if (parkedCars) {
        let idleCount = 0;
        for (const car of cars) {
          if (car.homeHouseId === house.id && car.state === CarState.Idle) idleCount++;
        }
        for (let i = 0; i < parkedCars.length; i++) {
          parkedCars[i].visible = i < idleCount;
        }
      }

      // Delivery balls (InstancedMesh per house)
      const houseGroup = this.houseMeshes.get(house.id)!;
      const ballMat = houseGroup.userData.deliveryBallMat as THREE.MeshStandardMaterial;
      let ballRef = this.deliveryBallRefs.get(house.id);
      if (house.deliveryCount > 0 && !ballRef) {
        const capacity = 32;
        const instMesh = new THREE.InstancedMesh(this.deliveryBallGeom, ballMat, capacity);
        instMesh.count = 0;
        instMesh.castShadow = false;
        houseGroup.add(instMesh);
        ballRef = { mesh: instMesh, count: 0, capacity };
        this.deliveryBallRefs.set(house.id, ballRef);
      }
      if (ballRef && ballRef.count < house.deliveryCount) {
        if (house.deliveryCount > ballRef.capacity) {
          const oldMesh = ballRef.mesh;
          const newCapacity = Math.max(ballRef.capacity * 2, house.deliveryCount);
          const newMesh = new THREE.InstancedMesh(this.deliveryBallGeom, ballMat, newCapacity);
          for (let i = 0; i < ballRef.count; i++) {
            const m = new THREE.Matrix4();
            oldMesh.getMatrixAt(i, m);
            newMesh.setMatrixAt(i, m);
          }
          newMesh.count = ballRef.count;
          newMesh.castShadow = false;
          houseGroup.remove(oldMesh);
          oldMesh.dispose();
          houseGroup.add(newMesh);
          ballRef.mesh = newMesh;
          ballRef.capacity = newCapacity;
        }
        const positions: { x: number; y: number; z: number }[] = [];
        const tmpMatrix = new THREE.Matrix4();
        const tmpPos = new THREE.Vector3();
        for (let i = 0; i < ballRef.count; i++) {
          ballRef.mesh.getMatrixAt(i, tmpMatrix);
          tmpPos.setFromMatrixPosition(tmpMatrix);
          positions.push({ x: tmpPos.x, y: tmpPos.y - 1.4, z: tmpPos.z });
        }
        const mat4 = new THREE.Matrix4();
        for (let i = ballRef.count; i < house.deliveryCount; i++) {
          const pos = this.computeBallPosition(house.id, i, this.houseHemisphereRadius, positions);
          positions.push(pos);
          mat4.makeTranslation(pos.x, pos.y + 1.4, pos.z);
          ballRef.mesh.setMatrixAt(i, mat4);
        }
        ballRef.count = house.deliveryCount;
        ballRef.mesh.count = house.deliveryCount;
        ballRef.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private createHouseMesh(house: House): { group: THREE.Group; parkedCars: THREE.Group[] } {
    const group = new THREE.Group();
    const hexColor = this.gameColors[house.color];
    const mat = new THREE.MeshStandardMaterial({
      color: hexColor, metalness: 0.2, roughness: 0.1,
      emissive: hexColor, emissiveIntensity: 0.15,
    });

    const dome = new THREE.Mesh(this.houseHemisphereGeom, mat);
    dome.position.y = 1.4;
    dome.castShadow = true;
    group.add(dome);

    const deliveryBallMat = new THREE.MeshStandardMaterial({
      color: hexColor, metalness: 0.2, roughness: 0.1,
      emissive: hexColor, emissiveIntensity: 0.2,
      transparent: true, opacity: 0.6,
    });
    group.userData.deliveryBallMat = deliveryBallMat;

    addGroundPlate(group, { width: this.housePlateSize, depth: this.housePlateSize, centerX: 0, centerZ: 0 }, this.plateMat, this.plateGeomCache);

    const parkedCars: THREE.Group[] = [];
    const cabOffsetX = CAR_LENGTH * 0.18;
    const bedOffsetX = -CAR_LENGTH * 0.20;
    const sideY = 1.2;
    const sideZ = CAR_WIDTH * 0.42;

    // Derived from the house's own cars rather than the module constant, so the mesh count
    // cannot disagree with a map's `CARS_PER_HOUSE`. `CarSystem.registerHouse` fills
    // `carIds` synchronously from `SpawnSystem.onHouseSpawn`, before any render pass.
    // (The designer has no CarSystem, so its houses get none — already invisible there,
    // since `BuildingLayer.update` runs with an empty car list.)
    const parkedCarCount = house.carIds.length;

    for (let i = 0; i < parkedCarCount; i++) {
      const carGroup = new THREE.Group();

      const cab = new THREE.Mesh(this.parkedCabGeom, mat);
      cab.position.x = cabOffsetX;
      carGroup.add(cab);

      const bed = new THREE.Mesh(this.parkedBedGeom, mat);
      bed.position.x = bedOffsetX;
      carGroup.add(bed);

      const leftWall = new THREE.Mesh(this.parkedBedSideGeom, mat);
      leftWall.position.set(bedOffsetX, sideY, sideZ);
      carGroup.add(leftWall);
      const rightWall = new THREE.Mesh(this.parkedBedSideGeom, mat);
      rightWall.position.set(bedOffsetX, sideY, -sideZ);
      carGroup.add(rightWall);

      const rearWall = new THREE.Mesh(this.parkedBedRearGeom, mat);
      rearWall.position.set(bedOffsetX - CAR_LENGTH * 0.24, sideY, 0);
      carGroup.add(rearWall);

      // Symmetric spread around the centre line; reduces to exactly ∓LANE_OFFSET at the
      // default count of 2, so the standard house is pixel-identical.
      const lateralOffset = (i * 2 - (parkedCarCount - 1)) * LANE_OFFSET;
      carGroup.position.set(0, 0.8, lateralOffset);

      group.add(carGroup);
      parkedCars.push(carGroup);
    }

    const px = house.pos.gx * TILE_SIZE + TILE_SIZE / 2;
    const pz = house.pos.gy * TILE_SIZE + TILE_SIZE / 2;
    group.position.set(px, 0, pz);

    return { group, parkedCars };
  }

  private computeBallPosition(houseId: string, ballIndex: number, radius: number, existing: { x: number; y: number; z: number }[]): { x: number; y: number; z: number } {
    let seed = ballIndex * 7919;
    for (let i = 0; i < houseId.length; i++) seed = (seed * 31 + houseId.charCodeAt(i)) | 0;
    seed ^= (seed << 13); seed ^= (seed >> 17); seed ^= (seed << 5);
    seed = Math.abs(seed) || 1;
    const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; };

    const ballRadius = 5;

    if (ballIndex < 6 || existing.length === 0) {
      const theta = rand() * 0.8 * (Math.PI / 2);
      const phi = rand() * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      return {
        x: radius * sinTheta * Math.cos(phi),
        y: radius * Math.cos(theta),
        z: radius * sinTheta * Math.sin(phi),
      };
    }

    const parentIdx = Math.floor(rand() * existing.length);
    const parent = existing[parentIdx];
    const offTheta = rand() * Math.PI;
    const offPhi = rand() * Math.PI * 2;
    const dist = 8;
    const sinOff = Math.sin(offTheta);
    const x = parent.x + dist * sinOff * Math.cos(offPhi);
    let y = parent.y + dist * Math.cos(offTheta);
    const z = parent.z + dist * sinOff * Math.sin(offPhi);
    y = Math.max(y, ballRadius);
    return { x, y, z };
  }

  dispose(scene: THREE.Scene): void {
    for (const [, group] of this.houseMeshes) {
      scene.remove(group);
      disposeGroup(group, this.sharedResources);
    }
    this.houseMeshes.clear();
    this.parkedCarMeshes.clear();
    this.deliveryBallRefs.clear();

    this.houseHemisphereGeom.dispose();
    this.deliveryBallGeom.dispose();
    this.parkedCabGeom.dispose();
    this.parkedBedGeom.dispose();
    this.parkedBedSideGeom.dispose();
    this.parkedBedRearGeom.dispose();
    for (const geom of this.plateGeomCache.values()) geom.dispose();
    this.plateGeomCache.clear();
    this.plateMat.dispose();
    this.plateNoiseTexture.dispose();
  }
}
