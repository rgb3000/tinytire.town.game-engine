/**
 * runtime -> wire. The exact inverse of `loadMap.ts`; the shape both agree on is
 * defined once in `schema.ts`.
 *
 * This is the only serializer. Everything that persists or exports a map goes
 * through it, so the format can only change in one place.
 */
import { Direction } from '../types';
import { COLOR_NAMES, DIRECTION_NAMES } from './schema';
import type { MapFile, ColorName, DirectionName } from './schema';
import { THEME_COLOR_KEYS } from '../designer/colorTheme';
import type {
  MapConfig,
  ObstacleDefinition,
  BackgroundTileDefinition,
  ColorTheme,
} from './types';

function toDirectionNames(mask: number): DirectionName[] {
  return DIRECTION_NAMES.filter((name) => mask & Direction[name]);
}

/** All four triangles set (or none at all) means a full cell — don't write flags. */
function isFullCell(o: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }): boolean {
  return !!(o.top && o.right && o.bottom && o.left);
}

function fromObstacle(o: ObstacleDefinition): NonNullable<MapFile['obstacles']>[number] {
  const out: NonNullable<MapFile['obstacles']>[number] = { gx: o.gx, gy: o.gy, type: o.type };
  if (o.height !== undefined) out.height = Math.round(o.height);
  if (!isFullCell(o)) {
    if (o.top) out.top = true;
    if (o.right) out.right = true;
    if (o.bottom) out.bottom = true;
    if (o.left) out.left = true;
  }
  return out;
}

function fromBackgroundTile(t: BackgroundTileDefinition): NonNullable<MapFile['backgroundTiles']>[number] {
  const out: NonNullable<MapFile['backgroundTiles']>[number] = { gx: t.gx, gy: t.gy };
  if (t.top !== undefined) out.top = t.top;
  if (t.right !== undefined) out.right = t.right;
  if (t.bottom !== undefined) out.bottom = t.bottom;
  if (t.left !== undefined) out.left = t.left;
  return out;
}

function fromColorTheme(theme: Partial<ColorTheme>): NonNullable<MapFile['colorTheme']> {
  const out: NonNullable<MapFile['colorTheme']> = {};

  for (const key of THEME_COLOR_KEYS) {
    const value = theme[key];
    if (value !== undefined) out[key] = value;
  }

  if (theme.gameColors) {
    const byName: Partial<Record<ColorName, string>> = {};
    for (const [value, hex] of Object.entries(theme.gameColors)) {
      const name = COLOR_NAMES[Number(value) as keyof typeof COLOR_NAMES];
      if (name) byName[name] = hex;
    }
    out.gameColors = byName;
  }
  if (theme.paintPalette) out.paintPalette = [...theme.paintPalette];

  return out;
}

/**
 * Convert a runtime `MapConfig` into the JSON shape that gets persisted.
 *
 * Empty collections are omitted rather than written as `[]`, matching the format
 * already in the database.
 *
 * `obstacles` is the one field where empty and absent mean different things:
 * `ObstacleSystem` generates random terrain when it is absent and places nothing
 * when it is `[]`. The designer always supplies an array (so its exports keep
 * disabling random generation), while a map like `classic.json` omits it to opt in.
 * Collapsing the two would quietly turn Classic into a barren map.
 */
export function toMapFile(config: MapConfig): MapFile {
  const file: MapFile = {
    id: config.id,
    name: config.name,
    description: config.description,
  };

  if (config.debug) file.debug = config.debug;
  if (config.houses?.length) {
    file.houses = config.houses.map((h) => ({ gx: h.gx, gy: h.gy, color: COLOR_NAMES[h.color] }));
  }
  if (config.businesses?.length) {
    file.businesses = config.businesses.map((b) => ({
      gx: b.gx,
      gy: b.gy,
      color: COLOR_NAMES[b.color],
      rotation: b.rotation,
    }));
  }
  if (config.roads?.length) {
    file.roads = config.roads.map((r) => {
      const names = toDirectionNames(r.connections ?? 0);
      return names.length > 0 ? { gx: r.gx, gy: r.gy, connections: names } : { gx: r.gx, gy: r.gy };
    });
  }
  if (config.obstacles !== undefined) file.obstacles = config.obstacles.map(fromObstacle);
  if (config.gasStations?.length) {
    file.gasStations = config.gasStations.map((g) => ({ gx: g.gx, gy: g.gy }));
  }
  if (config.highways?.length) {
    file.highways = config.highways.map((h) => ({
      fromGx: h.fromGx,
      fromGy: h.fromGy,
      toGx: h.toGx,
      toGy: h.toGy,
      cp1X: Math.round(h.cp1X),
      cp1Y: Math.round(h.cp1Y),
      cp2X: Math.round(h.cp2X),
      cp2Y: Math.round(h.cp2Y),
    }));
  }
  if (config.backgroundTiles?.length) {
    file.backgroundTiles = config.backgroundTiles.map(fromBackgroundTile);
    if (config.paintPalette) file.paintPalette = [...config.paintPalette];
  }
  // Unlike `obstacles`, absent and `[]` mean the same here — no forest, no trees — so the
  // usual omission of empty collections applies.
  if (config.forests?.length) file.forests = config.forests.map((f) => ({ gx: f.gx, gy: f.gy }));
  if (config.colorTheme) {
    const theme = fromColorTheme(config.colorTheme);
    if (Object.keys(theme).length > 0) file.colorTheme = theme;
  }
  if (config.constants && Object.keys(config.constants).length > 0) {
    file.constants = { ...config.constants };
  }

  return file;
}

/** Pretty-printed JSON, as shown in the designer's Export modal and saved to the DB. */
export function serializeMapConfig(config: MapConfig): string {
  return JSON.stringify(toMapFile(config), null, 2);
}
