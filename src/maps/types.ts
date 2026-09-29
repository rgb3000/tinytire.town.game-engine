import type { GameColor } from '../types';

export interface ObstacleDefinition {
  gx: number;
  gy: number;
  type: 'mountain' | 'lake';
  /**
   * @deprecated Ignored since the terrain rebuild — terrace count is derived from a
   * landform's actual thickness, not from a per-cell height. Still accepted by the schema
   * and passed through by `serializeMap` so existing maps keep round-tripping unchanged.
   */
  height?: number;
  top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; // triangle subdivision (mountains & lakes)
}

/** Per-cell triangle data for mountains. When all 4 are true or absent → full cell. */
export type MountainTriangles = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>;

/** Per-cell triangle data for lakes. When all 4 are true or absent → full cell. */
export type LakeTriangles = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>;

export interface HouseDefinition {
  gx: number;
  gy: number;
  color: GameColor;
}

export interface BusinessDefinition {
  gx: number;
  gy: number;
  color: GameColor;
  rotation: 0 | 90 | 180 | 270;
}

export interface RoadDefinition {
  gx: number;
  gy: number;
  connections?: number;  // bitmask of Direction flags
}

export interface HighwayDefinition {
  fromGx: number;
  fromGy: number;
  toGx: number;
  toGy: number;
  cp1X: number;
  cp1Y: number;
  cp2X: number;
  cp2Y: number;
}

export interface GasStationDefinition {
  gx: number;
  gy: number;
  orientation?: 'horizontal' | 'vertical'; // legacy, ignored — gas stations are single-tile
}

export interface Inventory {
  roads: number;
  highways: number;
  gasStations: number;
}

export interface WeeklyChoiceOption {
  type: keyof Inventory;
  amount: number;
  label: string;
}

/**
 * The gameplay constants a map may override, via `constants` in its JSON.
 *
 * Every key here must actually be *honoured* at runtime — that is, read from the resolved
 * config rather than imported as a module constant from `src/constants.ts`. That invariant
 * is enforced by `src/constants.test.ts`; add a key here and the test will tell you if you
 * forgot to wire it up.
 *
 * Grid size is deliberately absent. `GRID_COLS`/`GRID_ROWS` used to be listed, but only
 * `Grid` itself ever honoured them: roughly thirty sites bake the module constants into
 * flat-array strides (`RoadPlacementPathfinder`, `RoadLayer`), bounds checks (`RoadDrawer`)
 * and constructor-time geometry (`Renderer`'s ground mesh, shadow frustum, offscreen canvas
 * and screenshot capture), so a map that set them got a world and a renderer that disagreed.
 * Making it real means threading dimensions through all of those; the list above is the
 * inventory if that is ever worth doing.
 */
export interface GameConstants {
  // Demand
  /**
   * NOTE: honoured by the simulation (`DemandSystem`, `Game.update`) but *not* by the
   * renderer, which still reads the module constant in `Renderer.ts` and `BusinessLayer.ts`.
   * Pin geometry is also a fixed 3x3 grid (`src/utils/businessLayout.ts`), so values above 9
   * cannot render. See the allow-list in `src/constants.test.ts`.
   */
  MAX_DEMAND_PINS: number;
  DEMAND_BASE_RATE: number;
  DEMAND_RATE_GROWTH: number;
  DEMAND_PIN_COOLDOWN: number;

  // Cars
  CARS_PER_HOUSE: number;
  CAR_SPEED: number;

  // Unloading
  UNLOAD_TIME: number;

  // Spawning
  INITIAL_SPAWN_DELAY: number;
  COLOR_UNLOCK_INTERVAL: number;
  HOUSE_CLUSTER_RADIUS: number;
  HOUSE_RANDOM_PLACEMENT_CHANCE: number;
  MIN_BUSINESS_DISTANCE: number;
  SPAWN_INTERVAL: number;
  MIN_SPAWN_INTERVAL: number;
  SPAWN_INTERVAL_DECAY: number;

  // Inventory
  STARTING_ROADS: number;
  STARTING_GAS_STATIONS: number;
  STARTING_HIGHWAYS: number;
  WEEK_LENGTH_DAYS: number;
  WEEKLY_ROAD_BONUS: number;
  HIGHWAY_UNLOCK_WEEK: number;

  // Obstacles
  //
  // `_COUNT` is how many landforms are generated. The `_MIN_SIZE`/`_MAX_SIZE` pair is a
  // target *area* in cells, not an exact cell count: the landform is grown to that area's
  // radius and noise then decides how many cells it actually takes. Very small targets are
  // rounded up to a radius that still reads as a landform, and the lake pair is exceeded
  // outright for a lake that `LAKE_ISLAND_CHANCE` has picked to carry an island.
  MOUNTAIN_CLUSTER_COUNT: number;
  MOUNTAIN_CLUSTER_MIN_SIZE: number;
  MOUNTAIN_CLUSTER_MAX_SIZE: number;
  LAKE_CLUSTER_COUNT: number;
  LAKE_CLUSTER_MIN_SIZE: number;
  LAKE_CLUSTER_MAX_SIZE: number;
  OBSTACLE_EDGE_MARGIN: number;
  OBSTACLE_CENTER_EXCLUSION: number;
  LAKE_ISLAND_CHANCE: number;
  TERRAIN_NOISE_SCALE: number;

  // Demand-aware spawning
  HOUSE_SUPPLY_PER_MINUTE: number;
  HOUSE_SUPPLY_PER_MINUTE_MIN: number;
  HOUSE_SUPPLY_NEAR_DISTANCE: number;
  HOUSE_SUPPLY_FAR_DISTANCE: number;

  // Highways
  HIGHWAY_SPEED_MULTIPLIER: number;

  // Day length
  DAY_LENGTH_SECONDS: number;

  // Gas stations
  FUEL_CAPACITY: number;
  REFUEL_TIME: number;
}

/** 5-slot paint palette. Each slot is a CSS hex color string. */
export type PaintPalette = [string, string, string, string, string];

/** Each tile stores up to 4 triangle quadrants, each referencing a palette index (0-4). */
export interface BackgroundTileDefinition {
  gx: number;
  gy: number;
  top?: number;    // palette index 0-4
  right?: number;
  bottom?: number;
  left?: number;
}

export interface ColorTheme {
  background: string;
  groundPlate: string;
  road: string;
  highway: string;
  gridLines: string;
  mountainColor: string;
  waterColor: string;
  shorelineColor: string;
  mountainShorelineColor: string;
  /** Base colour of decorative trees and bushes; each item varies around it. */
  foliage: string;
  gameColors: Record<number, string>;
  paintPalette: PaintPalette;
}

export interface MapConfig {
  id: string;
  name: string;
  description: string;
  debug?: boolean;
  obstacles?: ObstacleDefinition[];
  houses?: HouseDefinition[];
  businesses?: BusinessDefinition[];
  roads?: RoadDefinition[];
  gasStations?: GasStationDefinition[];
  highways?: HighwayDefinition[];
  paintPalette?: PaintPalette;
  backgroundTiles?: BackgroundTileDefinition[];
  colorTheme?: Partial<ColorTheme>;
  constants?: Partial<GameConstants>;
  designerMode?: boolean;
}
