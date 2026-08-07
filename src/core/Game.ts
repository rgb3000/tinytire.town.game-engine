import * as THREE from 'three';
import { createWebGLRenderer } from '../rendering/createWebGLRenderer';
import { CellType, GameState, Tool } from '../types';
import type { GameColor } from '../types';
import { Grid } from './Grid';
import { GameLoop } from './GameLoop';
import { Renderer } from '../rendering/Renderer';
import { InputHandler } from '../input/InputHandler';
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
import { stepGridPos } from '../systems/car/CarRouter';
import { SPAWN_DEBUG, DEMAND_DEBUG, CAR_DEBUG, TILE_SIZE, buildConfig } from '../constants';
import { CarEventLog } from '../debug/CarEventLog';
import type { Car } from '../entities/Car';
import type { MapConfig, Inventory, WeeklyChoiceOption } from '../maps/types';
import type { GameConstants } from '../maps/types';
import { buildColorTheme } from '../designer/colorTheme';
import { applyMapConfig, backgroundTilesToMap } from './applyMapConfig';

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
  private inventory!: Inventory;

  private demandWarnPrevSin = 0;
  private musicSystem: MusicSystem = new MusicSystem();
  private soundEffects: SoundEffectSystem = new SoundEffectSystem();
  private state: GameState = GameState.WaitingToStart;
  private elapsedTime = 0;
  private timeScale: number = 1;
  private currentWeek = 1;
  private weekChoicePending = false;
  private pendingChoiceOptions: WeeklyChoiceOption[] = [];
  private stateCallback: ((state: GameState, score: number, time: number, inventory: Inventory, demandStats: DemandStat[] | null, gameDay: number, timeScale: number, gameWeek: number, weekChoicePending: boolean, pendingChoiceOptions: WeeklyChoiceOption[]) => void) | null = null;
  private spaceDown = false;
  private isPanning = false;
  private lastPanX = 0;
  private lastPanY = 0;
  private lastTiltY = 0;
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
  private keydownHandler: (e: KeyboardEvent) => void;
  private keyupHandler: (e: KeyboardEvent) => void;

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

    // Wheel: pan (normal scroll) or zoom (ctrl/pinch)
    canvas.addEventListener('wheel', (e) => this.renderer.onWheel(e), { passive: false });

    // Window resize
    this.resizeHandler = () => this.onResize();
    window.addEventListener('resize', this.resizeHandler);

    // Keyboard zoom + pause + tool shortcuts + space panning
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') this.renderer.zoomByKey(1);
      if (e.key === '-') this.renderer.zoomByKey(-1);
      if (e.key === 'Escape' || e.key === 'p') this.togglePause();
      if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.performUndo();
      }
      if (e.key === 'r' || e.key === 'R') this.setActiveTool(Tool.Road);
      if (e.key === 'e' || e.key === 'E') this.setActiveTool(Tool.Eraser);
      if (e.key === 'h' || e.key === 'H') this.setActiveTool(Tool.Highway);
      if (e.key === 'g' || e.key === 'G') this.setActiveTool(Tool.GasStation);
      if (e.key === 'f' || e.key === 'F') this.toggleSpeed();
      if (e.key === 'v' || e.key === 'V') this.toggleIsometric();
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        this.spaceDown = true;
        this.lastTiltY = -1;
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
        this.canvas.style.cursor = this.activeTool === Tool.Eraser ? 'crosshair' : 'default';
        this.renderer.resetTilt();
      }
    };
    window.addEventListener('keyup', this.keyupHandler);

    // Space+drag panning
    canvas.addEventListener('mousedown', (e) => {
      if (this.spaceDown && e.button === 0) {
        this.isPanning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.renderer.panByScreen(dx, dy);
      } else if (this.spaceDown) {
        if (this.renderer.getIsometric()) {
          // In isometric mode, skip manual tilt
        } else if (this.lastTiltY < 0) {
          this.lastTiltY = e.clientY;
        } else {
          const dy = e.clientY - this.lastTiltY;
          this.lastTiltY = e.clientY;
          this.renderer.tiltBy(-dy * 0.003);
        }
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.isPanning) {
        this.isPanning = false;
        this.canvas.style.cursor = this.spaceDown ? 'grab' : (this.activeTool === Tool.Eraser ? 'crosshair' : 'default');
      }
    });

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

    this.renderer = new Renderer(this.webglRenderer, this.grid, () => this.spawnSystem.getHouses(), () => this.spawnSystem.getBusinesses());
    this.renderer.buildObstacles(this.obstacleSystem.getMountainCells(), this.obstacleSystem.getLakeCells(), this.obstacleSystem.getMountainTriangles(), this.obstacleSystem.getLakeTriangles());
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
    this.roadDrawer = new RoadDrawer(this.input, this.roadSystem, this.grid, this.createInventorySlot('roads'), () => this.spawnSystem.getHouses(), this.undoSystem, () => this.activeTool);
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
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
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
    return Math.floor((this.getGameDay() - 1) / this.cfg.WEEK_LENGTH_DAYS) + 1;
  }

  isWeekChoicePending(): boolean {
    return this.weekChoicePending;
  }

  getPendingChoiceOptions(): WeeklyChoiceOption[] {
    return this.pendingChoiceOptions;
  }

  applyWeeklyChoice(option: WeeklyChoiceOption): void {
    this.inventory[option.type] += option.amount;
    this.weekChoicePending = false;
    this.pendingChoiceOptions = [];
    if (this.state === GameState.Paused) {
      this.state = GameState.Playing;
      this.musicSystem.startMusic();
    }
  }

  private createInventorySlot(slot: keyof Inventory): InventorySlot {
    return {
      hasStock: (count: number) => this.inventory[slot] >= count,
      consume: (count: number) => { this.inventory[slot] -= count; },
      restore: (count: number) => { this.inventory[slot] += count; },
    };
  }

  private generateChoiceOptions(): WeeklyChoiceOption[] {
    const pool: WeeklyChoiceOption[] = [
      { type: 'roads', amount: 20, label: '+20 Roads' },
      { type: 'gasStations', amount: 1, label: '+1 Gas Station' },
    ];
    if (this.currentWeek >= this.cfg.HIGHWAY_UNLOCK_WEEK) {
      pool.push({ type: 'highways', amount: 1, label: '+1 Highway' });
    }
    // Shuffle and take 2
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 2);
  }

  onStateUpdate(cb: (state: GameState, score: number, time: number, inventory: Inventory, demandStats: DemandStat[] | null, gameDay: number, timeScale: number, gameWeek: number, weekChoicePending: boolean, pendingChoiceOptions: WeeklyChoiceOption[]) => void): void {
    this.stateCallback = cb;
  }

  getGameDay(): number {
    return Math.floor(this.elapsedTime / this.cfg.DAY_LENGTH_SECONDS) + 1;
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  getWeekLengthDays(): number {
    return this.cfg.WEEK_LENGTH_DAYS;
  }

  getWeeklyRoadBonus(): number {
    return this.cfg.WEEKLY_ROAD_BONUS;
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

    // Reset the run's own state; everything else is rebuilt from scratch.
    this.elapsedTime = 0;
    this.timeScale = 1;
    this.currentWeek = 1;
    this.weekChoicePending = false;
    this.pendingChoiceOptions = [];
    this.demandWarnPrevSin = 0;

    this.musicSystem = new MusicSystem();
    this.soundEffects = new SoundEffectSystem();
    this.buildWorld();
    this.setActiveTool(Tool.Road);

    this.audioInitialized = false;
    await this.initAudio();
    this.state = GameState.Playing;
  }

  performUndo(): void {
    if (this.state === GameState.GameOver) return;
    const group = this.undoSystem.undo();
    if (!group) return;
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
    this.canvas.style.cursor = (tool === Tool.Eraser || tool === Tool.Highway || tool === Tool.GasStation) ? 'crosshair' : 'default';
    this.toolChangeCallback?.(tool);
  }

  onToolChange(cb: ((tool: Tool) => void) | null): void {
    this.toolChangeCallback = cb;
  }

  private handleTryErase(gx: number, gy: number): boolean {
    // Also try erasing highways at this cell
    this.highwayDrawer.tryEraseAtCell(gx, gy);

    // Try erasing gas station
    const cell = this.grid.getCell(gx, gy);
    if (cell && (cell.type === CellType.GasStation || (cell.type === CellType.Connector && cell.entityId))) {
      const station = this.gasStationSystem.findByCellPos(gx, gy);
      if (station) {
        this.gasStationSystem.removeGasStation(station.id);
        this.inventory.gasStations += 1;
        return true;
      }
    }

    if (!cell || cell.type !== CellType.Road) return false;

    if (cell.pendingDeletion) return false;

    // Check all car states that depend on this cell
    const cars = this.carSystem.getCars();
    const dependentCarIds: string[] = [];
    for (const car of cars) {
      if (car.state === CarState.GoingToBusiness && car.path.length > 0) {
        for (let i = 0; i < car.pathIndex; i++) {
          const p = stepGridPos(car.path[i]);
          if (p.gx === gx && p.gy === gy) {
            dependentCarIds.push(car.id);
            break;
          }
        }
      } else if (car.state === CarState.Unloading || car.state === CarState.Refueling) {
        for (const step of car.outboundPath) {
          const p = stepGridPos(step);
          if (p.gx === gx && p.gy === gy) {
            dependentCarIds.push(car.id);
            break;
          }
        }
      } else if (car.state === CarState.GoingHome && car.path.length > 0) {
        for (let i = car.pathIndex; i < car.path.length; i++) {
          const p = stepGridPos(car.path[i]);
          if (p.gx === gx && p.gy === gy) {
            dependentCarIds.push(car.id);
            break;
          }
        }
      }
    }

    if (dependentCarIds.length === 0) {
      if (this.roadSystem.removeRoad(gx, gy)) {
        this.inventory.roads += 1;
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

    if (this.roadSystem.isDirty || this.highwaySystem.isDirty || this.gasStationSystem.isDirty) {
      this.pathfinder.clearCache();
      this.carSystem.onRoadsChanged(this.spawnSystem.getHouses());
      if (this.roadSystem.isDirty) {
        this.roadSystem.clearDirty();
        this.grid.recomputeIntersectionFlags();
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
    }

    // Update business connector status
    for (const biz of this.spawnSystem.getBusinesses()) {
      const cell = this.grid.getCell(biz.connectorPos.gx, biz.connectorPos.gy);
      biz.connected = cell ? cell.roadConnections !== 0 : false;
    }

    // Game simulation — only when playing
    if (this.state !== GameState.Playing) return;

    const scaledDt = dt * this.timeScale;
    this.elapsedTime += scaledDt;
    if (CAR_DEBUG) this.carSystem.setElapsedTime(this.elapsedTime);

    // Week transition
    const newWeek = this.getGameWeek();
    if (newWeek > this.currentWeek) {
      this.currentWeek = newWeek;
      this.inventory.roads += this.cfg.WEEKLY_ROAD_BONUS;
      this.pendingChoiceOptions = this.generateChoiceOptions();
      this.weekChoicePending = true;
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
    let demandStats: DemandStat[] | null = null;
    if (DEMAND_DEBUG) {
      const colorDemands = this.demandSystem.getColorDemands();
      demandStats = this.spawnSystem.getUnlockedColors().map(color => ({
        color,
        demand: colorDemands.get(color) ?? 0,
        supplyPerMin: this.spawnSystem.getHouses().filter(h => h.color === color).length * this.cfg.HOUSE_SUPPLY_PER_MINUTE,
        demandPerMin: this.demandSystem.getColorPinOutputRate(color),
        houses: this.spawnSystem.getHouses().filter(h => h.color === color).length,
        businesses: this.spawnSystem.getBusinesses().filter(b => b.color === color).length,
      }));
    }
    // Only fire stateCallback when values actually change to avoid per-frame React re-renders
    const score = this.carSystem.getScore();
    const gameWeek = this.getGameWeek();
    if (this.stateCallback && (
      this.state !== this.prevCallbackState ||
      score !== this.prevCallbackScore ||
      this.elapsedTime !== this.prevCallbackTime ||
      this.inventory.roads !== this.prevCallbackRoads ||
      this.inventory.highways !== this.prevCallbackHighways ||
      this.inventory.gasStations !== this.prevCallbackGasStations ||
      gameWeek !== this.prevCallbackWeek ||
      this.weekChoicePending !== this.prevCallbackWeekChoice ||
      demandStats !== null
    )) {
      this.prevCallbackState = this.state;
      this.prevCallbackScore = score;
      this.prevCallbackTime = this.elapsedTime;
      this.prevCallbackRoads = this.inventory.roads;
      this.prevCallbackHighways = this.inventory.highways;
      this.prevCallbackGasStations = this.inventory.gasStations;
      this.prevCallbackWeek = gameWeek;
      this.prevCallbackWeekChoice = this.weekChoicePending;
      this.stateCallback(this.state, score, this.elapsedTime, { ...this.inventory }, demandStats, this.getGameDay(), this.timeScale, gameWeek, this.weekChoicePending, this.pendingChoiceOptions);
    }
  }

  private onResize(): void {
    this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }
}
