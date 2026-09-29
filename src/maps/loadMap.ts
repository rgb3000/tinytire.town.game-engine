/**
 * wire -> runtime. The inverse lives in `serializeMap.ts`; the shape both agree on
 * is defined once in `schema.ts`.
 */
import { z } from 'zod';
import { Direction } from '../types';
import { omitUndefined } from '../utils/omitUndefined';
import { mapFileSchema, COLOR_BY_NAME } from './schema';
import type { MapFile, DirectionName } from './schema';
import type {
  MapConfig,
  ObstacleDefinition,
  RoadDefinition,
  BackgroundTileDefinition,
  PaintPalette,
  ColorTheme,
} from './types';

function toBitmask(connections: DirectionName[]): number {
  let mask = 0;
  for (const name of connections) mask |= Direction[name];
  return mask;
}

function toObstacle(o: NonNullable<MapFile['obstacles']>[number]): ObstacleDefinition {
  const def: ObstacleDefinition = { gx: o.gx, gy: o.gy, type: o.type };
  if (o.height !== undefined) def.height = o.height;
  // Triangle subdivision — dropping these is what used to silently turn every
  // partial mountain/lake back into a full cell on load.
  if (o.top !== undefined) def.top = o.top;
  if (o.right !== undefined) def.right = o.right;
  if (o.bottom !== undefined) def.bottom = o.bottom;
  if (o.left !== undefined) def.left = o.left;
  return def;
}

function toRoad(r: NonNullable<MapFile['roads']>[number]): RoadDefinition {
  const def: RoadDefinition = { gx: r.gx, gy: r.gy };
  if (r.connections !== undefined) def.connections = toBitmask(r.connections);
  return def;
}

function toBackgroundTile(t: NonNullable<MapFile['backgroundTiles']>[number]): BackgroundTileDefinition {
  const def: BackgroundTileDefinition = { gx: t.gx, gy: t.gy };
  if (t.top !== undefined) def.top = t.top;
  if (t.right !== undefined) def.right = t.right;
  if (t.bottom !== undefined) def.bottom = t.bottom;
  if (t.left !== undefined) def.left = t.left;
  return def;
}

function toColorTheme(raw: NonNullable<MapFile['colorTheme']>): Partial<ColorTheme> {
  const { gameColors, paintPalette, ...colors } = raw;
  // `omitUndefined` rather than a plain spread: `buildColorTheme` merges this over the
  // defaults, so a key that is present-but-undefined would erase a default colour.
  const theme: Partial<ColorTheme> = omitUndefined(colors);

  if (gameColors) {
    const byEnum: Record<number, string> = {};
    for (const [name, hex] of Object.entries(gameColors)) {
      if (hex !== undefined) byEnum[COLOR_BY_NAME[name as keyof typeof COLOR_BY_NAME]] = hex;
    }
    theme.gameColors = byEnum;
  }
  if (paintPalette) theme.paintPalette = [...paintPalette] as PaintPalette;

  return theme;
}

/** Turn a parsed map file into the runtime config the engine consumes. */
export function mapFileToConfig(file: MapFile): MapConfig {
  const config: MapConfig = {
    id: file.id,
    name: file.name,
    description: file.description,
  };

  if (file.debug !== undefined) config.debug = file.debug;
  if (file.houses) {
    config.houses = file.houses.map((h) => ({ gx: h.gx, gy: h.gy, color: COLOR_BY_NAME[h.color] }));
  }
  if (file.businesses) {
    config.businesses = file.businesses.map((b) => ({
      gx: b.gx,
      gy: b.gy,
      color: COLOR_BY_NAME[b.color],
      rotation: b.rotation,
    }));
  }
  if (file.roads) config.roads = file.roads.map(toRoad);
  if (file.obstacles) config.obstacles = file.obstacles.map(toObstacle);
  if (file.gasStations) config.gasStations = file.gasStations.map((g) => ({ gx: g.gx, gy: g.gy }));
  if (file.highways) config.highways = file.highways.map((h) => ({ ...h }));
  if (file.backgroundTiles) config.backgroundTiles = file.backgroundTiles.map(toBackgroundTile);
  if (file.paintPalette) config.paintPalette = [...file.paintPalette] as PaintPalette;
  if (file.forests) config.forests = file.forests.map((f) => ({ gx: f.gx, gy: f.gy }));
  if (file.colorTheme) config.colorTheme = toColorTheme(file.colorTheme);
  // Same reasoning as `toColorTheme`: `buildConfig` spreads these over
  // `DEFAULT_GAME_CONSTANTS`, and an undefined override would reach engine arithmetic.
  if (file.constants) config.constants = omitUndefined(file.constants);

  return config;
}

/**
 * Parse and validate untrusted map JSON (a built-in map file, or `map_data` from the
 * database) into a runtime `MapConfig`.
 *
 * @throws Error with a human-readable description of every problem found.
 */
export function validateMapConfig(json: unknown): MapConfig {
  const result = mapFileSchema.safeParse(json);
  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }
  return mapFileToConfig(result.data);
}
