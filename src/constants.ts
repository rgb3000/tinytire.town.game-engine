import { GameColor } from './types';

// Grid — fixed, not map-overridable. See the note on `GameConstants` in src/maps/types.ts.
export const GRID_COLS = 80;
export const GRID_ROWS = 50;
export const TILE_SIZE = 40;
export const CANVAS_WIDTH = GRID_COLS * TILE_SIZE;
export const CANVAS_HEIGHT = GRID_ROWS * TILE_SIZE;

// Game loop
export const FIXED_DT = 1 / 60;         // 60 updates/sec
export const MAX_FRAME_TIME = 0.2;       // spiral-of-death cap

// Demand
export const MAX_DEMAND_PINS = 9;
export const DEMAND_BASE_RATE = 1.5;   // pins/min for a fresh business
export const DEMAND_RATE_GROWTH = 0.3; // additional pins/min per minute of age
export const DEMAND_PIN_COOLDOWN = 5;  // minimum seconds between adding pins to the same business

// Cars
export const CARS_PER_HOUSE = 2;
export const CAR_SPEED = 1; // tiles per second
export const LANE_OFFSET = TILE_SIZE * 0.12;    // px from tile center to lane center
export const CAR_WIDTH = TILE_SIZE * 0.12;       // px (narrow dimension, perpendicular to travel)
export const CAR_LENGTH = TILE_SIZE * 0.3;      // px (long dimension, along travel direction)
export const INTERSECTION_SPEED_MULTIPLIER = 0.7;
export const INTERSECTION_DEADLOCK_TIMEOUT = 2.0; // seconds

// Arc-length following distance
export const CAR_MIN_GAP = TILE_SIZE * 0.4;          // ~20px minimum bumper gap
export const CAR_COMFORT_GAP = TILE_SIZE * 1.5;      // ~75px full-speed gap

// Intersection approach deceleration
export const INTERSECTION_STOP_DIST = TILE_SIZE * 0.3;   // stop distance before conflict point (px)
export const INTERSECTION_DECEL_DIST = TILE_SIZE * 2.0;  // start decelerating distance (px)

// T-intersection gap acceptance
export const T_INTERSECTION_GAP_TIME = 2.0;  // seconds of clear gap needed on major road
export const UNIVERSAL_STUCK_TIMEOUT = 8.0; // seconds

// Unloading
export const UNLOAD_TIME = 1; // seconds

// Spawning
export const INITIAL_SPAWN_DELAY = 20;     // seconds before second color
export const COLOR_UNLOCK_INTERVAL = 100;   // seconds between new colors
export const HOUSE_CLUSTER_RADIUS = 3;     // tiles
export const HOUSE_RANDOM_PLACEMENT_CHANCE = 0.1; // chance (0–1) that a new house ignores clustering and spawns at a random location, preventing same-color houses from always clumping together
export const MIN_BUSINESS_DISTANCE = 3;    // tiles from matching houses
export const SPAWN_INTERVAL = 30;          // seconds – initial time between house/business spawns; after each spawn this is multiplied by SPAWN_INTERVAL_DECAY (0.97), gradually accelerating spawns down to MIN_SPAWN_INTERVAL
export const MIN_SPAWN_INTERVAL = 10;    // seconds – lower bound for spawn interval; SPAWN_INTERVAL decays by SPAWN_INTERVAL_DECAY after each spawn but never drops below this value
export const SPAWN_INTERVAL_DECAY = 0.97;
export const SPAWN_AREA_INTERVALS = [
  { threshold: 0, inset: 0.42 },   //  0 entities: 10% of grid
  { threshold: 5, inset: 0.41 },   //  4 entities: 20% of grid
  { threshold: 10, inset: 0.35 },   //  8 entities: 30% of grid
  { threshold: 20, inset: 0.30 },  // 12 entities: 40% of grid
  { threshold: 30, inset: 0.25 },  // 16 entities: 50% of grid
  { threshold: 40, inset: 0.20 },  // 20 entities: 60% of grid
  { threshold: 60, inset: 0.15 },  // 24 entities: 70% of grid
  { threshold: 120, inset: 0.10 },  // 28 entities: 80% of grid
  { threshold: 240, inset: 0.05 },  // 32 entities: 90% of grid
  { threshold: 480, inset: 0.00 },  // 36 entities: full grid
];

// Inventory
export const STARTING_ROADS = 40; // road count at the start of the game
export const STARTING_GAS_STATIONS = 1; // gas station count at the start of the game
export const STARTING_HIGHWAYS = 0; // highway count at the start of the game
export const WEEK_LENGTH_DAYS = 7; // how many days in a week
export const WEEKLY_ROAD_BONUS = 20; // how many road tiles the user gets per week
export const HIGHWAY_UNLOCK_WEEK = 4; // after how many week the user can choose a hihgway as an extra

// Gas stations
export const FUEL_CAPACITY = 100;
export const REFUEL_TIME = 2;

// Building layout (shared margin system)
export const CELL_MARGIN = 6;          // ground plate edge inset from cell boundary (px)
export const GROUND_PLATE_MARGIN = 3;  // inner building space inset from plate edge (px)

// Highways
export const HIGHWAY_SPEED_MULTIPLIER = 2.0;
export const HIGHWAY_PEAK_Y = 45;

// Day length
export const DAY_LENGTH_SECONDS = 15; // 2 minutes = 1 game day at 1x speed

// Colors - map GameColor enum to hex
export const COLOR_MAP: Record<GameColor, string> = {
  [GameColor.Red]: '#E74C3C',
  [GameColor.Blue]: '#3498DB',
  [GameColor.Yellow]: '#F1C40F',
  [GameColor.Green]: '#2ECC71',
  [GameColor.Purple]: '#9B59B6',
  [GameColor.Orange]: '#E67E22',
};

// Obstacles
export const MOUNTAIN_CLUSTER_COUNT = 3;
export const MOUNTAIN_CLUSTER_MIN_SIZE = 4;
export const MOUNTAIN_CLUSTER_MAX_SIZE = 8;
export const LAKE_CLUSTER_COUNT = 2;
export const LAKE_CLUSTER_MIN_SIZE = 5;
export const LAKE_CLUSTER_MAX_SIZE = 12;
export const OBSTACLE_EDGE_MARGIN = 3;
export const OBSTACLE_CENTER_EXCLUSION = 8;

/** Probability that a generated lake large enough to hold one is given an island. */
export const LAKE_ISLAND_CHANCE = 0.45;

/** Spatial frequency of the noise that perturbs landform boundaries. Lower is smoother. */
export const TERRAIN_NOISE_SCALE = 0.35;

export const MOUNTAIN_COLOR = '#A0947C';
export const LAKE_COLOR = '#7ABFCF';
export const LAKE_SHORE_COLOR = '#C4B896';
export const MOUNTAIN_MIN_HEIGHT = 6;
export const MOUNTAIN_MAX_HEIGHT = 14;

// Demand-aware spawning
//
// The spawn system estimates how many demand pins per minute each house can
// clear ("supply rate") to decide whether a color needs more houses.
//
// Previously every house was assumed to clear pins at the same flat rate,
// regardless of how far it was from businesses. This caused problems: when
// houses of one color were far from their businesses, cars spent most of
// their travel time driving instead of delivering, so the effective supply
// was much lower than estimated. The spawn system didn't spawn enough
// houses, leading to avoidable game-overs.
//
// Now each house's supply rate is scaled by its average octile distance to
// same-color businesses. Close houses use the max rate, far houses use the
// min rate, with a linear interpolation (lerp) between NEAR and FAR
// thresholds.
//
//   distance ≤ NEAR  →  supply = HOUSE_SUPPLY_PER_MINUTE      (max, 1.2)
//   distance ≥ FAR   →  supply = HOUSE_SUPPLY_PER_MINUTE_MIN  (min, 0.7)
//   in between       →  linearly interpolated
//
export const HOUSE_SUPPLY_PER_MINUTE = 1.5; // pins/min one close house can clear (max rate)
export const HOUSE_SUPPLY_PER_MINUTE_MIN = 0.7; // pins/min one far house can clear (min rate / floor)
export const HOUSE_SUPPLY_NEAR_DISTANCE = 10; // tiles — at or below this octile distance, house uses max supply rate
export const HOUSE_SUPPLY_FAR_DISTANCE = 40; // tiles — at or above this octile distance, house uses min supply rate (grid is 80×50, so 40 ≈ half the map width)

// Debug
export const SPAWN_DEBUG = false;
export const DEMAND_DEBUG = false;
export const ROAD_DEBUG = false;
export const ROAD_GRAPH_DEBUG = false;
export const CAR_DEBUG = false;

// Roads
export const ROAD_HALF_WIDTH = TILE_SIZE * 0.2;
export const HIGHWAY_HALF_WIDTH = ROAD_HALF_WIDTH;
export const HIGHWAY_COLOR_HEX = 0x8899AA;
export const ROAD_COLOR = '#555';

export const GROUND_Y_POSITION = 1.75;

// Color unlock order
export const COLOR_UNLOCK_ORDER: GameColor[] = [
  GameColor.Red,
  GameColor.Blue,
  GameColor.Yellow,
  GameColor.Green,
  GameColor.Purple,
  GameColor.Orange,
];

// --- Configurable constants bundle ---
import type { GameConstants } from './maps/types';

export const DEFAULT_GAME_CONSTANTS: GameConstants = {
  MAX_DEMAND_PINS,
  DEMAND_BASE_RATE,
  DEMAND_RATE_GROWTH,
  DEMAND_PIN_COOLDOWN,
  CARS_PER_HOUSE,
  CAR_SPEED,
  UNLOAD_TIME,
  INITIAL_SPAWN_DELAY,
  COLOR_UNLOCK_INTERVAL,
  HOUSE_CLUSTER_RADIUS,
  MIN_BUSINESS_DISTANCE,
  SPAWN_INTERVAL,
  MIN_SPAWN_INTERVAL,
  SPAWN_INTERVAL_DECAY,
  STARTING_ROADS,
  STARTING_GAS_STATIONS,
  STARTING_HIGHWAYS,
  WEEK_LENGTH_DAYS,
  WEEKLY_ROAD_BONUS,
  HIGHWAY_UNLOCK_WEEK,
  MOUNTAIN_CLUSTER_COUNT,
  MOUNTAIN_CLUSTER_MIN_SIZE,
  MOUNTAIN_CLUSTER_MAX_SIZE,
  LAKE_CLUSTER_COUNT,
  LAKE_CLUSTER_MIN_SIZE,
  LAKE_CLUSTER_MAX_SIZE,
  OBSTACLE_EDGE_MARGIN,
  OBSTACLE_CENTER_EXCLUSION,
  LAKE_ISLAND_CHANCE,
  TERRAIN_NOISE_SCALE,
  HOUSE_RANDOM_PLACEMENT_CHANCE,
  HOUSE_SUPPLY_PER_MINUTE,
  HOUSE_SUPPLY_PER_MINUTE_MIN,
  HOUSE_SUPPLY_NEAR_DISTANCE,
  HOUSE_SUPPLY_FAR_DISTANCE,
  HIGHWAY_SPEED_MULTIPLIER,
  DAY_LENGTH_SECONDS,
  FUEL_CAPACITY,
  REFUEL_TIME,
};

export function buildConfig(overrides?: Partial<GameConstants>): GameConstants {
  if (!overrides) return { ...DEFAULT_GAME_CONSTANTS };
  return { ...DEFAULT_GAME_CONSTANTS, ...overrides };
}
