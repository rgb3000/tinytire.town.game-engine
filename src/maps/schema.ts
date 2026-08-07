/**
 * The single owner of the map *wire format* — the JSON shape stored in
 * `maps.map_data` in Supabase and in the built-in map JSON files.
 *
 * The wire format uses human-readable names (`"Red"`, `["Up", "Down"]`) while the
 * engine runtime uses numeric enums and bitmasks. That translation lives in exactly
 * two places, both derived from this file:
 *
 *   wire -> runtime   `loadMap.ts`      (validateMapConfig)
 *   runtime -> wire   `serializeMap.ts` (toMapFile)
 *
 * Anything added here must be added to both, and `schema.test.ts` enforces the
 * round trip.
 *
 * Leniency policy: only `constants` is strict, because it is a curated list where a
 * typo should be loud. Every other object silently drops unknown keys so that maps
 * saved by older versions keep loading (e.g. the legacy `gasStations[].orientation`
 * field still present in `home-background.json`).
 */
import { z } from 'zod';
import { GameColor, Direction } from '../types';
import { DEFAULT_GAME_CONSTANTS } from '../constants';
import { THEME_COLOR_KEYS } from '../designer/colorTheme';
import type { ThemeColorKey } from '../designer/colorTheme';
import type { GameConstants } from './types';

/* -------------------------------------------------------------------------- */
/* Shared wire <-> runtime vocabularies                                        */
/* -------------------------------------------------------------------------- */

/** Runtime `GameColor` -> the name used in JSON. */
export const COLOR_NAMES = {
  [GameColor.Red]: 'Red',
  [GameColor.Blue]: 'Blue',
  [GameColor.Yellow]: 'Yellow',
  [GameColor.Green]: 'Green',
  [GameColor.Purple]: 'Purple',
  [GameColor.Orange]: 'Orange',
} as const satisfies Record<GameColor, string>;

export type ColorName = (typeof COLOR_NAMES)[GameColor];

/** The exact inverse of {@link COLOR_NAMES}, derived so the two cannot drift. */
export const COLOR_BY_NAME = Object.fromEntries(
  Object.entries(COLOR_NAMES).map(([value, name]) => [name, Number(value) as GameColor]),
) as Record<ColorName, GameColor>;

export type DirectionName = keyof typeof Direction;

/** Direction names in bit order, taken straight from the `Direction` const object. */
export const DIRECTION_NAMES = Object.keys(Direction) as DirectionName[];

const colorNameSchema = z.enum(Object.values(COLOR_NAMES) as [ColorName, ...ColorName[]]);
const directionNameSchema = z.enum(DIRECTION_NAMES as [DirectionName, ...DirectionName[]]);

/* -------------------------------------------------------------------------- */
/* Wire schemas                                                                */
/* -------------------------------------------------------------------------- */

/** Triangle subdivision of a single cell. Absent or all-four -> a full cell. */
const triangleFlags = {
  top: z.boolean().optional(),
  right: z.boolean().optional(),
  bottom: z.boolean().optional(),
  left: z.boolean().optional(),
};

const obstacleSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  type: z.enum(['mountain', 'lake']),
  height: z.number().optional(), // mountains only
  ...triangleFlags,
});

const houseSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  color: colorNameSchema,
});

const businessSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  color: colorNameSchema,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

const roadSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  connections: z.array(directionNameSchema).optional(),
});

const gasStationSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  // `orientation` may still be present on older maps; it is intentionally ignored.
});

const highwaySchema = z.object({
  fromGx: z.number(),
  fromGy: z.number(),
  toGx: z.number(),
  toGy: z.number(),
  cp1X: z.number(),
  cp1Y: z.number(),
  cp2X: z.number(),
  cp2Y: z.number(),
});

const backgroundTileSchema = z.object({
  gx: z.number(),
  gy: z.number(),
  // Each quadrant references a paint palette index (0-4).
  top: z.number().optional(),
  right: z.number().optional(),
  bottom: z.number().optional(),
  left: z.number().optional(),
});

const paintPaletteSchema = z
  .array(z.string())
  .length(5, 'paintPalette must be an array of exactly 5 hex strings');

/**
 * Colour fields come from `THEME_COLOR_KEYS`, which is derived from
 * `DEFAULT_COLOR_THEME` — so adding a colour there automatically makes it
 * persistable. When this list was hand-written, four of the nine were dropped.
 */
const colorThemeSchema = z.object({
  ...(Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [key, z.string().optional()]),
  ) as Record<ThemeColorKey, z.ZodOptional<z.ZodString>>),
  /** Keyed by colour *name* on the wire, by `GameColor` at runtime. */
  gameColors: z.partialRecord(colorNameSchema, z.string()).optional(),
  paintPalette: paintPaletteSchema.optional(),
});

/**
 * Gameplay constant overrides. Derived from `DEFAULT_GAME_CONSTANTS`, which
 * TypeScript already checks against the `GameConstants` interface — so the key list
 * cannot drift from the type the way the old hand-written set did.
 *
 * Strict on purpose: an unrecognised key is a typo, and should say so.
 */
const constantsSchema = z.strictObject(
  Object.fromEntries(
    Object.keys(DEFAULT_GAME_CONSTANTS).map((key) => [key, z.number().optional()]),
  ) as Record<keyof GameConstants, z.ZodOptional<z.ZodNumber>>,
);

export const mapFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  debug: z.boolean().optional(),
  houses: z.array(houseSchema).optional(),
  businesses: z.array(businessSchema).optional(),
  roads: z.array(roadSchema).optional(),
  obstacles: z.array(obstacleSchema).optional(),
  gasStations: z.array(gasStationSchema).optional(),
  highways: z.array(highwaySchema).optional(),
  backgroundTiles: z.array(backgroundTileSchema).optional(),
  paintPalette: paintPaletteSchema.optional(),
  colorTheme: colorThemeSchema.optional(),
  constants: constantsSchema.optional(),
});

/** The JSON shape persisted in Supabase and in the built-in map files. */
export type MapFile = z.infer<typeof mapFileSchema>;
