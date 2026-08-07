/**
 * Guards the invariant that makes `GameConstants` honest: **a key a map can override must
 * not also be readable as a module-level constant from inside the engine.**
 *
 * Eight keys used to violate this. They were declared in `GameConstants`, accepted by the
 * strict wire schema, and persisted by the designer — while every consumer read the
 * module constant, so setting them in a map did nothing at all. `GRID_COLS`/`GRID_ROWS`
 * were removed from the interface; the six car/fuel keys were threaded through properly.
 *
 * The static test below is the durable half: it is derived from `DEFAULT_GAME_CONSTANTS`,
 * so it covers new keys automatically, and it fails the moment someone reintroduces a
 * direct import. That matters more than a behavioural probe here, because seven of the
 * keys are only observable through `Game`, which needs a canvas and a WebGL context.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DEFAULT_GAME_CONSTANTS, buildConfig } from './constants';
import { Grid } from './core/Grid';
import { RoadSystem } from './systems/RoadSystem';
import { PendingDeletionSystem } from './systems/PendingDeletionSystem';
import { HighwaySystem } from './systems/HighwaySystem';
import { Pathfinder } from './pathfinding/Pathfinder';
import { CarSystem } from './systems/CarSystem';
import { House } from './entities/House';
import { GameColor } from './types';

const SRC_DIR = import.meta.dirname;

/**
 * Files permitted to import a configurable constant directly, each with the reason.
 * Every entry here is a known gap — keep the list short and justified.
 */
const ALLOWED: Record<string, string> = {
  // `MAX_DEMAND_PINS` is honoured by the simulation (DemandSystem, Game.update) but not by
  // the renderer: these two compute the same "near game over" predicate from the module
  // constant instead of cfg. The pin geometry is also a fixed 3x3 grid
  // (src/utils/businessLayout.ts), so values above 9 cannot render at all. Fixing that
  // means deriving the pin count from pinSlots.length, or constraining the key in the
  // schema — a separate change.
  'rendering/Renderer.ts': 'MAX_DEMAND_PINS — renderer half of a known split, see src/maps/types.ts',
  'rendering/layers/buildings/BusinessLayer.ts': 'MAX_DEMAND_PINS — as above',
};

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Named bindings pulled from `…/constants`, tolerating the multi-line form.
 *
 * `export … from` counts as well as `import`: a re-export through `src/index.ts` hands the
 * constant to every consumer of the package, which is the same leak this guards against,
 * one level further out.
 */
function constantsBindings(source: string): string[] {
  const names: string[] = [];
  const re = /(?:import|export)\s*\{([^}]*)\}\s*from\s*'[^']*\/constants'/g;
  for (const match of source.matchAll(re)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('configurable constants are not read directly', () => {
  const configurable = new Set(Object.keys(DEFAULT_GAME_CONSTANTS));
  const files = tsFiles(SRC_DIR).filter(f => f !== join(SRC_DIR, 'constants.ts'));

  it('scans a plausible number of engine files', () => {
    // Guards against a regex or traversal slip producing a vacuous pass.
    expect(files.length).toBeGreaterThan(50);
    const withImports = files.filter(f => constantsBindings(readFileSync(f, 'utf8')).length > 0);
    expect(withImports.length).toBeGreaterThan(20);
  });

  it('no engine file imports or re-exports a key of DEFAULT_GAME_CONSTANTS from src/constants', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      if (rel in ALLOWED) continue;
      const leaked = constantsBindings(readFileSync(file, 'utf8')).filter(n => configurable.has(n));
      if (leaked.length > 0) offenders.push(`${rel}: ${leaked.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});

describe('car tuning reaches the simulation', () => {
  it('honours CARS_PER_HOUSE and FUEL_CAPACITY from a map override', () => {
    const cfg = buildConfig({ CARS_PER_HOUSE: 5, FUEL_CAPACITY: 42 });
    const grid = new Grid();
    const roadSystem = new RoadSystem(grid);
    const carSystem = new CarSystem(
      new Pathfinder(grid, cfg, new HighwaySystem()),
      grid,
      new PendingDeletionSystem(grid, roadSystem),
      cfg,
    );

    const house = new House({ gx: 10, gy: 10 }, GameColor.Red);
    carSystem.registerHouse(house);

    const cars = carSystem.getCars();
    expect(cars).toHaveLength(5);
    expect(house.carIds).toHaveLength(5);
    for (const car of cars) {
      expect(car.fuelCapacity).toBe(42);
      expect(car.fuel).toBe(42);
    }
  });

  it('defaults match DEFAULT_GAME_CONSTANTS when a map overrides nothing', () => {
    const cfg = buildConfig();
    const grid = new Grid();
    const roadSystem = new RoadSystem(grid);
    const carSystem = new CarSystem(
      new Pathfinder(grid, cfg, new HighwaySystem()),
      grid,
      new PendingDeletionSystem(grid, roadSystem),
      cfg,
    );

    carSystem.registerHouse(new House({ gx: 10, gy: 10 }, GameColor.Red));

    expect(carSystem.getCars()).toHaveLength(DEFAULT_GAME_CONSTANTS.CARS_PER_HOUSE);
    expect(carSystem.getCars()[0].fuelCapacity).toBe(DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
  });
});
