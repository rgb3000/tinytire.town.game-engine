import type { GameConstants } from '../../maps/types';

/**
 * The complete set of `GameConstants` keys the car simulation honours.
 *
 * A `Pick` rather than a hand-written interface: it is *derived* from `GameConstants`, so
 * renaming a key there is a compile error here instead of leaving a silently orphaned
 * duplicate. Same reasoning as `SpawnDemandSource` in `src/systems/SpawnSystem.ts`, which
 * keeps a system's dependency narrow, plus the cannot-drift property.
 *
 * All six used to be read as module-level constants inside the individual managers, which
 * meant a map that set `CAR_SPEED` (or any of the others) changed nothing at all — the
 * key was declared configurable, accepted by the wire schema, persisted by the designer,
 * and then ignored. Each manager below takes only the slice it actually observes, so it
 * stays obvious from a signature which constants a file can be affected by.
 *
 * `GameConstants` satisfies every one of these structurally, so `CarSystem` forwards its
 * own resolved config with no object construction.
 */
export type CarTuning = Pick<
  GameConstants,
  | 'CARS_PER_HOUSE'
  | 'CAR_SPEED'
  | 'UNLOAD_TIME'
  | 'FUEL_CAPACITY'
  | 'REFUEL_TIME'
  | 'HIGHWAY_SPEED_MULTIPLIER'
>;
