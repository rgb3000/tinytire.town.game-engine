/**
 * `applyMapConfig` replaced three hand-maintained copies of this logic that had
 * already drifted apart. These tests pin the behaviour all three callers now share,
 * in particular the three-pass road restore, which is the part most likely to be
 * broken by a well-meaning simplification.
 *
 * Everything here is pure — no DOM, no WebGL — because the renderer deliberately
 * stays outside applyMapConfig's scope.
 */
import { describe, it, expect } from 'vitest';

import { applyMapConfig, backgroundTilesToMap } from './applyMapConfig';
import type { MapWorld } from './applyMapConfig';
import { Grid } from './Grid';
import { RoadSystem } from '../systems/RoadSystem';
import { SpawnSystem } from '../systems/SpawnSystem';
import { HighwaySystem } from '../systems/HighwaySystem';
import { GasStationSystem } from '../systems/GasStationSystem';
import { DemandSystem } from '../systems/DemandSystem';
import { buildConfig } from '../constants';
import { CellType, GameColor, Direction } from '../types';
import { ALL_DIRECTIONS, opposite } from '../utils/direction';
import type { MapConfig } from '../maps/types';

function makeWorld(): MapWorld {
  const cfg = buildConfig();
  const grid = new Grid();
  return {
    grid,
    roadSystem: new RoadSystem(grid),
    spawnSystem: new SpawnSystem(grid, new DemandSystem(cfg), cfg),
    highwaySystem: new HighwaySystem(),
    gasStationSystem: new GasStationSystem(grid),
  };
}

const base: MapConfig = { id: 'w', name: 'W', description: '' };

describe('entities', () => {
  it('places houses, businesses and gas stations', () => {
    const world = makeWorld();

    applyMapConfig({
      ...base,
      houses: [{ gx: 5, gy: 5, color: GameColor.Blue }],
      businesses: [{ gx: 10, gy: 10, color: GameColor.Green, rotation: 0 }],
      gasStations: [{ gx: 20, gy: 20 }],
    }, world);

    expect(world.spawnSystem.getHouses()).toHaveLength(1);
    expect(world.spawnSystem.getHouses()[0].color).toBe(GameColor.Blue);
    expect(world.spawnSystem.getBusinesses()).toHaveLength(1);
    expect(world.gasStationSystem!.getGasStations()).toHaveLength(1);
    expect(world.grid.getCell(20, 20)!.type).toBe(CellType.GasStation);
  });

  it('places gas stations even when the map defines no houses or businesses', () => {
    // The old Game copy nested gas stations inside the "has predefined entities"
    // branch, so a terrain-only map with gas stations silently got none.
    const world = makeWorld();
    applyMapConfig({ ...base, gasStations: [{ gx: 7, gy: 7 }] }, world);
    expect(world.gasStationSystem!.getGasStations()).toHaveLength(1);
  });

  it('unlocks all colours only for maps that ship their own entities', () => {
    const withEntities = makeWorld();
    applyMapConfig({ ...base, houses: [{ gx: 5, gy: 5, color: GameColor.Orange }] }, withEntities);
    expect(withEntities.spawnSystem.getUnlockedColors()).toHaveLength(6);

    // A map with only terrain stays on the progressive unlock track.
    const terrainOnly = makeWorld();
    applyMapConfig({ ...base, roads: [{ gx: 1, gy: 1 }] }, terrainOnly);
    expect(terrainOnly.spawnSystem.getUnlockedColors()).toHaveLength(1);
  });

  it('tolerates a config with nothing in it', () => {
    const world = makeWorld();
    expect(() => applyMapConfig(base, world)).not.toThrow();
    expect(world.spawnSystem.getHouses()).toHaveLength(0);
  });
});

describe('roads', () => {
  it('restores saved connections rather than re-deriving them', () => {
    const world = makeWorld();
    const connections = Direction.Left | Direction.Right;

    applyMapConfig({
      ...base,
      roads: [
        { gx: 3, gy: 3, connections },
        { gx: 4, gy: 3, connections },
      ],
    }, world);

    expect(world.grid.getCell(3, 3)!.type).toBe(CellType.Road);
    expect(world.grid.getCell(3, 3)!.roadConnections).toBe(connections);
    expect(world.grid.getCell(4, 3)!.roadConnections).toBe(connections);
  });

  it('mirrors road connections onto the house cell they point at', () => {
    // This third pass is what makes buildings read as "connected". The designer copy
    // never did it, so loading a saved map there showed connected houses as isolated.
    const world = makeWorld();

    applyMapConfig({
      ...base,
      houses: [{ gx: 8, gy: 8, color: GameColor.Red }],
      // A road immediately to the right of the house, pointing left at it.
      roads: [{ gx: 9, gy: 8, connections: Direction.Left }],
    }, world);

    const houseCell = world.grid.getCell(8, 8)!;
    expect(houseCell.type).toBe(CellType.House);
    expect(houseCell.roadConnections & Direction.Right).toBeTruthy();
  });

  it('mirrors road connections onto a business connector cell', () => {
    const businesses = [{ gx: 12, gy: 12, color: GameColor.Yellow, rotation: 0 as const }];

    // Locate the connector, then find a free neighbour to approach it from — the
    // business fills a 2x2 block, so not every neighbouring cell is placeable.
    const probe = makeWorld();
    applyMapConfig({ ...base, businesses }, probe);
    const connector = probe.spawnSystem.getBusinesses()[0].connectorPos;

    const approach = ALL_DIRECTIONS
      .map((dir) => ({ dir, neighbor: probe.grid.getNeighbor(connector.gx, connector.gy, dir) }))
      .find(({ neighbor }) => neighbor?.cell.type === CellType.Empty);
    expect(approach, 'expected the connector to have at least one free neighbour').toBeDefined();

    const { dir, neighbor } = approach!;
    const world = makeWorld();
    applyMapConfig({
      ...base,
      businesses,
      // A road on that neighbour, pointing back at the connector.
      roads: [{ gx: neighbor!.gx, gy: neighbor!.gy, connections: opposite(dir) }],
    }, world);

    const connectorCell = world.grid.getCell(connector.gx, connector.gy)!;
    expect(connectorCell.type).toBe(CellType.Connector);
    expect(connectorCell.roadConnections & dir).toBeTruthy();
  });

  it('marks the road system dirty so downstream systems recompute', () => {
    const world = makeWorld();
    expect(world.roadSystem.isDirty).toBe(false);
    applyMapConfig({ ...base, roads: [{ gx: 1, gy: 1 }] }, world);
    expect(world.roadSystem.isDirty).toBe(true);
  });

  it('leaves the road system clean when the map has no roads', () => {
    const world = makeWorld();
    applyMapConfig(base, world);
    expect(world.roadSystem.isDirty).toBe(false);
  });
});

describe('highways', () => {
  it('recreates highways with their control points', () => {
    const world = makeWorld();

    applyMapConfig({
      ...base,
      highways: [{ fromGx: 1, fromGy: 2, toGx: 8, toGy: 9, cp1X: 100, cp1Y: 200, cp2X: 300, cp2Y: 400 }],
    }, world);

    const [highway] = world.highwaySystem.getAll();
    expect(highway.fromPos).toEqual({ gx: 1, gy: 2 });
    expect(highway.toPos).toEqual({ gx: 8, gy: 9 });
    expect(highway.cp1).toEqual({ x: 100, y: 200 });
    expect(world.highwaySystem.isDirty).toBe(true);
  });
});

describe('backgroundTilesToMap', () => {
  it('keys tiles by cell and keeps every quadrant', () => {
    const map = backgroundTilesToMap([
      { gx: 1, gy: 2, top: 0, left: 4 },
      { gx: 3, gy: 4, bottom: 2 },
    ]);

    expect(map.size).toBe(2);
    expect(map.get('1,2')).toEqual({ top: 0, right: undefined, bottom: undefined, left: 4 });
    expect(map.get('3,4')!.bottom).toBe(2);
  });
});
