/**
 * Round-trip tests for the map format.
 *
 * Every bug these cover was live in production: triangle subdivision and four of the
 * nine theme colours were silently dropped on load, and one declared constant could
 * not be used at all. The format is only safe while `toMapFile` and
 * `validateMapConfig` remain exact inverses, so that is what is asserted here.
 */
import { describe, it, expect } from 'vitest';

import { validateMapConfig } from './loadMap';
import { toMapFile, serializeMapConfig } from './serializeMap';
import { DEFAULT_GAME_CONSTANTS, buildConfig } from '../constants';
import { DEFAULT_COLOR_THEME, THEME_COLOR_KEYS, diffColorTheme, buildColorTheme } from '../designer/colorTheme';
import { GameColor, Direction } from '../types';
import type { MapConfig } from './types';

import classicJson from './classic/classic.json';
import lakelandJson from './lakeland/lakeland.json';
import narrowPassJson from './narrow-pass/narrow-pass.json';
import trafficStressTestJson from './traffic-stress-test/traffic-stress-test.json';
import homeBackgroundJson from './home-background/home-background.json';

/** Send a runtime config out to the wire and back. */
function roundTrip(config: MapConfig): MapConfig {
  return validateMapConfig(JSON.parse(serializeMapConfig(config)));
}

const baseConfig: MapConfig = {
  id: 'test-map',
  name: 'Test Map',
  description: 'Fixture',
};

describe('obstacle triangles', () => {
  it('preserves partial mountains and lakes', () => {
    const config: MapConfig = {
      ...baseConfig,
      obstacles: [
        { gx: 1, gy: 2, type: 'mountain', height: 9, top: true },
        { gx: 3, gy: 4, type: 'mountain', height: 7, right: true, bottom: true },
        { gx: 5, gy: 6, type: 'lake', left: true },
        { gx: 7, gy: 8, type: 'lake', top: true, right: true, bottom: true, left: true },
      ],
    };

    const obstacles = roundTrip(config).obstacles!;

    expect(obstacles[0]).toMatchObject({ gx: 1, gy: 2, type: 'mountain', height: 9, top: true });
    expect(obstacles[1]).toMatchObject({ right: true, bottom: true });
    expect(obstacles[1].top).toBeUndefined();
    expect(obstacles[2]).toMatchObject({ gx: 5, gy: 6, type: 'lake', left: true });
  });

  it('writes an all-four cell as a plain full cell', () => {
    const config: MapConfig = {
      ...baseConfig,
      obstacles: [{ gx: 7, gy: 8, type: 'lake', top: true, right: true, bottom: true, left: true }],
    };

    // A fully-covered cell needs no flags — it is just a normal obstacle.
    const [wire] = toMapFile(config).obstacles!;
    expect(wire).toEqual({ gx: 7, gy: 8, type: 'lake' });
  });

  it('distinguishes "no obstacles key" from "an empty obstacle list"', () => {
    // ObstacleSystem generates random terrain when `obstacles` is absent and places
    // nothing when it is []. Collapsing the two turns Classic into a barren map.
    expect(toMapFile({ ...baseConfig }).obstacles).toBeUndefined();
    expect(toMapFile({ ...baseConfig, obstacles: [] }).obstacles).toEqual([]);

    expect(roundTrip({ ...baseConfig }).obstacles).toBeUndefined();
    expect(roundTrip({ ...baseConfig, obstacles: [] }).obstacles).toEqual([]);
  });

  it('keeps mountains and lakes distinguishable', () => {
    const config: MapConfig = {
      ...baseConfig,
      obstacles: [
        { gx: 0, gy: 0, type: 'mountain', height: 12 },
        { gx: 1, gy: 0, type: 'lake' },
      ],
    };

    const obstacles = roundTrip(config).obstacles!;
    expect(obstacles.map((o) => o.type)).toEqual(['mountain', 'lake']);
    expect(obstacles[1].height).toBeUndefined();
  });
});

describe('colour theme', () => {
  it('round-trips every colour in the theme, not just the ones someone remembered', () => {
    // Build a theme where every flat colour differs from the default, so a dropped
    // key cannot hide behind a matching default.
    const customized = { ...DEFAULT_COLOR_THEME };
    for (const [i, key] of THEME_COLOR_KEYS.entries()) {
      customized[key] = `#${String(i + 1).repeat(6)}`;
    }

    // Non-null: every THEME_COLOR_KEYS entry was just changed above, so the diff cannot
    // be empty. `?? {}` would compile too, but would quietly weaken the assertion if
    // that ever stopped being true.
    const config: MapConfig = { ...baseConfig, colorTheme: diffColorTheme(customized)! };
    const theme = roundTrip(config).colorTheme!;

    for (const key of THEME_COLOR_KEYS) {
      expect(theme[key], `theme colour "${key}" was lost in the round trip`).toBe(customized[key]);
    }
  });

  it('covers all ten documented theme colours', () => {
    // Guards against someone adding a colour to ColorTheme but not to the defaults,
    // which is what the schema derives its key list from.
    expect(THEME_COLOR_KEYS).toHaveLength(10);
    expect(THEME_COLOR_KEYS).toContain('mountainColor');
    expect(THEME_COLOR_KEYS).toContain('waterColor');
    expect(THEME_COLOR_KEYS).toContain('shorelineColor');
    expect(THEME_COLOR_KEYS).toContain('mountainShorelineColor');
    expect(THEME_COLOR_KEYS).toContain('foliage');
  });

  it('translates game colours between enum keys and names', () => {
    const config: MapConfig = {
      ...baseConfig,
      colorTheme: { gameColors: { [GameColor.Yellow]: '#dc5589', [GameColor.Red]: '#123456' } },
    };

    expect(toMapFile(config).colorTheme!.gameColors).toEqual({ Yellow: '#dc5589', Red: '#123456' });
    expect(roundTrip(config).colorTheme!.gameColors).toEqual({
      [GameColor.Yellow]: '#dc5589',
      [GameColor.Red]: '#123456',
    });
  });

  it('round-trips the paint palette', () => {
    const palette = ['#111111', '#222222', '#333333', '#444444', '#555555'] as const;
    const config: MapConfig = {
      ...baseConfig,
      paintPalette: [...palette],
      backgroundTiles: [{ gx: 2, gy: 3, top: 0, right: 4 }],
    };

    const result = roundTrip(config);
    expect(result.paintPalette).toEqual([...palette]);
    expect(result.backgroundTiles).toEqual([{ gx: 2, gy: 3, top: 0, right: 4 }]);
  });

  it('rejects an unknown game colour name', () => {
    expect(() =>
      validateMapConfig({ ...baseConfig, colorTheme: { gameColors: { Chartreuse: '#000000' } } }),
    ).toThrow();
  });

  it('omits the theme entirely when nothing differs from the defaults', () => {
    expect(diffColorTheme(buildColorTheme())).toBeUndefined();
  });
});

describe('constants', () => {
  it('accepts every key declared in DEFAULT_GAME_CONSTANTS', () => {
    // The old hand-written key set had drifted from the type: a map overriding
    // HOUSE_RANDOM_PLACEMENT_CHANCE was rejected outright.
    const constants = { ...DEFAULT_GAME_CONSTANTS };
    const result = validateMapConfig({ ...baseConfig, constants });

    expect(result.constants).toEqual(constants);
    expect(Object.keys(result.constants!)).toHaveLength(Object.keys(DEFAULT_GAME_CONSTANTS).length);
  });

  it('accepts HOUSE_RANDOM_PLACEMENT_CHANCE specifically', () => {
    const result = validateMapConfig({ ...baseConfig, constants: { HOUSE_RANDOM_PLACEMENT_CHANCE: 0.25 } });
    expect(result.constants).toEqual({ HOUSE_RANDOM_PLACEMENT_CHANCE: 0.25 });
  });

  it('rejects an unknown constant with a message naming it', () => {
    expect(() => validateMapConfig({ ...baseConfig, constants: { NOT_A_CONSTANT: 1 } }))
      .toThrow(/NOT_A_CONSTANT/);
  });

  it('rejects a non-numeric constant', () => {
    expect(() => validateMapConfig({ ...baseConfig, constants: { STARTING_ROADS: 'lots' } })).toThrow();
  });
});

describe('roads', () => {
  it('round-trips connection bitmasks through direction names', () => {
    const config: MapConfig = {
      ...baseConfig,
      roads: [
        { gx: 1, gy: 1, connections: Direction.Up | Direction.Down },
        { gx: 2, gy: 1, connections: Direction.UpLeft | Direction.DownRight | Direction.Right },
        { gx: 3, gy: 1, connections: 0 },
        { gx: 4, gy: 1 },
      ],
    };

    const roads = roundTrip(config).roads!;
    expect(roads[0].connections).toBe(Direction.Up | Direction.Down);
    expect(roads[1].connections).toBe(Direction.UpLeft | Direction.DownRight | Direction.Right);
    // An empty mask is written as "no connections key" and reads back as absent.
    expect(roads[2].connections).toBeUndefined();
    expect(roads[3].connections).toBeUndefined();
  });

  it('rejects an unknown direction name', () => {
    expect(() => validateMapConfig({ ...baseConfig, roads: [{ gx: 0, gy: 0, connections: ['Sideways'] }] }))
      .toThrow();
  });
});

describe('whole-config round trip', () => {
  it('preserves a config that exercises every field', () => {
    const config: MapConfig = {
      ...baseConfig,
      debug: true,
      houses: [{ gx: 1, gy: 1, color: GameColor.Purple }],
      businesses: [{ gx: 4, gy: 4, color: GameColor.Green, rotation: 270 }],
      roads: [{ gx: 2, gy: 2, connections: Direction.Left | Direction.Right }],
      obstacles: [{ gx: 9, gy: 9, type: 'mountain', height: 11, bottom: true }],
      gasStations: [{ gx: 6, gy: 6 }],
      highways: [{ fromGx: 1, fromGy: 2, toGx: 3, toGy: 4, cp1X: 10, cp1Y: 20, cp2X: 30, cp2Y: 40 }],
      backgroundTiles: [{ gx: 0, gy: 1, left: 2 }],
      paintPalette: ['#a', '#b', '#c', '#d', '#e'],
      forests: [{ gx: 12, gy: 3 }, { gx: 13, gy: 3 }],
      colorTheme: { background: '#ffaf00', waterColor: '#001122' },
      constants: { STARTING_ROADS: 50, DEMAND_RATE_GROWTH: 0.4 },
    };

    expect(roundTrip(config)).toEqual(config);
  });

  it('writes no forests key for an empty forest — absent and empty both mean no trees', () => {
    expect(toMapFile({ ...baseConfig, forests: [] })).not.toHaveProperty('forests');
  });

  it('is idempotent — a second trip changes nothing', () => {
    const config: MapConfig = {
      ...baseConfig,
      obstacles: [{ gx: 1, gy: 1, type: 'lake', top: true }],
      colorTheme: { mountainShorelineColor: '#abcdef' },
    };

    const once = roundTrip(config);
    expect(roundTrip(once)).toEqual(once);
  });
});

describe('built-in and legacy map files', () => {
  const builtIns = {
    classic: classicJson,
    lakeland: lakelandJson,
    'narrow-pass': narrowPassJson,
    'traffic-stress-test': trafficStressTestJson,
    'home-background': homeBackgroundJson,
  };

  for (const [name, json] of Object.entries(builtIns)) {
    it(`parses ${name}.json`, () => {
      expect(() => validateMapConfig(json)).not.toThrow();
    });

    it(`re-serializes ${name}.json without losing anything`, () => {
      const config = validateMapConfig(json);
      expect(roundTrip(config)).toEqual(config);
    });
  }

  it('recovers triangles and colours from a payload written by the old serializer', () => {
    // Verbatim shape of what the previous exportMapConfig wrote into maps.map_data.
    // That data was always persisted correctly — only the *reader* discarded it — so
    // fixing the parser restores work on maps saved before the fix. This test is the
    // proof of that claim; if it ever fails, existing users lose their terrain again.
    const storedByOldVersion = {
      id: 'custom-map',
      name: 'Custom Map',
      description: 'Created with Map Designer',
      houses: [{ gx: 25, gy: 39, color: 'Red' }],
      roads: [{ gx: 41, gy: 15, connections: ['Down'] }],
      gasStations: [{ gx: 42, gy: 24, orientation: 'horizontal' }],
      obstacles: [
        { gx: 10, gy: 10, type: 'mountain', height: 9, top: true, right: true },
        { gx: 11, gy: 10, type: 'lake', bottom: true },
        { gx: 12, gy: 10, type: 'mountain', height: 12 },
      ],
      colorTheme: {
        background: '#ffaf00',
        groundPlate: '#3d3c8f',
        road: '#666666',
        highway: '#002bb6',
        gridLines: '#ff472c',
        mountainColor: '#111111',
        waterColor: '#222222',
        shorelineColor: '#333333',
        mountainShorelineColor: '#444444',
        gameColors: { Yellow: '#dc5589' },
        paintPalette: ['#a1', '#b2', '#c3', '#d4', '#e5'],
      },
      constants: { STARTING_ROADS: 50 },
    };

    const config = validateMapConfig(storedByOldVersion);

    expect(config.obstacles).toEqual([
      { gx: 10, gy: 10, type: 'mountain', height: 9, top: true, right: true },
      { gx: 11, gy: 10, type: 'lake', bottom: true },
      { gx: 12, gy: 10, type: 'mountain', height: 12 },
    ]);
    expect(config.colorTheme).toMatchObject({
      mountainColor: '#111111',
      waterColor: '#222222',
      shorelineColor: '#333333',
      mountainShorelineColor: '#444444',
      gameColors: { [GameColor.Yellow]: '#dc5589' },
      paintPalette: ['#a1', '#b2', '#c3', '#d4', '#e5'],
    });
    expect(config.roads).toEqual([{ gx: 41, gy: 15, connections: Direction.Down }]);
    expect(config.houses).toEqual([{ gx: 25, gy: 39, color: GameColor.Red }]);
  });

  it('tolerates the legacy gasStations[].orientation field', () => {
    // home-background.json still carries it; dropping support would break that map.
    const result = validateMapConfig({
      ...baseConfig,
      gasStations: [{ gx: 42, gy: 24, orientation: 'horizontal' }],
    });
    expect(result.gasStations).toEqual([{ gx: 42, gy: 24 }]);
  });
});

describe('validation errors', () => {
  it('reports a readable message rather than a raw ZodError dump', () => {
    let message = '';
    try {
      validateMapConfig({ id: 'x', name: 'y' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('description');
  });

  it('rejects a non-object', () => {
    expect(() => validateMapConfig(null)).toThrow();
    expect(() => validateMapConfig('a map')).toThrow();
  });
});

describe('terrain generation constants', () => {
  it('accepts the new obstacle keys from a map', () => {
    const cfg = buildConfig({ LAKE_ISLAND_CHANCE: 1, TERRAIN_NOISE_SCALE: 0.9 });
    expect(cfg.LAKE_ISLAND_CHANCE).toBe(1);
    expect(cfg.TERRAIN_NOISE_SCALE).toBe(0.9);
  });
});
