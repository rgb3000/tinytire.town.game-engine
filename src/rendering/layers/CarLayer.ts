import * as THREE from 'three';
import { type Car, CarState } from '../../entities/Car';
import { COLOR_MAP, CAR_WIDTH, CAR_LENGTH, GROUND_Y_POSITION } from '../../constants';
import type { GameColor } from '../../types';
import { lerp } from '../../utils/math';
import { groundShadowOffset } from '../sun';
import {
  carShadowTexels, CAR_SHADOW_TEX_WIDTH, CAR_SHADOW_TEX_HEIGHT,
  CAR_SHADOW_LENGTH_SCALE, CAR_SHADOW_WIDTH_SCALE, CAR_SHADOW_HEIGHT,
} from './carShadow';

/** Where each car's shadow patch sits relative to the car, in world space. See `carShadow.ts`. */
const SHADOW_OFFSET = groundShadowOffset(CAR_SHADOW_HEIGHT);
/** Just above the car's own base, so the patch lies on whatever surface the car is on. */
const SHADOW_Y = 0.25;

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = w / 2, hh = h / 2;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return shape;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

export class CarLayer {
  private meshes = new Map<string, THREE.Group>();
  private materialCache = new Map<GameColor, THREE.MeshStandardMaterial>();
  private gameColors: Record<number, string> = { ...COLOR_MAP };
  private selectedCarId: string | null = null;
  private prevSelectedCarId: string | null = null;
  private hiddenCarIds = new Set<string>();
  // Pickup truck geometries
  private cabBaseGeometry: THREE.ExtrudeGeometry;
  private cabRoofGeometry: THREE.ExtrudeGeometry;
  private bedFloorGeometry: THREE.ExtrudeGeometry;
  private bedSideGeometry: THREE.BoxGeometry;
  private bedRearGeometry: THREE.BoxGeometry;
  private bumperGeometry: THREE.BoxGeometry;
  private loadGeometry: THREE.SphereGeometry;
  private loadMaterialCache = new Map<GameColor, THREE.MeshStandardMaterial>();
  private bumperMaterial: THREE.MeshStandardMaterial;
  private tireGeometry: THREE.CylinderGeometry;
  private tireMaterial: THREE.MeshStandardMaterial;
  private shadowGeometry: THREE.PlaneGeometry;
  private shadowTexture: THREE.DataTexture;
  private shadowMaterial: THREE.MeshBasicMaterial;
  private activeCarIds = new Set<string>();

  constructor() {
    // Cab base: front 40% of truck
    const cabLen = CAR_LENGTH * 0.38;
    const cabBaseShape = roundedRectShape(cabLen, CAR_WIDTH, 1);
    this.cabBaseGeometry = new THREE.ExtrudeGeometry(cabBaseShape, { depth: 1.8, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 3 });
    this.cabBaseGeometry.rotateX(-Math.PI / 2);

    // Cab roof: slightly narrower and shorter than base
    const roofShape = roundedRectShape(cabLen * 0.85, CAR_WIDTH * 0.75, 0.8);
    this.cabRoofGeometry = new THREE.ExtrudeGeometry(roofShape, { depth: 2.0, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 2, curveSegments: 3 });
    this.cabRoofGeometry.rotateX(-Math.PI / 2);

    // Bed floor: rear 55% of truck, low
    const bedLen = CAR_LENGTH * 0.52;
    const bedShape = roundedRectShape(bedLen, CAR_WIDTH, 0.8);
    this.bedFloorGeometry = new THREE.ExtrudeGeometry(bedShape, { depth: 1.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 1, curveSegments: 3 });
    this.bedFloorGeometry.rotateX(-Math.PI / 2);

    // Bed side walls (thin boxes along each side of the bed)
    this.bedSideGeometry = new THREE.BoxGeometry(bedLen * 0.9, 2.0, 0.6);
    // Bed rear wall
    this.bedRearGeometry = new THREE.BoxGeometry(0.6, 2.0, CAR_WIDTH * 0.75);

    // Bumpers: small strips front and rear
    this.bumperGeometry = new THREE.BoxGeometry(0.4, 0.8, CAR_WIDTH + 0.4);
    this.bumperMaterial = new THREE.MeshStandardMaterial({ color: 0x444444 });

    // Load cargo — shiny sphere matching car color (like demand pins)
    this.loadGeometry = new THREE.SphereGeometry(5, 16, 12);

    // Tires
    const tireRadius = 1.2;
    const tireWidth = 1.0;
    this.tireGeometry = new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 8);
    this.tireGeometry.rotateX(Math.PI / 2);
    this.tireMaterial = new THREE.MeshStandardMaterial({ color: 0x222222 });

    // Cars cast no shadow into the shadow map (see `carShadow.ts`); this patch stands in.
    this.shadowGeometry = new THREE.PlaneGeometry(CAR_LENGTH * CAR_SHADOW_LENGTH_SCALE, CAR_WIDTH * CAR_SHADOW_WIDTH_SCALE);
    this.shadowGeometry.rotateX(-Math.PI / 2);
    this.shadowTexture = new THREE.DataTexture(carShadowTexels(), CAR_SHADOW_TEX_WIDTH, CAR_SHADOW_TEX_HEIGHT);
    this.shadowTexture.magFilter = THREE.LinearFilter;
    this.shadowTexture.minFilter = THREE.LinearFilter;
    this.shadowTexture.needsUpdate = true;
    this.shadowMaterial = new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false });
  }

  setSelectedCarId(id: string | null): void {
    this.selectedCarId = id;
  }

  toggleHidden(id: string): void {
    if (this.hiddenCarIds.has(id)) {
      this.hiddenCarIds.delete(id);
    } else {
      this.hiddenCarIds.add(id);
    }
  }

  isHidden(id: string): boolean {
    return this.hiddenCarIds.has(id);
  }

  setGameColors(colors: Record<number, string>): void {
    this.gameColors = { ...colors };
    // Clear material caches so they get recreated with new colors
    for (const [, mat] of this.materialCache) mat.dispose();
    this.materialCache.clear();
    for (const [, mat] of this.loadMaterialCache) mat.dispose();
    this.loadMaterialCache.clear();
  }

  private getMaterial(color: GameColor): THREE.MeshStandardMaterial {
    let mat = this.materialCache.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: this.gameColors[color] });
      this.materialCache.set(color, mat);
    }
    return mat;
  }

  private getLoadMaterial(color: GameColor): THREE.MeshStandardMaterial {
    let mat = this.loadMaterialCache.get(color);
    if (!mat) {
      const hexColor = this.gameColors[color];
      mat = new THREE.MeshStandardMaterial({
        color: hexColor, metalness: 0.6, roughness: 0.25,
        emissive: hexColor, emissiveIntensity: 0.15,
        transparent: true, opacity: 0.7,
      });
      this.loadMaterialCache.set(color, mat);
    }
    return mat;
  }

  update(scene: THREE.Scene, cars: Car[], alpha: number): void {
    const activeCars = this.activeCarIds;
    activeCars.clear();

    // Reset highlight on previously-selected car when selection changes
    if (this.prevSelectedCarId && this.prevSelectedCarId !== this.selectedCarId) {
      const prevGroup = this.meshes.get(this.prevSelectedCarId);
      if (prevGroup) {
        // Reset emissive on body materials (first 6 children are body meshes)
        for (let i = 0; i < 6; i++) {
          const mesh = prevGroup.children[i] as THREE.Mesh;
          if (mesh?.material instanceof THREE.MeshStandardMaterial) {
            mesh.material.emissive.setHex(0x000000);
            mesh.material.emissiveIntensity = 0;
          }
        }
      }
    }
    this.prevSelectedCarId = this.selectedCarId;

    // Skip all work when no cars exist and no meshes to clean up
    if (cars.length === 0 && this.meshes.size === 0) return;

    for (const car of cars) {
      activeCars.add(car.id);

      // Hide hidden cars
      if (this.hiddenCarIds.has(car.id)) {
        const existing = this.meshes.get(car.id);
        if (existing) existing.visible = false;
        continue;
      }

      // Hide idle cars — they're sitting at home, not on the road
      if (car.state === CarState.Idle) {
        const existing = this.meshes.get(car.id);
        if (existing) existing.visible = false;
        continue;
      }

      let group = this.meshes.get(car.id);
      if (!group) {
        group = new THREE.Group();
        const mat = this.getMaterial(car.color);

        const cabOffsetX = CAR_LENGTH * 0.18; // cab sits in front half
        const bedOffsetX = -CAR_LENGTH * 0.20; // bed sits in rear half

        // Cab base (front)
        const cabBase = new THREE.Mesh(this.cabBaseGeometry, mat);
        cabBase.position.x = cabOffsetX;
        group.add(cabBase);

        // Cab roof (narrower, on top of base)
        const cabRoof = new THREE.Mesh(this.cabRoofGeometry, mat);
        cabRoof.position.set(cabOffsetX, 1.8, 0);
        group.add(cabRoof);

        // Bed floor (rear, low)
        const bedFloor = new THREE.Mesh(this.bedFloorGeometry, mat);
        bedFloor.position.x = bedOffsetX;
        group.add(bedFloor);

        // Bed side walls
        const sideY = 1.2;
        const sideZ = CAR_WIDTH * 0.42;
        const leftWall = new THREE.Mesh(this.bedSideGeometry, mat);
        leftWall.position.set(bedOffsetX, sideY, sideZ);
        group.add(leftWall);
        const rightWall = new THREE.Mesh(this.bedSideGeometry, mat);
        rightWall.position.set(bedOffsetX, sideY, -sideZ);
        group.add(rightWall);

        // Bed rear wall
        const rearWall = new THREE.Mesh(this.bedRearGeometry, mat);
        rearWall.position.set(bedOffsetX - CAR_LENGTH * 0.24, sideY, 0);
        group.add(rearWall);

        // Front bumper (flush against cab front edge)
        const frontBumper = new THREE.Mesh(this.bumperGeometry, this.bumperMaterial);
        frontBumper.position.set(cabOffsetX + CAR_LENGTH * 0.19 + 0.2, 0.3, 0);
        group.add(frontBumper);

        // Rear bumper (flush against bed rear edge)
        const rearBumper = new THREE.Mesh(this.bumperGeometry, this.bumperMaterial);
        rearBumper.position.set(bedOffsetX - CAR_LENGTH * 0.26 - 0.2, 0.3, 0);
        group.add(rearBumper);

        // Load (pin sphere in the bed, child index 8)
        const load = new THREE.Mesh(this.loadGeometry, this.getLoadMaterial(car.color));
        load.position.set(bedOffsetX, 6, 0);
        load.visible = false;
        group.add(load);

        // Tires at four corners
        const tireOffsetX = CAR_LENGTH * 0.25;
        const tireOffsetZ = CAR_WIDTH * 0.5 + 0.3;
        const tirePositions = [
          { x: tireOffsetX, z: tireOffsetZ },
          { x: tireOffsetX, z: -tireOffsetZ },
          { x: -tireOffsetX, z: tireOffsetZ },
          { x: -tireOffsetX, z: -tireOffsetZ },
        ];
        for (const tp of tirePositions) {
          const tire = new THREE.Mesh(this.tireGeometry, this.tireMaterial);
          tire.position.set(tp.x, 0, tp.z);
          group.add(tire);
        }

        // Shadow patch (child index 13). Last, so the fixed indices above are unchanged.
        const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
        shadow.renderOrder = 1;
        group.add(shadow);

        scene.add(group);
        this.meshes.set(car.id, group);
      }

      group.visible = true;

      // Toggle load visibility based on car state (load is child index 8)
      const load = group.children[8];
      load.visible = car.hasLoad;

      // Interpolate position
      const x = lerp(car.prevPixelPos.x, car.pixelPos.x, alpha);
      const y = lerp(car.prevPixelPos.y, car.pixelPos.y, alpha);
      const prevElev = car.prevElevationY > 0 ? car.prevElevationY : GROUND_Y_POSITION;
      const curElev = car.elevationY > 0 ? car.elevationY : GROUND_Y_POSITION;
      const yPos = lerp(prevElev, curElev, alpha);
      group.position.set(x, yPos, y);

      // Compute pitch for highway slope
      if (car.onHighway) {
        const dx = car.pixelPos.x - car.prevPixelPos.x;
        const dy = car.pixelPos.y - car.prevPixelPos.y;
        const horizDist = Math.sqrt(dx * dx + dy * dy);
        const elevDiff = curElev - prevElev;
        if (horizDist > 0.01) {
          group.rotation.z = Math.atan2(elevDiff, horizDist);
        } else {
          group.rotation.z = 0;
        }
      } else {
        group.rotation.z = 0;
      }

      // Interpolate rotation
      const angle = lerpAngle(car.prevRenderAngle, car.renderAngle, alpha);
      group.rotation.y = -angle;

      // The shadow's offset is fixed in world space — it points away from the sun whichever
      // way the car faces — so it is turned back through the car's own heading.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      group.children[13].position.set(
        SHADOW_OFFSET.x * cos + SHADOW_OFFSET.z * sin,
        SHADOW_Y,
        -SHADOW_OFFSET.x * sin + SHADOW_OFFSET.z * cos,
      );

      // Highlight selected car
      const isSelected = car.id === this.selectedCarId;
      if (isSelected) {
        // Emissive glow on body materials (first 6 children are body meshes)
        for (let i = 0; i < 6; i++) {
          const mesh = group.children[i] as THREE.Mesh;
          if (mesh?.material instanceof THREE.MeshStandardMaterial) {
            mesh.material.emissive.setHex(0xffffff);
            mesh.material.emissiveIntensity = 0.4;
          }
        }
      }

      // Pulsing scale for stranded cars
      if (car.state === CarState.Stranded) {
        const pulse = 1 + 0.15 * Math.sin(Date.now() * 0.006);
        group.scale.set(pulse, pulse, pulse);
      } else if (isSelected) {
        group.scale.set(1.3, 1.3, 1.3);
      } else {
        group.scale.set(1, 1, 1);
      }
    }

    // Remove groups for cars no longer in the list
    for (const [id, group] of this.meshes) {
      if (!activeCars.has(id)) {
        scene.remove(group);
        this.meshes.delete(id);
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const [, group] of this.meshes) {
      scene.remove(group);
    }
    this.meshes.clear();
    this.cabBaseGeometry.dispose();
    this.cabRoofGeometry.dispose();
    this.bedFloorGeometry.dispose();
    this.bedSideGeometry.dispose();
    this.bedRearGeometry.dispose();
    this.bumperGeometry.dispose();
    this.bumperMaterial.dispose();
    this.loadGeometry.dispose();
    for (const [, mat] of this.loadMaterialCache) {
      mat.dispose();
    }
    this.loadMaterialCache.clear();
    this.tireGeometry.dispose();
    this.tireMaterial.dispose();
    this.shadowGeometry.dispose();
    this.shadowTexture.dispose();
    this.shadowMaterial.dispose();
    for (const [, mat] of this.materialCache) {
      mat.dispose();
    }
    this.materialCache.clear();
  }
}
