import type { PixelPos } from '../../types';
import type { Route } from '../../traffic';
import { splitAt } from '../../traffic';

/**
 * The geometry decision behind the hovered-car route overlay, kept away from Three.js.
 *
 * `CarRouteLayer` builds `Line2`/`LineGeometry` objects and needs a WebGL-shaped world to do
 * it in, which the Node-only suite has not got. What it decides — where the route is cut,
 * and whether either half is worth drawing at all — is plain arithmetic on plain data, so it
 * lives here where a test can reach it. The same split `worldFrame.ts` and
 * `CarSystem.carsDependingOn` already make.
 */

/**
 * How far apart two points must be before the polyline through them counts as a line.
 *
 * `splitAt` always returns two points per half, and at either extreme of the route both of
 * them are the same point: `travelled` is a stub at arc 0, and `remaining` is a stub once the
 * car reaches the end. A car parked at its destination therefore offers a zero-length
 * `remaining` on every single frame.
 *
 * That is not merely an invisible line. `Line2` expands each segment into a screen-space
 * quad in the vertex shader, and it does so from `normalize(ndcEnd.xy - ndcStart.xy)`
 * (`three/examples/jsm/lines/LineMaterial.js`, "// direction"). Normalising a zero vector is
 * 0/0, so every vertex of the quad comes out NaN and the segment renders as garbage or not
 * at all, depending on the driver. The dashed travelled half has a second problem on top:
 * `computeLineDistances` gives a zero-length polyline a total distance of zero — no NaN,
 * checked — so the whole segment lands inside a single dash or a single gap.
 *
 * 0.01px² is a tenth of a pixel: far below anything the camera can resolve at any zoom, and
 * far above the float error `splitAt`'s interpolation can introduce at a segment boundary.
 */
export const MIN_DRAWN_LENGTH_SQ = 0.01;

/**
 * Is this point list a line rather than a point?
 *
 * Every point is compared against the first, not just the last: a route can double back on
 * itself, so a polyline whose ends coincide may still enclose real length, and one whose
 * interior points all sit on the start is still a stub however many of them there are.
 */
export function isDrawablePolyline(points: PixelPos[]): boolean {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[0].x;
    const dy = points[i].y - points[0].y;
    if (dx * dx + dy * dy > MIN_DRAWN_LENGTH_SQ) return true;
  }
  return false;
}

/** Either half of a cut route, or null when that half has nothing to draw. */
export interface RouteHalves {
  travelled: PixelPos[] | null;
  remaining: PixelPos[] | null;
}

/**
 * Cut a route at the car's arc distance into the part to shade as travelled and the part to
 * draw as still to come, dropping whichever half is degenerate.
 *
 * The points are the route's own — the polyline the simulation samples the car's position
 * from — so a highway crossing draws as the curve the car actually flies, and a smoothed
 * corner draws as the corner it actually cuts. The overlay this replaced reconstructed
 * tile centres from `car.path` whenever `car.smoothPath` happened to be empty, which drew a
 * different line from the one the car was driving.
 */
export function drawableHalves(route: Route, arc: number): RouteHalves {
  const { travelled, remaining } = splitAt(route, arc);
  return {
    travelled: isDrawablePolyline(travelled) ? travelled : null,
    remaining: isDrawablePolyline(remaining) ? remaining : null,
  };
}

/**
 * Flatten a route polyline into the flat XYZ triples `LineGeometry.setPositions` wants.
 *
 * Route space is the game's 2D grid plane, so a point's `y` is a depth and becomes the
 * world's `z`; the world's `y` is the constant height the overlay floats at.
 */
export function toLinePositions(points: PixelPos[], y: number): number[] {
  const positions: number[] = [];
  for (const p of points) positions.push(p.x, y, p.y);
  return positions;
}
