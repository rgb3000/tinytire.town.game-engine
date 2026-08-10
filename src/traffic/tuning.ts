import { TILE_SIZE } from '../constants';
import type { IdmParams } from './headway';

/**
 * Intelligent Driver Model parameters, in pixels and seconds.
 *
 * Deliberately module constants and **not** keys of `GameConstants`: a map may set
 * `CAR_SPEED`, but the feel of following distance is engine-wide. Adding any of these to
 * `GameConstants` would require a wire-schema change and would trip `constants.test.ts`
 * if they were then imported directly, as they are here.
 *
 * Starting values only. These want a tuning pass in the demo — the tests prove the model
 * is correct, not that it feels right at one tile per second.
 */
export const DEFAULT_IDM: IdmParams = {
  s0: TILE_SIZE * 0.35,   // 14px — standstill gap, a little over one car length (12px)
  T: 0.6,                 // desired time headway, seconds
  a: TILE_SIZE * 1.0,     // 40px/s² — reaches one tile/sec in about a second
  b: TILE_SIZE * 1.5,     // 60px/s² — comfortable braking
  delta: 4,
};

/** Hard ceiling on braking, used to clamp the integrator. Emergency, not comfort. */
export const MAX_DECELERATION = TILE_SIZE * 4;

/** How many route edges ahead the leader search scans. Beyond this, gaps are irrelevant. */
export const LEADER_SCAN_EDGES = 3;

/** Arrival times within this many seconds count as simultaneous for rechts vor links. */
export const SIMULTANEOUS_EPS = 0.05;

/** A car is "stopped" for exit-clearance purposes below this speed. */
export const STOPPED_SPEED = TILE_SIZE * 0.05;
