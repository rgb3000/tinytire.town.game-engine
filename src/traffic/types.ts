import type { GridPos, PixelPos } from '../types';

/**
 * What a stretch of a route is made of. Affects only the speed limit and, for
 * `Highway`, whether an elevation profile applies. Position is always arc distance.
 */
export const SegmentKind = {
  Road: 0,
  Intersection: 1,
  Connector: 2,
  Highway: 3,
} as const;
export type SegmentKind = (typeof SegmentKind)[keyof typeof SegmentKind];

/** One grid cell as handed to the route builder by the adapter. */
export interface RouteCellInput {
  pos: GridPos;
  kind: SegmentKind;
  /** Pixels per second. Already resolved from the map config by the adapter. */
  speedLimit: number;
  pendingDeletion: boolean;
}

export type RouteSpan =
  | { kind: 'grid'; cells: RouteCellInput[] }
  | { kind: 'highway'; polyline: PixelPos[]; speedLimit: number };

export interface RouteInput {
  id: string;
  spans: RouteSpan[];
}

export interface RouteSegment {
  kind: SegmentKind;
  startArc: number;
  endArc: number;
  speedLimit: number;
  pendingDeletion: boolean;
}

export interface Route {
  id: string;
  points: PixelPos[];
  cumDist: number[];
  /**
   * Grid cells traversed, in order. Highway spans contribute none, and a cell shared as
   * the joint between two adjacent grid spans appears once.
   */
  cells: GridPos[];
  /**
   * Arc distance of each entry in `cells`. Strictly increasing — consumers may divide by
   * the gap between neighbours.
   */
  cellDist: number[];
  segments: RouteSegment[];
  length: number;
}

export interface RouteSample {
  x: number;
  y: number;
  angle: number;
  elevationY: number;
}

export const VehicleMode = {
  Driving: 0,
  /** Physically present and blocking, but not advancing. */
  Parked: 1,
} as const;
export type VehicleMode = (typeof VehicleMode)[keyof typeof VehicleMode];

export interface Vehicle {
  id: string;
  routeId: string;
  /** Position along the route, in pixels. The single source of truth. */
  arcDistance: number;
  /** Pixels per second. */
  speed: number;
  mode: VehicleMode;
  /** Set by the stepper each tick; diagnostic only. */
  lastAcceleration: number;
  /**
   * World time at which this vehicle began waiting at its current junction, or 0 if it is
   * not waiting. Feeds the arrival-time key in junction admission.
   */
  arrivalTime: number;
  /**
   * Arc distance covered in the most recent `step`, in pixels.
   *
   * Written every tick and read by the adapter to deduct fuel. Carried on the vehicle
   * rather than emitted as a per-tick event so that a 200-car world does not allocate 200
   * event objects every frame — events are reserved for things that actually happen.
   */
  distanceThisTick: number;
}

export interface TrafficWorld {
  routes: Map<string, Route>;
  vehicles: Vehicle[];
  /** Seconds since the world was created. Advanced by `step`. */
  time: number;
}

/**
 * Events report things that *happened*, not per-tick state. Continuous quantities like
 * distance travelled live on the vehicle, so a busy frame allocates nothing.
 *
 * One vocabulary, two emitters. `step` emits `Arrived`. `Blocked` is emitted by
 * `TrafficAdapter` and never by anything in here, deliberately: "blocked" is a claim about
 * a *remedy* — some length of standstill after which the game should reroute or strand the
 * car — and both the threshold and the remedy are game-side. The kind lives here anyway so
 * that the adapter's caller has a single event stream to switch on rather than two.
 */
export const TrafficEventKind = {
  Arrived: 0,
  /**
   * A vehicle has stood still long enough that something outside the simulation must
   * intervene. See `TrafficAdapter.update`.
   */
  Blocked: 1,
} as const;
export type TrafficEventKind = (typeof TrafficEventKind)[keyof typeof TrafficEventKind];

export interface TrafficEvent {
  kind: TrafficEventKind;
  vehicleId: string;
}

export function createWorld(): TrafficWorld {
  return { routes: new Map(), vehicles: [], time: 0 };
}
