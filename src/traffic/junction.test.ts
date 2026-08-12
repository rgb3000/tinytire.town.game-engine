/**
 * Junction admission is the fix for "cars do not respect common traffic rules" and for
 * cars getting stuck at intersections. Two failures of the model it replaces are named
 * directly by tests here.
 *
 * The old rule was pairwise — "does A give way to B?" — and *rechts vor links* is cyclic
 * at a four-way: A yields B yields C yields D yields A. Nothing broke the cycle except a
 * two-second timeout that then released the whole ring at once, into each other. The
 * `pairwiseAdmit` reference below reproduces exactly that rule on top of this module's own
 * conflict geometry, and the four-way test asserts it admits nobody while `admit` admits
 * somebody. Admission here is greedy over a total order, so a cycle of "waiting for"
 * relations cannot form and no escape timeout exists.
 *
 * The old model also had nothing that stopped a car entering a junction it could not
 * leave. `exitHasRoom` is that missing rule.
 *
 * Conflict is decided by chord geometry, not by a left/right/straight taxonomy. That is
 * what lets a diagonal approach be expressed at all, and one test pins a diagonal/cardinal
 * crossing that no cardinal-only classification can see.
 */
import { describe, it, expect } from 'vitest';
import { maneuverChord, maneuversConflict, admit } from './junction';
import type { Chord, JunctionCandidate, Point } from './junction';
import { Direction } from '../types';
import { ALL_DIRECTIONS, CARDINAL_DIRECTIONS, YIELD_TO_DIRECTION } from '../utils/direction';
import { LANE_OFFSET, TILE_SIZE } from '../constants';

// All single-cell candidates share one junction cell: these tests exercise the order and
// the conflict rules, for which one box is enough — the multi-cell region shape is pinned
// where it is produced, in `step.test.ts` and `adjacentJunctions.test.ts`.
const CELL = 0;

function candidate(
  id: string, entry: Direction, exit: Direction,
  over: Partial<JunctionCandidate> = {},
): JunctionCandidate {
  return {
    vehicleId: id, maneuvers: [{ cell: CELL, entry, exit }],
    inside: false, arrivalTime: 0, exitHasRoom: true,
    ...over,
  };
}

/**
 * The rule this task replaces: a car proceeds only if no conflicting car is on its right.
 * Correct for two cars, and hopelessly cyclic for four.
 */
function pairwiseAdmit(candidates: JunctionCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const c of candidates) {
    const [m] = c.maneuvers;
    const mustYield = candidates.some(o =>
      o.vehicleId !== c.vehicleId
      && maneuversConflict(m.entry, m.exit, o.maneuvers[0].entry, o.maneuvers[0].exit)
      && o.maneuvers[0].entry === YIELD_TO_DIRECTION[m.entry]);
    if (!mustYield) out.add(c.vehicleId);
  }
  return out;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

describe('maneuverChord', () => {
  const LANE_FRAC = LANE_OFFSET / TILE_SIZE;

  it('runs from the far side of the entry to the far side of the exit', () => {
    // Travelling Right means arriving from the cell's left edge and leaving by its right.
    // Reading `entry` as "the side I came from" would mirror this and every conflict with it.
    const chord = maneuverChord(Direction.Right, Direction.Right);
    expect(chord.a.x).toBeCloseTo(-0.5, 10);
    expect(chord.b.x).toBeCloseTo(0.5, 10);
  });

  it('offsets both endpoints to the driver\'s right, with screen y down', () => {
    // Same convention as computeSmoothLanePath: right of travel (dx, dy) is (-dy, dx).
    // Travelling Right, that is +y, i.e. towards the bottom of the screen.
    const chord = maneuverChord(Direction.Right, Direction.Right);
    expect(chord.a.y).toBeCloseTo(LANE_FRAC, 10);
    expect(chord.b.y).toBeCloseTo(LANE_FRAC, 10);

    // Travelling Up (screen -y), the driver's right is +x.
    const up = maneuverChord(Direction.Up, Direction.Up);
    expect(up.a.x).toBeCloseTo(LANE_FRAC, 10);
    expect(up.a.y).toBeCloseTo(0.5, 10);
    expect(up.b.y).toBeCloseTo(-0.5, 10);
  });

  it('keeps diagonal endpoints on the same circle as cardinal ones', () => {
    // Diagonal offsets are normalised, so a diagonal entry is not pushed 41% further out.
    const chord = maneuverChord(Direction.UpRight, Direction.UpRight);
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    expect(radius(chord.a)).toBeCloseTo(Math.hypot(0.5, LANE_FRAC), 10);
    expect(radius(chord.b)).toBeCloseTo(Math.hypot(0.5, LANE_FRAC), 10);
  });
});

describe('maneuversConflict', () => {
  it('does not conflict with itself coming from the same approach', () => {
    // Two cars nose to tail from the same direction are a following problem, not a
    // junction problem.
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Right, Direction.Up))
      .toBe(false);
  });

  it('conflicts when two maneuvers merge into the same exit', () => {
    expect(maneuversConflict(Direction.Right, Direction.Up, Direction.Down, Direction.Up))
      .toBe(true);
  });

  it('conflicts for two perpendicular straights', () => {
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Down, Direction.Down))
      .toBe(true);
  });

  it('does not conflict for two opposing straights', () => {
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Left, Direction.Left))
      .toBe(false);
  });

  it('does not conflict for two right turns from perpendicular approaches', () => {
    // Travelling right, turning right exits Down. Travelling down, turning right exits Left.
    expect(maneuversConflict(Direction.Right, Direction.Down, Direction.Down, Direction.Left))
      .toBe(false);
  });

  it('conflicts for a diagonal straight crossing a cardinal straight', () => {
    // A car travelling UpRight cuts clean across a car travelling Right. No left/right/
    // straight classification over cardinal directions can express this pair at all;
    // the chords cross, so the geometry sees it.
    expect(maneuversConflict(Direction.UpRight, Direction.UpRight, Direction.Right, Direction.Right))
      .toBe(true);
  });

  it('does not conflict for two opposing diagonal straights', () => {
    expect(maneuversConflict(Direction.UpRight, Direction.UpRight, Direction.DownLeft, Direction.DownLeft))
      .toBe(false);
  });

  it('is symmetric for every pair of maneuvers over all eight directions', () => {
    for (const aEntry of ALL_DIRECTIONS) {
      for (const aExit of ALL_DIRECTIONS) {
        for (const bEntry of ALL_DIRECTIONS) {
          for (const bExit of ALL_DIRECTIONS) {
            expect(maneuversConflict(aEntry, aExit, bEntry, bExit))
              .toBe(maneuversConflict(bEntry, bExit, aEntry, aExit));
          }
        }
      }
    }
  });

  it('never lands two decidable chords in a degenerate touching configuration', () => {
    // The crossing test is a *proper* one: chords that merely touch do not conflict. That
    // is only safe because touching cannot happen for a pair the geometry actually has to
    // decide. Every coincident endpoint in this cell implies a shared entry (excluded) or
    // a shared exit (already a merge), so both are settled before any chord is drawn.
    // Without this, tightening the crossing test to inclusive comparisons would be an
    // undetectable change.
    const onSegment = (p: Point, s: Chord): boolean => {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const len2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
      return Math.hypot(s.a.x + t * dx - p.x, s.a.y + t * dy - p.y) < 1e-9;
    };

    for (const aEntry of ALL_DIRECTIONS) {
      for (const aExit of ALL_DIRECTIONS) {
        for (const bEntry of ALL_DIRECTIONS) {
          for (const bExit of ALL_DIRECTIONS) {
            if (aEntry === bEntry || aExit === bExit) continue;
            const p = maneuverChord(aEntry, aExit);
            const q = maneuverChord(bEntry, bExit);
            expect(onSegment(p.a, q)).toBe(false);
            expect(onSegment(p.b, q)).toBe(false);
            expect(onSegment(q.a, p)).toBe(false);
            expect(onSegment(q.b, p)).toBe(false);
          }
        }
      }
    }
  });

  it('lets every approach of a cardinal four-way turn right at once', () => {
    // The four right turns are the classic simultaneously-safe set. If the chord endpoints
    // sat far enough into the corners that the lane offset could not separate them, this
    // would report a phantom conflict and a four-way would serialise for no reason.
    const rightTurn: Record<number, Direction> = {
      [Direction.Up]: Direction.Right,
      [Direction.Right]: Direction.Down,
      [Direction.Down]: Direction.Left,
      [Direction.Left]: Direction.Up,
    };
    for (const a of CARDINAL_DIRECTIONS) {
      for (const b of CARDINAL_DIRECTIONS) {
        if (a === b) continue;
        expect(maneuversConflict(a, rightTurn[a], b, rightTurn[b])).toBe(false);
      }
    }
  });
});

describe('admit', () => {
  it('admits a lone car', () => {
    expect(admit([candidate('a', Direction.Right, Direction.Right)])).toEqual(new Set(['a']));
  });

  it('admits both cars when their maneuvers do not conflict', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Left, Direction.Left),
    ]);
    expect(got).toEqual(new Set(['a', 'b']));
  });

  it('admits exactly one of two conflicting cars', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Down, Direction.Down),
    ]);
    expect(got.size).toBe(1);
    // Travelling Right, my right is the screen-bottom side, from which cars travel Up.
    // 'b' travels Down, so it comes from my left and gives way.
    expect(got).toEqual(new Set(['a']));
  });

  it('gives way to the right when two arrive together', () => {
    // Travelling Right, the car on my right approaches travelling Up.
    // YIELD_TO_DIRECTION[Right] === Up, so 'b' has priority.
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Up, Direction.Up),
    ]);
    expect(got.has('b')).toBe(true);
    expect(got.has('a')).toBe(false);
  });

  it('does not give way to a car on the right whose path never crosses ours', () => {
    // Give-way-to-the-right ranks only *conflicting* cars. A car stalled at a junction
    // deferring to someone it would never have met is the exact symptom this task removes.
    //
    // 'c' travels Left and turns Down; 'a' travels Up and turns Right. Their chords are
    // parallel, so they can go together. 'c' is on 'a's right (YIELD_TO_DIRECTION[Up] is
    // Left), and if that counted, 'a' would be outranked by 'b' — which conflicts with
    // both — and the junction would pass one car instead of two.
    const got = admit([
      candidate('a', Direction.Up, Direction.Right),
      candidate('b', Direction.Down, Direction.Right),
      candidate('c', Direction.Left, Direction.Down),
    ]);
    expect(maneuversConflict(Direction.Up, Direction.Right, Direction.Left, Direction.Down))
      .toBe(false);
    expect(got).toEqual(new Set(['a', 'c']));
  });

  it('lets the earlier arrival through when arrivals are clearly separated', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 5 }),
      candidate('b', Direction.Down, Direction.Down, { arrivalTime: 1 }),
    ]);
    expect(got).toEqual(new Set(['b']));
  });

  it('lets a waiting car through ahead of a later arrival on its right', () => {
    // Give-way-to-the-right applies only to cars that arrived together. A car that has
    // been sitting at the line does not surrender its turn to every fresh arrival — that
    // is the whole mechanism by which a car passed over this tick wins the next one.
    //
    // Both times are non-zero on purpose. This test used to write the waiting car as
    // `arrivalTime: 0`, which read correctly when zero sorted first but says the opposite
    // now that zero is the sentinel for "has not begun waiting" — it would have been
    // asserting that a car which never queued beats one that did. The property is unchanged
    // and so is the shape of the assertion; only the encoding of "has been waiting longer"
    // is now stated in the same units the stepper actually stamps.
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 1 }),
      candidate('b', Direction.Up, Direction.Up, { arrivalTime: 5 }),
    ]);
    // Premise: they really are in conflict, so one of them has to lose.
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Up, Direction.Up))
      .toBe(true);
    expect(got).toEqual(new Set(['a']));
  });

  it('makes a car that has not begun waiting yield to one that has', () => {
    // `arrivalTime` is a sentinel, not a timestamp: zero means "not queued", and the stepper
    // only stamps a vehicle once it comes to rest. Sorting zero *first* meant a car still
    // rolling towards the junction — possibly seconds away, since candidacy has no approach
    // horizon — outranked one that had been stopped at the line for a minute. A cross stream
    // whose headway was shorter than its own approach then held a waiting car for ever:
    // measured at 53.93s and still standing before this was fixed.
    const got = admit([
      candidate('rolling', Direction.Right, Direction.Right, { arrivalTime: 0 }),
      candidate('queued', Direction.Up, Direction.Up, { arrivalTime: 30 }),
    ]);
    expect(got).toEqual(new Set(['queued']));
  });

  it('makes a rolling car yield to one queued within the simultaneity window', () => {
    // The same rule as above, but with the stamp *inside* `SIMULTANEOUS_EPS` of the sentinel —
    // and that difference is the whole test. The 30s stamp above is far outside the window, so
    // `yieldRank` skips the pair and only the comparator ever sees the sentinel. Here the two
    // are simultaneous by raw arithmetic (|0 - 0.03| <= 0.05), so the give-way rule engages and
    // it is `yieldRank` that has to map the sentinel. It did not, for three revisions: the rank
    // sorts *before* the arrival time, so a car stamped within 50ms of world creation was
    // outranked by every rolling car for ever. A world built at t=0 with cars already at rest
    // is exactly that, and it starved five of sixteen cells of the approach x headway sweep.
    //
    // **The entry directions are load-bearing, not decoration.** `YIELD_TO_DIRECTION[Up]` is
    // `Left`, so a roller arriving from the left is one the queued car must give way to, and
    // the rank flips. Run the same probe with `Direction.Right` for the roller and it passes
    // even with the sentinel missing from `yieldRank` — the queued car outranks it anyway, and
    // the bug walks straight through.
    expect(YIELD_TO_DIRECTION[Direction.Up]).toBe(Direction.Left);
    expect(maneuversConflict(Direction.Left, Direction.Left, Direction.Up, Direction.Up))
      .toBe(true);

    const near = admit([
      candidate('rolling', Direction.Left, Direction.Left, { arrivalTime: 0 }),
      candidate('queued', Direction.Up, Direction.Up, { arrivalTime: 0.03 }),
    ]);
    expect(near).toEqual(new Set(['queued']));
  });

  it('still admits a lone rolling car immediately, with nobody queued against it', () => {
    // The other half of the sentinel: yielding to a queue must not become stopping at every
    // junction. An uncontested car loses this key to nobody, so free flow is untouched.
    expect(admit([candidate('rolling', Direction.Right, Direction.Right, { arrivalTime: 0 })]))
      .toEqual(new Set(['rolling']));
    // Two rolling cars in conflict still fall through to the rank and id tiebreaks rather
    // than deadlocking on a shared sentinel.
    const both = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 0 }),
      candidate('b', Direction.Up, Direction.Up, { arrivalTime: 0 }),
    ]);
    expect(both.size).toBe(1);
  });

  it('gives a car already inside absolute priority', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 0 }),
      candidate('b', Direction.Down, Direction.Down, { arrivalTime: 9, inside: true }),
    ]);
    expect(got.has('b')).toBe(true);
    expect(got.has('a')).toBe(false);
  });

  it('keeps a car that is already inside moving even when its exit is full', () => {
    // Don't-block-the-box is a rule about entering. Applying it to a car mid-junction
    // would freeze it exactly where it does the most damage.
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { inside: true, exitHasRoom: false }),
    ]);
    expect(got).toEqual(new Set(['a']));
  });

  it('breaks a four-way cycle instead of deadlocking', () => {
    // All four arrive together, each yielding to the one on its right. The old pairwise
    // rule cycled here and only the 2s timeout broke it — releasing everyone at once.
    const got = admit([
      candidate('a', Direction.Up, Direction.Up),
      candidate('b', Direction.Right, Direction.Right),
      candidate('c', Direction.Down, Direction.Down),
      candidate('d', Direction.Left, Direction.Left),
    ]);
    expect(got.size).toBeGreaterThanOrEqual(1);
  });

  it('deadlocks the four-way under a pairwise give-way rule but not under admission', () => {
    // The same conflict geometry, resolved the old way. Every car has someone on its
    // right, so nobody moves, and only a timeout could ever have released them.
    const cycle = [
      candidate('a', Direction.Up, Direction.Up),
      candidate('b', Direction.Right, Direction.Right),
      candidate('c', Direction.Down, Direction.Down),
      candidate('d', Direction.Left, Direction.Left),
    ];
    expect(pairwiseAdmit(cycle)).toEqual(new Set());
    expect(admit(cycle).size).toBeGreaterThanOrEqual(1);

    // With only two cars the pairwise rule is right, and admission agrees with it.
    const pair = [
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Up, Direction.Up),
    ];
    expect(pairwiseAdmit(pair)).toEqual(new Set(['b']));
    expect(admit(pair)).toEqual(new Set(['b']));
  });

  it('clears a whole four-way within two rounds, admitting someone every round', () => {
    // Repeated admission makes progress without any escape hatch: no round is ever empty,
    // so no car can be stuck behind a junction that never resolves.
    let waiting = [
      candidate('a', Direction.Up, Direction.Up),
      candidate('b', Direction.Right, Direction.Right),
      candidate('c', Direction.Down, Direction.Down),
      candidate('d', Direction.Left, Direction.Left),
    ];
    const cleared: string[] = [];
    let rounds = 0;
    while (waiting.length > 0) {
      rounds++;
      expect(rounds).toBeLessThanOrEqual(4);
      const got = admit(waiting);
      expect(got.size).toBeGreaterThanOrEqual(1);
      cleared.push(...waiting.filter(c => got.has(c.vehicleId)).map(c => c.vehicleId));
      waiting = waiting.filter(c => !got.has(c.vehicleId));
    }
    expect(rounds).toBe(2);
    expect(cleared.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a car whose exit has no room', () => {
    // Don't block the intersection.
    const got = admit([candidate('a', Direction.Right, Direction.Right, { exitHasRoom: false })]);
    expect(got.size).toBe(0);
  });

  it('passes over a car with no exit room and admits the one behind the conflict', () => {
    // The blocked car must not take the junction's capacity with it.
    const got = admit([
      candidate('a', Direction.Up, Direction.Up, { exitHasRoom: false }),
      candidate('b', Direction.Right, Direction.Right),
    ]);
    expect(got).toEqual(new Set(['b']));
  });

  it('is deterministic regardless of input order', () => {
    const a = candidate('a', Direction.Right, Direction.Right);
    const b = candidate('b', Direction.Down, Direction.Down);
    const c = candidate('c', Direction.Left, Direction.Left);
    expect(admit([a, b, c])).toEqual(admit([c, b, a]));
  });

  it('gives the same answer for every permutation of a four-way', () => {
    // One reversed input is not enough to pin an order-independent result: a comparator
    // that returns 0 for tied candidates leaves them in input order, and a stable sort
    // hides that from any single permutation.
    const cycle = [
      candidate('a', Direction.Up, Direction.Up),
      candidate('b', Direction.Right, Direction.Right),
      candidate('c', Direction.Down, Direction.Down),
      candidate('d', Direction.Left, Direction.Left),
    ];
    for (const perm of permutations(cycle)) {
      expect(admit(perm)).toEqual(new Set(['a', 'c']));
    }
  });

  it('gives the same answer for every permutation of a mixed-priority set', () => {
    const set = [
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 2 }),
      candidate('b', Direction.Up, Direction.Up, { arrivalTime: 2 }),
      candidate('c', Direction.Down, Direction.Down, { arrivalTime: 0.5, exitHasRoom: false }),
      candidate('d', Direction.Left, Direction.Left, { arrivalTime: 7, inside: true }),
    ];
    const expected = admit(set);
    expect(expected.size).toBeGreaterThanOrEqual(1);
    expect(expected.has('c')).toBe(false);
    for (const perm of permutations(set)) {
      expect(admit(perm)).toEqual(expected);
    }
  });

  it('admits nobody from an empty junction', () => {
    expect(admit([])).toEqual(new Set());
  });
});
