/**
 * Where the sun sits, as an offset from the board centre it shines at, in world units.
 *
 * One definition because two things must agree on it: the directional light that casts
 * the baked shadows, and the car shadows that are *not* cast by it but placed by hand
 * (`CarLayer`) to land where that light would have put them.
 */
export const SUN_OFFSET = { x: -800, y: 1100, z: 1200 } as const;

/**
 * How far, horizontally, the shadow of a point `height` above the ground lands from the
 * point itself. Sunlight travels along `-SUN_OFFSET`, so it drops `SUN_OFFSET.y` for every
 * `-SUN_OFFSET.x`/`-SUN_OFFSET.z` it moves across.
 */
export function groundShadowOffset(height: number): { x: number; z: number } {
  return {
    x: (-SUN_OFFSET.x / SUN_OFFSET.y) * height,
    z: (-SUN_OFFSET.z / SUN_OFFSET.y) * height,
  };
}
