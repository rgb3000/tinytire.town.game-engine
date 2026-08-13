import * as THREE from 'three';
import type { Grid } from '../core/Grid';
import type { House } from '../entities/House';
import type { Business } from '../entities/Business';
import type { Car } from '../entities/Car';
import type { GasStation } from '../entities/GasStation';
import type { GridPos } from '../types';
import { CANVAS_WIDTH, CANVAS_HEIGHT, GRID_COLS, GRID_ROWS, TILE_SIZE, ROAD_DEBUG, MAX_DEMAND_PINS } from '../constants';
import { lerp, clamp } from '../utils/math';
import { TerrainLayer } from './layers/TerrainLayer';
import { RoadLayer } from './layers/RoadLayer';
import { BuildingLayer } from './layers/BuildingLayer';
import { CarLayer } from './layers/CarLayer';
import { DebugLayer } from './layers/DebugLayer';
import { ObstacleLayer } from './layers/ObstacleLayer';
import { LakeLayer } from './layers/LakeLayer';
import { RoadDebugLayer } from './layers/RoadDebugLayer';
import { CarRouteLayer } from './layers/CarRouteLayer';
import type { TrafficAdapter } from '../systems/car/TrafficAdapter';
import { HighwayLayer } from './layers/HighwayLayer';
import { createBackdropPlane } from './backdrop';
import {
  poseFor, stepPose, poseSettled, positionFor,
  ISO_ELEVATION, ISO_AZIMUTH, MAX_TILT, TOP_DOWN_AZIMUTH, CAMERA_DISTANCE, POSE_LERP,
  type CameraPose,
} from './cameraPose';
import type { HighwaySystem } from '../systems/HighwaySystem';
import type { HighwayPlacementState } from '../input/HighwayDrawer';
import { Tool } from '../types';
import type { ColorTheme, MountainTriangles, LakeTriangles } from '../maps/types';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const ZOOM_LERP = 0.25;
const ZOOM_STEP = 0.05;
const KEY_ZOOM_STEP = 0.08;

export class Renderer {
  protected scene: THREE.Scene;
  protected camera: THREE.OrthographicCamera;
  private webglRenderer: THREE.WebGLRenderer;

  private terrainLayer: TerrainLayer;
  private roadLayer: RoadLayer;
  private buildingLayer: BuildingLayer;
  private carLayer: CarLayer;
  private debugLayer: DebugLayer;
  private obstacleLayer: ObstacleLayer;
  private lakeLayer: LakeLayer;
  private roadDebugLayer: RoadDebugLayer;
  private carRouteLayer: CarRouteLayer;
  private trafficAdapter: TrafficAdapter | null;
  private highwayLayer: HighwayLayer;
  private grid: Grid;
  private lakeCells: GridPos[] = [];
  private lakeTris: LakeTriangles | undefined;
  private indicatorMesh: THREE.Mesh | null = null;
  private gridLines: THREE.LineSegments | null = null;
  private gasStationPreviewMeshes: THREE.Mesh[] | null = null;

  private offscreenCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private groundTexture: THREE.CanvasTexture;
  private groundMesh!: THREE.Mesh;
  private bgPlaneMesh!: THREE.Mesh;
  private backgroundTiles?: Map<string, { top?: number; right?: number; bottom?: number; left?: number }>;
  private paintPalette?: string[];
  private groundDirty = false;
  private highwayDirty = false;
  private prevActiveTool: Tool | null = null;
  private roadRebuildScheduled = false;
  private dpr: number;
  private needsRender = true;
  private isCapturing = false;
  private prevHouseCount = 0;
  private prevBusinessCount = 0;
  private prevCarCount = 0;
  private prevGasStationCount = 0;
  private hasPulsingEntities = false;
  private mountainColor: string | undefined;
  private waterColor: string | undefined;
  private shorelineColor: string | undefined;
  private mountainShorelineColor: string | undefined;

  // Blueprint image (designer-only, not saved with map)
  private blueprintMesh: THREE.Mesh | null = null;

  // Raycaster for screen-to-world conversion
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Orientation state. One interpolable pose rather than tilt/azimuth/up-blend/extent as
  // four independently-lerped scalars — see `cameraPose.ts` for why that mattered.
  private currentPose!: CameraPose;
  private targetPose!: CameraPose;
  /**
   * The angle the space+drag gesture has accumulated, in radians from vertical.
   *
   * Gesture bookkeeping, not camera state: a quaternion has no natural "add 0.003 rad and
   * clamp to [0, MAX_TILT]", so the drag stays a scalar and `targetPose` is rebuilt from it.
   */
  private gestureTilt = 0;
  private isometricMode = false;

  // Zoom state
  private currentZoom = MAX_ZOOM * 0.7;
  private targetZoom = MAX_ZOOM * 0.7;
  protected cameraCenterX = CANVAS_WIDTH / 2;
  protected cameraCenterZ = CANVAS_HEIGHT / 2;
  protected cameraTargetX = CANVAS_WIDTH / 2;
  protected cameraTargetZ = CANVAS_HEIGHT / 2;
  protected viewportWidth = CANVAS_WIDTH;
  protected viewportHeight = CANVAS_HEIGHT;

  /**
   * `trafficAdapter` is the simulation the route overlays read; null for a renderer with no
   * simulation behind it, which is the map designer. It is a constructor collaborator rather
   * than a per-frame argument because a `Renderer` never outlives the world it was built
   * for — `Game.buildWorld` makes both, in that order, and a restart makes both again.
   */
  constructor(
    webglRenderer: THREE.WebGLRenderer,
    grid: Grid,
    getHouses: () => House[] = () => [],
    getBusinesses: () => Business[] = () => [],
    trafficAdapter: TrafficAdapter | null = null,
  ) {
    this.webglRenderer = webglRenderer;
    this.trafficAdapter = trafficAdapter;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Camera — orthographic, top-down (frustum set by updateFrustum)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    // No `up` vector: the pose carries the whole orientation and is applied as a quaternion.
    this.currentPose = this.poseAt(0, TOP_DOWN_AZIMUTH);
    this.targetPose = this.currentPose;
    this.updateFrustum();
    this.updateCameraPosition();

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
    dirLight.position.set(
      CANVAS_WIDTH / 2 - 800,
      600,
      CANVAS_HEIGHT / 2 + 1200,
    );
    dirLight.target.position.set(CANVAS_WIDTH / 2, 0, CANVAS_HEIGHT / 2);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(4096, 4096);
    dirLight.shadow.radius = 2;
    dirLight.shadow.blurSamples = 25;
    dirLight.shadow.bias = -0.0005;
    const shadowMargin = 1.0;
    dirLight.shadow.camera.left = -CANVAS_WIDTH / 2 * shadowMargin;
    dirLight.shadow.camera.right = CANVAS_WIDTH / 2 * shadowMargin;
    dirLight.shadow.camera.top = CANVAS_HEIGHT / 2 * shadowMargin;
    dirLight.shadow.camera.bottom = -CANVAS_HEIGHT / 2 * shadowMargin;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 5000;
    this.scene.add(dirLight);
    this.scene.add(dirLight.target);

    // Offscreen canvas for terrain (scaled by DPR for sharp rendering)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = CANVAS_WIDTH * this.dpr;
    this.offscreenCanvas.height = CANVAS_HEIGHT * this.dpr;
    this.offCtx = this.offscreenCanvas.getContext('2d')!;

    // Layers
    this.terrainLayer = new TerrainLayer();
    this.roadLayer = new RoadLayer(grid, getHouses, getBusinesses);
    this.buildingLayer = new BuildingLayer();
    this.carLayer = new CarLayer();
    this.debugLayer = new DebugLayer();
    this.obstacleLayer = new ObstacleLayer();
    this.lakeLayer = new LakeLayer();
    this.roadDebugLayer = new RoadDebugLayer();
    this.carRouteLayer = new CarRouteLayer();
    this.highwayLayer = new HighwayLayer();
    this.grid = grid;

    // Render initial ground state (terrain only, roads are 3D)
    this.offCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.terrainLayer.render(this.offCtx, this.lakeCells, this.backgroundTiles, this.paintPalette, this.lakeTris);

    // Ground plane — a flat quad. Lakes are not a depression in this mesh: `alphaTest`
    // below lets the transparent holes that TerrainLayer punches into the ground texture
    // show the LakeLayer's water meshes through.
    this.groundTexture = new THREE.CanvasTexture(this.offscreenCanvas);
    this.groundTexture.minFilter = THREE.LinearFilter;
    this.groundTexture.magFilter = THREE.LinearFilter;

    const groundMat = new THREE.MeshStandardMaterial({ map: this.groundTexture, roughness: 0.85, alphaTest: 0.5 });
    const groundGeom = new THREE.PlaneGeometry(CANVAS_WIDTH, CANVAS_HEIGHT);
    groundGeom.rotateX(-Math.PI / 2);
    this.groundMesh = new THREE.Mesh(groundGeom, groundMat);
    this.groundMesh.position.set(CANVAS_WIDTH / 2, 0, CANVAS_HEIGHT / 2);
    this.groundMesh.receiveShadow = true;
    this.groundMesh.castShadow = true;
    this.scene.add(this.groundMesh);

    // Large background plane beneath ground to fill viewport when tilted/rotated.
    //
    // y = -0.01 is under the ground plane but *above* every lake terrace below the water
    // surface, so this cannot be left to depth-sort against the scene — see `backdrop.ts`
    // for why it draws first and writes no depth.
    const bgSize = Math.max(CANVAS_WIDTH, CANVAS_HEIGHT) * 4;
    this.bgPlaneMesh = createBackdropPlane(bgSize, '#FFFFFF');
    this.bgPlaneMesh.position.set(CANVAS_WIDTH / 2, -0.01, CANVAS_HEIGHT / 2);
    this.scene.add(this.bgPlaneMesh);

    // Grid lines as 3D line geometry (constant 1px width at any zoom)
    this.buildGridLines();
  }

  private buildGridLines(): void {
    const w = GRID_COLS * TILE_SIZE;
    const h = GRID_ROWS * TILE_SIZE;
    const y = 0.15; // just above ground plane

    const points: number[] = [];

    // Vertical lines
    for (let x = 0; x <= GRID_COLS; x++) {
      const px = x * TILE_SIZE;
      points.push(px, y, 0, px, y, h);
    }

    // Horizontal lines
    for (let z = 0; z <= GRID_ROWS; z++) {
      const pz = z * TILE_SIZE;
      points.push(0, y, pz, w, y, pz);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0xD4C4A0,
      transparent: true,
      opacity: 0.5,
      depthTest: true,
    });

    this.gridLines = new THREE.LineSegments(geom, mat);
    this.scene.add(this.gridLines);
  }

  resize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    // The pose carries the frustum extent, and the extent is fitted to viewport aspect, so a
    // resize invalidates it. Settled cameras adopt the new extent outright; an in-flight one
    // is left to converge, since snapping it would undo the transition it is halfway through.
    const wasSettled = poseSettled(this.currentPose, this.targetPose);
    this.rebuildTargetPose();
    if (wasSettled) this.currentPose = this.targetPose;
    this.updateFrustum();
    this.needsRender = true;
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.needsRender = true;

    if (e.ctrlKey) {
      // Ctrl+scroll / pinch-to-zoom: zoom toward cursor via raycasting
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const world = this.screenToWorld(sx, sy);

      const direction = e.deltaY > 0 ? -1 : 1;
      const prevZoom = this.targetZoom;
      this.targetZoom = clamp(
        this.targetZoom * (1 + direction * ZOOM_STEP),
        MIN_ZOOM,
        MAX_ZOOM,
      );

      // Adjust camera center to keep the world point under the cursor
      const zoomRatio = prevZoom / this.targetZoom;
      this.cameraTargetX = world.x + (this.cameraTargetX - world.x) * zoomRatio;
      this.cameraTargetZ = world.z + (this.cameraTargetZ - world.z) * zoomRatio;
    } else {
      // Normal scroll: pan the camera (use panByScreen to handle rotation)
      this.panByScreen(-e.deltaX, -e.deltaY);
    }
  }

  /**
   * The pose family both gestures target, at the current viewport aspect.
   *
   * Manual tilt pitches around {@link TOP_DOWN_AZIMUTH} rather than azimuth zero, which is
   * what makes it a pure pitch. At azimuth zero the old code rolled the map a full 90
   * degrees over the first half of a drag, because it orbited towards screen-right while
   * blending the up-vector towards world-Y; the two disagree by a quarter turn and the
   * blend spun the scene to reconcile them.
   */
  private poseAt(tilt: number, azimuth: number): CameraPose {
    return poseFor(tilt, azimuth, this.viewportWidth / this.viewportHeight);
  }

  /**
   * Re-derive {@link targetPose} from whichever gesture currently owns the camera.
   *
   * The target is always describable by two angles; only the *animation* is a pose. Keeping
   * it derived rather than stored is what lets {@link resize} rebuild it, since the frustum
   * extent depends on viewport aspect.
   */
  private rebuildTargetPose(): void {
    this.targetPose = this.isometricMode
      ? this.poseAt(ISO_ELEVATION, ISO_AZIMUTH)
      : this.poseAt(this.gestureTilt, TOP_DOWN_AZIMUTH);
    this.needsRender = true;
  }

  tiltBy(delta: number): void {
    if (this.isometricMode) return;
    this.gestureTilt = clamp(this.gestureTilt + delta, 0, MAX_TILT);
    this.rebuildTargetPose();
  }

  resetTilt(): void {
    if (this.isometricMode) return;
    this.gestureTilt = 0;
    this.rebuildTargetPose();
  }

  setIsometric(enabled: boolean): void {
    this.isometricMode = enabled;
    // A manual tilt left mid-gesture must not survive the toggle and reappear on the way back.
    this.gestureTilt = 0;
    this.rebuildTargetPose();
  }

  getIsometric(): boolean {
    return this.isometricMode;
  }

  // `getCameraState`/`setCameraState` used to live here, purely so the designer could carry
  // the camera across a dispose-and-recreate. Nothing recreates the renderer any more, and
  // the pair was a trap: it covered zoom and centre but not tilt, azimuth or isometric mode,
  // so "restoring" the camera silently flattened it. Re-add a snapshot only if something
  // genuinely needs one, and make it total when you do.

  zoomByKey(direction: 1 | -1): void {
    this.targetZoom = clamp(
      this.targetZoom * (1 + direction * KEY_ZOOM_STEP),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.needsRender = true;
  }

  screenToWorld(screenX: number, screenY: number): { x: number; z: number } {
    const ndcX = (screenX / this.viewportWidth) * 2 - 1;
    const ndcY = -(screenY / this.viewportHeight) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const target = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, target)) {
      return { x: target.x, z: target.z };
    }
    // Fallback: project onto ground using camera center
    return { x: this.cameraCenterX, z: this.cameraCenterZ };
  }

  panByScreen(screenDx: number, screenDy: number): void {
    // Convert screen-space delta to world-space delta by raycasting two points
    const cx = this.viewportWidth / 2;
    const cy = this.viewportHeight / 2;
    const before = this.screenToWorld(cx, cy);
    const after = this.screenToWorld(cx + screenDx, cy + screenDy);
    this.cameraTargetX -= (after.x - before.x);
    this.cameraTargetZ -= (after.z - before.z);
    this.needsRender = true;
  }

  /**
   * Build or replace all terrain geometry, in place. Safe to call on a running renderer:
   * both layers drop their previous geometry and materials before rebuilding.
   *
   * The designer used to rebuild terrain by disposing the whole `Renderer`, constructing a
   * new one, and hand-replaying camera state, paint, theme, size and blueprint onto it — on
   * every mousemove sample of a brush stroke. Nothing about the ground requires that: it is
   * a flat two-triangle plane whose geometry is never touched, and lakes reach it only
   * through the alpha holes `TerrainLayer` punches into the ground texture. The replay was
   * also silently incomplete — isometric mode, tilt and azimuth were not on it, so painting
   * in a tilted view snapped the camera flat.
   *
   * `lakeCells`/`lakeTriangles` are what those holes are cut from, so this marks the ground
   * dirty itself. Before, that worked only because the designer happened to call
   * `applyColorTheme` — which ends in `markGroundDirty` — immediately beforehand.
   *
   * Colours come from the last {@link applyColorTheme}: the layers bake them into materials
   * at build time, so changing a terrain colour needs a rebuild, not a repaint.
   */
  rebuildTerrain(mountainCells: GridPos[], lakeCells: GridPos[], mountainTriangles?: MountainTriangles, lakeTriangles?: LakeTriangles): void {
    this.obstacleLayer.build(this.scene, mountainCells, this.mountainColor, mountainTriangles, this.mountainShorelineColor);
    this.lakeLayer.build(this.scene, lakeCells, lakeTriangles, this.waterColor, this.shorelineColor);
    this.lakeCells = lakeCells;
    this.lakeTris = lakeTriangles;
    this.markGroundDirty();
  }

  updateIndicator(pos: GridPos | null): void {
    if (!pos) {
      if (this.indicatorMesh && this.indicatorMesh.visible) {
        this.indicatorMesh.visible = false;
        this.needsRender = true;
      }
      return;
    }
    this.needsRender = true;

    if (!this.indicatorMesh) {
      const geom = new THREE.RingGeometry(TILE_SIZE * 0.35, TILE_SIZE * 0.42, 32);
      geom.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x333333,
        transparent: true,
        opacity: 0.35,
        depthTest: false,
      });
      this.indicatorMesh = new THREE.Mesh(geom, mat);
      this.indicatorMesh.renderOrder = 999;
      this.scene.add(this.indicatorMesh);
    }

    this.indicatorMesh.position.set(
      (pos.gx + 0.5) * TILE_SIZE,
      1.5,
      (pos.gy + 0.5) * TILE_SIZE,
    );
    this.indicatorMesh.visible = true;
  }

  updateGasStationPreview(cells: GridPos[] | null): void {
    if (!this.gasStationPreviewMeshes) {
      const geom = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
      geom.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x555555,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 999;
      mesh.visible = false;
      this.scene.add(mesh);
      this.gasStationPreviewMeshes = [mesh];
    }

    if (!cells) {
      for (const mesh of this.gasStationPreviewMeshes) mesh.visible = false;
      return;
    }

    const mesh = this.gasStationPreviewMeshes[0];
    mesh.position.set(
      (cells[0].gx + 0.5) * TILE_SIZE,
      1.5,
      (cells[0].gy + 0.5) * TILE_SIZE,
    );
    mesh.visible = true;
  }

  applyColorTheme(theme: ColorTheme): void {
    // Mountain/water color (used on the next rebuildTerrain call)
    this.mountainColor = theme.mountainColor;
    this.waterColor = theme.waterColor;
    this.shorelineColor = theme.shorelineColor;
    this.mountainShorelineColor = theme.mountainShorelineColor;
    // Grid lines
    if (this.gridLines) {
      (this.gridLines.material as THREE.LineBasicMaterial).color.set(theme.gridLines);
    }
    // Terrain background
    this.terrainLayer.setBackgroundColor(theme.background);
    (this.bgPlaneMesh.material as THREE.MeshBasicMaterial).color.set(theme.background);
    // Lake colors
    this.terrainLayer.setLakeColors(theme.waterColor);
    // Road surface
    this.roadLayer.setRoadColor(theme.road);
    // Highway surface
    this.highwayLayer.setHighwayColor(theme.highway, theme.road);
    // Building plate and entity colors
    this.buildingLayer.setPlateColor(theme.groundPlate);
    this.buildingLayer.setGameColors(theme.gameColors);
    // Car colors
    this.carLayer.setGameColors(theme.gameColors);
    // Car route colors
    this.carRouteLayer.setGameColors(theme.gameColors);
    // Mark dirty for repaint
    this.markGroundDirty();
    this.markHighwayDirty();
  }

  setSelectedCarId(id: string | null): void {
    this.carLayer.setSelectedCarId(id);
    this.needsRender = true;
  }

  toggleHiddenCar(id: string): void {
    this.carLayer.toggleHidden(id);
    this.needsRender = true;
  }

  isCarHidden(id: string): boolean {
    return this.carLayer.isHidden(id);
  }

  markGroundDirty(): void {
    this.groundDirty = true;
    this.needsRender = true;
  }

  markHighwayDirty(): void {
    this.highwayDirty = true;
    this.needsRender = true;
  }

  requestRender(): void {
    this.needsRender = true;
  }

  setBlueprintImage(image: HTMLImageElement): void {
    this.clearBlueprint();

    const texture = new THREE.Texture(image);
    texture.needsUpdate = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.5,
      depthTest: true,
    });
    const geom = new THREE.PlaneGeometry(CANVAS_WIDTH, CANVAS_HEIGHT);
    geom.rotateX(-Math.PI / 2);

    this.blueprintMesh = new THREE.Mesh(geom, mat);
    this.blueprintMesh.position.set(CANVAS_WIDTH / 2, 0.05, CANVAS_HEIGHT / 2);
    this.scene.add(this.blueprintMesh);
    this.needsRender = true;
  }

  setBlueprintVisible(visible: boolean): void {
    if (this.blueprintMesh) {
      this.blueprintMesh.visible = visible;
      this.needsRender = true;
    }
  }

  setBlueprintOpacity(opacity: number): void {
    if (this.blueprintMesh) {
      (this.blueprintMesh.material as THREE.MeshBasicMaterial).opacity = opacity;
      this.needsRender = true;
    }
  }

  clearBlueprint(): void {
    if (this.blueprintMesh) {
      this.scene.remove(this.blueprintMesh);
      this.blueprintMesh.geometry.dispose();
      const mat = this.blueprintMesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.blueprintMesh = null;
      this.needsRender = true;
    }
  }

  setBackgroundTiles(
    tiles: Map<string, { top?: number; right?: number; bottom?: number; left?: number }>,
    palette: string[],
  ): void {
    this.backgroundTiles = tiles;
    this.paintPalette = palette;
  }

  render(
    alpha: number,
    houses: House[],
    businesses: Business[],
    cars: Car[],
    spawnBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null,
    mouseWorldX = 0,
    mouseWorldY = 0,
    isPaused = false,
    highwaySystem: HighwaySystem | null = null,
    activeTool: Tool = Tool.Road,
    highwayPlacementState: HighwayPlacementState | null = null,
    gasStations: GasStation[] = [],
  ): void {
    // Smooth zoom/pan animation (also sets needsRender if camera is animating)
    this.updateCamera();

    // Detect entity count changes
    const houseCount = houses.length;
    const bizCount = businesses.length;
    const carCount = cars.length;
    const gsCount = gasStations.length;
    if (houseCount !== this.prevHouseCount || bizCount !== this.prevBusinessCount ||
        carCount !== this.prevCarCount || gsCount !== this.prevGasStationCount) {
      this.needsRender = true;
      this.prevHouseCount = houseCount;
      this.prevBusinessCount = bizCount;
      this.prevCarCount = carCount;
      this.prevGasStationCount = gsCount;
    }

    // Cars moving or pulsing entities always need render
    if (carCount > 0) this.needsRender = true;

    // Check for pulsing demand pins (businesses near max demand) or spinning connectors
    this.hasPulsingEntities = businesses.some(b => b.demandPins >= MAX_DEMAND_PINS - 2);
    if (this.hasPulsingEntities) this.needsRender = true;
    if (businesses.some(b => !b.connected)) this.needsRender = true;

    // Update ground texture if dirty (terrain only)
    if (this.groundDirty) {
      this.offCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.terrainLayer.render(this.offCtx, this.lakeCells, this.backgroundTiles, this.paintPalette, this.lakeTris);
      this.groundTexture.needsUpdate = true;

      // Defer road mesh rebuild to next frame to avoid frame hitch
      if (!this.roadRebuildScheduled) {
        this.roadRebuildScheduled = true;
        setTimeout(() => {
          this.roadLayer.update(this.scene);
          this.roadRebuildScheduled = false;
        }, 0);
      }
      this.groundDirty = false;
    }

    // Update highway layer when dirty, tool is Highway, or tool just changed away from Highway
    const toolChanged = activeTool !== this.prevActiveTool;
    if (highwaySystem && (this.highwayDirty || activeTool === Tool.Highway || (toolChanged && this.prevActiveTool === Tool.Highway))) {
      this.highwayLayer.update(this.scene, highwaySystem, activeTool, highwayPlacementState);
      this.highwayDirty = false;
    }
    this.prevActiveTool = activeTool;

    // Update 3D meshes
    this.buildingLayer.update(this.scene, houses, businesses, gasStations, cars);
    this.carLayer.update(this.scene, cars, isPaused ? 1 : alpha);
    this.debugLayer.update(this.scene, spawnBounds);
    if (ROAD_DEBUG) this.roadDebugLayer.update(this.scene, this.grid, cars, this.trafficAdapter);
    if (isPaused && this.trafficAdapter) {
      this.carRouteLayer.update(
        this.scene, this.trafficAdapter, cars, houses, businesses, mouseWorldX, mouseWorldY,
      );
    } else {
      this.carRouteLayer.clear(this.scene);
    }
    // Render only when something changed
    if (this.needsRender && !this.isCapturing) {
      this.webglRenderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  async captureGridScreenshot(): Promise<Blob> {
    // Save current state
    const savedZoom = this.currentZoom;
    const savedTargetZoom = this.targetZoom;
    const savedCenterX = this.cameraCenterX;
    const savedCenterZ = this.cameraCenterZ;
    const savedTargetX = this.cameraTargetX;
    const savedTargetZ = this.cameraTargetZ;
    const savedViewW = this.viewportWidth;
    const savedViewH = this.viewportHeight;
    const savedDpr = this.webglRenderer.getPixelRatio();
    const savedPose = this.currentPose;
    const savedTargetPose = this.targetPose;
    const savedGestureTilt = this.gestureTilt;
    const canvas = this.webglRenderer.domElement;

    this.isCapturing = true;
    try {
      // Capture at exact grid pixel dimensions so aspect matches perfectly
      const captureW = CANVAS_WIDTH;
      const captureH = CANVAS_HEIGHT;
      this.webglRenderer.setPixelRatio(this.dpr);
      this.webglRenderer.setSize(captureW, captureH, false);

      // Reset camera to show full grid (zoom=1, centered, no tilt/rotation)
      this.currentZoom = 1;
      this.targetZoom = 1;
      this.viewportWidth = captureW;
      this.viewportHeight = captureH;
      // Flat and square-on, at the capture viewport's aspect. Set after the viewport fields
      // because the pose's frustum extent is fitted to them.
      this.gestureTilt = 0;
      this.currentPose = this.poseAt(0, TOP_DOWN_AZIMUTH);
      this.targetPose = this.currentPose;
      this.cameraCenterX = CANVAS_WIDTH / 2;
      this.cameraCenterZ = CANVAS_HEIGHT / 2;
      this.updateFrustum();
      this.updateCameraPosition();

      // Render one frame
      this.webglRenderer.render(this.scene, this.camera);

      // Capture the blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to capture grid screenshot'))),
          'image/webp',
          0.85,
        );
      });

      return blob;
    } finally {
      // Restore everything
      this.isCapturing = false;
      this.webglRenderer.setPixelRatio(savedDpr);
      this.webglRenderer.setSize(savedViewW, savedViewH, false);
      // Restore CSS size (setSize with false skipped it)
      canvas.style.width = savedViewW + 'px';
      canvas.style.height = savedViewH + 'px';
      this.currentZoom = savedZoom;
      this.targetZoom = savedTargetZoom;
      this.currentPose = savedPose;
      this.targetPose = savedTargetPose;
      this.gestureTilt = savedGestureTilt;
      this.cameraCenterX = savedCenterX;
      this.cameraCenterZ = savedCenterZ;
      this.cameraTargetX = savedTargetX;
      this.cameraTargetZ = savedTargetZ;
      this.viewportWidth = savedViewW;
      this.viewportHeight = savedViewH;
      this.updateFrustum();
      this.updateCameraPosition();
      this.needsRender = true;
    }
  }

  dispose(): void {
    this.clearBlueprint();
    this.roadLayer.dispose(this.scene);
    this.buildingLayer.dispose(this.scene);
    this.carLayer.dispose(this.scene);
    this.debugLayer.dispose(this.scene);
    this.roadDebugLayer.dispose(this.scene);
    this.carRouteLayer.dispose(this.scene);
    this.highwayLayer.dispose(this.scene);
    this.obstacleLayer.dispose(this.scene);
    this.lakeLayer.dispose(this.scene);
    if (this.indicatorMesh) {
      this.scene.remove(this.indicatorMesh);
      this.indicatorMesh.geometry.dispose();
      (this.indicatorMesh.material as THREE.Material).dispose();
      this.indicatorMesh = null;
    }
    if (this.gasStationPreviewMeshes) {
      for (const mesh of this.gasStationPreviewMeshes) {
        this.scene.remove(mesh);
      }
      // Shared geometry and material — dispose once
      this.gasStationPreviewMeshes[0].geometry.dispose();
      (this.gasStationPreviewMeshes[0].material as THREE.Material).dispose();
      this.gasStationPreviewMeshes = null;
    }
    if (this.gridLines) {
      this.scene.remove(this.gridLines);
      this.gridLines.geometry.dispose();
      (this.gridLines.material as THREE.Material).dispose();
      this.gridLines = null;
    }

    // Dispose all remaining scene objects
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose());
        } else {
          mat.dispose();
        }
      }
    });
    this.scene.clear();

    this.groundTexture.dispose();
  }

  /**
   * The frustum half-extents to draw with, at a given zoom.
   *
   * The pose already carries the extent fitted to the viewport, so this only applies zoom.
   * `IsometricRenderer` overrides {@link updateFrustum} and supplies its own extent instead.
   */
  protected computeHalfSizes(zoom: number): { halfW: number; halfH: number } {
    return {
      halfW: this.currentPose.halfW / zoom,
      halfH: this.currentPose.halfH / zoom,
    };
  }

  protected updateFrustum(): void {
    const { halfW, halfH } = this.computeHalfSizes(this.currentZoom);
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  protected updateCameraPosition(): void {
    // Orientation is set outright, not implied by `up` + `lookAt`. That pairing was the
    // wobble: `up` was a linear blend of two vectors that froze at one end of the
    // transition, so the scene rotated backwards until it thawed. A quaternion has no such
    // seam — see `cameraPose.ts`.
    this.camera.quaternion.copy(this.currentPose.quaternion);
    this.camera.position.copy(
      positionFor(this.currentPose, this.cameraCenterX, this.cameraCenterZ, CAMERA_DISTANCE),
    );
    this.camera.updateMatrixWorld(true);
  }

  private updateCamera(): void {
    const prevZoom = this.currentZoom;
    const prevCX = this.cameraCenterX;
    const prevCZ = this.cameraCenterZ;
    const prevPose = this.currentPose;

    this.currentZoom = lerp(this.currentZoom, this.targetZoom, ZOOM_LERP);
    if (Math.abs(this.currentZoom - this.targetZoom) < 0.001) {
      this.currentZoom = this.targetZoom;
    }

    this.cameraCenterX = lerp(this.cameraCenterX, this.cameraTargetX, ZOOM_LERP);
    this.cameraCenterZ = lerp(this.cameraCenterZ, this.cameraTargetZ, ZOOM_LERP);
    if (Math.abs(this.cameraCenterX - this.cameraTargetX) < 0.01) {
      this.cameraCenterX = this.cameraTargetX;
    }
    if (Math.abs(this.cameraCenterZ - this.cameraTargetZ) < 0.01) {
      this.cameraCenterZ = this.cameraTargetZ;
    }

    // One geodesic step. Orientation and frustum extent travel together by construction, so
    // they cannot disagree about how far through the transition they are.
    if (poseSettled(this.currentPose, this.targetPose)) {
      this.currentPose = this.targetPose;
    } else {
      this.currentPose = stepPose(this.currentPose, this.targetPose, POSE_LERP);
    }

    // Only update projection matrix and camera position when something changed
    const changed = this.currentZoom !== prevZoom ||
      this.cameraCenterX !== prevCX ||
      this.cameraCenterZ !== prevCZ ||
      this.currentPose !== prevPose;

    if (changed) {
      this.updateFrustum();
      this.updateCameraPosition();
      this.needsRender = true;
    }
  }
}
