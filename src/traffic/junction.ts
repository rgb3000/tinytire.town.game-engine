import { Direction } from '../types';
import { DIRECTION_OFFSETS, YIELD_TO_DIRECTION } from '../utils/direction';
import { LANE_OFFSET, TILE_SIZE } from '../constants';
import { SIMULTANEOUS_EPS } from './tuning';

export interface JunctionCandidate {
  /**
   * Must be unique among the candidates of a single `admit` call. Ranks are keyed by it,
   * so a duplicate collapses two vehicles into one rank, makes the comparator return 0 for
   * the pair (destroying order independence), and loses one of them from the result set.
   */
  vehicleId: string;
  /** Direction of travel into the junction. */
  entry: Direction;
  /** Direction of travel out of the junction. */
  exit: Direction;
  /**
   * Already past the entry boundary. Absolute priority.
   *
   * A vehicle inside the junction **must be offered as a candidate on every tick until it
   * has left**, and must keep `inside` set for the whole crossing. Safety here is not a
   * property of the vehicle but of the set: an inside vehicle sorts first and then blocks
   * every conflicting candidate behind it, which is the only thing preventing two
   * conflicting vehicles being inside at once. Drop it from the list for a single tick and
   * the junction will happily admit a crossing stream into it.
   */
  inside: boolean;
  /** When this vehicle first began waiting, in world seconds. */
  arrivalTime: number;
  /** Whether the cell beyond the junction has space. Enforces don't-block-the-box. */
  exitHasRoom: boolean;
}

export interface Point { x: number; y: number }
export interface Chord { a: Point; b: Point }

const LANE_FRAC = LANE_OFFSET / TILE_SIZE;

/** Unit vector along a direction. Diagonals are normalised so all points sit on a circle. */
function unit(dir: Direction): Point {
  const o = DIRECTION_OFFSETS[dir];
  const len = Math.sqrt(o.gx * o.gx + o.gy * o.gy) || 1;
  return { x: o.gx / len, y: o.gy / len };
}

/** Perpendicular to the driver's right. Screen y is down, matching `computeSmoothLanePath`. */
function right(dir: Direction): Point {
  const u = unit(dir);
  return { x: -u.y, y: u.x };
}

/**
 * The straight chord a maneuver traces across the junction cell, in cell-fraction units
 * centred on the cell (so ±0.5 is the cell boundary).
 *
 * Entering on `entry` means the car comes from the `-entry` side; leaving on `exit` means
 * it departs through the `+exit` side. Both endpoints sit on the right-hand lane.
 */
export function maneuverChord(entry: Direction, exit: Direction): Chord {
  const uIn = unit(entry);
  const rIn = right(entry);
  const uOut = unit(exit);
  const rOut = right(exit);

  return {
    a: { x: -uIn.x * 0.5 + rIn.x * LANE_FRAC, y: -uIn.y * 0.5 + rIn.y * LANE_FRAC },
    b: { x: uOut.x * 0.5 + rOut.x * LANE_FRAC, y: uOut.y * 0.5 + rOut.y * LANE_FRAC },
  };
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Proper segment intersection. Collinear touching counts as no crossing. */
function segmentsIntersect(p: Chord, q: Chord): boolean {
  const d1 = cross(p.a.x, p.a.y, p.b.x, p.b.y, q.a.x, q.a.y);
  const d2 = cross(p.a.x, p.a.y, p.b.x, p.b.y, q.b.x, q.b.y);
  const d3 = cross(q.a.x, q.a.y, q.b.x, q.b.y, p.a.x, p.a.y);
  const d4 = cross(q.a.x, q.a.y, q.b.x, q.b.y, p.b.x, p.b.y);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Whether two maneuvers through the same junction cannot be performed at once.
 *
 * Two rules only: a shared exit is a merge, and crossing chords are a crossing. There is
 * no left/right/straight taxonomy — the design dropped "straight beats turning", and
 * chord geometry covers diagonal approaches that a cardinal-only classification could not.
 */
export function maneuversConflict(
  aEntry: Direction, aExit: Direction,
  bEntry: Direction, bExit: Direction,
): boolean {
  // Same approach: they are queued behind one another. That is the following model's job.
  if (aEntry === bEntry) return false;
  if (aExit === bExit) return true;
  return segmentsIntersect(maneuverChord(aEntry, aExit), maneuverChord(bEntry, bExit));
}

/**
 * `arrivalTime` sort key. Zero is a sentinel meaning "has not begun waiting" — the stepper
 * only stamps a vehicle once it comes to rest — so it must order *after* every real time,
 * not before it.
 *
 * This lives in one function because it was once applied in one place. The comparator below
 * mapped the sentinel and `simultaneous` did not, so a car still rolling counted as having
 * arrived at time zero on the yield rank — the key that sorts *first*. Any vehicle whose own
 * stamp fell within `SIMULTANEOUS_EPS` of zero was therefore simultaneous with every rolling
 * car for ever, and could be outranked by each of them in turn. That is not hypothetical: a
 * world created at t=0 with a car already at rest stamps it at t=0.017, and on the same
 * fixture that proved the first starvation it stood at the line for the whole 60s run, while
 * the identical world with its clock warmed to t=100 crossed in 6.12s.
 */
function arrivalKey(arrivalTime: number): number {
  return arrivalTime === 0 ? Infinity : arrivalTime;
}

/**
 * Whether two candidates count as having arrived together, for *rechts vor links*.
 *
 * Two cars that have both yet to stop are simultaneous with each other — they are converging
 * on the junction together and the give-way rule is exactly what decides between them. A car
 * that has stopped and one that has not are never simultaneous, however close the stamp is to
 * zero: `Infinity` is not within `SIMULTANEOUS_EPS` of anything finite.
 */
function simultaneous(a: number, b: number): boolean {
  const ka = arrivalKey(a);
  const kb = arrivalKey(b);
  if (ka === kb) return true;
  return Math.abs(ka - kb) <= SIMULTANEOUS_EPS;
}

/**
 * How many simultaneous, conflicting candidates have priority over this one under
 * *rechts vor links*.
 *
 * This is the trick that makes the rule usable: the pairwise relation "A gives way to B"
 * is cyclic at a four-way, but counting how many cars each driver must give way to is a
 * plain number, and numbers sort. Two cars reproduce the rule exactly; four cars in a
 * cycle all score 1, and the id tiebreak lets exactly one through.
 *
 * Ranks are compared on `arrivalKey`, not on the raw time, and this key sorts **before** the
 * arrival time in `admit` — so getting the sentinel wrong here outranks getting it right
 * there. See `arrivalKey`.
 */
function yieldRank(c: JunctionCandidate, all: JunctionCandidate[]): number {
  let rank = 0;
  for (const other of all) {
    if (other.vehicleId === c.vehicleId) continue;
    if (!simultaneous(other.arrivalTime, c.arrivalTime)) continue;
    if (!maneuversConflict(c.entry, c.exit, other.entry, other.exit)) continue;
    if (other.entry === YIELD_TO_DIRECTION[c.entry]) rank++;
  }
  return rank;
}

/**
 * Choose the set of vehicles that may proceed through a junction this tick.
 *
 * Greedy admission over a total order — inside first, then yield rank, then arrival time,
 * then vehicle id. Because we walk a fixed sequence and only ever admit, no cycle of
 * "waiting for" relations can form, so no deadlock is possible and no escape timeout is
 * needed. A candidate whose exit has no room is never admitted, which is what stops a
 * junction filling up and gridlocking a ring of blocks; a candidate already inside is
 * exempt, since stopping it mid-junction is the very thing that rule exists to prevent.
 *
 * A car passed over this tick is not starved: next tick it is ranked against whoever is
 * there then, with an arrival time now earlier than theirs, and wins on that key.
 *
 * Two preconditions the caller owns, both load-bearing for safety rather than for taste:
 * `vehicleId` must be unique within the call, and every vehicle currently inside the
 * junction must appear in `candidates`. See `JunctionCandidate`.
 */
export function admit(candidates: JunctionCandidate[]): Set<string> {
  // Ranks are computed once against the unsorted input, so the comparator is a pure
  // lookup and cannot depend on how far the sort has got.
  const ranks = new Map<string, number>();
  for (const c of candidates) ranks.set(c.vehicleId, yieldRank(c, candidates));

  const ordered = candidates.slice().sort((x, y) => {
    if (x.inside !== y.inside) return x.inside ? -1 : 1;
    const rx = ranks.get(x.vehicleId)!;
    const ry = ranks.get(y.vehicleId)!;
    if (rx !== ry) return rx - ry;
    // Zero is the sentinel for "has not begun waiting", not a timestamp — so it must sort
    // *last* on this key, not first. Via `arrivalKey`, which `yieldRank` shares: the two
    // disagreeing about the sentinel is what made a whole class of starvation invisible.
    //
    // Reading it as an ordinary arrival time meant a car still rolling towards the junction
    // outranked one that had been stopped at the line for a minute, since the stepper only
    // stamps `arrivalTime` when a vehicle comes to rest. Nothing here bounds how far away a
    // candidate may be, so a cross stream whose headway is shorter than its own approach
    // travel time always had *somebody* upstream carrying a zero, and the waiting car was
    // never let in: measured at 53.93 seconds and still standing, on a stream of one car
    // every two seconds joining two cells out.
    //
    // The rule itself is unchanged — the earlier arrival still wins. Free flow is unchanged
    // too: an uncontested rolling car is admitted immediately, because it can only lose this
    // key to a car that is actually queued at the line. A contested one now yields to that
    // queue, which is what a junction is for.
    const ax = arrivalKey(x.arrivalTime);
    const ay = arrivalKey(y.arrivalTime);
    if (ax !== ay) return ax - ay;
    return x.vehicleId < y.vehicleId ? -1 : x.vehicleId > y.vehicleId ? 1 : 0;
  });

  const admitted: JunctionCandidate[] = [];
  const result = new Set<string>();

  for (const c of ordered) {
    if (!c.inside && !c.exitHasRoom) continue;

    let blocked = false;
    for (const other of admitted) {
      if (maneuversConflict(c.entry, c.exit, other.entry, other.exit)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    admitted.push(c);
    result.add(c.vehicleId);
  }

  return result;
}
