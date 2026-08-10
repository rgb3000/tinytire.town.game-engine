import { CAR_LENGTH } from '../constants';
import { Direction } from '../types';
import { getDirection } from '../utils/direction';
import { LEADER_SCAN_EDGES } from './tuning';
import type { Route, TrafficWorld, Vehicle } from './types';

/** Direction bitmask (1,2,4,…,128) to a dense 0-7 index, for packing into a lane key. */
const DIR_INDEX: Record<number, number> = {
  [Direction.Up]: 0, [Direction.Down]: 1, [Direction.Left]: 2, [Direction.Right]: 3,
  [Direction.UpLeft]: 4, [Direction.UpRight]: 5, [Direction.DownLeft]: 6, [Direction.DownRight]: 7,
};

/**
 * A lane is one directed edge between adjacent cells, keyed by its start cell and the
 * direction of travel.
 *
 * The key deliberately does not involve the *observer's* heading, which is what
 * `CarLeaderIndex` did — it bucketed by `directionToLane(dir)` computed from whoever was
 * looking, so a car that entered a tile from a different approach landed in a different
 * bucket and was invisible. Keying on the edge itself makes every car on that ground
 * visible to every other car on it.
 */
export function laneKey(gx: number, gy: number, dir: Direction): number {
  return gx | (gy << 8) | (DIR_INDEX[dir] << 16);
}

/**
 * Which edge of the route the arc distance falls on: the edge from `cells[i]` to
 * `cells[i+1]`. Clamped to the last edge.
 *
 * A car standing exactly on a cell centre is on the edge *leaving* that cell, which is
 * the lane it is committed to. Relies on `cellDist` being strictly increasing.
 */
export function edgeIndexAt(route: Route, arc: number): number {
  const lastEdge = Math.max(0, route.cells.length - 2);
  if (route.cells.length < 2) return 0;
  for (let i = 0; i < route.cells.length - 1; i++) {
    if (arc < route.cellDist[i + 1]) return i;
  }
  return lastEdge;
}

/**
 * The lane key of one edge of a route, or null past the end.
 *
 * The two cells need not be grid-adjacent. A highway span contributes no cells at all, so
 * the edge either side of one joins the last cell before the crossing to the first cell
 * after it. `getDirection` reduces that to a dominant-axis direction, which yields a
 * well-formed key covering the whole crossing: every car on the highway shares one bucket
 * ordered by arc, which is what a single-lane highway wants and is the only thing giving
 * those cars a leader at all. Do not add an adjacency guard here.
 *
 * The consequence is that the key of a highway edge carries a single direction even where
 * the polyline curves. That is harmless for leader ordering, which depends on arc rather
 * than heading, but nothing should try to infer geometry from a lane key.
 */
function laneKeyForEdge(route: Route, edgeIndex: number): number | null {
  if (edgeIndex < 0 || edgeIndex + 1 >= route.cells.length) return null;
  const from = route.cells[edgeIndex];
  const to = route.cells[edgeIndex + 1];
  return laneKey(from.gx, from.gy, getDirection(from, to));
}

interface LaneOccupant {
  vehicleId: string;
  /** Distance from the start cell of this edge, in px. Comparable across routes. */
  offset: number;
  speed: number;
}

export interface LeaderInfo {
  id: string;
  /**
   * Clear distance along the follower's own route to the leader's rear bumper, in px.
   *
   * Net, not centre-to-centre: one `CAR_LENGTH` is already subtracted here, so no consumer
   * repeats it. That makes the no-overlap invariant `gap >= 0` — a single condition that
   * cannot be mis-set — rather than `gap >= CAR_LENGTH`, a correction the stepper, the
   * collision sweep and every debug overlay would each have to reproduce independently.
   * It also restores IDM's own definition, where `s0` is the jam distance between bumpers.
   *
   * **May be negative** when vehicles genuinely overlap. Such a leader is reported rather
   * than filtered, because it is the one that most needs braking for; `idmAcceleration`
   * floors the gap at `1e-3`, which turns a negative gap into hard braking.
   */
  gap: number;
  speed: number;
}

/**
 * Which vehicles occupy which lane, rebuilt each tick.
 *
 * Offsets are measured from the shared start cell of the edge, so two vehicles on
 * different routes through the same edge are directly comparable. Their smoothed geometry
 * differs slightly where the surrounding cells differ, so the offset carries a few pixels
 * of error; the standstill gap `s0` is 14px, an order of magnitude larger, and the
 * stepper's hard clamp catches anything pathological. Do not try to eliminate it — making
 * offsets exact would mean giving up the cross-route comparison this buys.
 *
 * Parked vehicles are indexed like any other. They are physically sitting on the road, and
 * omitting them is precisely how followers came to drive onto them.
 */
export class LaneIndex {
  private byLane = new Map<number, LaneOccupant[]>();
  private pool: LaneOccupant[][] = [];

  rebuild(world: TrafficWorld): void {
    for (const list of this.byLane.values()) {
      list.length = 0;
      this.pool.push(list);
    }
    this.byLane.clear();

    for (const v of world.vehicles) {
      const route = world.routes.get(v.routeId);
      if (!route || route.cells.length < 2) continue;

      const edge = edgeIndexAt(route, v.arcDistance);
      const key = laneKeyForEdge(route, edge);
      if (key === null) continue;

      let list = this.byLane.get(key);
      if (!list) {
        list = this.pool.pop() ?? [];
        this.byLane.set(key, list);
      }
      list.push({
        vehicleId: v.id,
        offset: v.arcDistance - route.cellDist[edge],
        speed: v.speed,
      });
    }
  }

  /**
   * The nearest vehicle ahead of `vehicle` along its own route, or null.
   *
   * Scans forward edge by edge and stops at the first edge that yields a candidate, so the
   * result is the nearest by route distance rather than by straight-line distance. The old
   * index measured Euclidean pixels (`CarLeaderIndex.ts:90`), which understated the
   * urgency of a leader around a corner and so under-applied braking exactly where the
   * geometry was tightest.
   *
   * A vehicle converging on the same cell from a different approach is on a different edge
   * and is deliberately not found here. That cell is necessarily an intersection, and
   * junction admission serialises the two — the lane model and the junction model only
   * cover the space together.
   */
  findLeader(world: TrafficWorld, vehicle: Vehicle): LeaderInfo | null {
    const route = world.routes.get(vehicle.routeId);
    if (!route || route.cells.length < 2) return null;

    const startEdge = edgeIndexAt(route, vehicle.arcDistance);

    for (let n = 0; n < LEADER_SCAN_EDGES; n++) {
      const edge = startEdge + n;
      const key = laneKeyForEdge(route, edge);
      if (key === null) break;

      const occupants = this.byLane.get(key);
      if (!occupants) continue;

      const edgeStart = route.cellDist[edge];
      let best: LeaderInfo | null = null;

      for (const o of occupants) {
        // Kept explicit rather than left to the sign test below. `edgeStart + offset`
        // reconstructs the vehicle's own arc and is exact for every spacing the board
        // produces, but a net gap makes the failure mode expensive if it ever were not:
        // a sub-ulp positive difference would report the vehicle as its own leader a full
        // car length inside itself, and it would brake to a permanent stop.
        if (o.vehicleId === vehicle.id) continue;
        const theirArc = edgeStart + o.offset;
        // Ahead-ness is decided on the raw centre-to-centre difference, before the car
        // length comes off. Testing the net gap instead would drop an overlapping leader —
        // the single vehicle a follower most needs to brake for — as if it were behind.
        const rawAhead = theirArc - vehicle.arcDistance;
        if (rawAhead <= 0) continue;
        const gap = rawAhead - CAR_LENGTH;
        if (best === null || gap < best.gap) {
          best = { id: o.vehicleId, gap, speed: o.speed };
        }
      }

      if (best !== null) return best;
    }

    return null;
  }
}
