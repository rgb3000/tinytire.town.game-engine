/**
 * Covers the weekly economy — the calendar, the automatic road bonus and the weekly choice.
 *
 * This logic lived inside `Game` until now, which meant it needed a canvas and a WebGL
 * context to observe and therefore had no coverage at all. Extracted, it is plain
 * arithmetic over an elapsed time and runs headless.
 *
 * Expectations are derived from `DEFAULT_GAME_CONSTANTS` rather than hardcoding its values,
 * so retuning the defaults does not turn this red for no reason.
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_GAME_CONSTANTS, buildConfig } from '../constants';
import { EconomySystem } from './EconomySystem';
import type { GameConstants, Inventory } from '../maps/types';

/**
 * A fast clock keeps the arithmetic readable: one day per second, two days per week, so
 * week 2 begins at t=2s.
 */
const FAST: Partial<GameConstants> = { DAY_LENGTH_SECONDS: 1, WEEK_LENGTH_DAYS: 2 };

function makeEconomy(overrides?: Partial<GameConstants>, random?: () => number) {
  const inventory: Inventory = { roads: 0, highways: 0, gasStations: 0 };
  const economy = new EconomySystem(
    buildConfig(overrides),
    (slot, amount) => { inventory[slot] += amount; },
    random,
  );
  return { economy, inventory };
}

describe('week clock', () => {
  it('starts on day 1 of week 1', () => {
    const { economy } = makeEconomy();
    expect(economy.getGameDay(0)).toBe(1);
    expect(economy.getGameWeek(0)).toBe(1);
    expect(economy.getCurrentWeek()).toBe(1);
  });

  it('rolls the day at DAY_LENGTH_SECONDS', () => {
    const { economy } = makeEconomy(FAST);
    expect(economy.getGameDay(0.9)).toBe(1);
    expect(economy.getGameDay(1)).toBe(2);
  });

  it('rolls the week after WEEK_LENGTH_DAYS days', () => {
    const { economy } = makeEconomy(FAST);
    expect(economy.getGameWeek(1.9)).toBe(1);
    expect(economy.getGameWeek(2)).toBe(2);
  });

  it('honours a map override of the day length', () => {
    const { economy } = makeEconomy({ DAY_LENGTH_SECONDS: 60 });
    expect(economy.getGameDay(59)).toBe(1);
    expect(economy.getGameDay(60)).toBe(2);
  });
});

describe('week transition', () => {
  it('does not fire at the start of the run', () => {
    const { economy, inventory } = makeEconomy(FAST);
    expect(economy.tick(0)).toBe(false);
    expect(inventory.roads).toBe(0);
    expect(economy.isWeekChoicePending()).toBe(false);
  });

  it('does not fire before the boundary', () => {
    const { economy, inventory } = makeEconomy(FAST);
    expect(economy.tick(1.9)).toBe(false);
    expect(inventory.roads).toBe(0);
  });

  it('grants the road bonus and offers a choice on a new week', () => {
    const { economy, inventory } = makeEconomy(FAST);

    expect(economy.tick(2)).toBe(true);
    expect(inventory.roads).toBe(DEFAULT_GAME_CONSTANTS.WEEKLY_ROAD_BONUS);
    expect(economy.getCurrentWeek()).toBe(2);
    expect(economy.isWeekChoicePending()).toBe(true);
  });

  it('grants exactly once per week', () => {
    const { economy, inventory } = makeEconomy(FAST);
    economy.tick(2);
    const afterFirst = inventory.roads;

    expect(economy.tick(2.5)).toBe(false);
    expect(inventory.roads).toBe(afterFirst);
  });

  it('grants again on the following week', () => {
    const { economy, inventory } = makeEconomy(FAST);
    economy.tick(2);
    expect(economy.tick(4)).toBe(true);
    expect(economy.getCurrentWeek()).toBe(3);
    expect(inventory.roads).toBe(2 * DEFAULT_GAME_CONSTANTS.WEEKLY_ROAD_BONUS);
  });

  it('grants one bonus when several weeks elapse in a single tick', () => {
    // Pins existing behaviour rather than endorsing it: a long frame or a big time jump
    // skips the intervening bonuses. Changing that should be a deliberate act.
    const { economy, inventory } = makeEconomy(FAST);

    expect(economy.tick(10)).toBe(true);
    expect(economy.getCurrentWeek()).toBe(6);
    expect(inventory.roads).toBe(DEFAULT_GAME_CONSTANTS.WEEKLY_ROAD_BONUS);
  });

  it('honours a map override of the road bonus', () => {
    const { economy, inventory } = makeEconomy({ ...FAST, WEEKLY_ROAD_BONUS: 7 });
    economy.tick(2);
    expect(inventory.roads).toBe(7);
  });
});

describe('choice pool', () => {
  it('always offers exactly two distinct options', () => {
    for (let trial = 0; trial < 200; trial++) {
      const { economy } = makeEconomy({ ...FAST, HIGHWAY_UNLOCK_WEEK: 1 });
      economy.tick(2);
      const options = economy.getPendingChoiceOptions();
      expect(options).toHaveLength(2);
      expect(options[0].type).not.toBe(options[1].type);
    }
  });

  it('offers well-formed options', () => {
    const { economy } = makeEconomy(FAST);
    economy.tick(2);
    for (const option of economy.getPendingChoiceOptions()) {
      expect(['roads', 'highways', 'gasStations']).toContain(option.type);
      expect(option.amount).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('never offers a highway before HIGHWAY_UNLOCK_WEEK', () => {
    for (let trial = 0; trial < 100; trial++) {
      const { economy } = makeEconomy({ ...FAST, HIGHWAY_UNLOCK_WEEK: 4 });
      // Weeks 2 and 3 are both before the unlock.
      economy.tick(2);
      expect(economy.getPendingChoiceOptions().some(o => o.type === 'highways')).toBe(false);
      economy.tick(4);
      expect(economy.getPendingChoiceOptions().some(o => o.type === 'highways')).toBe(false);
    }
  });

  it('can offer a highway from HIGHWAY_UNLOCK_WEEK onward', () => {
    // Deterministic rather than statistical: with `random` pinned to 0, the Fisher-Yates
    // pass over [roads, gas, highway] lands highway in the first two slots.
    const { economy } = makeEconomy({ ...FAST, HIGHWAY_UNLOCK_WEEK: 4 }, () => 0);
    // Week 4 begins at day 7, i.e. t=6 on the fast clock.
    economy.tick(6);
    expect(economy.getCurrentWeek()).toBe(4);
    expect(economy.getPendingChoiceOptions().some(o => o.type === 'highways')).toBe(true);
  });

  it('replaces the previous week\'s options rather than accumulating', () => {
    const { economy } = makeEconomy(FAST);
    economy.tick(2);
    economy.tick(4);
    expect(economy.getPendingChoiceOptions()).toHaveLength(2);
  });
});

describe('applyWeeklyChoice', () => {
  it('credits roads', () => {
    const { economy, inventory } = makeEconomy(FAST);
    const before = inventory.roads;
    economy.applyWeeklyChoice({ type: 'roads', amount: 20, label: '+20 Roads' });
    expect(inventory.roads).toBe(before + 20);
    expect(inventory.highways).toBe(0);
    expect(inventory.gasStations).toBe(0);
  });

  it('credits gas stations', () => {
    const { economy, inventory } = makeEconomy(FAST);
    economy.applyWeeklyChoice({ type: 'gasStations', amount: 1, label: '+1 Gas Station' });
    expect(inventory.gasStations).toBe(1);
    expect(inventory.roads).toBe(0);
  });

  it('credits highways', () => {
    const { economy, inventory } = makeEconomy(FAST);
    economy.applyWeeklyChoice({ type: 'highways', amount: 1, label: '+1 Highway' });
    expect(inventory.highways).toBe(1);
    expect(inventory.roads).toBe(0);
  });

  it('closes the pending choice', () => {
    const { economy } = makeEconomy(FAST);
    economy.tick(2);
    expect(economy.isWeekChoicePending()).toBe(true);

    economy.applyWeeklyChoice(economy.getPendingChoiceOptions()[0]);
    expect(economy.isWeekChoicePending()).toBe(false);
    expect(economy.getPendingChoiceOptions()).toHaveLength(0);
  });

  it('does not advance the week', () => {
    const { economy } = makeEconomy(FAST);
    economy.tick(2);
    economy.applyWeeklyChoice(economy.getPendingChoiceOptions()[0]);
    expect(economy.getCurrentWeek()).toBe(2);
  });
});

describe('config accessors', () => {
  it('report the resolved values Game delegates to', () => {
    const { economy } = makeEconomy({ WEEK_LENGTH_DAYS: 5, WEEKLY_ROAD_BONUS: 33 });
    expect(economy.getWeekLengthDays()).toBe(5);
    expect(economy.getWeeklyRoadBonus()).toBe(33);
  });
});
