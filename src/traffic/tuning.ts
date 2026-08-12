import { CAR_LENGTH, TILE_SIZE } from '../constants';
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
  s0: TILE_SIZE * 0.1,    // 4px — standstill gap between bumpers; queues pack close to
                          // bumper-to-bumper (a third of the 12px car length). Was 0.35,
                          // which read as each car keeping a whole car length of daylight.
  T: 0.6,                 // desired time headway, seconds
  a: TILE_SIZE * 1.0,     // 40px/s² — reaches one tile/sec in about a second
  b: TILE_SIZE * 1.5,     // 60px/s² — comfortable braking
  delta: 4,
};

/** Hard ceiling on braking, used to clamp the integrator. Emergency, not comfort. */
export const MAX_DECELERATION = TILE_SIZE * 4;

/**
 * How far behind the junction boundary a waiting car's *centre* comes to rest, px.
 *
 * A stop line is a line, not a car: parking `s0` behind it, the right thing behind a
 * physical leader, is arbitrary before a painted line — with the original `s0` of 14px it
 * left a waiting car's nose a full 20px of empty asphalt short of the crossing pavement
 * (`ROAD_HALF_WIDTH` is 8px from the junction centre), reading as a car refusing to pull
 * up. `nearestConstraint` therefore offsets the stop constraint by `s0 - STOP_LINE_SETBACK`
 * (either side of the boundary — the sign follows the tuning), so the IDM equilibrium
 * rest — constraint minus `s0` — lands here, independent of any retune of `s0`.
 *
 * Bracketed on both sides:
 *
 * - **Lower bound 5px** — the forced-stop distance from full road speed,
 *   `CAR_SPEED² / (2 · MAX_DECELERATION)` = 40²/320. A car can lose admission on the tick a
 *   competitor with a better claim stamps in; below this margin it crosses the boundary
 *   while stopping, flips `inside`, and is granted the absolute priority it was just
 *   denied. (A map raising `CAR_SPEED` past ~1.1 tiles/s erodes the margin — at 6px the
 *   breach speed is 44px/s. The integrator's own settle error is 0.281px, an order of
 *   magnitude inside the margin.)
 * - **Upper bound: purely visual.** Every pixel of setback is daylight between the resting
 *   nose and the line; 14px of it was the original complaint this constant exists to fix.
 *
 * `CAR_LENGTH / 2` = 6px rests the nose exactly on the boundary: visually at the line,
 * still a pixel of margin over the worst forced stop.
 */
export const STOP_LINE_SETBACK = CAR_LENGTH / 2;

/** How many route edges ahead the leader search scans. Beyond this, gaps are irrelevant. */
export const LEADER_SCAN_EDGES = 3;

/** Arrival times within this many seconds count as simultaneous for rechts vor links. */
export const SIMULTANEOUS_EPS = 0.05;

/** A car is "stopped" for exit-clearance purposes below this speed. */
export const STOPPED_SPEED = TILE_SIZE * 0.05;

/**
 * How long a vehicle may stand still, having not chosen to, before `TrafficAdapter` reports
 * it as `Blocked` and asks the game to intervene. Seconds.
 *
 * **Defensible only in terms of the two measurements that bracket it, so both are recorded
 * here.** A value outside that window is wrong in one of two ways, and neither is visible
 * from the code:
 *
 * - **Lower bound 9.65s** — the longest stall Task 8 measured on a loaded nine-junction city
 *   that went on to clear its load normally. Congestion that resolves itself is not a
 *   defect, and a watchdog that fires on it trains its consumer to ignore the event, which
 *   is worse than having no watchdog because it reads as coverage. The predecessor of this
 *   constant, `UNIVERSAL_STUCK_TIMEOUT`, was 8s and therefore sat *below* observed-healthy
 *   behaviour.
 * - **Upper bound 15s** — the `maxStall` bound the invariant sweeps in
 *   `src/traffic/invariants.test.ts` assert. Past that the simulation's own tests call the
 *   run defective, so the watchdog must have spoken before then or it has nothing to add.
 *
 * 12 leaves ~24% headroom over the worst healthy stall and 3s of margin under the bound.
 * `does not fire during a congested stall that resolves itself` pins the lower half
 * behaviourally, so lowering this back toward 8 fails rather than silently regressing.
 *
 * It lives here rather than in `src/constants.ts` for two reasons: it is engine-wide feel
 * rather than a per-map setting, so it must not become a `GameConstants` key; and Task 14
 * deleted `UNIVERSAL_STUCK_TIMEOUT` from `src/constants.ts`. That deletion is verified by
 * checking for live *imports*, not for mentions of the name — this paragraph is itself a
 * mention, and is the record of why 8s was the wrong number, so a grep for the bare name
 * will always find it and finding it is not a failure.
 */
export const STALL_WATCHDOG_SECONDS = 12;
