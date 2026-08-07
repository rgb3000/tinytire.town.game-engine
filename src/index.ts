/**
 * The engine's public API.
 *
 * Everything outside this file is an implementation detail. Consumers — the website
 * today, the standalone demo and any third party once this is its own package — import
 * from here and nowhere else, so that `rendering/`, `systems/`, `pathfinding/`, `input/`,
 * `highways/`, and `debug/` stay free to change without breaking anyone.
 *
 * Adding an export here is a deliberate act: it is a promise. Removing one is a breaking
 * change. Reaching past this file from outside the engine is the thing this file exists
 * to prevent.
 */

// Runtime
export { Game, type DemandStat } from './core/Game';
export { DemoGame } from './core/DemoGame';

// Designer
export { MapDesigner, DesignerTool } from './designer/MapDesigner';

// Entities — exposed for debug/inspection UI, not for construction by consumers.
export { Car, CarState } from './entities/Car';

// Capture
export { GameScreenshot } from './utils/GameScreenshot';

// Enums and shared value types
export { Tool, GameState, GameColor, type BusinessRotation } from './types';

// Constants. Note these are all *non*-configurable: nothing here is a key of
// `GameConstants`. A map-overridable constant must be read through the resolved config,
// never imported — `constants.test.ts` enforces that, including through this barrel.
export { COLOR_MAP, CAR_DEBUG, DEFAULT_GAME_CONSTANTS, GRID_COLS, GRID_ROWS } from './constants';

// Maps: the built-in set, plus the format's parser and wire schema.
export { allMaps, getMapById, homeBackgroundMap } from './maps';
export { validateMapConfig } from './maps/loadMap';
export { mapFileSchema } from './maps/schema';
export type {
  MapConfig,
  Inventory,
  WeeklyChoiceOption,
  ColorTheme,
  GameConstants,
} from './maps/types';
