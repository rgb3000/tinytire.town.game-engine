/**
 * The camera transition used to wobble, and these tests are the shape of that bug.
 *
 * Toggling isometric view lerped four quantities independently — tilt, azimuth, an up-vector
 * blend and the frustum extent. What the eye tracks is the screen rotation and scale, a
 * nonlinear function of all four, and nothing held it monotonic. Going iso -> top the scene
 * rotated *backwards* 6.75 degrees over the first two frames before sweeping forward, and the
 * view zoomed in 4.1% before pulling out (16% on a portrait viewport).
 *
 * So the property under test is not "the camera ends up in the right place" — the old code
 * did that too. It is that the camera never travels *away* from where it is going. A
 * direction reversal in screen rotation or scale is the bug, whatever its magnitude.
 *
 * Measurement matters here. Reading the screen angle of a single world axis goes degenerate
 * when that axis points at the camera, which is exactly where the wobble lives; the first
 * measurement of this bug reported a spurious 90-degree flip for that reason. So rotation is
 * read as the polar-decomposition rotation of the whole ground-to-screen 2x2, which stays
 * well conditioned at every tilt.
 *
 * `Renderer` cannot be constructed under Node (its constructor reads `window.devicePixelRatio`
 * and draws terrain into a 2D canvas context), so that it actually *routes* through this
 * module is verified by running the demo, not here.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  poseFor, stepPose, poseSettled, positionFor,
  ISO_ELEVATION, ISO_AZIMUTH, MAX_TILT, TOP_DOWN_AZIMUTH, CAMERA_DISTANCE, POSE_LERP,
  type CameraPose,
} from './cameraPose';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../constants';

/** Viewports worth testing: the scale pump was 4.1% on 16:9 but 16% in portrait. */
const VIEWPORTS = [
  { name: '16:9', w: 1600, h: 900 },
  { name: '5:4', w: 1280, h: 1024 },
  { name: 'portrait', w: 1024, h: 1366 },
];

const CENTER_X = CANVAS_WIDTH / 2;
const CENTER_Z = CANVAS_HEIGHT / 2;

function cameraFor(pose: CameraPose): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    -pose.halfW, pose.halfW, pose.halfH, -pose.halfH, 0.1, 5000,
  );
  cam.quaternion.copy(pose.quaternion);
  cam.position.copy(positionFor(pose, CENTER_X, CENTER_Z, CAMERA_DISTANCE));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * How the ground plane lands on screen at this pose: its rotation, and its areal scale.
 *
 * Builds the 2x2 that maps world (x, z) to screen pixels, then takes the rotation of its
 * polar decomposition, `atan2(c - b, a + d)`, and the scale as the square root of |det|.
 */
function screenMetrics(pose: CameraPose, w: number, h: number): { rotDeg: number; scale: number } {
  const cam = cameraFor(pose);
  const at = (x: number, z: number) => {
    const p = new THREE.Vector3(x, 0, z).project(cam);
    return { x: p.x * w / 2, y: -p.y * h / 2 };
  };
  const o = at(CENTER_X, CENTER_Z);
  const px = at(CENTER_X + 100, CENTER_Z);
  const pz = at(CENTER_X, CENTER_Z + 100);
  const a = px.x - o.x, c = px.y - o.y;
  const b = pz.x - o.x, d = pz.y - o.y;
  return {
    rotDeg: Math.atan2(c - b, a + d) * 180 / Math.PI,
    scale: Math.sqrt(Math.abs(a * d - b * c)) / 100,
  };
}

/** Frames of an exponential approach from `from` to `to`, as `Renderer.updateCamera` runs it. */
function replay(from: CameraPose, to: CameraPose, frames = 60): CameraPose[] {
  const out: CameraPose[] = [from];
  let cur = from;
  for (let i = 0; i < frames; i++) {
    cur = stepPose(cur, to, POSE_LERP);
    out.push(cur);
  }
  return out;
}

/** The largest step a series takes *against* its own overall direction, in its own units. */
function worstBacktrack(values: number[]): number {
  const forward = Math.sign(values.at(-1)! - values[0]);
  let worst = 0;
  for (let i = 1; i < values.length; i++) {
    const step = (values[i] - values[i - 1]) * forward;
    if (step < 0) worst = Math.max(worst, -step);
  }
  return worst;
}

/** The same, as a fraction of the value it happens at — for comparing scales across viewports. */
function worstBacktrackRatio(values: number[]): number {
  const forward = Math.sign(values.at(-1)! - values[0]);
  let worst = 0;
  for (let i = 1; i < values.length; i++) {
    const step = (values[i] - values[i - 1]) * forward;
    if (step < 0) worst = Math.max(worst, -step / Math.abs(values[i - 1]));
  }
  return worst;
}

/**
 * Rotation must not double back at all. Slerp is a constant-rate rotation, so the only
 * backward motion float noise can produce is at the scale of the epsilon itself.
 */
const ROTATION_BACKTRACK_LIMIT_DEG = 1e-6;

/**
 * Scale gets a budget rather than zero, because it cannot be exactly zero here.
 *
 * On-screen scale goes as `sqrt(cos tilt) / sqrt(halfW * halfH)`. The numerator follows the
 * slerp and the denominator the lerp, and a ratio of two monotone functions need not itself
 * be monotone, so a small overshoot survives where the two curves disagree most. Removing it
 * would mean distorting the content box that exists to fit the map to the screen — a worse
 * trade than a sub-pixel wobble.
 *
 * Worst single backward step, this measure, old vs new:
 *
 *     viewport   direction    old      new
 *     16:9       iso->flat    4.788%   0.000%
 *     16:9       flat->iso    0.646%   0.000%
 *     5:4        iso->flat    4.788%   0.073%
 *     5:4        flat->iso    9.621%   0.667%
 *     portrait   iso->flat    1.166%   0.139%
 *     portrait   flat->iso    9.621%   1.003%
 *
 * The budget sits ~1.5x above the worst survivor and ~6x below the worst the old code
 * produced, so it still fails loudly if the four-independent-scalars mistake comes back.
 */
const SCALE_BACKTRACK_BUDGET = 0.015;

/** The camera basis the renderer built before the rebuild, for endpoint comparison. */
function legacyBasis(tilt: number, azimuth: number): THREE.Matrix4 {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  cam.position.set(
    CENTER_X + Math.cos(azimuth) * Math.sin(tilt) * CAMERA_DISTANCE,
    Math.cos(tilt) * CAMERA_DISTANCE,
    CENTER_Z + Math.sin(azimuth) * Math.sin(tilt) * CAMERA_DISTANCE,
  );
  const blend = Math.min(tilt / 0.5, 1);
  cam.up.set(
    -Math.sin(azimuth) * (1 - blend),
    blend,
    -Math.cos(azimuth) * (1 - blend),
  ).normalize();
  cam.lookAt(CENTER_X, 0, CENTER_Z);
  cam.updateMatrixWorld(true);
  return cam.matrixWorld;
}

const flat = (aspect: number) => poseFor(0, TOP_DOWN_AZIMUTH, aspect);
const iso = (aspect: number) => poseFor(ISO_ELEVATION, ISO_AZIMUTH, aspect);

describe('the isometric transition never travels away from where it is going', () => {
  for (const { name, w, h } of VIEWPORTS) {
    const aspect = w / h;

    it(`never rotates backwards sweeping iso to flat, on ${name}`, () => {
      // The reported symptom, in one line: this was 6.75 degrees.
      const metrics = replay(iso(aspect), flat(aspect)).map((p) => screenMetrics(p, w, h));
      expect(worstBacktrack(metrics.map((m) => m.rotDeg)))
        .toBeLessThan(ROTATION_BACKTRACK_LIMIT_DEG);
    });

    it(`never rotates backwards sweeping flat to iso, on ${name}`, () => {
      // Less visible than the other direction, because the old overshoot landed late in the
      // motion and read as a settle rather than a reversal. It was still 8.14 degrees.
      const metrics = replay(flat(aspect), iso(aspect)).map((p) => screenMetrics(p, w, h));
      expect(worstBacktrack(metrics.map((m) => m.rotDeg)))
        .toBeLessThan(ROTATION_BACKTRACK_LIMIT_DEG);
    });

    it(`holds the zoom within its perceptual budget both ways, on ${name}`, () => {
      const there = replay(flat(aspect), iso(aspect)).map((p) => screenMetrics(p, w, h));
      const back = replay(iso(aspect), flat(aspect)).map((p) => screenMetrics(p, w, h));
      expect(worstBacktrackRatio(there.map((m) => m.scale))).toBeLessThan(SCALE_BACKTRACK_BUDGET);
      expect(worstBacktrackRatio(back.map((m) => m.scale))).toBeLessThan(SCALE_BACKTRACK_BUDGET);
    });
  }

  it('turns around cleanly when the toggle is reversed mid-transition', () => {
    // The old state was four scalars with independent snap epsilons; an interrupted
    // transition could leave them disagreeing about how far through they were.
    const aspect = 16 / 9;
    const halfway = replay(flat(aspect), iso(aspect), 6).at(-1)!;
    const metrics = replay(halfway, flat(aspect)).map((p) => screenMetrics(p, 1600, 900));
    expect(worstBacktrack(metrics.map((m) => m.rotDeg))).toBeLessThan(ROTATION_BACKTRACK_LIMIT_DEG);
    expect(worstBacktrackRatio(metrics.map((m) => m.scale))).toBeLessThan(SCALE_BACKTRACK_BUDGET);
  });
});

describe('the two views themselves are unchanged by the rebuild', () => {
  // Guards against "fixed the wobble, changed the look". The endpoints are where the old
  // up-vector blend was well defined (exactly 0 flat, exactly 1 isometric), so the old basis
  // is the reference — it is only in between that it misbehaved.
  const cases = [
    { name: 'flat', pose: () => flat(16 / 9), legacy: () => legacyBasis(0, 0) },
    { name: 'isometric', pose: () => iso(16 / 9), legacy: () => legacyBasis(ISO_ELEVATION, ISO_AZIMUTH) },
  ];

  for (const { name, pose, legacy } of cases) {
    it(`reproduces the ${name} camera basis exactly`, () => {
      const rebuilt = new THREE.Matrix4().makeRotationFromQuaternion(pose().quaternion);
      const old = legacy();
      const mismatches: string[] = [];
      // Compare the three basis columns; the legacy matrix also carries translation.
      for (const [col, label] of [[0, 'right'], [4, 'up'], [8, 'back']] as const) {
        for (let i = 0; i < 3; i++) {
          const delta = Math.abs(rebuilt.elements[col + i] - old.elements[col + i]);
          if (delta > 1e-9) mismatches.push(`${label}[${i}] off by ${delta}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('places the flat camera straight above the map centre', () => {
    const p = positionFor(flat(16 / 9), CENTER_X, CENTER_Z, CAMERA_DISTANCE);
    expect(p.x).toBeCloseTo(CENTER_X, 6);
    expect(p.y).toBeCloseTo(CAMERA_DISTANCE, 6);
    expect(p.z).toBeCloseTo(CENTER_Z, 6);
  });

  it('frames the flat view on the grid itself, with no isometric zoom boost', () => {
    // Portrait: taller than the content, so width binds and half-width is half the grid.
    const p = poseFor(0, TOP_DOWN_AZIMUTH, 1024 / 1366);
    expect(p.halfW).toBeCloseTo(CANVAS_WIDTH / 2, 4);
  });

  it('leaves the flat view square-on, with world north straight up the screen', () => {
    expect(screenMetrics(flat(16 / 9), 1600, 900).rotDeg).toBeCloseTo(0, 6);
  });

  it('turns the isometric view a quarter of the way round', () => {
    expect(screenMetrics(iso(16 / 9), 1600, 900).rotDeg).toBeCloseTo(45, 6);
  });
});

describe('manual tilt pitches without rolling', () => {
  // It used to roll a full 90 degrees over the first half of a drag: it orbited towards
  // screen-right while blending the up-vector towards world-Y, and those disagree by a
  // quarter turn, so the scene span to reconcile them. Pitching around TOP_DOWN_AZIMUTH
  // instead holds screen-right fixed.
  const tilts = [0, 0.15, 0.3, 0.45, 0.6, 0.8, MAX_TILT];

  it('holds screen-right on world +X at every angle of the drag', () => {
    const drift: string[] = [];
    for (const tilt of tilts) {
      const right = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(poseFor(tilt, TOP_DOWN_AZIMUTH, 16 / 9).quaternion);
      if (right.distanceTo(new THREE.Vector3(1, 0, 0)) > 1e-9) {
        drift.push(`tilt ${tilt}: right drifted to ${right.toArray().join(', ')}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('keeps the map upright on screen throughout the drag', () => {
    const rotations = tilts.map((t) => screenMetrics(poseFor(t, TOP_DOWN_AZIMUTH, 16 / 9), 1600, 900).rotDeg);
    for (const rot of rotations) expect(rot).toBeCloseTo(0, 6);
  });

  it('frames a pitched view on the grid width, which the old content box transposed', () => {
    // At this azimuth the footprint keeps its full width and foreshortens in height. The old
    // code evaluated the same expression at azimuth 0, which swapped the two: it sized the
    // view to the grid's *height* and foreshortened its *width*. Checked past the boost
    // clamp, where width binds on every viewport under test.
    const tilt = MAX_TILT;
    const boost = 1 + 0.25;
    for (const { w, h } of VIEWPORTS) {
      const pose = poseFor(tilt, TOP_DOWN_AZIMUTH, w / h);
      expect(pose.halfW * boost).toBeCloseTo(CANVAS_WIDTH / 2, 4);
    }
  });

  // There is deliberately no monotonic-scale test here. A plane's projected area *must*
  // shrink as it tilts, so the on-screen scale rises while the framing compensates and then
  // falls once foreshortening wins — a peak is geometry, not a defect, and the old code had
  // one too (1.2% / 0.9% / 1.5% against this build's 1.0% / 0.7% / 0.7%). What the animated
  // transition does with scale is budgeted above, where it is a genuine interpolation choice.

  it('returns to exactly the flat pose when the gesture is released', () => {
    const released = poseFor(0, TOP_DOWN_AZIMUTH, 16 / 9);
    expect(poseSettled(released, flat(16 / 9))).toBe(true);
  });
});

describe('stepPose converges and then stops', () => {
  it('reaches the target within a couple of seconds of frames', () => {
    const frames = replay(iso(16 / 9), flat(16 / 9), 120);
    expect(poseSettled(frames.at(-1)!, flat(16 / 9))).toBe(true);
  });

  it('reports an untouched pose as settled against itself', () => {
    const pose = iso(16 / 9);
    expect(poseSettled(pose, pose)).toBe(true);
  });

  it('reports a fresh transition as unsettled, so the renderer keeps drawing', () => {
    expect(poseSettled(flat(16 / 9), iso(16 / 9))).toBe(false);
  });

  it('leaves the source pose untouched, so callers can hold one safely', () => {
    const from = iso(16 / 9);
    const before = from.quaternion.clone();
    stepPose(from, flat(16 / 9), POSE_LERP);
    expect(from.quaternion.angleTo(before)).toBeCloseTo(0, 12);
  });
});
