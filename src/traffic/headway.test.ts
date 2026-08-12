/**
 * The Intelligent Driver Model is the only place a car decides to slow down, so these
 * tests are about the shape of the function rather than any one number it happens to
 * return today.
 *
 * Expectations are derived from IDM's own algebra — the free-road term, the equilibrium
 * gap `s0 + v*T` where a follower matching its leader's speed neither gains nor loses
 * ground, and the squared desired-gap-over-actual-gap interaction term at the point where
 * the two are equal — never by reading a value back out
 * of `idmAcceleration`. `DEFAULT_IDM` is an *input* here: the tests take its fields as
 * given and check the model built from them, which is why substituting a different
 * parameter set would not silently make them pass.
 */
import { describe, it, expect } from 'vitest';
import { idmAcceleration } from './headway';
import {
  DEFAULT_IDM,
  MAX_DECELERATION,
  LEADER_SCAN_EDGES,
  SIMULTANEOUS_EPS,
  STOPPED_SPEED,
} from './tuning';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

const P = DEFAULT_IDM;

/** One tile per second, the engine's car speed once converted to px/s. */
const V_ROAD = TILE_SIZE;

/**
 * The gap at which a follower travelling at `v` behind a leader at the same speed is in
 * equilibrium: closing speed is zero, so the desired dynamic gap is exactly `s0 + v*T`.
 */
const equilibriumGap = (v: number): number => P.s0 + v * P.T;

describe('idmAcceleration', () => {
  it('accelerates from rest on an empty road', () => {
    expect(idmAcceleration(0, V_ROAD, Infinity, 0, P)).toBeCloseTo(P.a, 5);
  });

  it('stops accelerating at the speed limit on an empty road', () => {
    expect(idmAcceleration(V_ROAD, V_ROAD, Infinity, 0, P)).toBeCloseTo(0, 5);
  });

  it('eases off the throttle as the free-road term says, not as a switch', () => {
    // At half the desired speed the free-road term is exactly 1 - (1/2)^delta.
    const half = P.a * (1 - Math.pow(0.5, P.delta));
    expect(idmAcceleration(V_ROAD / 2, V_ROAD, Infinity, 0, P)).toBeCloseTo(half, 9);
    // And at a quarter, 1 - (1/4)^delta — a linear or constant ramp fails both at once.
    const quarter = P.a * (1 - Math.pow(0.25, P.delta));
    expect(idmAcceleration(V_ROAD / 4, V_ROAD, Infinity, 0, P)).toBeCloseTo(quarter, 9);
  });

  it('brakes when closing on a stopped leader', () => {
    expect(idmAcceleration(V_ROAD, V_ROAD, 30, 0, P)).toBeLessThan(0);
  });

  it('brakes harder the smaller the gap', () => {
    const far = idmAcceleration(V_ROAD, V_ROAD, 60, 0, P);
    const near = idmAcceleration(V_ROAD, V_ROAD, 20, 0, P);
    expect(near).toBeLessThan(far);
  });

  it('is strictly increasing in gap, finely sampled across s0 and the comfort distance', () => {
    // At v = 30 the desired gap behind a stopped leader is s0 + v*T + v^2/(2*sqrt(a*b)),
    // roughly 41px; the sweep steps by a quarter-pixel from inside s0 (14px) out past ten
    // tiles so the whole knee is sampled, not straddled.
    const v = 30;
    let prev = -Infinity;
    let sampled = 0;
    for (let gap = 1; gap <= 400; gap += 0.25) {
      const acc = idmAcceleration(v, V_ROAD, gap, 0, P);
      expect(Number.isFinite(acc)).toBe(true);
      expect(acc).toBeGreaterThan(prev);
      prev = acc;
      sampled++;
    }
    expect(sampled).toBeGreaterThan(1500);
    // Ten tiles out, the interaction has decayed to under 2% of the acceleration budget,
    // approaching the free-road value from below without ever reaching it.
    const free = P.a * (1 - Math.pow(v / V_ROAD, P.delta));
    expect(free - prev).toBeGreaterThan(0);
    expect(free - prev).toBeLessThan(P.a * 0.02);
  });

  it('barely brakes for a leader moving away at the same speed with a comfortable gap', () => {
    // The interaction term never vanishes, so a car already at its desired speed always
    // eases off a little; what matters is that it is a rounding error next to comfortable
    // braking, not a stop. (The brief asserted this was >= 0, which standard IDM never is
    // at the desired speed — the free-road term is exactly zero there.)
    const acc = idmAcceleration(V_ROAD, V_ROAD, 200, V_ROAD, P);
    expect(acc).toBeLessThan(0);
    expect(Math.abs(acc)).toBeLessThan(P.b * 0.05);
  });

  it('still accelerates behind a same-speed leader when below the speed limit', () => {
    // Below the desired speed the free-road term dominates a distant leader outright.
    expect(idmAcceleration(V_ROAD * 0.75, V_ROAD, 200, V_ROAD * 0.75, P)).toBeGreaterThan(P.a / 2);
  });

  it('holds station at rest behind a stopped leader at the minimum gap', () => {
    expect(idmAcceleration(0, V_ROAD, P.s0, 0, P)).toBeCloseTo(0, 5);
  });

  it('holds equilibrium at s0 + v*T behind a leader matching its speed', () => {
    // Closing speed zero makes the desired gap exactly s0 + v*T, so the interaction term
    // is 1 and only the free-road shortfall remains: -a * (v/v0)^delta.
    for (const v of [10, 20, 30, V_ROAD]) {
      const expected = -P.a * Math.pow(v / V_ROAD, P.delta);
      expect(idmAcceleration(v, V_ROAD, equilibriumGap(v), v, P)).toBeCloseTo(expected, 9);
    }
  });

  it('brakes at a * (1 - (s0/s)^2) when creeping inside s0 at rest', () => {
    // Standing still, the desired gap collapses to s0, so halving the gap quadruples the
    // interaction term: a * (1 - 2^2) = -3a.
    expect(idmAcceleration(0, V_ROAD, P.s0 / 2, 0, P)).toBeCloseTo(-3 * P.a, 9);
    // A third of s0 gives 3^2 = 9.
    expect(idmAcceleration(0, V_ROAD, P.s0 / 3, 0, P)).toBeCloseTo(-8 * P.a, 9);
    // Twice s0 is a quarter of the interaction, so still braking but gently.
    expect(idmAcceleration(0, V_ROAD, P.s0 * 2, 0, P)).toBeCloseTo(P.a * (1 - 0.25), 9);
  });

  it('brakes less the faster the leader is moving, at a fixed gap', () => {
    // Below the speed limit, so the free-road term leaves room for the sign to turn over.
    const v = V_ROAD * 0.75;
    // Exactly the desired gap behind a *stopped* leader — derived, not hard-coded, so the
    // sign structure survives a retune of `s0`. At this gap the interaction term behind the
    // stopped leader is the full -a, far below the free-road surplus, so braking is
    // guaranteed; behind a leader at the limit the anticipation term is negative and the
    // same gap is roomy, so the sweep crosses zero rather than merely shifting.
    const gap = P.s0 + v * P.T + (v * v) / (2 * Math.sqrt(P.a * P.b));
    const accs = [0, 10, 20, 30, 40].map((ls) => idmAcceleration(v, V_ROAD, gap, ls, P));
    for (let i = 1; i < accs.length; i++) {
      expect(accs[i]).toBeGreaterThan(accs[i - 1]);
    }
    expect(accs[0]).toBeLessThan(0);
    expect(accs[accs.length - 1]).toBeGreaterThan(0);
  });

  it('scales the anticipation term by the comfortable deceleration', () => {
    // `b` enters the model in exactly one place: the 2*sqrt(a*b) denominator of the
    // anticipation term, which is what makes this more than a time-headway controller. It
    // is invisible unless the closing speed is nonzero, so pin it with an exact value at a
    // leader that is moving but slower — the loose bracket on the clamp threshold below
    // tolerates `b` anywhere from roughly 28 to 694.
    //
    // The parameters are **frozen locally**, not read from `DEFAULT_IDM`: the point of this
    // test is a hand-computed cross-check of the algebra, and a hand computation is only a
    // cross-check against the numbers it was done with. Reading the live tuning here made
    // the test fire on every legitimate retune of `s0` — a tuning value with no bearing on
    // where `b` sits in the formula.
    const frozen = { s0: TILE_SIZE * 0.35, T: 0.6, a: TILE_SIZE, b: TILE_SIZE * 1.5, delta: 4 };
    const v = V_ROAD;
    const gap = 60;
    const leaderSpeed = 20;

    // At the desired speed the free-road term is exactly zero, so the whole result is the
    // interaction term: -a * (s*/s)^2 with s* = s0 + v*T + v*dv / (2*sqrt(a*b)).
    const sStar = frozen.s0 + v * frozen.T
      + (v * (v - leaderSpeed)) / (2 * Math.sqrt(frozen.a * frozen.b));
    const ratio = sStar / gap;
    const expected = -frozen.a * ratio * ratio;

    // Cross-checked by hand against the frozen parameters so this derivation cannot drift
    // silently: 2*sqrt(a*b) = 97.9796, s* = 46.1650, acc = -23.6800. Swapping `b` for `a`
    // in the denominator gives s* = 48 and -25.6 — a difference of 1.92.
    expect(expected).toBeCloseTo(-23.68, 2);
    expect(idmAcceleration(v, V_ROAD, gap, leaderSpeed, frozen)).toBeCloseTo(expected, 9);
  });

  it('never lets the desired gap fall below s0, however fast the leader escapes', () => {
    // A leader pulling away hard would drive the dynamic term negative; clamped at zero,
    // the desired gap is exactly s0. Sitting at s0 while already at the speed limit is
    // then pure interaction: a * (0 - 1) = -a, with no dependence on how fast it escapes.
    // The dynamic term only goes negative once the leader is pulling away by more than
    // 2*sqrt(a*b)*T, about 59px/s here; past that the answer stops moving entirely.
    for (const leaderSpeed of [200, 400, 4000]) {
      expect(idmAcceleration(V_ROAD, V_ROAD, P.s0, leaderSpeed, P)).toBeCloseTo(-P.a, 9);
    }
    // And it does not fire early: a leader only modestly faster still lengthens the
    // desired gap, so the car brakes harder than the clamped floor.
    expect(idmAcceleration(V_ROAD, V_ROAD, P.s0, V_ROAD * 2, P)).toBeLessThan(-P.a);
  });

  it('never returns NaN, even at zero gap', () => {
    expect(Number.isNaN(idmAcceleration(V_ROAD, V_ROAD, 0, 0, P))).toBe(false);
    expect(Number.isNaN(idmAcceleration(0, 0, 0, 0, P))).toBe(false);
  });

  it('brakes hard but finitely at or below zero gap', () => {
    for (const gap of [0, -5, -TILE_SIZE]) {
      const acc = idmAcceleration(V_ROAD, V_ROAD, gap, 0, P);
      expect(Number.isFinite(acc)).toBe(true);
      // The 1e-3 floor makes an overlapping gap a very large, still-finite deceleration.
      expect(acc).toBeLessThan(-1e6);
    }
  });

  it('treats a zero desired speed as standing orders to stop, not a division by zero', () => {
    const acc = idmAcceleration(V_ROAD, 0, Infinity, 0, P);
    expect(Number.isFinite(acc)).toBe(true);
    expect(acc).toBeLessThan(0);
  });
});

/**
 * A car approaching a stopped obstacle must come to rest behind it. This is the property
 * the old step-function multiplier could not offer: it snapped to zero at a hard minimum
 * gap, so a car could arrive already overlapping. Integrated at the game's 60Hz with the
 * clamp Task 7 will apply, IDM has to stop short every time.
 */
function approachStoppedObstacle(desiredSpeed: number, startGap: number) {
  const dt = 1 / 60;
  let v = desiredSpeed;
  let gap = startGap;
  let minGap = gap;
  let maxStep = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const raw = idmAcceleration(v, desiredSpeed, gap, 0, P);
    const acc = Math.max(-MAX_DECELERATION, Math.min(P.a, raw));
    const next = Math.max(0, v + acc * dt);
    const step = ((v + next) / 2) * dt;
    gap -= step;
    v = next;
    minGap = Math.min(minGap, gap);
    maxStep = Math.max(maxStep, step);
  }
  return { gap, v, minGap, maxStep };
}

describe('idmAcceleration under 60Hz integration', () => {
  it('stops short of a stopped obstacle from every approach speed and distance', () => {
    const dt = 1 / 60;
    for (const desiredSpeed of [TILE_SIZE, TILE_SIZE * 2, TILE_SIZE * 3]) {
      // Only distances the car could physically stop within: braking from the speed limit
      // at MAX_DECELERATION, plus the standstill gap it means to leave. Below that, no
      // controller can help — see the note on leader-scan range in the task report.
      const stoppable = (desiredSpeed * desiredSpeed) / (2 * MAX_DECELERATION) + P.s0;
      for (const startGap of [TILE_SIZE * 2, TILE_SIZE * 5, TILE_SIZE * 20]) {
        expect(startGap).toBeGreaterThan(stoppable);
        const { v, minGap, maxStep } = approachStoppedObstacle(desiredSpeed, startGap);
        // Never overlaps. `gap` here is the net, bumper-to-bumper distance the lane index
        // reports and the model controls, so zero is contact and the whole no-overlap
        // invariant is a single sign test — no car length to subtract or forget.
        expect(minGap).toBeGreaterThan(0);
        // Stronger: it does not dive inside the standstill gap and climb back out. The
        // closest it ever comes is the gap it settles at.
        expect(minGap).toBeGreaterThan(P.s0 * 0.95);
        // Comes to rest rather than creeping.
        expect(v).toBeLessThan(STOPPED_SPEED);
        // No tick teleports the car: a frame's travel never exceeds a frame at the limit,
        // and stays well under a car length either way.
        expect(maxStep).toBeLessThanOrEqual(desiredSpeed * dt + 1e-9);
        expect(maxStep).toBeLessThan(CAR_LENGTH);
      }
    }
  });

  it('settles at the standstill gap rather than short of it or on top of it', () => {
    const { gap, v } = approachStoppedObstacle(TILE_SIZE, TILE_SIZE * 5);
    expect(v).toBeLessThan(STOPPED_SPEED);
    expect(gap).toBeGreaterThan(P.s0 * 0.95);
    expect(gap).toBeLessThan(P.s0 * 1.05);
  });
});

describe('tuning constants', () => {
  it('keeps a stopped queue to less than one tile per car', () => {
    // `s0` is now the clear space between bumpers, as in Treiber's own formulation, so
    // comparing it to a car length says nothing. What it has to satisfy is a property of
    // the board: a stopped car occupies `CAR_LENGTH + s0` of centre-to-centre spacing, and
    // if that exceeded a tile a queue could not form along a road at all — every waiting
    // car would reach back past the cell behind it.
    expect(P.s0).toBeGreaterThan(0);
    expect(CAR_LENGTH + P.s0).toBeLessThan(TILE_SIZE);
  });

  it('reserves harder braking for emergencies than for comfort', () => {
    expect(MAX_DECELERATION).toBeGreaterThan(P.b);
  });

  it('brakes at least as willingly as it accelerates', () => {
    expect(P.b).toBeGreaterThanOrEqual(P.a);
  });

  it('scans a whole number of edges ahead, at least the next one', () => {
    expect(Number.isInteger(LEADER_SCAN_EDGES)).toBe(true);
    expect(LEADER_SCAN_EDGES).toBeGreaterThanOrEqual(1);
  });

  it('calls arrivals simultaneous only within a fraction of a tick-run', () => {
    expect(SIMULTANEOUS_EPS).toBeGreaterThan(0);
    expect(SIMULTANEOUS_EPS).toBeLessThan(1);
  });

  it('treats a stopped car as slower than a crawl, not as exactly zero', () => {
    expect(STOPPED_SPEED).toBeGreaterThan(0);
    expect(STOPPED_SPEED).toBeLessThan(TILE_SIZE * 0.5);
  });
});
