import type { GameConstants, Inventory, WeeklyChoiceOption } from '../maps/types';

/**
 * The weekly economy: the calendar, the automatic road bonus, and the choice the player is
 * offered when a new week begins.
 *
 * Extracted from `Game`, which held the three pieces of state, the choice generator and the
 * transition check inline among its rendering and input concerns. Keeping it separate is
 * what makes it testable at all — everything here is arithmetic over an elapsed time, so it
 * runs in Node without a canvas, and `src/systems/EconomySystem.test.ts` is the first real
 * coverage this logic has had.
 *
 * Deliberately knows nothing about `GameState` or audio. A new week is *reported*; pausing
 * the game and stopping the music stay with `Game`, which owns both.
 */
export class EconomySystem {
  private currentWeek = 1;
  private weekChoicePending = false;
  private pendingChoiceOptions: WeeklyChoiceOption[] = [];

  private dayLengthSeconds: number;
  private weekLengthDays: number;
  private weeklyRoadBonus: number;
  private highwayUnlockWeek: number;

  private credit: (slot: keyof Inventory, amount: number) => void;
  private random: () => number;

  /**
   * Takes a *fully resolved* `GameConstants` — see the note on `SpawnSystem`'s constructor
   * for why this is not a `Partial`. Reading these four keys from the resolved config rather
   * than importing them is also what keeps `src/constants.test.ts` green.
   *
   * `credit` is a callback rather than an `Inventory` reference because `Game.buildWorld()`
   * replaces the inventory object wholesale on every restart; a captured reference would go
   * on paying bonuses into a discarded object.
   *
   * `random` is injectable so the weekly-choice shuffle can be pinned in tests.
   */
  constructor(
    cfg: GameConstants,
    credit: (slot: keyof Inventory, amount: number) => void,
    random: () => number = Math.random,
  ) {
    this.dayLengthSeconds = cfg.DAY_LENGTH_SECONDS;
    this.weekLengthDays = cfg.WEEK_LENGTH_DAYS;
    this.weeklyRoadBonus = cfg.WEEKLY_ROAD_BONUS;
    this.highwayUnlockWeek = cfg.HIGHWAY_UNLOCK_WEEK;
    this.credit = credit;
    this.random = random;
  }

  /** 1-based: the run starts on day 1. */
  getGameDay(elapsedTime: number): number {
    return Math.floor(elapsedTime / this.dayLengthSeconds) + 1;
  }

  /** 1-based: the run starts in week 1. */
  getGameWeek(elapsedTime: number): number {
    return Math.floor((this.getGameDay(elapsedTime) - 1) / this.weekLengthDays) + 1;
  }

  getCurrentWeek(): number {
    return this.currentWeek;
  }

  getWeekLengthDays(): number {
    return this.weekLengthDays;
  }

  getWeeklyRoadBonus(): number {
    return this.weeklyRoadBonus;
  }

  isWeekChoicePending(): boolean {
    return this.weekChoicePending;
  }

  getPendingChoiceOptions(): WeeklyChoiceOption[] {
    return this.pendingChoiceOptions;
  }

  /**
   * Advance the week clock, granting the road bonus and generating a choice if a new week
   * has begun. Returns whether it did, which the caller turns into a pause.
   *
   * Skipping several weeks in one call grants one bonus, not one per week. That is existing
   * behaviour and is pinned by a test so that changing it has to be deliberate.
   */
  tick(elapsedTime: number): boolean {
    const newWeek = this.getGameWeek(elapsedTime);
    if (newWeek <= this.currentWeek) return false;

    this.currentWeek = newWeek;
    this.credit('roads', this.weeklyRoadBonus);
    this.pendingChoiceOptions = this.generateChoiceOptions();
    this.weekChoicePending = true;
    return true;
  }

  /** Credit the chosen option and close the choice. */
  applyWeeklyChoice(option: WeeklyChoiceOption): void {
    this.credit(option.type, option.amount);
    this.weekChoicePending = false;
    this.pendingChoiceOptions = [];
  }

  /**
   * Two options drawn from the pool available this week.
   *
   * The amounts are literals rather than `WEEKLY_ROAD_BONUS` and friends on purpose: the
   * weekly bonus is what you get automatically, while this is what you get for *picking*
   * roads over a gas station. They happen to share the value 20 today, but tying them
   * together would let a map that retunes the automatic bonus silently retune the choice as
   * well. Making these configurable means new `GameConstants` keys and templated labels —
   * a balance decision, not a refactor.
   */
  private generateChoiceOptions(): WeeklyChoiceOption[] {
    const pool: WeeklyChoiceOption[] = [
      { type: 'roads', amount: 20, label: '+20 Roads' },
      { type: 'gasStations', amount: 1, label: '+1 Gas Station' },
    ];
    if (this.currentWeek >= this.highwayUnlockWeek) {
      pool.push({ type: 'highways', amount: 1, label: '+1 Highway' });
    }
    // Shuffle and take 2
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 2);
  }
}
