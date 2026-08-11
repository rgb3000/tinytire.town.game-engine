import * as THREE from 'three';
import { createWebGLRenderer } from '../rendering/createWebGLRenderer';
import { CellType, GameState, Tool } from '../types';
import type { GameColor } from '../types';
import { Grid } from './Grid';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { InputHandler } from '../input/InputHandler';
import { CameraController } from '../input/CameraController';
import { KeyBindings } from '../input/KeyBindings';
import { gameKeyBindings } from './gameKeyBindings';
import { RoadDrawer } from '../input/RoadDrawer';
import type { InventorySlot } from '../input/RoadDrawer';
import { UndoSystem } from '../input/UndoSystem';
import { RoadSystem } from '../systems/RoadSystem';
import { SpawnSystem } from '../systems/SpawnSystem';
import { DemandSystem } from '../systems/DemandSystem';
import { CarSystem } from '../systems/CarSystem';
import { MusicSystem } from '../systems/MusicSystem';
import { SoundEffectSystem } from '../systems/SoundEffectSystem';
import { ObstacleSystem } from '../systems/ObstacleSystem';
import { Pathfinder } from '../pathfinding/Pathfinder';
import { PendingDeletionSystem } from '../systems/PendingDeletionSystem';
import { HighwaySystem } from '../systems/HighwaySystem';
import { HighwayDrawer } from '../input/HighwayDrawer';
import { GasStationPlacer } from '../input/GasStationPlacer';
import { GasStationSystem } from '../systems/GasStationSystem';
import { CarState } from '../entities/Car';
import { SPAWN_DEBUG, CAR_DEBUG, TILE_SIZE, buildConfig } from '../constants';
import { CarEventLog } from '../debug/CarEventLog';
import { EconomySystem } from '../systems/EconomySystem';
import type { Car } from '../entities/Car';
import type { MapConfig, Inventory, WeeklyChoiceOption } from '../maps/types';
import type { GameConstants } from '../maps/types';
import { buildColorTheme } from '../designer/colorTheme';
import { applyMapConfig, backgroundTilesToMap } from './applyMapConfig';
import { flushWorldDirty, updateConnectorStatus, type WorldFrameSystems } from './worldFrame';

export interface DemandStat {
  color: GameColor;
  demand: number;
  supplyPerMin: number;
  demandPerMin: number;
  houses: number;
  businesses: number;
}

export class Game {
  private webglRenderer: THREE.WebGLRenderer;
  private gameLoop: GameLoop;
  private input: InputHandler;

  // Rebuilt wholesale by buildWorld(), which both the constructor and restart() call.
  // The `!` says "assigned before use" — TypeScript cannot see through the helper.
  private grid!: Grid;
  private renderer!: Renderer;
  private roadDrawer!: RoadDrawer;
  private roadSystem!: RoadSystem;
  private spawnSystem!: SpawnSystem;
  private demandSystem!: DemandSystem;
  private carSystem!: CarSystem;
  private pendingDeletionSystem!: PendingDeletionSystem;
  private obstacleSystem!: ObstacleSystem;
  private highwaySystem!: HighwaySystem;
  private highwayDrawer!: HighwayDrawer;
  private gasStationSystem!: GasStationSystem;
  private gasStationPlacer!: GasStationPlacer;
  private pathfinder!: Pathfinder;
  private undoSystem!: UndoSystem;
  private economy!: EconomySystem;
  private inventory!: Inventory;

  private demandWarnPrevSin = 0;
  private musicSystem: MusicSystem = new MusicSystem();
  private soundEffects: SoundEffectSystem = new SoundEffectSystem();
  private state: GameState = GameState.WaitingToStart;
  private elapsedTime = 0;
  private timeScale: number = 1;
  private stateCallback: ((state: GameState, score: number, time: number, inventory: Inventory, demandStats: DemandStat[] | null, gameDay: number, timeScale: number, gameWeek: number, weekChoicePending: boolean, pendingChoiceOptions: WeeklyChoiceOption[]) => void) | null = null;
  private camera: CameraController;
  private keyBindings: KeyBindings;
  private canvas: HTMLCanvasElement;
  private onUndoStateChange: (() => void) | null = null;
  private musicEnabled = true;
  private activeTool: Tool = Tool.Road;
  private toolChangeCallback: ((tool: Tool) => void) | null = null;
  private mapConfig: MapConfig | undefined;
  private cfg: GameConstants;
  private audioInitialized = false;
  private disposed = false;

  // State callback throttling — cache previous values to avoid redundant React updates
  private prevCallbackState: GameState = GameState.WaitingToStart;
  private prevCallbackScore = 0;
  private prevCallbackTime = 0;
  private prevCallbackRoads = 0;
  private prevCallbackHighways = 0;
  private prevCallbackGasStations = 0;
  private prevCallbackWeek = 1;
  private prevCallbackWeekChoice = false;

  // Event listener references for cleanup
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement, mapConfig?: MapConfig) {
    this.canvas = canvas;
    this.mapConfig = mapConfig;
    this.cfg = buildConfig(mapConfig?.constants);

    this.webglRenderer = createWebGLRenderer(canvas);
    this.input = new InputHandler(
      canvas,
      (sx, sy) => this.renderer.screenToWorld(sx, sy),
    );

    this.buildWorld();

    this.gameLoop = new GameLoop(
      (dt) => this.update(dt),
      (alpha) => this.render(alpha),
    );

    // Window resize
    this.resizeHandler = () => this.onResize();
    window.addEventListener('resize', this.resizeHandler);

    // The renderer arrives as a getter: `buildWorld()` replaces it on every restart, while
    // the controller and its DOM listeners outlive one.
    this.camera = new CameraController(
      canvas,
      this.input,
      () => this.renderer,
      () => this.cursorForActiveTool(),
    );

    this.keyBindings = new KeyBindings(gameKeyBindings({
      zoomBy: (direction) => this.renderer.zoomByKey(direction),
      togglePause: () => this.togglePause(),
      undo: () => this.performUndo(),
      selectTool: (tool) => this.setActiveTool(tool),
      toggleSpeed: () => this.toggleSpeed(),
      toggleIsometric: () => this.toggleIsometric(),
      beginSpacePan: () => this.camera.beginPan(),
      endSpacePan: () => this.camera.endPan(),
    }));
  }

  /**
   * The cursor to show when no camera gesture is in progress.
   *
   * One definition, because there used to be three and they disagreed: `setActiveTool` gave
   * Highway and GasStation a crosshair, while the space-keyup and mouseup handlers restored
   * one only for the Eraser — so space-panning with the Highway tool left you with the wrong
   * cursor.
   *
   * Read only by `CameraController.syncCursor()`, which is the sole writer of
   * `canvas.style.cursor`. `setActiveTool` used to write it directly with a second copy of
   * this predicate, which meant picking a tool mid-space-pan clobbered `grab`/`grabbing`.
   */
  private cursorForActiveTool(): string {
    return (this.activeTool === Tool.Eraser || this.activeTool === Tool.Highway || this.activeTool === Tool.GasStation)
      ? 'crosshair'
      : 'default';
  }

  /**
   * Build (or rebuild) every system, the world they describe, and the wiring between
   * them. Shared by the constructor and {@link restart}; keeping one copy is what
   * stops the two from drifting, as they had — `restart()` used to reset the
   * inventory unconditionally, wiping designer test-play's unlimited stock.
   *
   * Anything that outlives a restart — the canvas, the WebGL context, the input
   * handler and the DOM listeners — is set up by the constructor instead.
   */
  private buildWorld(): void {
    const isDesigner = !!this.mapConfig?.designerMode;
    this.inventory = isDesigner
      ? { roads: Infinity, highways: Infinity, gasStations: Infinity }
      : { roads: this.cfg.STARTING_ROADS, highways: this.cfg.STARTING_HIGHWAYS, gasStations: this.cfg.STARTING_GAS_STATIONS };

    // Built here rather than in the constructor so a restart gets a fresh calendar, the
    // same way every other system does. That is what lets `restart()` drop its hand-written
    // week/choice resets.
    this.economy = new EconomySystem(this.cfg, (slot, amount) => { this.inventory[slot] += amount; });

    this.grid = new Grid();
    this.obstacleSystem = new ObstacleSystem(this.grid, this.mapConfig?.obstacles, this.cfg);
    this.obstacleSystem.generate();
    this.roadSystem = new RoadSystem(this.grid);
    this.highwaySystem = new HighwaySystem();
    this.gasStationSystem = new GasStationSystem(this.grid);
    this.pathfinder = new Pathfinder(this.grid, this.cfg, this.highwaySystem);
    this.pendingDeletionSystem = new PendingDeletionSystem(this.grid, this.roadSystem);
    this.demandSystem = new DemandSystem(this.cfg);
    this.spawnSystem = new SpawnSystem(this.grid, this.demandSystem, this.cfg);
    if (isDesigner) this.spawnSystem.disableAutoSpawn = true;
    this.carSystem = new CarSystem(this.pathfinder, this.grid, this.pendingDeletionSystem, this.cfg, this.highwaySystem, this.gasStationSystem);

    this.renderer = new Renderer(this.webglRenderer, this.grid, () => this.spawnSystem.getHouses(), () => this.spawnSystem.getBusinesses(), this.carSystem.getTrafficAdapter());
    this.renderer.rebuildTerrain(this.obstacleSystem.getMountainCells(), this.obstacleSystem.getLakeCells(), this.obstacleSystem.getMountainTriangles(), this.obstacleSystem.getLakeTriangles());
    if (this.mapConfig?.backgroundTiles && this.mapConfig.paintPalette) {
      this.renderer.setBackgroundTiles(
        backgroundTilesToMap(this.mapConfig.backgroundTiles),
        [...this.mapConfig.paintPalette],
      );
    }
    if (this.mapConfig?.colorTheme) {
      this.renderer.applyColorTheme(buildColorTheme(this.mapConfig.colorTheme));
    }
    this.renderer.resize(window.innerWidth, window.innerHeight);

    this.undoSystem = new UndoSystem(this.grid);
    this.roadDrawer = new RoadDrawer(this.input, this.roadSystem, this.grid, this.createInventorySlot('roads'), this.undoSystem, () => this.activeTool);
    this.roadDrawer.onTryErase = (gx, gy) => this.handleTryErase(gx, gy);
    this.roadDrawer.onRescuePendingConnection = (gx, gy, dir) => {
      this.pendingDeletionSystem.rescueConnection(gx, gy, dir);
    };
    this.highwayDrawer = new HighwayDrawer(this.input, this.highwaySystem, this.grid, this.createInventorySlot('highways'), () => this.activeTool);
    this.gasStationPlacer = new GasStationPlacer(this.input, this.gasStationSystem, this.grid, this.createInventorySlot('gasStations'), () => this.activeTool);

    // Register cars when houses are spawned — must precede applyMapConfig so that
    // predefined houses get their cars too.
    this.spawnSystem.onHouseSpawn = (house) => this.carSystem.registerHouse(house);

    // A map without its own entities seeds the progressive spawn track instead. This
    // runs before applyMapConfig so that spawnInitial() still picks its spot on a
    // bare grid, as it did when these were separate steps.
    const hasPredefinedEntities = !!(this.mapConfig?.houses?.length || this.mapConfig?.businesses?.length);
    if (!hasPredefinedEntities) this.spawnSystem.spawnInitial();

    if (this.mapConfig) {
      applyMapConfig(this.mapConfig, {
        grid: this.grid,
        roadSystem: this.roadSystem,
        spawnSystem: this.spawnSystem,
        highwaySystem: this.highwaySystem,
        gasStationSystem: this.gasStationSystem,
      });
    }
    if (this.mapConfig?.highways?.length) this.renderer.markHighwayDirty();
    this.renderer.markGroundDirty();
    this.spawnSystem.clearDirty();

    // Wire up sound callbacks immediately (audio inits lazily on first interaction)
    this.carSystem.onHomeReturn = () => { this.soundEffects.playHomeReturn(); };
    this.carSystem.onStranded = () => this.soundEffects.playStrandedAlert();
    this.roadDrawer.onRoadPlace = () => this.soundEffects.playRoadPlace();
    this.roadDrawer.onRoadDelete = () => this.soundEffects.playRoadDelete();
    this.spawnSystem.onSpawn = () => this.soundEffects.playSpawn();
  }

  start(): void {
    this.gameLoop.start();
  }

  stop(): void {
    this.gameLoop.stop();
  }

  dispose(): void {
    // The back button disposes explicitly and GameCanvas disposes again on unmount,
    // so this has to tolerate being called twice.
    if (this.disposed) return;
    this.disposed = true;
    this.gameLoop.stop();
    this.musicSystem.dispose();
    this.soundEffects.dispose();
    this.renderer.dispose();
    this.webglRenderer.dispose();
    window.removeEventListener('resize', this.resizeHandler);
    // The canvas listeners these own were previously registered as inline arrows and never
    // removed at all.
    this.camera.dispose();
    this.keyBindings.dispose();
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  screenToWorld(sx: number, sy: number): { x: number; z: number } {
    return this.renderer.screenToWorld(sx, sy);
  }

  captureGridScreenshot(): Promise<Blob> {
    return this.renderer.captureGridScreenshot();
  }

  /** Get active area as normalized 0-1 ratios relative to grid dimensions */
  getActiveArea(): { x: number; y: number; w: number; h: number } | null {
    const area = this.grid.getActiveArea();
    if (!area) return null;
    return {
      x: area.minGx / this.grid.cols,
      y: area.minGy / this.grid.rows,
      w: (area.maxGx - area.minGx + 1) / this.grid.cols,
      h: (area.maxGy - area.minGy + 1) / this.grid.rows,
    };
  }

  getState(): GameState {
    return this.state;
  }

  getScore(): number {
    return this.carSystem.getScore();
  }

  getElapsedTime(): number {
    return this.elapsedTime;
  }

  getCars(): Car[] {
    return this.carSystem.getCars();
  }

  getCarEventLog(): typeof CarEventLog {
    return CarEventLog;
  }

  setSelectedCarId(id: string | null): void {
    this.renderer.setSelectedCarId(id);
  }

  toggleHiddenCar(id: string): void {
    this.renderer.toggleHiddenCar(id);
  }

  isCarHidden(id: string): boolean {
    return this.renderer.isCarHidden(id);
  }

  getCarAtWorldPos(worldX: number, worldZ: number): Car | null {
    const threshold = TILE_SIZE * 0.5;
    const thresholdSq = threshold * threshold;
    let best: Car | null = null;
    let bestDistSq = Infinity;
    for (const car of this.carSystem.getCars()) {
      if (car.state === CarState.Idle) continue;
      const dx = car.pixelPos.x - worldX;
      const dz = car.pixelPos.y - worldZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = car;
      }
    }
    return best;
  }

  getInventory(): Inventory {
    return { ...this.inventory };
  }

  getGameWeek(): number {
    return this.economy.getGameWeek(this.elapsedTime);
  }

  isWeekChoicePending(): boolean {
    return this.economy.isWeekChoicePending();
  }

  getPendingChoiceOptions(): WeeklyChoiceOption[] {
    return this.economy.getPendingChoiceOptions();
  }

  applyWeeklyChoice(option: WeeklyChoiceOption): void {
    this.economy.applyWeeklyChoice(option);
    if (this.state === GameState.Paused) {
      this.state = GameState.Playing;
      // Respects the mute, which this path used to ignore — answering a weekly choice
      // un-muted a muted game. `togglePause` has always had this guard.
      if (this.musicEnabled) this.musicSystem.startMusic();
    }
  }

  private createInventorySlot(slot: keyof Inventory): InventorySlot {
    return {
      hasStock: (count: number) => this.inventory[slot] >= count,
      consume: (count: number) => { this.inventory[slot] -= count; },
      restore: (count: number) => { this.inventory[slot] += count; },
    };
  }

  onStateUpdate(cb: (state: GameState, score: number, time: number, inventory: Inventory, demandStats: DemandStat[] | null, gameDay: number, timeScale: number, gameWeek: number, weekChoicePending: boolean, pendingChoiceOptions: WeeklyChoiceOption[]) => void): void {
    this.stateCallback = cb;
  }

  getGameDay(): number {
    return this.economy.getGameDay(this.elapsedTime);
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  getWeekLengthDays(): number {
    return this.economy.getWeekLengthDays();
  }

  getWeeklyRoadBonus(): number {
    return this.economy.getWeeklyRoadBonus();
  }

  toggleSpeed(): void {
    this.timeScale = this.timeScale === 1 ? 2 : 1;
  }

  toggleIsometric(): void {
    this.renderer.setIsometric(!this.renderer.getIsometric());
  }

  getIsometric(): boolean {
    return this.renderer.getIsometric();
  }

  async startGame(): Promise<void> {
    await this.initAudio();
    this.state = GameState.Playing;
  }

  private async initAudio(): Promise<void> {
    if (this.audioInitialized || this.disposed) return;
    this.audioInitialized = true;
    await this.musicSystem.init();
    await this.soundEffects.init();
    if (this.musicEnabled) this.musicSystem.startMusic();
  }

  togglePause(): void {
    if (this.state === GameState.Playing) {
      this.state = GameState.Paused;
      this.musicSystem.stopMusic();
    } else if (this.state === GameState.Paused) {
      this.state = GameState.Playing;
      if (this.musicEnabled) this.musicSystem.startMusic();
    }
  }

  async restart(): Promise<void> {
    if (CAR_DEBUG) CarEventLog.clear();
    this.musicSystem.dispose();
    this.soundEffects.dispose();
    this.renderer.dispose();

    // Reset the run's own state; everything else is rebuilt from scratch. The week and
    // pending choice used to be reset by hand here — `buildWorld()` now constructs a fresh
    // `EconomySystem`, so they cannot be forgotten.
    this.elapsedTime = 0;
    this.timeScale = 1;
    this.demandWarnPrevSin = 0;

    this.musicSystem = new MusicSystem();
    this.soundEffects = new SoundEffectSystem();
    this.buildWorld();
    this.setActiveTool(Tool.Road);

    this.audioInitialized = false;
    await this.initAudio();
    this.state = GameState.Playing;
  }

  /**
   * Reverse the last edit — the whole edit.
   *
   * Order matters. Entities go back first, because restoring them only touches their own
   * collections; `undo()` has already put the cells back, and a cell's `entityId` has to
   * resolve again once it does. Pending deletions are reconciled last: a snapshot predates
   * the `markPending` that followed it, so restoring the cell clears its flag while
   * `PendingDeletionSystem` still holds the entry — and would quietly finalise the deletion
   * a second later, undoing the undo.
   *
   * Nothing here talks to the renderer: `restore()` marks its system dirty and
   * `flushWorldDirty` picks that up on the next frame.
   */
  performUndo(): void {
    if (this.state === GameState.GameOver) return;
    const group = this.undoSystem.undo();
    if (!group) return;

    for (const station of group.removedGasStations) this.gasStationSystem.restore(station);
    for (const highway of group.removedHighways) this.highwaySystem.restore(highway);

    for (const snapshot of group.cellSnapshots.values()) {
      if (this.pendingDeletionSystem.isPending(snapshot.gx, snapshot.gy)) {
        this.pendingDeletionSystem.cancelPending(snapshot.gx, snapshot.gy);
      }
    }

    // Reverse the inventory change
    const delta = group.inventoryDelta;
    this.inventory.roads -= delta.roads;
    this.inventory.highways -= delta.highways;
    this.inventory.gasStations -= delta.gasStations;
    this.roadSystem.markDirty();
    this.onUndoStateChange?.();
  }

  canUndo(): boolean {
    return this.undoSystem.canUndo();
  }

  setOnUndoStateChange(cb: (() => void) | null): void {
    this.onUndoStateChange = cb;
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (!enabled) {
      this.musicSystem.stopMusic();
    } else if (this.state === GameState.Playing) {
      this.musicSystem.startMusic();
    }
  }

  isMusicEnabled(): boolean {
    return this.musicEnabled;
  }

  getActiveTool(): Tool {
    return this.activeTool;
  }

  setActiveTool(tool: Tool): void {
    if (this.activeTool === tool) return;
    // Block selection of inventory tools with 0 stock
    if (
      (tool === Tool.Road && this.inventory.roads <= 0) ||
      (tool === Tool.Highway && this.inventory.highways <= 0) ||
      (tool === Tool.GasStation && this.inventory.gasStations <= 0)
    ) {
      this.soundEffects.playError();
      return;
    }
    this.activeTool = tool;
    this.camera.syncCursor();
    this.toolChangeCallback?.(tool);
  }

  onToolChange(cb: ((tool: Tool) => void) | null): void {
    this.toolChangeCallback = cb;
  }

  /**
   * The systems {@link flushWorldDirty} reacts to. Built per call rather than cached because
   * `buildWorld()` replaces every one of them on a restart.
   */
  private worldFrameSystems(): WorldFrameSystems {
    return {
      grid: this.grid,
      roadSystem: this.roadSystem,
      highwaySystem: this.highwaySystem,
      gasStationSystem: this.gasStationSystem,
      pathfinder: this.pathfinder,
      carSystem: this.carSystem,
      getHouses: () => this.spawnSystem.getHouses(),
    };
  }

  /**
   * Refund stock for something the eraser destroyed, recording it so undo can take it back.
   *
   * The one place a refund may happen. `handleTryErase` used to bump `this.inventory`
   * directly, which meant the undo group never learned about it: undoing an erase restored
   * the road *and* kept its refund, so erase-then-undo minted roads indefinitely. The
   * `RoadDrawer` branch that did record the delta is unreachable here, because `Game`
   * always installs `onTryErase`.
   */
  private refund(slot: keyof Inventory, count = 1): void {
    this.inventory[slot] += count;
    this.undoSystem.addInventoryDelta(slot, count);
  }

  private handleTryErase(gx: number, gy: number): boolean {
    // Also try erasing highways at this cell. Removing one refunds its stock, so the undo
    // group has to hear about both the entity and the refund.
    for (const highway of this.highwayDrawer.tryEraseAtCell(gx, gy)) {
      this.undoSystem.addRemovedHighway(highway);
      this.undoSystem.addInventoryDelta('highways', 1);
    }

    // Try erasing gas station
    const cell = this.grid.getCell(gx, gy);
    if (cell && (cell.type === CellType.GasStation || (cell.type === CellType.Connector && cell.entityId))) {
      const station = this.gasStationSystem.findByCellPos(gx, gy);
      if (station) {
        this.undoSystem.addRemovedGasStation(station);
        this.gasStationSystem.removeGasStation(station.id);
        this.refund('gasStations');
        return true;
      }
    }

    if (!cell || cell.type !== CellType.Road) return false;

    if (cell.pendingDeletion) return false;

    // Which cars would this cell disappearing hurt? The simulation owns the answer.
    const dependentCarIds = this.carSystem.carsDependingOn(gx, gy);

    if (dependentCarIds.length === 0) {
      if (this.roadSystem.removeRoad(gx, gy)) {
        this.refund('roads');
        return true;
      }
      return false;
    }

    this.pendingDeletionSystem.markPending(gx, gy, dependentCarIds);
    return true;
  }

  private update(dt: number): void {
    if (this.state === GameState.WaitingToStart) return;

    // Road/highway/gas station editing — always runs (even when paused)
    this.roadDrawer.update();
    this.highwayDrawer.update();
    this.gasStationPlacer.update();

    flushWorldDirty(this.worldFrameSystems(), this.renderer);
    updateConnectorStatus(this.grid, this.spawnSystem.getBusinesses());

    // Game simulation — only when playing
    if (this.state !== GameState.Playing) return;

    const scaledDt = dt * this.timeScale;
    this.elapsedTime += scaledDt;
    if (CAR_DEBUG) this.carSystem.setElapsedTime(this.elapsedTime);

    // A new week grants its bonus and offers a choice; pausing for it is Game's call,
    // because the economy has no business knowing about game state or music.
    if (this.economy.tick(this.elapsedTime)) {
      this.state = GameState.Paused;
      this.musicSystem.stopMusic();
    }

    this.spawnSystem.update(scaledDt);

    if (this.spawnSystem.isDirty) {
      this.renderer.markGroundDirty();
      this.spawnSystem.clearDirty();
    }

    this.demandSystem.update(scaledDt, this.spawnSystem.getBusinesses());
    // Chirp in sync with pulse animation (sin wave crossing from negative to positive)
    const hasWarning = this.spawnSystem.getBusinesses().some(b => b.demandPins >= this.cfg.MAX_DEMAND_PINS - 2);
    if (hasWarning) {
      const sinVal = Math.sin(Date.now() * 0.006);
      if (sinVal >= 0 && this.demandWarnPrevSin < 0) {
        try { this.soundEffects.playDemandWarning(); } catch { /* audio timing glitch — non-fatal */ }
      }
      this.demandWarnPrevSin = sinVal;
    } else {
      this.demandWarnPrevSin = 0;
    }
    this.carSystem.update(scaledDt, this.spawnSystem.getHouses(), this.spawnSystem.getBusinesses());
    this.pendingDeletionSystem.update();

    if (this.demandSystem.isGameOver) {
      this.state = GameState.GameOver;
      this.musicSystem.stopMusic();
      this.soundEffects.playGameOver();
    }
  }

  private render(alpha: number): void {
    // Request render when game is playing (continuous animation) or waiting to start (show terrain)
    if (this.state === GameState.Playing || this.state === GameState.WaitingToStart) {
      this.renderer.requestRender();
    }

    this.renderer.updateIndicator(this.roadDrawer.getLastBuiltPos());
    this.renderer.updateGasStationPreview(this.gasStationPlacer.getPreviewCells());
    this.renderer.render(
      alpha,
      this.spawnSystem.getHouses(),
      this.spawnSystem.getBusinesses(),
      this.carSystem.getCars(),
      SPAWN_DEBUG ? this.spawnSystem.getSpawnBounds() : null,
      this.input.state.canvasX,
      this.input.state.canvasY,
      this.state === GameState.Paused,
      this.highwaySystem,
      this.activeTool,
      this.highwayDrawer.getPlacementState(),
      this.gasStationSystem.getGasStations(),
    );
    // Counted in one pass per array rather than a `filter` per colour per frame:
    // this runs on every rendered frame, and the filtering version walked the house
    // and business lists four times for each unlocked colour.
    const houseCounts = new Map<GameColor, number>();
    for (const house of this.spawnSystem.getHouses()) {
      houseCounts.set(house.color, (houseCounts.get(house.color) ?? 0) + 1);
    }
    const businessCounts = new Map<GameColor, number>();
    for (const business of this.spawnSystem.getBusinesses()) {
      businessCounts.set(business.color, (businessCounts.get(business.color) ?? 0) + 1);
    }
    const colorDemands = this.demandSystem.getColorDemands();
    const demandStats: DemandStat[] = this.spawnSystem.getUnlockedColors().map(color => {
      const houses = houseCounts.get(color) ?? 0;
      return {
        color,
        demand: colorDemands.get(color) ?? 0,
        // The spawner's own figure, not a flat per-house rate: the two used to disagree,
        // so the HUD reported a supply the simulation never believed.
        supplyPerMin: this.spawnSystem.getColorSupplyRate(color),
        demandPerMin: this.demandSystem.getColorPinOutputRate(color),
        houses,
        businesses: businessCounts.get(color) ?? 0,
      };
    });
    // Only fire stateCallback when values actually change to avoid per-frame React re-renders
    const score = this.carSystem.getScore();
    const gameWeek = this.getGameWeek();
    const weekChoicePending = this.economy.isWeekChoicePending();
    if (this.stateCallback && (
      this.state !== this.prevCallbackState ||
      score !== this.prevCallbackScore ||
      this.elapsedTime !== this.prevCallbackTime ||
      this.inventory.roads !== this.prevCallbackRoads ||
      this.inventory.highways !== this.prevCallbackHighways ||
      this.inventory.gasStations !== this.prevCallbackGasStations ||
      gameWeek !== this.prevCallbackWeek ||
      weekChoicePending !== this.prevCallbackWeekChoice
    )) {
      this.prevCallbackState = this.state;
      this.prevCallbackScore = score;
      this.prevCallbackTime = this.elapsedTime;
      this.prevCallbackRoads = this.inventory.roads;
      this.prevCallbackHighways = this.inventory.highways;
      this.prevCallbackGasStations = this.inventory.gasStations;
      this.prevCallbackWeek = gameWeek;
      this.prevCallbackWeekChoice = weekChoicePending;
      this.stateCallback(this.state, score, this.elapsedTime, { ...this.inventory }, demandStats, this.getGameDay(), this.timeScale, gameWeek, weekChoicePending, this.economy.getPendingChoiceOptions());
    }
  }

  private onResize(): void {
    this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }
}
