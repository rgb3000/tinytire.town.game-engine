import { COLOR_MAP } from '../constants';
import type { ColorTheme } from '../maps/types';

export const DEFAULT_COLOR_THEME: ColorTheme = {
  background: '#FFFFFF',
  groundPlate: '#FFFFFF',
  road: '#555555',
  highway: '#8899AA',
  gridLines: '#D4C4A0',
  mountainColor: '#A0947C',
  waterColor: '#7ABFCF',
  shorelineColor: '#C4B896',
  mountainShorelineColor: '#887E69',
  gameColors: { ...COLOR_MAP },
  paintPalette: ['#8BC34A', '#4FC3F7', '#FFD54F', '#EF9A9A', '#CE93D8'],
};

/** The flat colour fields — everything except the two structured ones. */
export type ThemeColorKey = Exclude<keyof ColorTheme, 'gameColors' | 'paintPalette'>;

/**
 * Derived from the defaults so that adding a colour here automatically makes it
 * editable, persistable and diffable. `src/maps/schema.ts` builds its wire schema
 * from this list; when it was hand-written instead, four of the nine colours were
 * silently dropped on load.
 */
export const THEME_COLOR_KEYS = Object.keys(DEFAULT_COLOR_THEME).filter(
  (key) => key !== 'gameColors' && key !== 'paintPalette',
) as ThemeColorKey[];

export function buildColorTheme(overrides?: Partial<ColorTheme>): ColorTheme {
  if (!overrides) return { ...DEFAULT_COLOR_THEME, gameColors: { ...DEFAULT_COLOR_THEME.gameColors }, paintPalette: [...DEFAULT_COLOR_THEME.paintPalette] };
  return {
    ...DEFAULT_COLOR_THEME,
    ...overrides,
    gameColors: overrides.gameColors ? { ...DEFAULT_COLOR_THEME.gameColors, ...overrides.gameColors } : { ...DEFAULT_COLOR_THEME.gameColors },
    paintPalette: overrides.paintPalette ? [...overrides.paintPalette] : [...DEFAULT_COLOR_THEME.paintPalette],
  };
}

/**
 * The inverse of {@link buildColorTheme}: reduce a full theme to only what differs
 * from the defaults, so maps store their overrides and nothing more.
 *
 * @returns `undefined` when the theme is entirely default.
 */
export function diffColorTheme(theme: ColorTheme): Partial<ColorTheme> | undefined {
  const defaults = DEFAULT_COLOR_THEME;
  const diff: Partial<ColorTheme> = {};
  let hasChanges = false;

  for (const key of THEME_COLOR_KEYS) {
    if (theme[key] !== defaults[key]) {
      diff[key] = theme[key];
      hasChanges = true;
    }
  }

  const changedColors: Record<number, string> = {};
  let hasColorChanges = false;
  for (const key of Object.keys(defaults.gameColors)) {
    const gameColor = Number(key);
    if (theme.gameColors[gameColor] !== defaults.gameColors[gameColor]) {
      changedColors[gameColor] = theme.gameColors[gameColor];
      hasColorChanges = true;
    }
  }
  if (hasColorChanges) {
    diff.gameColors = changedColors;
    hasChanges = true;
  }

  if (theme.paintPalette.some((color, i) => color !== defaults.paintPalette[i])) {
    diff.paintPalette = [...theme.paintPalette];
    hasChanges = true;
  }

  return hasChanges ? diff : undefined;
}
