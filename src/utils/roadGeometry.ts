import { LANE_OFFSET } from '../constants';
import { cubicBezier, gridToPixelCenter, lerp } from './math';
import type { GridPos } from '../types';

const BEZIER_SAMPLES = 8;
const SMOOTH_T = 0.75;

/**
 * Offset each cell center in a chain by `offset` perpendicular to the travel direction,
 * using miter joins at corners for clean geometry.
 */
export function offsetChainCenters(
  pixels: { x: number; y: number }[],
  offset: number,
  isLoop: boolean,
): { x: number; y: number }[] {
  const len = pixels.length;
  const result: { x: number; y: number }[] = [];

  for (let i = 0; i < len; i++) {
    const curr = pixels[i];

    if (!isLoop && i === 0) {
      const next = pixels[1];
      const dx = next.x - curr.x;
      const dy = next.y - curr.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen > 0) {
        result.push({ x: curr.x + (-dy / segLen) * offset, y: curr.y + (dx / segLen) * offset });
      } else {
        result.push({ x: curr.x, y: curr.y });
      }
      continue;
    }

    if (!isLoop && i === len - 1) {
      const prev = pixels[i - 1];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen > 0) {
        result.push({ x: curr.x + (-dy / segLen) * offset, y: curr.y + (dx / segLen) * offset });
      } else {
        result.push({ x: curr.x, y: curr.y });
      }
      continue;
    }

    // Interior point (or any point in a loop): miter join
    const prev = isLoop ? pixels[(i - 1 + len) % len] : pixels[i - 1];
    const next = isLoop ? pixels[(i + 1) % len] : pixels[i + 1];

    const dxIn = curr.x - prev.x;
    const dyIn = curr.y - prev.y;
    const lenIn = Math.sqrt(dxIn * dxIn + dyIn * dyIn);
    const dirInX = lenIn > 0 ? dxIn / lenIn : 0;
    const dirInY = lenIn > 0 ? dyIn / lenIn : 0;

    const dxOut = next.x - curr.x;
    const dyOut = next.y - curr.y;
    const lenOut = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
    const dirOutX = lenOut > 0 ? dxOut / lenOut : 0;
    const dirOutY = lenOut > 0 ? dyOut / lenOut : 0;

    const perpInX = -dirInY;
    const perpInY = dirInX;
    const perpOutX = -dirOutY;
    const perpOutY = dirOutX;

    const miterX = perpInX + perpOutX;
    const miterY = perpInY + perpOutY;
    const miterLen = Math.sqrt(miterX * miterX + miterY * miterY);

    if (miterLen < 1e-6) {
      result.push({ x: curr.x + perpInX * offset, y: curr.y + perpInY * offset });
    } else {
      const miterNX = miterX / miterLen;
      const miterNY = miterY / miterLen;
      const dot = miterNX * perpInX + miterNY * perpInY;
      const scale = dot > 1e-6 ? offset / dot : offset;
      result.push({ x: curr.x + miterNX * scale, y: curr.y + miterNY * scale });
    }
  }

  return result;
}

export interface SmoothResult {
  points: { x: number; y: number }[];
  cellIndices: number[];
}

/**
 * Bezier-smooth a polyline of 2D pixel coordinates.
 * Unlike the RoadLayer version, this preserves the first endpoint position
 * by inserting the bezier entry point as a new point instead of modifying point 0.
 */
export function smoothPolyline2D(
  pixels: { x: number; y: number }[],
  isLoop: boolean,
): SmoothResult {
  const points: { x: number; y: number }[] = [];
  const cellIndices: number[] = new Array(pixels.length);
  const len = pixels.length;

  // Pre-scan to identify corners
  const isCorner: boolean[] = new Array(len);
  for (let i = 0; i < len; i++) {
    if (!isLoop && (i === 0 || i === len - 1)) { isCorner[i] = false; continue; }
    const prev = isLoop ? pixels[(i - 1 + len) % len] : pixels[i - 1];
    const curr = pixels[i];
    const next = isLoop ? pixels[(i + 1) % len] : pixels[i + 1];
    const dxIn = curr.x - prev.x;
    const dyIn = curr.y - prev.y;
    const dxOut = next.x - curr.x;
    const dyOut = next.y - curr.y;
    const sameDir =
      Math.sign(dxIn) === Math.sign(dxOut) &&
      Math.sign(dyIn) === Math.sign(dyOut) &&
      Math.abs(dxIn) > 0 === (Math.abs(dxOut) > 0) &&
      Math.abs(dyIn) > 0 === (Math.abs(dyOut) > 0);
    isCorner[i] = !sameDir;
  }

  for (let i = 0; i < len; i++) {
    const curr = pixels[i];

    if (!isLoop && (i === 0 || i === len - 1)) {
      cellIndices[i] = points.length;
      points.push({ x: curr.x, y: curr.y });
      continue;
    }

    const prev = isLoop ? pixels[(i - 1 + len) % len] : pixels[i - 1];
    const next = isLoop ? pixels[(i + 1) % len] : pixels[i + 1];

    const dxIn = curr.x - prev.x;
    const dyIn = curr.y - prev.y;
    const dxOut = next.x - curr.x;
    const dyOut = next.y - curr.y;

    const sameDirection =
      Math.sign(dxIn) === Math.sign(dxOut) &&
      Math.sign(dyIn) === Math.sign(dyOut) &&
      Math.abs(dxIn) > 0 === (Math.abs(dxOut) > 0) &&
      Math.abs(dyIn) > 0 === (Math.abs(dyOut) > 0);

    if (sameDirection) {
      cellIndices[i] = points.length;
      points.push({ x: curr.x, y: curr.y });
    } else {
      const prevIdx = isLoop ? (i - 1 + len) % len : i - 1;
      const nextIdx = isLoop ? (i + 1) % len : i + 1;
      const inT = isCorner[prevIdx] ? Math.min(SMOOTH_T, 0.5) : SMOOTH_T;
      const outT = isCorner[nextIdx] ? Math.min(SMOOTH_T, 0.5) : SMOOTH_T;

      const pInX = lerp(prev.x, curr.x, 1 - inT);
      const pInY = lerp(prev.y, curr.y, 1 - inT);
      const pOutX = lerp(curr.x, next.x, outT);
      const pOutY = lerp(curr.y, next.y, outT);

      if (points.length > 0) {
        if (points.length === 1 && !isLoop) {
          // First endpoint: insert pIn as new point to preserve start position
          points.push({ x: pInX, y: pInY });
        } else {
          // Interior: modify last point (same as original smoothPolyline)
          const last = points[points.length - 1];
          last.x = pInX;
          last.y = pInY;
        }
      }

      const pInIdx = points.length - 1;

      for (let s = 1; s <= BEZIER_SAMPLES; s++) {
        const t = s / BEZIER_SAMPLES;
        const b = cubicBezier(
          pInX, pInY, curr.x, curr.y,
          curr.x, curr.y, pOutX, pOutY, t,
        );
        points.push({ x: b.x, y: b.y });
      }

      cellIndices[i] = pInIdx + BEZIER_SAMPLES / 2;
    }
  }

  if (isLoop && points.length > 0) {
    points.push({ ...points[0] });
  }

  return { points, cellIndices };
}

export interface SmoothLanePath {
  points: { x: number; y: number }[];
  cumDist: number[];
  cellDist: number[];
  totalDist: number;
}

/**
 * Compute the smooth right-lane polyline for a car's grid path.
 * Approach: smooth the center line first, then offset perpendicular by LANE_OFFSET.
 */
export function computeSmoothLanePath(path: GridPos[]): SmoothLanePath {
  if (path.length < 2) {
    const center = path.length === 1 ? gridToPixelCenter(path[0]) : { x: 0, y: 0 };
    return {
      points: [center],
      cumDist: [0],
      cellDist: [0],
      totalDist: 0,
    };
  }

  const pixels = path.map(gridToPixelCenter);
  const { points: smoothed, cellIndices } = smoothPolyline2D(pixels, false);

  // Offset each smoothed point perpendicular to the travel direction by LANE_OFFSET
  const points: { x: number; y: number }[] = new Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i++) {
    const curr = smoothed[i];
    let dx: number, dy: number;
    if (i === 0) {
      dx = smoothed[1].x - curr.x;
      dy = smoothed[1].y - curr.y;
    } else if (i === smoothed.length - 1) {
      dx = curr.x - smoothed[i - 1].x;
      dy = curr.y - smoothed[i - 1].y;
    } else {
      dx = smoothed[i + 1].x - smoothed[i - 1].x;
      dy = smoothed[i + 1].y - smoothed[i - 1].y;
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      // Perpendicular offset (right side of travel direction)
      points[i] = { x: curr.x + (-dy / len) * LANE_OFFSET, y: curr.y + (dx / len) * LANE_OFFSET };
    } else {
      points[i] = { x: curr.x, y: curr.y };
    }
  }

  // Compute cumulative arc-length distances
  const cumDist = new Array<number>(points.length);
  cumDist[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }

  const cellDist = new Array<number>(path.length);
  for (let i = 0; i < path.length; i++) {
    cellDist[i] = cumDist[cellIndices[i]];
  }

  return {
    points,
    cumDist,
    cellDist,
    totalDist: cumDist[cumDist.length - 1],
  };
}

/**
 * Sample a position and angle on a polyline at a given arc-length distance.
 */
export function sampleAtDistance(
  points: { x: number; y: number }[],
  cumDist: number[],
  dist: number,
): { x: number; y: number; angle: number } {
  if (points.length < 2) {
    return { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0, angle: 0 };
  }

  // Clamp distance
  const totalDist = cumDist[cumDist.length - 1];
  if (dist <= 0) {
    const dx = points[1].x - points[0].x;
    const dy = points[1].y - points[0].y;
    return { x: points[0].x, y: points[0].y, angle: Math.atan2(dy, dx) };
  }
  if (dist >= totalDist) {
    const n = points.length;
    const dx = points[n - 1].x - points[n - 2].x;
    const dy = points[n - 1].y - points[n - 2].y;
    return { x: points[n - 1].x, y: points[n - 1].y, angle: Math.atan2(dy, dx) };
  }

  // Binary search for the segment containing dist
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= dist) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (dist - cumDist[lo]) / segLen : 0;

  const p0 = points[lo];
  const p1 = points[hi];

  return {
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
    angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
  };
}
