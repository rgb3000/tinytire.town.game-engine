import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Business } from '../../../entities/Business';
import { TILE_SIZE, COLOR_MAP, MAX_DEMAND_PINS, DEMAND_DEBUG, CELL_MARGIN, GROUND_PLATE_MARGIN } from '../../../constants';
import { getBusinessLayout } from '../../../utils/businessLayout';
import {
  roundedRectShape,
  createPlateMat,
  addGroundPlate,
  disposeGroup,
  extrudeFlat,
  PLATE_EXTRUDE_OPTIONS,
} from './buildingRenderUtils';

// The factory: a hall in the business's colour under a sawtooth roof, with a chimney.
const HALL_SIZE = TILE_SIZE - CELL_MARGIN - 2 * GROUND_PLATE_MARGIN;
const HALL_BEVEL = 1;
const HALL_HEIGHT = 11;
const SAW_TEETH = 3;
const SAW_HEIGHT = 5;
/** Horizontal run of each tooth's glazed face; the rest of the tooth is roof. */
const SAW_GLASS_RUN = 2.6;
const CHIMNEY_RADIUS = 2.2;
const CHIMNEY_TOP = 27;
/** Chimney centre, inset from the hall's outer corner. */
const CHIMNEY_INSET = 4.5;

export class BusinessLayer {
  private businessMeshes = new Map<string, THREE.Group>();
  private demandPinRefs = new Map<string, THREE.Mesh[]>();
  private connectorMeshes = new Map<string, THREE.Mesh>();
  private debugSprites = new Map<string, THREE.Sprite>();
  private debugCanvas: HTMLCanvasElement | null = null;
  private debugCtx: CanvasRenderingContext2D | null = null;

  private hallGeom: THREE.ExtrudeGeometry;
  private sawRoofGeom: THREE.BufferGeometry;
  private sawGlassGeom: THREE.BufferGeometry;
  private chimneyGeom: THREE.CylinderGeometry;
  private chimneyBandGeom: THREE.CylinderGeometry;
  private chimneyMouthGeom: THREE.CircleGeometry;
  private glassMat: THREE.MeshStandardMaterial;
  private chimneyMat: THREE.MeshStandardMaterial;
  private chimneyBandMat: THREE.MeshStandardMaterial;
  private chimneyMouthMat: THREE.MeshStandardMaterial;
  private bizPinGeom: THREE.SphereGeometry;
  private bizPinOutlineGeom: THREE.CircleGeometry;
  private connectorGeom: THREE.CircleGeometry;
  private plateGeomCache = new Map<string, THREE.ExtrudeGeometry>();

  private plateMat: THREE.MeshStandardMaterial;
  private plateNoiseTexture: THREE.CanvasTexture;
  private bizOutlineMat: THREE.MeshBasicMaterial;

  private sharedResources = new Set<THREE.Material | THREE.BufferGeometry>();

  private gameColors: Record<number, string> = { ...COLOR_MAP };
  private isDirty = false;

  constructor() {
    // The bevel grows the outline outwards, so the shape is drawn that much smaller.
    const hallInner = HALL_SIZE - 2 * HALL_BEVEL;
    this.hallGeom = extrudeFlat(roundedRectShape(hallInner, hallInner, 2), HALL_HEIGHT, HALL_BEVEL);

    // Sawtooth roof. Ridges run along x; each tooth's glazed face looks north (-z), away
    // from the sun, and leans back enough to show as a strip of glass from straight above.
    const roofParts: THREE.BufferGeometry[] = [];
    const glassParts: THREE.BufferGeometry[] = [];
    const toothRun = hallInner / SAW_TEETH;
    for (let i = 0; i < SAW_TEETH; i++) {
      const z0 = -hallInner / 2 + i * toothRun;
      const zPeak = z0 + SAW_GLASS_RUN;
      glassParts.push(sawPrism(hallInner, [[z0, 0], [zPeak, SAW_HEIGHT], [zPeak, 0]]));
      roofParts.push(sawPrism(hallInner, [[zPeak, 0], [zPeak, SAW_HEIGHT], [z0 + toothRun, 0]]));
    }
    this.sawRoofGeom = mergeGeometries(roofParts);
    this.sawGlassGeom = mergeGeometries(glassParts);
    for (const g of [...roofParts, ...glassParts]) g.dispose();
    this.sawRoofGeom.translate(0, HALL_HEIGHT, 0);
    this.sawGlassGeom.translate(0, HALL_HEIGHT, 0);

    this.chimneyGeom = new THREE.CylinderGeometry(CHIMNEY_RADIUS * 0.85, CHIMNEY_RADIUS, CHIMNEY_TOP, 16);
    this.chimneyGeom.translate(0, CHIMNEY_TOP / 2, 0);
    this.chimneyBandGeom = new THREE.CylinderGeometry(CHIMNEY_RADIUS * 0.95, CHIMNEY_RADIUS * 0.97, 2, 16);
    this.chimneyBandGeom.translate(0, CHIMNEY_TOP - 3.5, 0);
    this.chimneyMouthGeom = new THREE.CircleGeometry(CHIMNEY_RADIUS * 0.6, 16);
    this.chimneyMouthGeom.rotateX(-Math.PI / 2);
    this.chimneyMouthGeom.translate(0, CHIMNEY_TOP + 0.02, 0);

    // The glazing faces away from the sun, so without a little light of its own it would
    // read as grey slate rather than glass.
    this.glassMat = new THREE.MeshStandardMaterial({
      color: '#BFDCE6', roughness: 0.2, emissive: '#9CC6D6', emissiveIntensity: 0.45,
    });
    this.chimneyMat = new THREE.MeshStandardMaterial({ color: '#8A8780', roughness: 0.7 });
    this.chimneyBandMat = new THREE.MeshStandardMaterial({ color: '#F7F5EF', roughness: 0.5 });
    this.chimneyMouthMat = new THREE.MeshStandardMaterial({ color: '#3D3D3A', roughness: 1 });

    this.bizPinGeom = new THREE.SphereGeometry(4, 16, 12);
    this.bizPinOutlineGeom = new THREE.CircleGeometry(3, 16);
    this.bizPinOutlineGeom.rotateX(-Math.PI / 2);

    // Connector indicator: full circle matching house hemisphere diameter
    const connectorRadius = (TILE_SIZE - 2 * CELL_MARGIN) / 2 - GROUND_PLATE_MARGIN;
    this.connectorGeom = new THREE.CircleGeometry(connectorRadius, 32);
    this.connectorGeom.rotateX(-Math.PI / 2);

    const { mat, tex } = createPlateMat();
    this.plateMat = mat;
    this.plateNoiseTexture = tex;
    this.bizOutlineMat = new THREE.MeshBasicMaterial({ color: '#666666', side: THREE.DoubleSide });


    this.sharedResources.add(this.plateMat);
    this.sharedResources.add(this.bizOutlineMat);
    this.sharedResources.add(this.bizPinGeom);
    this.sharedResources.add(this.bizPinOutlineGeom);
    this.sharedResources.add(this.connectorGeom);
    for (const r of [
      this.hallGeom, this.sawRoofGeom, this.sawGlassGeom, this.chimneyGeom, this.chimneyBandGeom,
      this.chimneyMouthGeom, this.glassMat, this.chimneyMat, this.chimneyBandMat, this.chimneyMouthMat,
    ]) this.sharedResources.add(r);
  }

  setPlateColor(color: string): void {
    this.plateMat.color.set(color);
  }

  setGameColors(colors: Record<number, string>): void {
    this.gameColors = { ...colors };
    this.isDirty = true;
  }

  /**
   * Returns whether anything that casts a shadow appeared or went away: a business added,
   * removed or rebuilt, or a demand pin shown or hidden. A pin's pulse is not counted —
   * the baked shadow keeps whatever size the pin had when it was last drawn, which on a
   * sphere that small is not visible.
   */
  update(scene: THREE.Scene, businesses: Business[]): boolean {
    let shadowsChanged = false;
    if (this.isDirty) {
      this.isDirty = false;
      shadowsChanged = true;
      for (const [id, group] of this.businessMeshes) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
        const sprite = this.debugSprites.get(id);
        if (sprite) {
          scene.remove(sprite);
          (sprite.material as THREE.SpriteMaterial).map?.dispose();
          sprite.material.dispose();
        }
      }
      this.businessMeshes.clear();
      this.demandPinRefs.clear();
      this.connectorMeshes.clear();
      this.debugSprites.clear();
    }

    // Remove meshes for deleted businesses
    const bizIds = new Set(businesses.map(b => b.id));
    for (const [id, group] of this.businessMeshes) {
      if (!bizIds.has(id)) {
        scene.remove(group);
        disposeGroup(group, this.sharedResources);
        this.businessMeshes.delete(id);
        this.demandPinRefs.delete(id);
        this.connectorMeshes.delete(id);
        shadowsChanged = true;
        const sprite = this.debugSprites.get(id);
        if (sprite) {
          scene.remove(sprite);
          (sprite.material as THREE.SpriteMaterial).map?.dispose();
          sprite.material.dispose();
          this.debugSprites.delete(id);
        }
      }
    }

    for (const biz of businesses) {
      if (!this.businessMeshes.has(biz.id)) {
        const { group, pins, connector } = this.createBusinessMesh(biz);
        scene.add(group);
        this.businessMeshes.set(biz.id, group);
        this.demandPinRefs.set(biz.id, pins);
        this.connectorMeshes.set(biz.id, connector);
        shadowsChanged = true;
      }

      const pins = this.demandPinRefs.get(biz.id)!;
      const shouldPulse = biz.demandPins >= MAX_DEMAND_PINS - 2;
      const pulseScale = shouldPulse ? 1 + 0.25 * Math.sin(Date.now() * 0.006) : 1;
      for (let i = 0; i < MAX_DEMAND_PINS; i++) {
        const visible = i < biz.demandPins;
        if (pins[i].visible !== visible) shadowsChanged = true;
        pins[i].visible = visible;
        if (visible && shouldPulse) {
          pins[i].scale.set(pulseScale, pulseScale, pulseScale);
        } else if (visible) {
          pins[i].scale.set(1, 1, 1);
        }
      }

      // Connector: hide when connected, pulse emissive when visible
      const connector = this.connectorMeshes.get(biz.id)!;
      if (biz.connected) {
        connector.visible = false;
      } else {
        connector.visible = true;
        const pulse = 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(Date.now() * 0.004));
        (connector.material as THREE.MeshStandardMaterial).opacity = pulse;
      }
    }

    // Per-business debug labels
    if (DEMAND_DEBUG) {
      if (!this.debugCanvas) {
        this.debugCanvas = document.createElement('canvas');
        this.debugCanvas.width = 128;
        this.debugCanvas.height = 32;
        this.debugCtx = this.debugCanvas.getContext('2d')!;
      }
      const tmpCanvas = this.debugCanvas!;
      const ctx = this.debugCtx!;

      for (const biz of businesses) {
        const ageMin = (biz.age / 60).toFixed(1);
        const text = `${ageMin}m | ${biz.pinOutputRate.toFixed(1)}/m`;

        ctx.clearRect(0, 0, 128, 32);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, 128, 32);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 16);

        let sprite = this.debugSprites.get(biz.id);
        if (!sprite) {
          const ownCanvas = document.createElement('canvas');
          ownCanvas.width = 128;
          ownCanvas.height = 32;
          const ownCtx = ownCanvas.getContext('2d')!;
          ownCtx.drawImage(tmpCanvas, 0, 0);
          const tex = new THREE.CanvasTexture(ownCanvas);
          const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
          sprite = new THREE.Sprite(mat);
          sprite.scale.set(40, 10, 1);
          scene.add(sprite);
          this.debugSprites.set(biz.id, sprite);
        } else {
          const tex = (sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture;
          const ownCanvas = tex.image as HTMLCanvasElement;
          const ownCtx = ownCanvas.getContext('2d')!;
          ownCtx.clearRect(0, 0, 128, 32);
          ownCtx.drawImage(tmpCanvas, 0, 0);
          tex.needsUpdate = true;
        }

        const px = biz.buildingPos.gx * TILE_SIZE + TILE_SIZE / 2;
        const pz = biz.buildingPos.gy * TILE_SIZE + TILE_SIZE / 2;
        sprite.position.set(px + 10, 2, pz + 15);
      }
    }
    return shadowsChanged;
  }

  private createBusinessMesh(biz: Business): { group: THREE.Group; pins: THREE.Mesh[]; connector: THREE.Mesh } {
    const group = new THREE.Group();
    const hexColor = this.gameColors[biz.color];
    const mat = new THREE.MeshStandardMaterial({
      color: hexColor, metalness: 0.2, roughness: 0.1,
      emissive: hexColor, emissiveIntensity: 0.15,
    });

    const layout = getBusinessLayout({
      anchorPos: biz.pos,
      rotation: biz.rotation,
    });

    const bx = layout.building.centerX;
    const bz = layout.building.centerZ;
    const addPart = (geom: THREE.BufferGeometry, partMat: THREE.Material, x: number, z: number) => {
      const mesh = new THREE.Mesh(geom, partMat);
      mesh.position.set(x, 0, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    addPart(this.hallGeom, mat, bx, bz);
    addPart(this.sawRoofGeom, mat, bx, bz);
    addPart(this.sawGlassGeom, this.glassMat, bx, bz);

    // The chimney stands at the hall's outer corner — the one facing away from the rest of
    // the lot — so it never crowds the pins or the connector, whichever way the lot is turned.
    const lot = layout.groundPlate;
    const cx = bx + Math.sign(bx - lot.centerX) * (HALL_SIZE / 2 - CHIMNEY_INSET);
    const cz = bz + Math.sign(bz - lot.centerZ) * (HALL_SIZE / 2 - CHIMNEY_INSET);
    addPart(this.chimneyGeom, this.chimneyMat, cx, cz);
    addPart(this.chimneyBandGeom, this.chimneyBandMat, cx, cz);
    addPart(this.chimneyMouthGeom, this.chimneyMouthMat, cx, cz);

    addGroundPlate(group, layout.groundPlate, this.plateMat, this.plateGeomCache);

    const outlineY = 0.01 + PLATE_EXTRUDE_OPTIONS.depth + PLATE_EXTRUDE_OPTIONS.bevelThickness + 0.05;
    for (const pin of layout.pinSlots) {
      const outline = new THREE.Mesh(this.bizPinOutlineGeom, this.bizOutlineMat);
      outline.position.set(pin.x, outlineY, pin.z);
      group.add(outline);
    }

    // Connector indicator
    const connectorY = 0.01 + PLATE_EXTRUDE_OPTIONS.depth + PLATE_EXTRUDE_OPTIONS.bevelThickness + 0.15;
    const connectorMat = new THREE.MeshStandardMaterial({
      color: hexColor,
      roughness: 0.5,
      metalness: 0.0,
      transparent: true,
      opacity: 0.8,
    });
    const connector = new THREE.Mesh(this.connectorGeom, connectorMat);
    connector.position.set(layout.connector.x, connectorY, layout.connector.z);
    connector.receiveShadow = true;
    group.add(connector);

    const pinMat = new THREE.MeshStandardMaterial({
      color: hexColor, metalness: 0.2, roughness: 0.1,
      emissive: hexColor, emissiveIntensity: 0.15
    });
    group.userData.pinMat = pinMat;

    const pinY = 5;
    const pins: THREE.Mesh[] = [];
    for (let i = 0; i < MAX_DEMAND_PINS; i++) {
      const pinPos = layout.pinSlots[i];
      const pin = new THREE.Mesh(this.bizPinGeom, pinMat);
      pin.position.set(pinPos.x, pinY, pinPos.z);
      pin.castShadow = true;
      pin.visible = false;
      group.add(pin);
      pins.push(pin);
    }

    return { group, pins, connector };
  }

  dispose(scene: THREE.Scene): void {
    for (const [, group] of this.businessMeshes) {
      scene.remove(group);
      disposeGroup(group, this.sharedResources);
    }
    for (const [, sprite] of this.debugSprites) {
      scene.remove(sprite);
      (sprite.material as THREE.SpriteMaterial).map?.dispose();
      sprite.material.dispose();
    }
    this.businessMeshes.clear();
    this.demandPinRefs.clear();
    this.connectorMeshes.clear();
    this.debugSprites.clear();

    for (const r of [
      this.hallGeom, this.sawRoofGeom, this.sawGlassGeom, this.chimneyGeom, this.chimneyBandGeom,
      this.chimneyMouthGeom, this.glassMat, this.chimneyMat, this.chimneyBandMat, this.chimneyMouthMat,
    ]) r.dispose();
    this.connectorGeom.dispose();
    for (const geom of this.plateGeomCache.values()) geom.dispose();
    this.plateGeomCache.clear();
    this.bizPinGeom.dispose();
    this.bizPinOutlineGeom.dispose();
    this.plateMat.dispose();
    this.plateNoiseTexture.dispose();
    this.bizOutlineMat.dispose();

  }
}

/**
 * A prism running the hall's full width along x, from a profile given as `[z, y]` points.
 */
function sawPrism(width: number, profile: [number, number][]): THREE.BufferGeometry {
  // Drawn with shape x = -z, because turning the extrusion onto x turns shape x onto -z.
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(-z, y)));
  const geom = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geom.rotateY(Math.PI / 2);
  geom.translate(-width / 2, 0, 0);
  return geom;
}
