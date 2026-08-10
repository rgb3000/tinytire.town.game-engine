export interface IdmParams {
  /** Standstill gap, px. */
  s0: number;
  /** Desired time headway, seconds. */
  T: number;
  /** Maximum acceleration, px/s². */
  a: number;
  /** Comfortable deceleration, px/s². */
  b: number;
  /** Free-road acceleration exponent. */
  delta: number;
}

/**
 * The Intelligent Driver Model: acceleration from own speed, desired speed, gap to the
 * obstacle ahead, and that obstacle's speed.
 *
 * Every constraint in the simulation reaches this function as a gap and a leader speed —
 * a real car ahead, a junction stop line, a parked car, the destination. There is exactly
 * one place where a car decides to slow down, which is what stops two mechanisms
 * disagreeing the way `followingSpeedMultiplier` and the intersection ramp used to.
 *
 * Unlike the multiplier it replaces, this eases to a stop rather than snapping to zero,
 * and bounded acceleration means a car cannot cross a gap within a single tick.
 *
 * The result is raw and unclamped; the integrator is what limits it to a survivable
 * deceleration.
 */
export function idmAcceleration(
  v: number,
  v0: number,
  gap: number,
  leaderSpeed: number,
  p: IdmParams,
): number {
  const desired = Math.max(v0, 1e-6);
  const freeRoad = 1 - Math.pow(v / desired, p.delta);

  if (!Number.isFinite(gap)) return p.a * freeRoad;

  const closingSpeed = v - leaderSpeed;
  const dynamic = v * p.T + (v * closingSpeed) / (2 * Math.sqrt(p.a * p.b));
  const sStar = p.s0 + Math.max(0, dynamic);

  // Guard the division: a zero gap must brake hard, not produce Infinity or NaN.
  const s = Math.max(gap, 1e-3);
  const interaction = (sStar / s) * (sStar / s);

  return p.a * (freeRoad - interaction);
}
