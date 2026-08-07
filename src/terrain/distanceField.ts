import type { CoverageField } from './field';
import { SUBCELL } from './field';

const ORTHO = 1;
const DIAG = Math.SQRT2;

export interface SignedField {
  width: number;
  height: number;
  originGx: number;
  originGy: number;
  /** Distance in tile units. Positive inside terrain, negative outside. */
  data: Float32Array;
  /** Largest positive value — how thick the thickest part of the shape is. */
  maxInside: number;
}

/**
 * Signed distance from the terrain boundary, in tile units.
 *
 * Terrace thresholds are read off this field, which is what makes the old collapse bug
 * unrepresentable: a shape two tiles wide simply has no samples above 1.0, so it cannot
 * be assigned six terraces however many cells it contains.
 */
export function buildSignedDistanceField(coverage: CoverageField): SignedField {
  const { width, height, data: cov } = coverage;

  // Coverage is fractional for triangle-subdivided cells, so "inside" is a majority test,
  // not a non-zero test. Half coverage is exactly the quadrant boundary.
  const inside = chamfer(cov, width, height, (v) => v >= 0.5);
  const outside = chamfer(cov, width, height, (v) => v < 0.5);

  const data = new Float32Array(width * height);
  let maxInside = 0;

  for (let i = 0; i < data.length; i++) {
    // Each half measures distance to the *nearest sample of the other kind*. Subtracting
    // half a sample from each side puts the zero crossing on the boundary between them
    // rather than half a sample inside it.
    const d = cov[i] >= 0.5 ? inside[i] - 0.5 : -(outside[i] - 0.5);
    const tiles = d / SUBCELL;
    data[i] = tiles;
    if (tiles > maxInside) maxInside = tiles;
  }

  return { width, height, originGx: coverage.originGx, originGy: coverage.originGy, data, maxInside };
}

/**
 * Two-pass chamfer transform: distance from every sample matching `isSubject` to the
 * nearest sample that does not.
 */
function chamfer(
  cov: Float32Array,
  width: number,
  height: number,
  isSubject: (v: number) => boolean,
): Float32Array {
  const dist = new Float32Array(width * height);
  const BIG = width + height;

  for (let i = 0; i < dist.length; i++) dist[i] = isSubject(cov[i]) ? BIG : 0;

  // Forward pass: north-west neighbourhood.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, dist[i - width - 1] + DIAG);
        best = Math.min(best, dist[i - width] + ORTHO);
        if (x < width - 1) best = Math.min(best, dist[i - width + 1] + DIAG);
      }
      if (x > 0) best = Math.min(best, dist[i - 1] + ORTHO);
      dist[i] = best;
    }
  }

  // Backward pass: south-east neighbourhood.
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y < height - 1) {
        if (x < width - 1) best = Math.min(best, dist[i + width + 1] + DIAG);
        best = Math.min(best, dist[i + width] + ORTHO);
        if (x > 0) best = Math.min(best, dist[i + width - 1] + DIAG);
      }
      if (x < width - 1) best = Math.min(best, dist[i + 1] + ORTHO);
      dist[i] = best;
    }
  }

  return dist;
}

/** Bilinear sample, for reading depth at arbitrary mesh vertices. */
export function sampleFieldBilinear(field: SignedField, sx: number, sy: number): number {
  const { width, height, data } = field;
  const cx = Math.max(0, Math.min(width - 1.001, sx));
  const cy = Math.max(0, Math.min(height - 1.001, sy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}
