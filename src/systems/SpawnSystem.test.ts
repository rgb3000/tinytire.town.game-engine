/**
 * Covers `SpawnSystem.getColorSupplyRate` — the distance-scaled estimate of how fast a
 * colour's houses can clear demand pins.
 *
 * This is worth a test for two reasons. It is the rule that decides whether the next spawn
 * is a house or a business, so getting it wrong quietly changes the difficulty curve. And it
 * is one of the few pieces of the simulation that is observable without a canvas: it needs
 * only a `Grid`, a standing-still demand source and a resolved config.
 *
 * The numbers below are derived from `DEFAULT_GAME_CONSTANTS`, not hardcoded copies of it,
 * so retuning the defaults does not turn this red for no reason.
 */
import { describe, it, expect } from 'vitest';

import { buildConfig } from '../constants';
import { Grid } from '../core/Grid';
import { GameColor } from '../types';
import { SpawnSystem, type SpawnDemandSource } from './SpawnSystem';
import type { GameConstants } from '../maps/types';

/** The designer's stub: buildings exist, nothing consumes. */
const NO_DEMAND: SpawnDemandSource = { getColorPinOutputRate: () => 0 };

function makeSystem(overrides?: Partial<GameConstants>): { spawn: SpawnSystem; cfg: GameConstants } {
  const cfg = buildConfig(overrides);
  return { spawn: new SpawnSystem(new Grid(), NO_DEMAND, cfg), cfg };
}

/**
 * A business anchored at `{gx, gy}` with rotation 0 puts its connector one cell below —
 * see `LAYOUT_OFFSETS` in `src/entities/Business.ts`. The connector is what distance is
 * measured to, so anchoring here keeps the arithmetic in the tests obvious.
 */
function connectorOf(anchor: { gx: number; gy: number }) {
  return { gx: anchor.gx, gy: anchor.gy + 1 };
}

describe('getColorSupplyRate', () => {
  it('falls back to the max rate when the colour has no businesses to be far from', () => {
    const { spawn, cfg } = makeSystem();

    spawn.spawnHouse({ gx: 10, gy: 10 }, GameColor.Red);
    spawn.spawnHouse({ gx: 12, gy: 10 }, GameColor.Red);

    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(2 * cfg.HOUSE_SUPPLY_PER_MINUTE);
  });

  it('is zero for a colour with no houses', () => {
    const { spawn } = makeSystem();
    spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Blue, 0);

    expect(spawn.getColorSupplyRate(GameColor.Blue)).toBe(0);
  });

  it('uses the max rate at or inside NEAR distance', () => {
    const { spawn, cfg } = makeSystem();
    const anchor = { gx: 20, gy: 20 };
    spawn.spawnBusiness(anchor, GameColor.Red, 0);

    // Straight up from the connector, well inside HOUSE_SUPPLY_NEAR_DISTANCE (10).
    const near = { gx: connectorOf(anchor).gx, gy: connectorOf(anchor).gy - 5 };
    spawn.spawnHouse(near, GameColor.Red);

    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);
  });

  it('uses the min rate at or beyond FAR distance', () => {
    const { spawn, cfg } = makeSystem();
    const anchor = { gx: 20, gy: 20 };
    spawn.spawnBusiness(anchor, GameColor.Red, 0);

    // 50 cells to the right of the connector — past HOUSE_SUPPLY_FAR_DISTANCE (40).
    const far = { gx: connectorOf(anchor).gx + 50, gy: connectorOf(anchor).gy };
    spawn.spawnHouse(far, GameColor.Red);

    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE_MIN);
  });

  it('interpolates linearly between NEAR and FAR', () => {
    const { spawn, cfg } = makeSystem();
    const anchor = { gx: 20, gy: 20 };
    spawn.spawnBusiness(anchor, GameColor.Red, 0);

    // Exactly halfway between NEAR (10) and FAR (40) on a pure-horizontal run, where
    // octile distance is just dx.
    const midDistance = (cfg.HOUSE_SUPPLY_NEAR_DISTANCE + cfg.HOUSE_SUPPLY_FAR_DISTANCE) / 2;
    spawn.spawnHouse({ gx: connectorOf(anchor).gx + midDistance, gy: connectorOf(anchor).gy }, GameColor.Red);

    const halfway = (cfg.HOUSE_SUPPLY_PER_MINUTE + cfg.HOUSE_SUPPLY_PER_MINUTE_MIN) / 2;
    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(halfway);
  });

  it('rates a distant house below a close one', () => {
    const near = makeSystem();
    near.spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
    near.spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);

    const far = makeSystem();
    far.spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
    far.spawn.spawnHouse({ gx: 70, gy: 21 }, GameColor.Red);

    expect(far.spawn.getColorSupplyRate(GameColor.Red))
      .toBeLessThan(near.spawn.getColorSupplyRate(GameColor.Red));
  });

  it('counts only same-colour houses and businesses', () => {
    const { spawn, cfg } = makeSystem();

    spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
    spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);
    // A blue house next door must not inflate red's supply.
    spawn.spawnHouse({ gx: 21, gy: 16 }, GameColor.Blue);

    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);
    // Blue has no businesses, so it takes the no-business fallback.
    expect(spawn.getColorSupplyRate(GameColor.Blue)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);
  });

  it('honours a map override of the supply constants', () => {
    // A map that says distance barely matters: NEAR and FAR both far beyond the grid.
    const { spawn } = makeSystem({
      HOUSE_SUPPLY_PER_MINUTE: 4,
      HOUSE_SUPPLY_PER_MINUTE_MIN: 1,
      HOUSE_SUPPLY_NEAR_DISTANCE: 100,
      HOUSE_SUPPLY_FAR_DISTANCE: 200,
    });

    spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
    spawn.spawnHouse({ gx: 70, gy: 21 }, GameColor.Red);

    // 50 cells away is now "near", so the overridden max rate applies in full.
    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(4);
  });

  it('averages distances, not per-business rates', () => {
    // Distances 2 and 18 average to 10, which with FAR = 10 clamps to the min rate.
    // Converting each distance to a rate first and averaging those would give roughly
    // 1.02 instead, because the near business never reaches the clamp. Only an exact
    // min here proves the averaging happens on distances — so this test fails if anyone
    // "simplifies" the nested reduce.
    const { spawn, cfg } = makeSystem({
      HOUSE_SUPPLY_NEAR_DISTANCE: 0,
      HOUSE_SUPPLY_FAR_DISTANCE: 10,
    });

    // Rotation 0 puts each connector one cell below its anchor: (30,21) and (50,21).
    spawn.spawnBusiness({ gx: 30, gy: 20 }, GameColor.Red, 0);
    spawn.spawnBusiness({ gx: 50, gy: 20 }, GameColor.Red, 0);
    spawn.spawnHouse({ gx: 32, gy: 21 }, GameColor.Red);

    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE_MIN);
  });

  describe('memoisation', () => {
    it('reflects a business appearing far away', () => {
      const { spawn, cfg } = makeSystem();
      spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);
      // No businesses yet: the fallback max rate.
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);

      spawn.spawnBusiness({ gx: 70, gy: 40 }, GameColor.Red, 0);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE_MIN);
    });

    it('reflects a house appearing', () => {
      const { spawn, cfg } = makeSystem();
      spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
      spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);

      spawn.spawnHouse({ gx: 22, gy: 16 }, GameColor.Red);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(2 * cfg.HOUSE_SUPPLY_PER_MINUTE);
    });

    it('reflects a house being removed', () => {
      const { spawn, cfg } = makeSystem();
      spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
      spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);
      spawn.spawnHouse({ gx: 22, gy: 16 }, GameColor.Red);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(2 * cfg.HOUSE_SUPPLY_PER_MINUTE);

      spawn.removeHouse(spawn.getHouses()[0].id);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);
    });

    it('reflects the last business being removed', () => {
      const { spawn, cfg } = makeSystem();
      spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
      spawn.spawnHouse({ gx: 70, gy: 21 }, GameColor.Red);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE_MIN);

      // With nothing left to be far from, the house is back on the max-rate fallback.
      spawn.removeBusiness(spawn.getBusinesses()[0].id);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(cfg.HOUSE_SUPPLY_PER_MINUTE);
    });

    it('is stable when nothing changes', () => {
      const { spawn } = makeSystem();
      spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
      spawn.spawnHouse({ gx: 40, gy: 21 }, GameColor.Red);

      const first = spawn.getColorSupplyRate(GameColor.Red);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBe(first);
      expect(spawn.getColorSupplyRate(GameColor.Red)).toBe(first);
    });
  });

  it('sums across houses', () => {
    const { spawn, cfg } = makeSystem();
    spawn.spawnBusiness({ gx: 20, gy: 20 }, GameColor.Red, 0);
    spawn.spawnHouse({ gx: 20, gy: 16 }, GameColor.Red);
    spawn.spawnHouse({ gx: 22, gy: 16 }, GameColor.Red);
    spawn.spawnHouse({ gx: 24, gy: 16 }, GameColor.Red);

    // All three are inside NEAR, so each contributes the max rate.
    expect(spawn.getColorSupplyRate(GameColor.Red)).toBeCloseTo(3 * cfg.HOUSE_SUPPLY_PER_MINUTE);
  });
});
