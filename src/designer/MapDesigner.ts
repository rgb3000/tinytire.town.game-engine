import * as THREE from 'three';
import { createWebGLRenderer } from '../rendering/createWebGLRenderer';
import { CellType, GameColor, Tool, type BusinessRotation } from '../types';
import { Grid } from '../core/Grid';
import { opposite, ALL_DIRECTIONS } from '../utils/direction';
import { Renderer } from '../rendering/Renderer';
import { RoadSystem } from '../systems/RoadSystem';
import { SpawnSystem, type SpawnDemandSource } from '../systems/SpawnSystem';
import { ObstacleSystem } from '../systems/ObstacleSystem';
import { GasStationSystem } from '../systems/GasStationSystem';
import { HighwaySystem } from '../systems/HighwaySystem';
import { buildConfig, MOUNTAIN_MIN_HEIGHT, MOUNTAIN_MAX_HEIGHT, TILE_SIZE } from '../constants';
import { InputHandler } from '../input/InputHandler';
import { RoadDrawer } from '../input/RoadDrawer';
import { HighwayDrawer } from '../input/HighwayDrawer';
import { serializeMapConfig } from '../maps/serializeMap';
import { applyMapConfig } from '../core/applyMapConfig';
import { omitUndefined } from '../utils/omitUndefined';
import type { MapConfig, ObstacleDefinition, PaintPalette, BackgroundTileDefinition, ColorTheme, GameConstants, MountainTriangles, LakeTriangles } from '../maps/types';
import { buildColorTheme, diffColorTheme } from './colorTheme';
export const DesignerTool = {
  Road: 0,
  Eraser: 1,
  House: 2,
  Business: 3,
  Mountain: 4,
  GasStation: 5,
  Highway: 6,
  Paint: 7,
  Lake: 8,
  Blueprint: 9,
} as const;
export type DesignerTool = (typeof DesignerTool)[keyof typeof DesignerTool];

/**
 * Constants that the designer owns itself rather than exposing as editable overrides.
 *
 * `SPAWN_INTERVAL`/`MIN_SPAWN_INTERVAL` and the obstacle cluster counts are set to
 * sentinel values by older exports to disable random generation during design; the
 * designer disables those directly, so re-importing them would leak into the saved
 * map. `STARTING_ROADS: 99999` is the same trick from before inventory was
 * configurable. Intentional back-compat, not dead code.
 */
const DESIGNER_INTERNAL_CONSTANTS = new Set<keyof GameConstants>([
  'SPAWN_INTERVAL', 'MIN_SPAWN_INTERVAL', 'MOUNTAIN_CLUSTER_COUNT', 'LAKE_CLUSTER_COUNT',
]);

function stripLegacyConstants(constants: Partial<GameConstants>): Partial<GameConstants> {
  const kept: Partial<GameConstants> = {};
  for (const [key, value] of Object.entries(constants) as [keyof GameConstants, number][]) {
    if (DESIGNER_INTERNAL_CONSTANTS.has(key)) continue;
    if (key === 'STARTING_ROADS' && value === 99999) continue;
    kept[key] = value;
  }
  return kept;
}

export class MapDesigner {
  private webglRenderer: THREE.WebGLRenderer;
  private grid: Grid;
  private renderer: Renderer;
  private roadSystem: RoadSystem;
  private spawnSystem: SpawnSystem;
  private obstacleSystem: ObstacleSystem;
  private gasStationSystem: GasStationSystem;
  private highwaySystem: HighwaySystem;
  private highwayDrawer: HighwayDrawer;
  private input: InputHandler;
  private roadDrawer: RoadDrawer;
  private canvas: HTMLCanvasElement;
  private animationId = 0;
  private disposed = false;
  private paused = false;

  // Pan/zoom state
  private spaceDown = false;
  private isPanning = false;
  private lastPanX = 0;
  private lastPanY = 0;

  // Designer state
  activeTool: DesignerTool = DesignerTool.Road;
  activeColor: GameColor = GameColor.Red;
  businessRotation: BusinessRotation = 0;
  obstacleType: 'mountain' | 'lake' = 'mountain';
  // Triangle subdivision
  mountainTriangles: MountainTriangles = new Map();
  lakeTriangles: LakeTriangles = new Map();

  // Paint state
  backgroundTiles: Map<string, { top?: number; right?: number; bottom?: number; left?: number }> = new Map();
  colorTheme: ColorTheme = buildColorTheme();
  activePaintSlot = 0;

  // Constants overrides (user-facing gameplay settings)
  constantsOverrides: Partial<GameConstants> = {};

  // Blueprint state
  blueprintVisible = false;
  blueprintOpacity = 0.5;
  private blueprintObjectUrl: string | null = null;
  private blueprintImage: HTMLImageElement | null = null;

  // Callbacks
  onToolChange: (() => void) | null = null;
  onBlueprintChange: (() => void) | null = null;

  updateConstant<K extends keyof GameConstants>(key: K, value: number): void {
    this.constantsOverrides[key] = value as GameConstants[K];
  }

  // Event listener references for cleanup
  private resizeHandler: () => void;
  private keydownHandler: (e: KeyboardEvent) => void;
  private keyupHandler: (e: KeyboardEvent) => void;
  private mousedownHandler: (e: MouseEvent) => void;
  private mousemoveHandler: (e: MouseEvent) => void;
  private mouseupHandler: (e: MouseEvent) => void;
  private wheelHandler: (e: WheelEvent) => void;
  private contextMenuHandler: (e: Event) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const cfg = buildConfig();

    this.webglRenderer = createWebGLRenderer(canvas);

    this.grid = new Grid();

    // ObstacleSystem with empty predefined (no random gen)
    this.obstacleSystem = new ObstacleSystem(this.grid, [], cfg);
    this.obstacleSystem.generate();

    this.roadSystem = new RoadSystem(this.grid);
    this.gasStationSystem = new GasStationSystem(this.grid);
    this.highwaySystem = new HighwaySystem();

    // The designer places buildings but never simulates demand, so nothing ever
    // consumes: a source that always reports zero is the honest answer, not a stub.
    const noDemand: SpawnDemandSource = { getColorPinOutputRate: () => 0 };
    this.spawnSystem = new SpawnSystem(this.grid, noDemand, cfg);
    this.spawnSystem.unlockAllColors();

    this.renderer = new Renderer(
      this.webglRenderer,
      this.grid,
      () => this.spawnSystem.getHouses(),
      () => this.spawnSystem.getBusinesses(),
    );
    this.renderer.buildObstacles(
      this.obstacleSystem.getMountainCells(),
      this.obstacleSystem.getLakeCells(),
      this.mountainTriangles,
      this.lakeTriangles,
    );
    this.renderer.resize(window.innerWidth, window.innerHeight);

    this.input = new InputHandler(
      canvas,
      (sx, sy) => this.renderer.screenToWorld(sx, sy),
    );

    const unlimitedStock = { hasStock: () => true, consume: () => {}, restore: () => {} };
    this.roadDrawer = new RoadDrawer(
      this.input, this.roadSystem, this.grid,
      unlimitedStock,
      () => this.spawnSystem.getHouses(),
      null,
      () => {
        if (this.activeTool === DesignerTool.Road) return Tool.Road;
        if (this.activeTool === DesignerTool.Eraser) return Tool.Eraser;
        if (this.activeTool === DesignerTool.Highway) return Tool.Highway;
        return Tool.GasStation; // All other tools: skip road drawing
      },
    );
    this.roadDrawer.onTryErase = (gx, gy) => {
      this.eraseAt(gx, gy);
      return true;
    };
    this.highwayDrawer = new HighwayDrawer(
      this.input, this.highwaySystem, this.grid,
      unlimitedStock,
      () => this.activeTool === DesignerTool.Highway ? Tool.Highway : (this.activeTool === DesignerTool.Eraser ? Tool.Eraser : Tool.Road),
    );

    // Wheel: pan/zoom
    this.wheelHandler = (e) => this.renderer.onWheel(e);
    canvas.addEventListener('wheel', this.wheelHandler, { passive: false });

    // Resize
    this.resizeHandler = () => {
      this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this.resizeHandler);

    // Keyboard
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') this.renderer.zoomByKey(1);
      if (e.key === '-') this.renderer.zoomByKey(-1);
      if (e.key === 'r' || e.key === 'R') this.setTool(DesignerTool.Road);
      if (e.key === 'e' || e.key === 'E') this.setTool(DesignerTool.Eraser);
      if (e.key === 'h' || e.key === 'H') this.setTool(DesignerTool.House);
      if (e.key === 'b' || e.key === 'B') this.setTool(DesignerTool.Business);
      if (e.key === 'm' || e.key === 'M') this.setTool(DesignerTool.Mountain);
      if (e.key === 'l' || e.key === 'L') this.setTool(DesignerTool.Lake);
      if (e.key === 'g' || e.key === 'G') this.setTool(DesignerTool.GasStation);
      if (e.key === 'w' || e.key === 'W') this.setTool(DesignerTool.Highway);
      if (e.key === 'p' || e.key === 'P') this.setTool(DesignerTool.Paint);
      if (e.key === 'v' || e.key === 'V') {
        this.toggleIsometric();
        this.onToolChange?.();
      }
      if (e.key >= '1' && e.key <= '6') {
        const colors = [GameColor.Red, GameColor.Blue, GameColor.Yellow, GameColor.Green, GameColor.Purple, GameColor.Orange];
        this.activeColor = colors[parseInt(e.key) - 1];
        this.onToolChange?.();
      }
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        this.spaceDown = true;
        this.input.panningActive = true;
        this.canvas.style.cursor = 'grab';
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    this.keyupHandler = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        this.spaceDown = false;
        this.isPanning = false;
        this.input.panningActive = false;
        this.canvas.style.cursor = this.getCursorForTool();
      }
    };
    window.addEventListener('keyup', this.keyupHandler);

    // Mouse: space+drag pan, left-click placement for non-road tools
    this.mousedownHandler = (e: MouseEvent) => {
      if (this.spaceDown && e.button === 0) {
        this.isPanning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      const pos = this.input.state.gridPos;

      if (e.button === 0) {
        // Left click — only handle non-road tools here; Road/Eraser handled by RoadDrawer
        if (this.activeTool === DesignerTool.House) {
          this.placeHouse(pos.gx, pos.gy);
        } else if (this.activeTool === DesignerTool.Business) {
          this.placeBusiness(pos.gx, pos.gy);
        } else if (this.activeTool === DesignerTool.Mountain || this.activeTool === DesignerTool.Lake) {
          const world = this.renderer.screenToWorld(e.clientX, e.clientY);
          this.placeObstacleAt(world.x, world.z);
        } else if (this.activeTool === DesignerTool.GasStation) {
          this.placeGasStation(pos.gx, pos.gy);
        } else if (this.activeTool === DesignerTool.Paint) {
          const world = this.renderer.screenToWorld(e.clientX, e.clientY);
          this.paintAt(world.x, world.z);
        }
      }
    };
    canvas.addEventListener('mousedown', this.mousedownHandler);

    this.mousemoveHandler = (e: MouseEvent) => {
      if (this.isPanning) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        const zoom = this.renderer.getCurrentZoom();
        this.renderer.panBy(-dx / zoom, -dy / zoom);
        return;
      }

      if ((this.activeTool === DesignerTool.Mountain || this.activeTool === DesignerTool.Lake) && (e.buttons & 1)) {
        const world = this.renderer.screenToWorld(e.clientX, e.clientY);
        this.placeObstacleAt(world.x, world.z);
      }
      if (this.activeTool === DesignerTool.Paint && (e.buttons & 1)) {
        const world = this.renderer.screenToWorld(e.clientX, e.clientY);
        this.paintAt(world.x, world.z);
      }
      // Road/Eraser drag handled by RoadDrawer.update()
    };
    canvas.addEventListener('mousemove', this.mousemoveHandler);

    this.mouseupHandler = (e: MouseEvent) => {
      if (e.button === 0 && this.isPanning) {
        this.isPanning = false;
        this.canvas.style.cursor = this.spaceDown ? 'grab' : this.getCursorForTool();
      }
      // Road/Eraser mouseup handled by RoadDrawer.update()
    };
    canvas.addEventListener('mouseup', this.mouseupHandler);

    this.contextMenuHandler = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', this.contextMenuHandler);

    this.renderer.markGroundDirty();
  }

  start(): void {
    const loop = () => {
      if (this.disposed || this.paused) return;
      this.roadDrawer.update();
      this.highwayDrawer.update();
      if (this.roadSystem.isDirty) {
        this.roadSystem.clearDirty();
        this.renderer.markGroundDirty();
      }
      if (this.highwaySystem.isDirty) {
        this.highwaySystem.clearDirty();
        this.renderer.markHighwayDirty();
      }
      if (this.gasStationSystem.isDirty) {
        this.gasStationSystem.clearDirty();
        this.renderer.markGroundDirty();
      }
      // Update business connector status
      for (const biz of this.spawnSystem.getBusinesses()) {
        const cell = this.grid.getCell(biz.connectorPos.gx, biz.connectorPos.gy);
        biz.connected = cell ? cell.roadConnections !== 0 : false;
      }
      this.renderer.updateIndicator(this.roadDrawer.getLastBuiltPos());
      const activeToolMapped = this.activeTool === DesignerTool.Highway ? Tool.Highway : Tool.Road;
      this.renderer.render(
        0,
        this.spawnSystem.getHouses(),
        this.spawnSystem.getBusinesses(),
        [],
        null,
        0, 0,
        false,
        this.highwaySystem,
        activeToolMapped,
        this.highwayDrawer.getPlacementState(),
        this.gasStationSystem.getGasStations(),
      );
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationId);
    if (this.blueprintObjectUrl) {
      URL.revokeObjectURL(this.blueprintObjectUrl);
      this.blueprintObjectUrl = null;
    }
    this.renderer.dispose();
    this.webglRenderer.dispose();
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
    this.canvas.removeEventListener('mousedown', this.mousedownHandler);
    this.canvas.removeEventListener('mousemove', this.mousemoveHandler);
    this.canvas.removeEventListener('mouseup', this.mouseupHandler);
    this.canvas.removeEventListener('contextmenu', this.contextMenuHandler);
  }

  setTool(tool: DesignerTool): void {
    this.activeTool = tool;
    if (tool === DesignerTool.Mountain) this.obstacleType = 'mountain';
    if (tool === DesignerTool.Lake) this.obstacleType = 'lake';
    this.canvas.style.cursor = this.getCursorForTool();
    this.onToolChange?.();
  }

  private getCursorForTool(): string {
    if (this.activeTool === DesignerTool.Eraser || this.activeTool === DesignerTool.Highway) return 'crosshair';
    return 'default';
  }

  placeHouse(gx: number, gy: number): void {
    const cell = this.grid.getCell(gx, gy);
    if (!cell || cell.type !== CellType.Empty) return;

    this.spawnSystem.spawnHouse({ gx, gy }, this.activeColor);
    this.renderer.markGroundDirty();
  }

  placeBusiness(gx: number, gy: number): void {
    // Check all 4 cells of the 2x2 block are empty
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cell = this.grid.getCell(gx + dx, gy + dy);
        if (!cell || cell.type !== CellType.Empty) return;
      }
    }

    this.spawnSystem.spawnBusiness({ gx, gy }, this.activeColor, this.businessRotation);
    this.renderer.markGroundDirty();
  }

  placeGasStation(gx: number, gy: number): void {
    const station = this.gasStationSystem.placeGasStation({ gx, gy });
    if (station) {
      this.roadSystem.markDirty();
      this.renderer.markGroundDirty();
    }
  }

  placeObstacleAt(worldX: number, worldZ: number): void {
    const gx = Math.floor(worldX / TILE_SIZE);
    const gy = Math.floor(worldZ / TILE_SIZE);
    if (gx < 0 || gx >= this.grid.cols || gy < 0 || gy >= this.grid.rows) return;

    const cell = this.grid.getCell(gx, gy);
    if (!cell) return;

    const localX = worldX - gx * TILE_SIZE;
    const localY = worldZ - gy * TILE_SIZE;
    const half = TILE_SIZE / 2;
    const quarter = TILE_SIZE / 4;
    const key = `${gx},${gy}`;

    if (this.obstacleType === 'lake') {
      // Lakes: triangle-aware placement
      if (cell.type !== CellType.Empty && cell.type !== CellType.Lake) return;

      if (cell.type === CellType.Empty) {
        this.grid.setCell(gx, gy, { type: CellType.Lake });
        this.obstacleSystem.getLakeCells().push({ gx, gy });
      }

      const existing = this.lakeTriangles.get(key) ?? {};

      if (Math.abs(localX - half) < quarter && Math.abs(localY - half) < quarter) {
        existing.top = true;
        existing.right = true;
        existing.bottom = true;
        existing.left = true;
      } else {
        const aboveDiag1 = localY < localX;
        const aboveDiag2 = localY < TILE_SIZE - localX;

        if (aboveDiag1 && aboveDiag2) existing.top = true;
        else if (aboveDiag1 && !aboveDiag2) existing.right = true;
        else if (!aboveDiag1 && !aboveDiag2) existing.bottom = true;
        else existing.left = true;
      }

      this.lakeTriangles.set(key, existing);
      this.rebuildObstacles();
      return;
    }

    // Mountains: triangle-aware placement
    if (cell.type !== CellType.Empty && cell.type !== CellType.Mountain) return;

    // If cell was empty, initialize it as mountain
    if (cell.type === CellType.Empty) {
      this.grid.setCell(gx, gy, { type: CellType.Mountain });
      const height = MOUNTAIN_MIN_HEIGHT + Math.random() * (MOUNTAIN_MAX_HEIGHT - MOUNTAIN_MIN_HEIGHT);
      this.obstacleSystem.getMountainHeightMap().set(key, height);
      this.obstacleSystem.getMountainCells().push({ gx, gy });
    }

    const existing = this.mountainTriangles.get(key) ?? {};

    // Center dead zone → fill all 4
    if (Math.abs(localX - half) < quarter && Math.abs(localY - half) < quarter) {
      existing.top = true;
      existing.right = true;
      existing.bottom = true;
      existing.left = true;
    } else {
      const aboveDiag1 = localY < localX;
      const aboveDiag2 = localY < TILE_SIZE - localX;

      if (aboveDiag1 && aboveDiag2) existing.top = true;
      else if (aboveDiag1 && !aboveDiag2) existing.right = true;
      else if (!aboveDiag1 && !aboveDiag2) existing.bottom = true;
      else existing.left = true;
    }

    this.mountainTriangles.set(key, existing);
    this.rebuildObstacles();
  }

  updatePaletteColor(index: number, color: string): void {
    this.colorTheme.paintPalette[index] = color;
    if (this.backgroundTiles.size > 0) {
      this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
      this.renderer.markGroundDirty();
    }
  }

  updateThemeField(key: 'background' | 'road' | 'highway' | 'gridLines' | 'groundPlate' | 'mountainColor' | 'waterColor' | 'shorelineColor' | 'mountainShorelineColor', value: string): void {
    this.colorTheme[key] = value;
    this.renderer.applyColorTheme(this.colorTheme);
    if (key === 'mountainColor' || key === 'waterColor' || key === 'shorelineColor' || key === 'mountainShorelineColor') {
      this.rebuildObstacles();
    }
  }

  updateGameColor(gc: number, hex: string): void {
    this.colorTheme.gameColors[gc] = hex;
    this.renderer.applyColorTheme(this.colorTheme);
  }

  updatePaintPaletteSlot(index: number, hex: string): void {
    this.colorTheme.paintPalette[index] = hex;
    this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
    this.renderer.applyColorTheme(this.colorTheme);
  }

  paintAt(worldX: number, worldZ: number): void {
    const gx = Math.floor(worldX / TILE_SIZE);
    const gy = Math.floor(worldZ / TILE_SIZE);
    if (gx < 0 || gx >= this.grid.cols || gy < 0 || gy >= this.grid.rows) return;

    const localX = worldX - gx * TILE_SIZE;
    const localY = worldZ - gy * TILE_SIZE;
    const half = TILE_SIZE / 2;
    const quarter = TILE_SIZE / 4;

    const key = `${gx},${gy}`;
    const existing = this.backgroundTiles.get(key) ?? {};
    const slot = this.activePaintSlot;

    // Center dead zone → fill all 4
    if (Math.abs(localX - half) < quarter && Math.abs(localY - half) < quarter) {
      existing.top = slot;
      existing.right = slot;
      existing.bottom = slot;
      existing.left = slot;
    } else {
      const aboveDiag1 = localY < localX;           // above TL→BR diagonal
      const aboveDiag2 = localY < TILE_SIZE - localX; // above TR→BL diagonal

      if (aboveDiag1 && aboveDiag2) existing.top = slot;
      else if (aboveDiag1 && !aboveDiag2) existing.right = slot;
      else if (!aboveDiag1 && !aboveDiag2) existing.bottom = slot;
      else existing.left = slot;
    }

    this.backgroundTiles.set(key, existing);
    this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
    this.renderer.markGroundDirty();
  }

  eraseAt(gx: number, gy: number): void {
    // Try erasing highways at this cell
    this.highwayDrawer.tryEraseAtCell(gx, gy);

    // Erase background paint
    const key = `${gx},${gy}`;
    if (this.backgroundTiles.has(key)) {
      this.backgroundTiles.delete(key);
      this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
      this.renderer.markGroundDirty();
    }

    const cell = this.grid.getCell(gx, gy);
    if (!cell) return;

    if (cell.type === CellType.Road) {
      this.roadSystem.removeRoad(gx, gy);
      this.renderer.markGroundDirty();
      return;
    }

    // Only allow erasing by clicking directly on the House or Business cell
    if (cell.type === CellType.House || cell.type === CellType.Business) {
      if (cell.entityId) {
        this.eraseEntity(cell.entityId);
        this.renderer.markGroundDirty();
      }
      return;
    }

    // Gas station cells — find and remove the whole station
    if (cell.type === CellType.GasStation || cell.type === CellType.Connector) {
      if (cell.entityId) {
        const station = this.gasStationSystem.getGasStationById(cell.entityId);
        if (station) {
          this.gasStationSystem.removeGasStation(station.id);
          this.roadSystem.markDirty();
          this.renderer.markGroundDirty();
          return;
        }
      }
      // If it's a connector without a gas station entity (e.g. business connector), skip
      if (cell.type === CellType.Connector) return;
    }

    if (cell.type === CellType.Mountain) {
      this.grid.setCell(gx, gy, {
        type: CellType.Empty,
        entityId: null,
        roadConnections: 0,
        color: null,
        connectorDir: null,
        pendingDeletion: false,
      });
      const cells = this.obstacleSystem.getMountainCells();
      const idx = cells.findIndex(c => c.gx === gx && c.gy === gy);
      if (idx !== -1) cells.splice(idx, 1);
      this.obstacleSystem.getMountainHeightMap().delete(`${gx},${gy}`);
      this.mountainTriangles.delete(`${gx},${gy}`);
      this.rebuildObstacles();
      return;
    }

    if (cell.type === CellType.Lake) {
      this.grid.setCell(gx, gy, {
        type: CellType.Empty,
        entityId: null,
        roadConnections: 0,
        color: null,
        connectorDir: null,
        pendingDeletion: false,
      });
      const cells = this.obstacleSystem.getLakeCells();
      const idx = cells.findIndex(c => c.gx === gx && c.gy === gy);
      if (idx !== -1) cells.splice(idx, 1);
      this.lakeTriangles.delete(`${gx},${gy}`);
      this.rebuildObstacles();
      return;
    }
  }

  private eraseEntity(entityId: string): void {
    // Find and remove a house
    const house = this.spawnSystem.getHouses().find(h => h.id === entityId);
    if (house) {
      this.clearCell(house.pos.gx, house.pos.gy);
      this.spawnSystem.removeHouse(entityId);
      this.roadSystem.markDirty();
      return;
    }

    // Find and remove a business (4 cells)
    const business = this.spawnSystem.getBusinesses().find(b => b.id === entityId);
    if (business) {
      this.clearCell(business.buildingPos.gx, business.buildingPos.gy);
      this.clearCell(business.pinsPos.gx, business.pinsPos.gy);
      this.clearCell(business.groundPlatePos.gx, business.groundPlatePos.gy);
      this.clearConnectorCell(business.connectorPos.gx, business.connectorPos.gy);
      this.spawnSystem.removeBusiness(entityId);
      return;
    }
  }

  private clearCell(gx: number, gy: number): void {
    this.grid.setCell(gx, gy, {
      type: CellType.Empty,
      entityId: null,
      roadConnections: 0,
      color: null,
      connectorDir: null,
      pendingDeletion: false,
    });
  }

  private clearConnectorCell(gx: number, gy: number): void {
    // Disconnect any road neighbors pointing into this cell
    for (const dir of ALL_DIRECTIONS) {
      const neighbor = this.grid.getNeighbor(gx, gy, dir);
      if (neighbor && neighbor.cell.type === CellType.Road) {
        const oppDir = opposite(dir);
        neighbor.cell.roadConnections &= ~oppDir;
      }
    }
    this.clearCell(gx, gy);
    this.roadSystem.markDirty();
  }


  private rebuildObstacles(): void {
    // Save camera state before disposing renderer
    const cameraState = this.renderer.getCameraState();

    // Rebuild the 3D obstacle rendering
    this.renderer.dispose();

    // Re-create renderer to get fresh ground mesh for lake displacement
    this.renderer = new Renderer(
      this.webglRenderer,
      this.grid,
      () => this.spawnSystem.getHouses(),
      () => this.spawnSystem.getBusinesses(),
    );
    this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
    this.renderer.applyColorTheme(this.colorTheme);
    this.renderer.buildObstacles(
      this.obstacleSystem.getMountainCells(),
      this.obstacleSystem.getLakeCells(),
      this.mountainTriangles,
      this.lakeTriangles,
    );
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.renderer.setCameraState(cameraState);

    // Restore blueprint image if one was loaded
    if (this.blueprintImage) {
      this.renderer.setBlueprintImage(this.blueprintImage);
      this.renderer.setBlueprintVisible(this.blueprintVisible);
      this.renderer.setBlueprintOpacity(this.blueprintOpacity);
    }
  }

  setBlueprintImage(file: File): void {
    this.clearBlueprint();
    const url = URL.createObjectURL(file);
    this.blueprintObjectUrl = url;
    const img = new Image();
    img.onload = () => {
      this.blueprintImage = img;
      this.renderer.setBlueprintImage(img);
      this.renderer.setBlueprintOpacity(this.blueprintOpacity);
      this.blueprintVisible = true;
      this.onBlueprintChange?.();
    };
    img.src = url;
  }

  toggleBlueprint(): void {
    this.blueprintVisible = !this.blueprintVisible;
    this.renderer.setBlueprintVisible(this.blueprintVisible);
    this.onBlueprintChange?.();
  }

  setBlueprintOpacity(opacity: number): void {
    this.blueprintOpacity = opacity;
    this.renderer.setBlueprintOpacity(opacity);
  }

  clearBlueprint(): void {
    this.renderer.clearBlueprint();
    if (this.blueprintObjectUrl) {
      URL.revokeObjectURL(this.blueprintObjectUrl);
      this.blueprintObjectUrl = null;
    }
    this.blueprintImage = null;
    this.blueprintVisible = false;
    this.onBlueprintChange?.();
  }

  toggleIsometric(): void {
    this.renderer.setIsometric(!this.renderer.getIsometric());
  }

  getIsometric(): boolean {
    return this.renderer.getIsometric();
  }

  pause(): void {
    this.paused = true;
    cancelAnimationFrame(this.animationId);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.start();
  }

  toMapConfig(): MapConfig {
    const houses = this.spawnSystem.getHouses().map(h => ({
      gx: h.pos.gx,
      gy: h.pos.gy,
      color: h.color,
    }));

    const businesses = this.spawnSystem.getBusinesses().map(b => ({
      gx: b.pos.gx,
      gy: b.pos.gy,
      color: b.color,
      rotation: b.rotation,
    }));

    const roads: { gx: number; gy: number; connections?: number }[] = [];
    for (let gy = 0; gy < this.grid.rows; gy++) {
      for (let gx = 0; gx < this.grid.cols; gx++) {
        const cell = this.grid.getCell(gx, gy);
        if (cell && cell.type === CellType.Road) {
          roads.push({
            gx,
            gy,
            connections: cell.roadConnections,
          });
        }
      }
    }

    const obstacles: ObstacleDefinition[] = [
      ...this.obstacleSystem.getMountainCells().map(c => {
        const tri = this.mountainTriangles.get(`${c.gx},${c.gy}`);
        const def: ObstacleDefinition = {
          gx: c.gx,
          gy: c.gy,
          type: 'mountain' as const,
        };
        const height = this.obstacleSystem.getMountainHeightMap().get(`${c.gx},${c.gy}`);
        if (height !== undefined) def.height = height;
        if (tri && !(tri.top && tri.right && tri.bottom && tri.left)) {
          if (tri.top) def.top = true;
          if (tri.right) def.right = true;
          if (tri.bottom) def.bottom = true;
          if (tri.left) def.left = true;
        }
        return def;
      }),
      ...this.obstacleSystem.getLakeCells().map(c => {
        const tri = this.lakeTriangles.get(`${c.gx},${c.gy}`);
        const def: ObstacleDefinition = {
          gx: c.gx,
          gy: c.gy,
          type: 'lake' as const,
        };
        if (tri && !(tri.top && tri.right && tri.bottom && tri.left)) {
          if (tri.top) def.top = true;
          if (tri.right) def.right = true;
          if (tri.bottom) def.bottom = true;
          if (tri.left) def.left = true;
        }
        return def;
      }),
    ];

    const gasStations = this.gasStationSystem.getGasStations().map(s => ({
      gx: s.pos.gx,
      gy: s.pos.gy,
    }));

    const highways = this.highwaySystem.getAll().map(h => ({
      fromGx: h.fromPos.gx,
      fromGy: h.fromPos.gy,
      toGx: h.toPos.gx,
      toGy: h.toPos.gy,
      cp1X: h.cp1.x,
      cp1Y: h.cp1.y,
      cp2X: h.cp2.x,
      cp2Y: h.cp2.y,
    }));

    // Background tiles
    const bgTiles: BackgroundTileDefinition[] = [];
    for (const [key, tile] of this.backgroundTiles) {
      const [gxStr, gyStr] = key.split(',');
      bgTiles.push({ gx: Number(gxStr), gy: Number(gyStr), ...tile });
    }

    // Built up rather than returned as one literal: under `exactOptionalPropertyTypes`
    // an explicit `key: undefined` is not the same as an absent key. Mirrors the shape
    // of `mapFileToConfig` in `src/maps/loadMap.ts`.
    const config: MapConfig = {
      id: 'custom-map',
      name: 'Custom Map',
      description: 'Created with Map Designer',
      houses,
      businesses,
      roads,
      // Always present, even when empty: `[]` means "this map has no terrain", while an
      // absent key means "generate terrain randomly". See `serializeMap.ts`.
      obstacles,
    };

    if (gasStations.length > 0) config.gasStations = gasStations;
    if (highways.length > 0) config.highways = highways;
    if (bgTiles.length > 0) {
      config.paintPalette = this.colorTheme.paintPalette as PaintPalette;
      config.backgroundTiles = bgTiles;
    }

    const colorTheme = diffColorTheme(this.colorTheme);
    if (colorTheme !== undefined) config.colorTheme = colorTheme;

    if (Object.keys(this.constantsOverrides).length > 0) {
      config.constants = { ...this.constantsOverrides };
    }

    return config;
  }

  loadMapConfig(config: MapConfig): void {
    // Obstacles: ObstacleSystem already knows how to place predefined terrain,
    // including triangle subdivision, so hand it the definitions and adopt the
    // triangle maps it produces rather than re-deriving them here.
    if (config.obstacles) {
      this.obstacleSystem = new ObstacleSystem(this.grid, config.obstacles, buildConfig());
      this.obstacleSystem.generate();
      this.mountainTriangles = this.obstacleSystem.getMountainTriangles();
      this.lakeTriangles = this.obstacleSystem.getLakeTriangles();
      this.rebuildObstacles();
    }

    applyMapConfig(config, {
      grid: this.grid,
      roadSystem: this.roadSystem,
      spawnSystem: this.spawnSystem,
      highwaySystem: this.highwaySystem,
      gasStationSystem: this.gasStationSystem,
    });

    // Load colour theme before the background tiles, which are painted with it.
    // buildColorTheme merges a partial over the defaults — including the
    // mountain/water/shoreline colours the old hand-written copy silently skipped.
    // `paintPalette` may arrive either nested in the theme or as a top-level field.
    if (config.colorTheme || config.paintPalette) {
      const overrides: Partial<ColorTheme> = { ...config.colorTheme };
      // Assigned only when present: buildColorTheme spreads these over the defaults,
      // and an explicit `paintPalette: undefined` would clobber the default palette.
      const paintPalette = config.colorTheme?.paintPalette ?? config.paintPalette;
      if (paintPalette !== undefined) overrides.paintPalette = paintPalette;

      this.colorTheme = buildColorTheme(overrides);
      this.renderer.applyColorTheme(this.colorTheme);
    }

    // Load background tiles
    if (config.backgroundTiles) {
      for (const tile of config.backgroundTiles) {
        const key = `${tile.gx},${tile.gy}`;
        this.backgroundTiles.set(key, omitUndefined({
          top: tile.top,
          right: tile.right,
          bottom: tile.bottom,
          left: tile.left,
        }));
      }
      this.renderer.setBackgroundTiles(this.backgroundTiles, this.colorTheme.paintPalette);
    }

    if (config.constants) {
      this.constantsOverrides = stripLegacyConstants(config.constants);
    }

    this.renderer.markGroundDirty();
  }

  exportConfig(): string {
    return serializeMapConfig(this.toMapConfig());
  }
}
