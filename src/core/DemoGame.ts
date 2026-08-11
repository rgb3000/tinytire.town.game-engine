import * as THREE from 'three';
import { createWebGLRenderer } from '../rendering/createWebGLRenderer';
import { Grid } from './Grid';
import { GameLoop } from './GameLoop';
import { IsometricRenderer } from '../rendering/IsometricRenderer';
import { RoadSystem } from '../systems/RoadSystem';
import { SpawnSystem } from '../systems/SpawnSystem';
import { DemandSystem } from '../systems/DemandSystem';
import { CarSystem } from '../systems/CarSystem';
import { ObstacleSystem } from '../systems/ObstacleSystem';
import { Pathfinder } from '../pathfinding/Pathfinder';
import { PendingDeletionSystem } from '../systems/PendingDeletionSystem';
import { HighwaySystem } from '../systems/HighwaySystem';
import { buildConfig } from '../constants';
import type { MapConfig } from '../maps/types';
import { buildColorTheme } from '../designer/colorTheme';
import { applyMapConfig, backgroundTilesToMap } from './applyMapConfig';
import { flushWorldDirty, updateConnectorStatus } from './worldFrame';

export class DemoGame {
  private webglRenderer: THREE.WebGLRenderer;
  private grid: Grid;
  private gameLoop: GameLoop;
  private renderer: IsometricRenderer;
  private roadSystem: RoadSystem;
  private spawnSystem: SpawnSystem;
  private demandSystem: DemandSystem;
  private carSystem: CarSystem;
  private obstacleSystem: ObstacleSystem;
  private pathfinder: Pathfinder;
  private highwaySystem: HighwaySystem;
  private pendingDeletionSystem: PendingDeletionSystem;
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement, mapConfig: MapConfig) {
    const cfg = buildConfig(mapConfig.constants);

    this.webglRenderer = createWebGLRenderer(canvas);

    this.grid = new Grid();
    this.obstacleSystem = new ObstacleSystem(this.grid, mapConfig.obstacles, cfg);
    this.obstacleSystem.generate();
    this.roadSystem = new RoadSystem(this.grid);
    this.highwaySystem = new HighwaySystem();
    this.pathfinder = new Pathfinder(this.grid, cfg, this.highwaySystem);
    this.pendingDeletionSystem = new PendingDeletionSystem(this.grid, this.roadSystem);
    this.demandSystem = new DemandSystem(cfg);
    this.spawnSystem = new SpawnSystem(this.grid, this.demandSystem, cfg);
    this.carSystem = new CarSystem(this.pathfinder, this.grid, this.pendingDeletionSystem, cfg, this.highwaySystem);

    this.renderer = new IsometricRenderer(
      this.webglRenderer, this.grid,
      () => this.spawnSystem.getHouses(),
      () => this.spawnSystem.getBusinesses(),
      this.carSystem.getTrafficAdapter(),
    );
    this.renderer.rebuildTerrain(
      this.obstacleSystem.getMountainCells(),
      this.obstacleSystem.getLakeCells(),
      this.obstacleSystem.getMountainTriangles(),
      this.obstacleSystem.getLakeTriangles(),
    );
    if (mapConfig.backgroundTiles && mapConfig.paintPalette) {
      this.renderer.setBackgroundTiles(
        backgroundTilesToMap(mapConfig.backgroundTiles),
        [...mapConfig.paintPalette],
      );
    }
    if (mapConfig.colorTheme) {
      this.renderer.applyColorTheme(buildColorTheme(mapConfig.colorTheme));
    }
    this.renderer.resize(window.innerWidth, window.innerHeight);

    // Register cars when houses are spawned — must precede applyMapConfig.
    this.spawnSystem.onHouseSpawn = (house) => this.carSystem.registerHouse(house);

    // No gasStationSystem on purpose: this is a decorative background with no
    // refuelling, so the home-background map's gas stations are skipped. Passing one
    // here would start rendering them on the landing page.
    applyMapConfig(mapConfig, {
      grid: this.grid,
      roadSystem: this.roadSystem,
      spawnSystem: this.spawnSystem,
      highwaySystem: this.highwaySystem,
    });
    if (mapConfig.highways?.length) this.renderer.markHighwayDirty();

    this.renderer.markGroundDirty();
    this.spawnSystem.clearDirty();

    // No-op home return (no money tracking needed)
    this.carSystem.onHomeReturn = () => {};

    this.gameLoop = new GameLoop(
      (dt) => this.update(dt),
      (alpha) => this.render(alpha),
    );

    this.resizeHandler = () => {
      this.webglRenderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this.resizeHandler);
  }

  start(): void {
    this.gameLoop.start();
  }

  stop(): void {
    this.gameLoop.stop();
  }

  dispose(): void {
    this.gameLoop.stop();
    this.renderer.dispose();
    this.webglRenderer.dispose();
    window.removeEventListener('resize', this.resizeHandler);
  }

  private update(dt: number): void {
    // No `gasStationSystem`: this world has none, by the constructor's design.
    flushWorldDirty({
      grid: this.grid,
      roadSystem: this.roadSystem,
      highwaySystem: this.highwaySystem,
      pathfinder: this.pathfinder,
      carSystem: this.carSystem,
      getHouses: () => this.spawnSystem.getHouses(),
    }, this.renderer);
    updateConnectorStatus(this.grid, this.spawnSystem.getBusinesses());

    this.spawnSystem.update(dt);
    if (this.spawnSystem.isDirty) {
      this.renderer.markGroundDirty();
      this.spawnSystem.clearDirty();
    }

    this.demandSystem.update(dt, this.spawnSystem.getBusinesses());
    this.carSystem.update(dt, this.spawnSystem.getHouses(), this.spawnSystem.getBusinesses());
    this.pendingDeletionSystem.update();
  }

  private render(alpha: number): void {
    this.renderer.render(
      alpha,
      this.spawnSystem.getHouses(),
      this.spawnSystem.getBusinesses(),
      this.carSystem.getCars(),
      null, 0, 0, false,
      this.highwaySystem,
    );
  }
}
