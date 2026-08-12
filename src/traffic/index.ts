/**
 * The traffic simulation's internal surface.
 *
 * Internal: `src/index.ts` re-exports none of this. The only consumer is
 * `src/systems/car/TrafficAdapter.ts`, which is the sole code that knows about both this
 * module's plain data and the engine's `Grid`, `Car` and renderers.
 */
export { buildRoute, sampleRoute, speedLimitAt, segmentAt } from './route';
export { cellsBetween, routeCoversCell, splitAt } from './routeQueries';
export { step } from './step';
// Tuning the adapter must reason about at its boundary: the safe-speed assertion needs the
// braking model, and the stall watchdog needs the same standstill threshold the junction's
// exit-clearance rule uses. Exported rather than duplicated so the two cannot drift.
export {
  DEFAULT_IDM, LEADER_SCAN_EDGES, MAX_DECELERATION, STALL_WATCHDOG_SECONDS, STOPPED_SPEED,
  STOP_LINE_SETBACK,
} from './tuning';
export { createWorld, SegmentKind, VehicleMode, TrafficEventKind } from './types';
export type {
  Route, RouteInput, RouteSpan, RouteCellInput, RouteSample, RouteSegment,
  TrafficWorld, TrafficEvent, Vehicle,
} from './types';
