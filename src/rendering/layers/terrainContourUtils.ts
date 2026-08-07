import * as THREE from 'three';
import type { GridPos } from '../../types';
import { TILE_SIZE } from '../../constants';
import { smoothNoise2D } from '../../utils/math';

/** Both MountainTriangles and LakeTriangles share this structure */
export type TriangleMap = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>;

type Quadrant = 'top' | 'right' | 'bottom' | 'left';

export interface Segment {
  x1: number; y1: number;
  x2: number; y2: number;
}

// --- Cluster identification (4-connected BFS) ---

export function findClusters(cells: GridPos[]): GridPos[][] {
  const set = new Set<string>();
  for (const c of cells) set.add(`${c.gx},${c.gy}`);

  const visited = new Set<string>();
  const clusters: GridPos[][] = [];

  for (const c of cells) {
    const key = `${c.gx},${c.gy}`;
    if (visited.has(key)) continue;

    const cluster: GridPos[] = [];
    const queue: GridPos[] = [c];
    visited.add(key);

    while (queue.length > 0) {
      const cur = queue.pop()!;
      cluster.push(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cur.gx + dx;
        const ny = cur.gy + dy;
        const nk = `${nx},${ny}`;
        if (set.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push({ gx: nx, gy: ny });
        }
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

// --- Triangle helpers ---

export function getTriFlags(
  gx: number, gy: number,
  cellSet: Set<string>,
  triangles?: TriangleMap,
): Record<Quadrant, boolean> {
  const key = `${gx},${gy}`;
  if (!cellSet.has(key)) return { top: false, right: false, bottom: false, left: false };
  const tri = triangles?.get(key);
  if (!tri) return { top: true, right: true, bottom: true, left: true };
  return {
    top: tri.top === true,
    right: tri.right === true,
    bottom: tri.bottom === true,
    left: tri.left === true,
  };
}

// --- Boundary segment collection (triangle-aware) ---

export function collectBoundarySegments(
  cluster: GridPos[],
  cellSet: Set<string>,
  triangles?: TriangleMap,
): Segment[] {
  const segments: Segment[] = [];

  for (const c of cluster) {
    const px = c.gx * TILE_SIZE;
    const py = c.gy * TILE_SIZE;
    const half = TILE_SIZE / 2;
    const cx = px + half;
    const cy = py + half;
    const me = getTriFlags(c.gx, c.gy, cellSet, triangles);

    if (me.top) {
      const above = getTriFlags(c.gx, c.gy - 1, cellSet, triangles);
      if (!above.bottom) segments.push({ x1: px, y1: py, x2: px + TILE_SIZE, y2: py });
    }
    if (me.bottom) {
      const below = getTriFlags(c.gx, c.gy + 1, cellSet, triangles);
      if (!below.top) segments.push({ x1: px, y1: py + TILE_SIZE, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    }
    if (me.left) {
      const left = getTriFlags(c.gx - 1, c.gy, cellSet, triangles);
      if (!left.right) segments.push({ x1: px, y1: py, x2: px, y2: py + TILE_SIZE });
    }
    if (me.right) {
      const right = getTriFlags(c.gx + 1, c.gy, cellSet, triangles);
      if (!right.left) segments.push({ x1: px + TILE_SIZE, y1: py, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    }

    if (me.top !== me.right) segments.push({ x1: cx, y1: cy, x2: px + TILE_SIZE, y2: py });
    if (me.right !== me.bottom) segments.push({ x1: cx, y1: cy, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    if (me.bottom !== me.left) segments.push({ x1: cx, y1: cy, x2: px, y2: py + TILE_SIZE });
    if (me.left !== me.top) segments.push({ x1: cx, y1: cy, x2: px, y2: py });
  }

  return segments;
}

// --- Segment chaining ---

export function chainSegments(segments: Segment[]): number[][][] {
  if (segments.length === 0) return [];

  const endpointMap = new Map<string, number[]>();
  const ptKey = (x: number, y: number) => `${x},${y}`;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const k1 = ptKey(s.x1, s.y1);
    const k2 = ptKey(s.x2, s.y2);
    if (!endpointMap.has(k1)) endpointMap.set(k1, []);
    if (!endpointMap.has(k2)) endpointMap.set(k2, []);
    endpointMap.get(k1)!.push(i);
    endpointMap.get(k2)!.push(i);
  }

  const used = new Set<number>();
  const loops: number[][][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);

    const chain: number[][] = [[segments[i].x1, segments[i].y1], [segments[i].x2, segments[i].y2]];
    let currentEnd = ptKey(segments[i].x2, segments[i].y2);

    for (;;) {
      const candidates = endpointMap.get(currentEnd);
      if (!candidates) break;

      let found = false;
      for (const ci of candidates) {
        if (used.has(ci)) continue;
        used.add(ci);
        const s = segments[ci];
        const sk1 = ptKey(s.x1, s.y1);

        if (sk1 === currentEnd) {
          chain.push([s.x2, s.y2]);
          currentEnd = ptKey(s.x2, s.y2);
        } else {
          chain.push([s.x1, s.y1]);
          currentEnd = ptKey(s.x1, s.y1);
        }
        found = true;
        break;
      }
      if (!found) break;
    }

    loops.push(chain);
  }

  return loops;
}

// --- Chaikin subdivision smoothing ---

export function chaikinSmooth(points: number[][], iterations: number): number[][] {
  let pts = points;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed: number[][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      smoothed.push([0.75 * x1 + 0.25 * x2, 0.75 * y1 + 0.25 * y2]);
      smoothed.push([0.25 * x1 + 0.75 * x2, 0.25 * y1 + 0.75 * y2]);
    }
    if (smoothed.length > 0) smoothed.push(smoothed[0]);
    pts = smoothed;
  }
  return pts;
}

// --- Mountain-specific rough smoothing ---

export function roughSmooth(points: number[][], seed: number): number[][] {
  // 2 Chaikin iterations (less round than lakes which use 3)
  let pts = chaikinSmooth(points, 2);

  // Displace each point along its contour normal using noise
  const n = pts.length;
  const closed = n > 0 && pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1];
  const count = closed ? n - 1 : n;
  if (count < 3) return pts;

  const amplitude = TILE_SIZE * 0.06;
  const result: number[][] = [];

  for (let i = 0; i < count; i++) {
    const prev = pts[(i - 1 + count) % count];
    const next = pts[(i + 1) % count];
    // Tangent direction
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-6) {
      result.push([pts[i][0], pts[i][1]]);
      continue;
    }
    // Normal (perpendicular to tangent)
    const nx = -ty / tLen;
    const ny = tx / tLen;
    // Noise displacement
    const noiseVal = smoothNoise2D(pts[i][0] / TILE_SIZE * 2.5 + seed, pts[i][1] / TILE_SIZE * 2.5 + seed);
    const displacement = (noiseVal - 0.5) * 2 * amplitude;
    result.push([pts[i][0] + nx * displacement, pts[i][1] + ny * displacement]);
  }

  if (closed && result.length > 0) result.push([result[0][0], result[0][1]]);
  return result;
}

// --- Inset/outset a polygon loop ---

export function signedArea2(points: number[][], count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    sum += (points[j][0] - points[i][0]) * (points[j][1] + points[i][1]);
  }
  return sum;
}

export function insetLoop(points: number[][], distance: number): number[][] {
  const n = points.length;
  if (n < 3) return points;

  const closed = points[0][0] === points[n - 1][0] && points[0][1] === points[n - 1][1];
  const count = closed ? n - 1 : n;
  if (count < 3) return points;

  const area2 = signedArea2(points, count);
  const sign = area2 > 0 ? -1 : 1;

  const result: number[][] = [];

  for (let i = 0; i < count; i++) {
    const prev = points[(i - 1 + count) % count];
    const curr = points[i];
    const next = points[(i + 1) % count];

    const e1x = curr[0] - prev[0], e1y = curr[1] - prev[1];
    const e2x = next[0] - curr[0], e2y = next[1] - curr[1];
    const len1 = Math.hypot(e1x, e1y);
    const len2 = Math.hypot(e2x, e2y);

    if (len1 < 1e-6 || len2 < 1e-6) {
      result.push([curr[0], curr[1]]);
      continue;
    }

    const n1x = sign * -e1y / len1, n1y = sign * e1x / len1;
    const n2x = sign * -e2y / len2, n2y = sign * e2x / len2;

    // Cross product detects reflex (concave) vertices
    const cross = e1x * e2y - e1y * e2x;
    const isReflex = sign * cross < 0;

    if (isReflex) {
      // Bevel join: two offset points prevent overshoot at concave corners
      result.push([curr[0] + n1x * distance, curr[1] + n1y * distance]);
      result.push([curr[0] + n2x * distance, curr[1] + n2y * distance]);
    } else {
      let bx = n1x + n2x, by = n1y + n2y;
      const bLen = Math.hypot(bx, by);

      if (bLen < 1e-6) {
        result.push([curr[0] + n1x * distance, curr[1] + n1y * distance]);
      } else {
        bx /= bLen;
        by /= bLen;
        const dot = n1x * bx + n1y * by;
        const scale = 1 / Math.max(dot, 0.3);
        result.push([curr[0] + bx * distance * scale, curr[1] + by * distance * scale]);
      }
    }
  }

  if (closed && result.length > 0) result.push([result[0][0], result[0][1]]);
  return result;
}

// --- THREE.js shape helpers ---

export function makeShape(points: number[][]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i][0], points[i][1]);
  }
  shape.closePath();
  return shape;
}

export function makePath(points: number[][]): THREE.Path {
  const path = new THREE.Path();
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    path.lineTo(points[i][0], points[i][1]);
  }
  path.closePath();
  return path;
}

// --- Terrace count scaling ---

export function getTerraceCount(clusterSize: number): number {
  if (clusterSize <= 3) return 2;
  if (clusterSize <= 8) return 3;
  if (clusterSize <= 15) return 4;
  if (clusterSize <= 25) return 5;
  return 6;
}
