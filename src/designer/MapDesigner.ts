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
import { buildConfig, TILE_SIZE } from '../constants';
import { InputHandler } from '../input/InputHandler';
import { CameraController } from '../input/CameraController';
import { KeyBindings } from '../input/KeyBindings';
import { designerKeyBindings } from './designerKeyBindings';
import { RoadDrawer } from '../input/RoadDrawer';
import { HighwayDrawer } from '../input/HighwayDrawer';
import { serializeMapConfig } from '../maps/serializeMap';
import { applyMapConfig } from '../core/applyMapConfig';
import { flushWorldDirty, updateConnectorStatus } from '../core/worldFrame';
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
  /** Assign-once: nothing replaces the renderer any more. See `rebuildObstacles`. */
  private readonly renderer: Renderer;
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

  private camera: CameraController;
  private keyBindings: KeyBindings;

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

  // Callbacks
  onToolChange: (() => void) | null = null;
  onBlueprintChange: (() => void) | null = null;

  updateConstant<K extends keyof GameConstants>(key: K, value: number): void {
    this.constantsOverrides[key] = value as GameConstants[K];
  }

  // Event listener references for cleanup. Wheel, keyboard and the pan half of the
  // mouse gestures belong to `camera`/`keyBindings` now; what is left is placement.
  private resizeHandler: () => void;
  private mousedownHandler: (e: MouseEvent) => void;
  private mousemoveHandler: (e: MouseEvent) => void;

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
    this.renderer.rebuildTerrain(
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

    // Resize
    this.resizeHandler = () => {
      this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this.resizeHandler);

    // Wheel zoom, space-to-pan and drag-to-tilt, plus the one writer of the cursor. This
    // was ~60 hand-rolled lines here with its own `spaceDown`/`isPanning`/`lastPanX/Y`,
    // which had already drifted from the shared class: no tilt at all, and a pan that
    // divided the screen delta by zoom instead of raycasting, so it dragged along the
    // wrong axes as soon as the camera was tilted or in isometric mode.
    //
    // The renderer is assign-once here, unlike `Game`'s, but it arrives as a getter all
    // the same — one call shape across both shells is worth more than saving a closure.
    this.camera = new CameraController(
      canvas,
      this.input,
      () => this.renderer,
      () => this.cursorForActiveTool(),
    );

    this.keyBindings = new KeyBindings(designerKeyBindings({
      zoomBy: (direction) => this.renderer.zoomByKey(direction),
      selectTool: (tool) => this.setTool(tool),
      // `activeColor` is a public field and `toggleIsometric()` a public method, both of
      // which hosts drive directly and then re-sync their own UI themselves — see
      // `demo/designPanel.ts` and the website's `DesignerUI`. So only the keyboard path
      // announces the change; firing `onToolChange` from the setters would double it.
      selectColor: (color) => { this.activeColor = color; this.onToolChange?.(); },
      toggleIsometric: () => { this.toggleIsometric(); this.onToolChange?.(); },
      beginSpacePan: () => this.camera.beginPan(),
      endSpacePan: () => this.camera.endPan(),
    }));

    // Placement only — the camera owns the drag whenever space is held. `panningActive` is
    // set by `CameraController.beginPan()` on the space *keydown*, so it is already true
    // before any mouse event of a pan gesture arrives. It is the same flag `InputHandler`
    // uses to keep `RoadDrawer` from drawing through a pan.
    //
    // These run after `InputHandler`'s own listeners, which is load-bearing: `mousedown`
    // reads a `state.gridPos` that `InputHandler.updatePosition()` must have refreshed first.
    this.mousedownHandler = (e: MouseEvent) => {
      if (this.input.panningActive || e.button !== 0) return;
      const pos = this.input.state.gridPos;
      // Road/Eraser are not handled here; `RoadDrawer.update()` polls for them.
      if (this.activeTool === DesignerTool.House) this.placeHouse(pos.gx, pos.gy);
      else if (this.activeTool === DesignerTool.Business) this.placeBusiness(pos.gx, pos.gy);
      else if (this.activeTool === DesignerTool.GasStation) this.placeGasStation(pos.gx, pos.gy);
      else this.brushAt(e);
    };
    canvas.addEventListener('mousedown', this.mousedownHandler);

    this.mousemoveHandler = (e: MouseEvent) => {
      if (this.input.panningActive || (e.buttons & 1) === 0) return;
      this.brushAt(e);
    };
    canvas.addEventListener('mousemove', this.mousemoveHandler);

    this.renderer.markGroundDirty();
  }

  start(): void {
    const loop = () => {
      if (this.disposed || this.paused) return;
      this.roadDrawer.update();
      this.highwayDrawer.update();
      // No pathfinder or cars: the designer places buildings but never simulates, so there
      // is no route to invalidate.
      flushWorldDirty({
        grid: this.grid,
        roadSystem: this.roadSystem,
        highwaySystem: this.highwaySystem,
        gasStationSystem: this.gasStationSystem,
      }, this.renderer);
      updateConnectorStatus(this.grid, this.spawnSystem.getBusinesses());
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
    // The wheel listener these replace was registered as an inline arrow and never removed
    // at all, so a disposed designer kept driving a disposed renderer on every scroll.
    this.camera.dispose();
    this.keyBindings.dispose();
    this.canvas.removeEventListener('mousedown', this.mousedownHandler);
    this.canvas.removeEventListener('mousemove', this.mousemoveHandler);
  }

  setTool(tool: DesignerTool): void {
    this.activeTool = tool;
    if (tool === DesignerTool.Mountain) this.obstacleType = 'mountain';
    if (tool === DesignerTool.Lake) this.obstacleType = 'lake';
    this.camera.syncCursor();
    this.onToolChange?.();
  }

  /**
   * The cursor to show when no camera gesture is in progress.
   *
   * Read only by `CameraController.syncCursor()`, which is the sole writer of
   * `canvas.style.cursor`. There used to be five writers here — the space keydown/keyup,
   * the pan mousedown/mouseup and `setTool` — and they disagreed: selecting a tool during a
   * space-pan clobbered `grab`, and this predicate was missing the GasStation case that
   * `Game.cursorForActiveTool()` has, so the Gas tool showed an arrow in the designer and a
   * crosshair in the game.
   */
  private cursorForActiveTool(): string {
    return (this.activeTool === DesignerTool.Eraser
         || this.activeTool === DesignerTool.Highway
         || this.activeTool === DesignerTool.GasStation)
      ? 'crosshair'
      : 'default';
  }

  /**
   * Paint or raise terrain under the pointer, for the three tools that work on a continuous
   * surface rather than a grid cell. One helper because the screen-to-world-then-branch
   * dance was written out four times across the old mousedown and mousemove handlers.
   */
  private brushAt(e: MouseEvent): void {
    if (this.activeTool !== DesignerTool.Mountain
     && this.activeTool !== DesignerTool.Lake
     && this.activeTool !== DesignerTool.Paint) return;
    const world = this.renderer.screenToWorld(e.clientX, e.clientY);
    if (this.activeTool === DesignerTool.Paint) this.paintAt(world.x, world.z);
    else this.placeObstacleAt(world.x, world.z);
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
      this.grid.clearCell(gx, gy);
      const cells = this.obstacleSystem.getMountainCells();
      const idx = cells.findIndex(c => c.gx === gx && c.gy === gy);
      if (idx !== -1) cells.splice(idx, 1);
      this.mountainTriangles.delete(`${gx},${gy}`);
      this.rebuildObstacles();
      return;
    }

    if (cell.type === CellType.Lake) {
      this.grid.clearCell(gx, gy);
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
      this.grid.clearCell(house.pos.gx, house.pos.gy);
      this.spawnSystem.removeHouse(entityId);
      this.roadSystem.markDirty();
      return;
    }

    // Find and remove a business (4 cells)
    const business = this.spawnSystem.getBusinesses().find(b => b.id === entityId);
    if (business) {
      this.grid.clearCell(business.buildingPos.gx, business.buildingPos.gy);
      this.grid.clearCell(business.pinsPos.gx, business.pinsPos.gy);
      this.grid.clearCell(business.groundPlatePos.gx, business.groundPlatePos.gy);
      this.clearConnectorCell(business.connectorPos.gx, business.connectorPos.gy);
      this.spawnSystem.removeBusiness(entityId);
      return;
    }
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
    this.grid.clearCell(gx, gy);
    this.roadSystem.markDirty();
  }


  /**
   * Push the current mountain/lake state into the renderer. Runs on every brush stroke.
   *
   * This used to dispose the whole `Renderer` and build a new one, then replay camera state,
   * paint, theme, size and blueprint onto it by hand — on the belief that the ground mesh
   * needed regenerating for lake displacement. It does not: the ground is a flat quad and
   * lakes show through alpha holes in its texture. The replay was also missing isometric
   * mode, tilt and azimuth, so painting while tilted snapped the camera flat.
   */
  private rebuildObstacles(): void {
    this.renderer.rebuildTerrain(
      this.obstacleSystem.getMountainCells(),
      this.obstacleSystem.getLakeCells(),
      this.mountainTriangles,
      this.lakeTriangles,
    );
  }

  setBlueprintImage(file: File): void {
    this.clearBlueprint();
    const url = URL.createObjectURL(file);
    this.blueprintObjectUrl = url;
    const img = new Image();
    img.onload = () => {
      this.renderer.setBlueprintImage(img);
      this.renderer.setBlueprintOpacity(this.blueprintOpacity);
      this.blueprintVisible = true;
      this.onBlueprintChange?.();
    };
    img.src = url;
  }

  /**
   * Whether a blueprint image is loaded, independent of whether it is currently shown.
   *
   * A separate question from {@link blueprintVisible}, and hosts need both: hiding a
   * blueprint has to keep the control that shows it again, so visibility alone would make
   * the toggle disappear the moment you used it.
   *
   * Exists because the website was answering it by reaching through bracket notation for a
   * private `blueprintImage` field — which type-checked only because bracket access
   * bypasses `private`, and broke the day that field was removed. The narrow operation it
   * actually wanted is this boolean, not the image.
   */
  hasBlueprint(): boolean {
    return this.blueprintObjectUrl !== null;
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
      // Terrain meshes are built further down, after the map's colour theme has been
      // applied: the mountain and water colours are baked in at build time, so building
      // here would use the outgoing map's palette.
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

    // Now that the theme is in place, build the terrain meshes with its colours.
    if (config.obstacles) this.rebuildObstacles();

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
