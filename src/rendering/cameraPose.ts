import * as THREE from 'three';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../constants';
import { lerp, clamp } from '../utils/math';

/**
 * Where the camera is pointing, and how much world it takes in — as one interpolable value.
 *
 * This exists because the top-down/isometric transition used to wobble: going iso -> top the
 * scene rotated *backwards* 6.75 degrees over two frames before sweeping forward, and the
 * zoom pumped in 4.1% before pulling out (16% on a portrait viewport). The cause was not any
 * one formula being wrong. `Renderer` lerped four quantities independently — tilt, azimuth,
 * an up-vector blend and the frustum extent — while what the eye actually tracks, the screen
 * rotation and scale, is a nonlinear function of all four. Nothing held that function
 * monotonic, so it wasn't.
 *
 * The fix is representational: interpolate the *pose*. Orientation is a quaternion stepped by
 * slerp, which is a constant-rate rotation along the geodesic and so cannot double back, and
 * the extent travels bundled with it in the same struct, stepped by the same fraction. Both
 * measured at exactly zero direction reversals, in both directions, at every viewport aspect
 * (`cameraPose.test.ts`).
 *
 * `Renderer` cannot be constructed under Node — its constructor reads `window.devicePixelRatio`
 * and draws terrain into a 2D canvas context — so this is a free-standing module for the same
 * reason `routeOverlay.ts` and `backdrop.ts` are: it is the part that is plain geometry, and
 * keeping it out here is what lets the Node-only suite reach it.
 */
export interface CameraPose {
  /** Camera orientation. Set on the camera directly — there is no `up` vector or `lookAt`. */
  readonly quaternion: THREE.Quaternion;
  /** Half-width of the frustum at zoom 1. The caller divides by its own zoom. */
  readonly halfW: number;
  /** Half-height of the frustum at zoom 1. */
  readonly halfH: number;
}

/** Angle from vertical of the isometric view. Not from the horizon, despite the name's age. */
export const ISO_ELEVATION = 35 * (Math.PI / 180);
/** Compass angle of the isometric view. */
export const ISO_AZIMUTH = 45 * (Math.PI / 180);
/** How far manual space+drag tilt may lean. */
export const MAX_TILT = Math.PI / 3;
/** Distance from the look-at point. Orthographic, so this only has to clear the geometry. */
export const CAMERA_DISTANCE = 3000;

/**
 * The azimuth the top-down view sits at — and the one manual tilt pitches around.
 *
 * Not zero, which is the surprise, and which is why the old transition rotated backwards.
 * A roll-free orbit frame has `right = (sin az, 0, -cos az)`; that limit is well defined as
 * tilt goes to zero, and for it to equal the top-down convention `right = (1,0,0)` the
 * azimuth must be a quarter turn. So the flat view *is* azimuth PI/2 in this family, and the
 * isometric transition sweeps PI/2 -> PI/4. The old code swept 0 -> PI/4: it started from the
 * wrong azimuth and travelled the wrong way, then papered over the mismatch with an
 * up-vector blend that reversed direction when it unfroze.
 */
export const TOP_DOWN_AZIMUTH = Math.PI / 2;

/** How much the isometric view zooms in relative to flat. Preserved from the original. */
const ISO_ZOOM_BOOST = 0.25;

/**
 * Fraction of the remaining distance a pose covers per frame.
 *
 * Exponential ease, framerate-dependent, and deliberately the same 0.15 the tilt used before
 * the rebuild: the transition's *path* was the bug, not its pacing.
 */
export const POSE_LERP = 0.15;

/** Below this angular difference a slerp step no longer moves anything a pixel. */
const SETTLE_RADIANS = 0.0005;
/** Below this relative difference an extent step no longer moves anything a pixel. */
const SETTLE_EXTENT_RATIO = 0.0002;

/**
 * The pose at a given orientation, for a viewport of the given aspect.
 *
 * Both gestures draw their targets from here: the isometric toggle asks for
 * `(ISO_ELEVATION, ISO_AZIMUTH)` or `(0, TOP_DOWN_AZIMUTH)`, and manual tilt asks for
 * `(angle, TOP_DOWN_AZIMUTH)`, which holds `right` at world +X and so pitches without
 * rolling. Both endpoints reproduce the pre-existing camera basis exactly, bit for bit.
 */
export function poseFor(tilt: number, azimuth: number, viewportAspect: number): CameraPose {
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  const sinA = Math.sin(azimuth);
  const cosA = Math.cos(azimuth);

  // Camera basis, right-handed, columns of the world matrix: right x up = back.
  const back = new THREE.Vector3(cosA * sinT, cosT, sinA * sinT);
  const right = new THREE.Vector3(sinA, 0, -cosA);
  const up = new THREE.Vector3().crossVectors(back, right);

  const basis = new THREE.Matrix4().makeBasis(right, up, back);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);

  const { halfW, halfH } = extentFor(tilt, azimuth, viewportAspect);
  return { quaternion, halfW, halfH };
}

/**
 * The world box the view has to hold at this orientation, fitted to the viewport.
 *
 * The map's footprint rotates with azimuth and foreshortens with tilt. Evaluated exactly at
 * whatever pose it is asked for — there is no blend-in factor, because the old one existed
 * only to fade the term in from a flat view it disagreed with, and at `TOP_DOWN_AZIMUTH` this
 * expression already returns the plain grid at tilt zero.
 */
function extentFor(
  tilt: number, azimuth: number, viewportAspect: number,
): { halfW: number; halfH: number } {
  const sinA = Math.abs(Math.sin(azimuth));
  const cosA = Math.abs(Math.cos(azimuth));
  // Guard the degenerate edge-on case; the camera never gets there, but the division would.
  const cosT = Math.max(Math.cos(tilt), 0.001);

  const contentW = CANVAS_WIDTH * sinA + CANVAS_HEIGHT * cosA;
  const contentH = (CANVAS_WIDTH * cosA + CANVAS_HEIGHT * sinA) * cosT;
  const contentAspect = contentW / contentH;

  let halfW: number;
  let halfH: number;
  if (viewportAspect > contentAspect) {
    halfH = contentH / 2;
    halfW = halfH * viewportAspect;
  } else {
    halfW = contentW / 2;
    halfH = halfW / viewportAspect;
  }

  // Lean in as the view tilts. Tied to ISO_ELEVATION rather than a bare knee so the
  // isometric view lands on exactly the original boost and the flat view on exactly none.
  const boost = 1 + ISO_ZOOM_BOOST * clamp(tilt / ISO_ELEVATION, 0, 1);
  return { halfW: halfW / boost, halfH: halfH / boost };
}

/**
 * Step `current` a fraction `t` of the way to `target` — the rotational analogue of `lerp`.
 *
 * Orientation moves by slerp and extent by `lerp`, both by the same fraction, which is what
 * keeps them agreeing. Repeated application is the same exponential ease the zoom and pan
 * already use, so the feel is unchanged; only the path is.
 */
export function stepPose(current: CameraPose, target: CameraPose, t: number): CameraPose {
  return {
    quaternion: current.quaternion.clone().slerp(target.quaternion, t),
    halfW: lerp(current.halfW, target.halfW, t),
    halfH: lerp(current.halfH, target.halfH, t),
  };
}

/** Whether stepping again would be a no-op, so the caller can stop re-rendering. */
export function poseSettled(current: CameraPose, target: CameraPose): boolean {
  if (current.quaternion.angleTo(target.quaternion) > SETTLE_RADIANS) return false;
  const scale = Math.max(target.halfW, target.halfH);
  return Math.abs(current.halfW - target.halfW) <= scale * SETTLE_EXTENT_RATIO
    && Math.abs(current.halfH - target.halfH) <= scale * SETTLE_EXTENT_RATIO;
}

/** Where the camera stands to look at `(centerX, 0, centerZ)` from this pose. */
export function positionFor(
  pose: CameraPose, centerX: number, centerZ: number, distance: number,
): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1)
    .applyQuaternion(pose.quaternion)
    .multiplyScalar(distance)
    .add(new THREE.Vector3(centerX, 0, centerZ));
}
