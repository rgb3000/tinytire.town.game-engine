/**
 * The single way to turn a `MapConfig` into a populated world.
 *
 * This used to exist in three hand-maintained copies — in `Game`, in `DemoGame` and
 * in `MapDesigner.loadMapConfig` — which had already drifted apart (the `DemoGame`
 * copy silently ignored gas stations, and the designer copy never restored road-side
 * connection bits on neighbouring cells).
 *
 * Scope is deliberately *world state only*: grid cells and the systems that own them.
 * Presentation — renderer dirty flags, colour themes, the designer's editable copies
 * of the paint state — stays with each caller, because they genuinely differ.
 * Obstacles are not handled here either; `ObstacleSystem` already places predefined
 * terrain (including triangle subdivision) from its constructor.
 */
import { CellType } from '../types';
import { forEachDirection, opposite } from '../utils/direction';
import { omitUndefined } from '../utils/omitUndefined';
import type { Grid } from './Grid';
import type { RoadSystem } from '../systems/RoadSystem';
import type { SpawnSystem } from '../systems/SpawnSystem';
import type { HighwaySystem } from '../systems/HighwaySystem';
import type { GasStationSystem } from '../systems/GasStationSystem';
import type { MapConfig, BackgroundTileDefinition } from '../maps/types';

export interface MapWorld {
  grid: Grid;
  roadSystem: RoadSystem;
  spawnSystem: SpawnSystem;
  highwaySystem: HighwaySystem;
  /** Optional: the demo background renders no gas stations. */
  gasStationSystem?: GasStationSystem;
}

/** Cells that record which side a road attaches to, rather than joining road-to-road. */
const ROAD_ADJACENT_TYPES: CellType[] = [CellType.Connector, CellType.House, CellType.GasStation];

function placeEntities(config: MapConfig, world: MapWorld): void {
  for (const h of config.houses ?? []) {
    world.spawnSystem.spawnHouse({ gx: h.gx, gy: h.gy }, h.color);
  }
  for (const b of config.businesses ?? []) {
    world.spawnSystem.spawnBusiness({ gx: b.gx, gy: b.gy }, b.color, b.rotation);
  }
  for (const gs of config.gasStations ?? []) {
    world.gasStationSystem?.placeGasStation({ gx: gs.gx, gy: gs.gy });
  }

  // A map that ships its own entities is not on the progressive colour-unlock track.
  if (config.houses?.length || config.businesses?.length) {
    world.spawnSystem.unlockAllColors();
  }
}

function placeRoads(config: MapConfig, world: MapWorld): void {
  const roads = config.roads;
  if (!roads?.length) return;

  for (const r of roads) {
    world.roadSystem.placeRoad(r.gx, r.gy);
  }

  // Connections are restored in a second pass: placeRoad() derives them from the
  // neighbours that existed at the time, which would clobber the saved layout.
  for (const r of roads) {
    const cell = world.grid.getCell(r.gx, r.gy);
    if (cell?.type === CellType.Road) cell.roadConnections = r.connections ?? 0;
  }

  // Third pass: mirror each road's connections onto the house/connector/gas-station
  // cell it points at, so buildings read as connected.
  for (const r of roads) {
    const cell = world.grid.getCell(r.gx, r.gy);
    if (cell?.type !== CellType.Road) continue;
    forEachDirection(cell.roadConnections, (dir) => {
      const neighbor = world.grid.getNeighbor(r.gx, r.gy, dir);
      if (neighbor && ROAD_ADJACENT_TYPES.includes(neighbor.cell.type)) {
        neighbor.cell.roadConnections |= opposite(dir);
      }
    });
  }

  world.roadSystem.markDirty();
}

function placeHighways(config: MapConfig, world: MapWorld): void {
  for (const h of config.highways ?? []) {
    world.highwaySystem.addHighway(
      { gx: h.fromGx, gy: h.fromGy },
      { gx: h.toGx, gy: h.toGy },
      { x: h.cp1X, y: h.cp1Y },
      { x: h.cp2X, y: h.cp2Y },
    );
  }
}

/**
 * Populate `world` with everything `config` describes. Safe to call on a freshly
 * constructed set of systems; it does not clear existing state.
 */
export function applyMapConfig(config: MapConfig, world: MapWorld): void {
  placeEntities(config, world);
  placeRoads(config, world);
  placeHighways(config, world);
}

/** Background tiles are stored as a list on the wire and keyed by cell in memory. */
export function backgroundTilesToMap(
  tiles: BackgroundTileDefinition[],
): Map<string, { top?: number; right?: number; bottom?: number; left?: number }> {
  const map = new Map<string, { top?: number; right?: number; bottom?: number; left?: number }>();
  for (const t of tiles) {
    map.set(`${t.gx},${t.gy}`, omitUndefined({ top: t.top, right: t.right, bottom: t.bottom, left: t.left }));
  }
  return map;
}
