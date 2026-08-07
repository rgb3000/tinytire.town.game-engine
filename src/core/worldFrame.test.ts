/**
 * Covers `flushWorldDirty` — the per-frame reaction to a changed world that `Game`,
 * `DemoGame` and `MapDesigner` all share.
 *
 * Worth testing because it is the one piece of the frame that every world runs and none of
 * them can observe: a flag that is cleared without telling the renderer shows up as a stale
 * frame, and a flag that is never cleared shows up as a permanent recompute. It is testable
 * at all only because the renderer arrives as `FrameRenderTarget` — two methods, no WebGL.
 */
import { describe, it, expect, vi } from 'vitest';

import { buildConfig } from '../constants';
import { CellType, Direction } from '../types';
import { Grid } from './Grid';
import { flushWorldDirty, updateConnectorStatus, type FrameRenderTarget, type WorldFrameSystems } from './worldFrame';
import { RoadSystem } from '../systems/RoadSystem';
import { HighwaySystem } from '../systems/HighwaySystem';
import { GasStationSystem } from '../systems/GasStationSystem';
import { CarSystem } from '../systems/CarSystem';
import { PendingDeletionSystem } from '../systems/PendingDeletionSystem';
import { Pathfinder } from '../pathfinding/Pathfinder';
import { Business } from '../entities/Business';
import { GameColor } from '../types';

function fakeRenderer(): FrameRenderTarget & { ground: number; highway: number } {
  return {
    ground: 0,
    highway: 0,
    markGroundDirty() { this.ground++; },
    markHighwayDirty() { this.highway++; },
  };
}

/** A full set of systems, as `Game` has. The other two worlds pass subsets of this. */
function makeWorld(): WorldFrameSystems & {
  grid: Grid;
  roadSystem: RoadSystem;
  highwaySystem: HighwaySystem;
  gasStationSystem: GasStationSystem;
  pathfinder: Pathfinder;
  carSystem: CarSystem;
} {
  const cfg = buildConfig();
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);
  const highwaySystem = new HighwaySystem();
  const gasStationSystem = new GasStationSystem(grid);
  const pathfinder = new Pathfinder(grid, cfg, highwaySystem);
  const carSystem = new CarSystem(pathfinder, grid, new PendingDeletionSystem(grid, roadSystem), cfg, highwaySystem, gasStationSystem);
  return {
    grid, roadSystem, highwaySystem, gasStationSystem, pathfinder, carSystem,
    getHouses: () => [],
  };
}

describe('flushWorldDirty', () => {
  it('does nothing at all when no system is dirty', () => {
    const world = makeWorld();
    const renderer = fakeRenderer();
    const clearCache = vi.spyOn(world.pathfinder, 'clearCache');
    const onRoadsChanged = vi.spyOn(world.carSystem, 'onRoadsChanged');

    flushWorldDirty(world, renderer);

    expect(renderer.ground).toBe(0);
    expect(renderer.highway).toBe(0);
    expect(clearCache).not.toHaveBeenCalled();
    expect(onRoadsChanged).not.toHaveBeenCalled();
  });

  it('clears the road flag, repaints the ground and recomputes intersection flags', () => {
    const world = makeWorld();
    const renderer = fakeRenderer();

    // A crossroads: three cardinal connections is what makes a cell an intersection.
    world.roadSystem.placeRoad(4, 4);
    const cell = world.grid.getCell(4, 4)!;
    cell.roadConnections = Direction.Up | Direction.Down | Direction.Left;
    expect(cell._isIntersection).toBe(false);

    flushWorldDirty(world, renderer);

    expect(world.roadSystem.isDirty).toBe(false);
    expect(renderer.ground).toBe(1);
    expect(renderer.highway).toBe(0);
    // The designer used to skip this, so its road edits left the flags stale.
    expect(cell._isIntersection).toBe(true);
    expect(cell._isTIntersection).toBe(true);
  });

  it('clears the highway flag and repaints highways only', () => {
    const world = makeWorld();
    const renderer = fakeRenderer();
    world.highwaySystem.addHighway({ gx: 1, gy: 1 }, { gx: 5, gy: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 });

    flushWorldDirty(world, renderer);

    expect(world.highwaySystem.isDirty).toBe(false);
    expect(renderer.highway).toBe(1);
    expect(renderer.ground).toBe(0);
  });

  it('clears the gas station flag and repaints the ground', () => {
    const world = makeWorld();
    const renderer = fakeRenderer();
    world.gasStationSystem.placeGasStation({ gx: 7, gy: 7 });

    flushWorldDirty(world, renderer);

    expect(world.gasStationSystem.isDirty).toBe(false);
    expect(renderer.ground).toBe(1);
  });

  it('invalidates paths and reroutes cars when any one of the three changed', () => {
    // Not just roads: a new highway or gas station changes what the pathfinder would answer,
    // which is why the reroute sits above the per-flag branches.
    for (const dirty of ['road', 'highway', 'gasStation'] as const) {
      const world = makeWorld();
      const clearCache = vi.spyOn(world.pathfinder, 'clearCache');
      const onRoadsChanged = vi.spyOn(world.carSystem, 'onRoadsChanged');

      if (dirty === 'road') world.roadSystem.placeRoad(2, 2);
      if (dirty === 'highway') world.highwaySystem.addHighway({ gx: 1, gy: 1 }, { gx: 5, gy: 5 }, { x: 0, y: 0 }, { x: 10, y: 10 });
      if (dirty === 'gasStation') world.gasStationSystem.placeGasStation({ gx: 7, gy: 7 });

      flushWorldDirty(world, fakeRenderer());

      expect(clearCache, dirty).toHaveBeenCalledTimes(1);
      expect(onRoadsChanged, dirty).toHaveBeenCalledTimes(1);
    }
  });

  it('handles the systems a world genuinely lacks', () => {
    // The demo backdrop has no gas stations; the designer has no pathfinder and no cars.
    const world = makeWorld();
    const renderer = fakeRenderer();
    world.roadSystem.placeRoad(3, 3);

    expect(() => flushWorldDirty({
      grid: world.grid,
      roadSystem: world.roadSystem,
      highwaySystem: world.highwaySystem,
    }, renderer)).not.toThrow();

    expect(world.roadSystem.isDirty).toBe(false);
    expect(renderer.ground).toBe(1);
  });

  it('clears each flag exactly once, so a second flush is a no-op', () => {
    const world = makeWorld();
    const renderer = fakeRenderer();
    world.roadSystem.placeRoad(3, 3);
    world.gasStationSystem.placeGasStation({ gx: 7, gy: 7 });

    flushWorldDirty(world, renderer);
    const groundAfterFirst = renderer.ground;
    flushWorldDirty(world, renderer);

    expect(renderer.ground).toBe(groundAfterFirst);
  });
});

describe('updateConnectorStatus', () => {
  it('reports a business as connected only while a road reaches its connector', () => {
    const grid = new Grid();
    const business = new Business({ gx: 10, gy: 10 }, GameColor.Red, 0);
    const connector = grid.getCell(business.connectorPos.gx, business.connectorPos.gy)!;
    connector.type = CellType.Connector;

    updateConnectorStatus(grid, [business]);
    expect(business.connected).toBe(false);

    connector.roadConnections = Direction.Up;
    updateConnectorStatus(grid, [business]);
    expect(business.connected).toBe(true);

    connector.roadConnections = 0;
    updateConnectorStatus(grid, [business]);
    expect(business.connected).toBe(false);
  });
});
