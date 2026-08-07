import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { GRID_COLS, GRID_ROWS, TILE_SIZE, LAKE_SHORE_COLOR } from '../../constants';

type Quadrant = 'top' | 'right' | 'bottom' | 'left';

interface Segment {
  x1: number; y1: number;
  x2: number; y2: number;
}

function findClusters(lakeCells: GridPos[]): GridPos[][] {
  const lakeSet = new Set(lakeCells.map(p => `${p.gx},${p.gy}`));
  const visited = new Set<string>();
  const clusters: GridPos[][] = [];

  for (const cell of lakeCells) {
    const key = `${cell.gx},${cell.gy}`;
    if (visited.has(key)) continue;

    const cluster: GridPos[] = [];
    const queue: GridPos[] = [cell];
    visited.add(key);

    while (queue.length > 0) {
      const c = queue.pop()!;
      cluster.push(c);

      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nk = `${c.gx + dx},${c.gy + dy}`;
        if (lakeSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push({ gx: c.gx + dx, gy: c.gy + dy });
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function collectBoundarySegments(
  cluster: GridPos[],
  lakeSet: Set<string>,
  lakeTriangles?: LakeTriangles,
): Segment[] {
  const segments: Segment[] = [];

  for (const c of cluster) {
    const px = c.gx * TILE_SIZE;
    const py = c.gy * TILE_SIZE;
    const half = TILE_SIZE / 2;
    const cx = px + half;
    const cy = py + half;
    const me = getTriFlags(c.gx, c.gy, lakeSet, lakeTriangles);

    // Outer edges
    if (me.top) {
      const above = getTriFlags(c.gx, c.gy - 1, lakeSet, lakeTriangles);
      if (!above.bottom) segments.push({ x1: px, y1: py, x2: px + TILE_SIZE, y2: py });
    }
    if (me.bottom) {
      const below = getTriFlags(c.gx, c.gy + 1, lakeSet, lakeTriangles);
      if (!below.top) segments.push({ x1: px, y1: py + TILE_SIZE, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    }
    if (me.left) {
      const left = getTriFlags(c.gx - 1, c.gy, lakeSet, lakeTriangles);
      if (!left.right) segments.push({ x1: px, y1: py, x2: px, y2: py + TILE_SIZE });
    }
    if (me.right) {
      const right = getTriFlags(c.gx + 1, c.gy, lakeSet, lakeTriangles);
      if (!right.left) segments.push({ x1: px + TILE_SIZE, y1: py, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    }

    // Internal diagonal edges
    if (me.top !== me.right) segments.push({ x1: cx, y1: cy, x2: px + TILE_SIZE, y2: py });
    if (me.right !== me.bottom) segments.push({ x1: cx, y1: cy, x2: px + TILE_SIZE, y2: py + TILE_SIZE });
    if (me.bottom !== me.left) segments.push({ x1: cx, y1: cy, x2: px, y2: py + TILE_SIZE });
    if (me.left !== me.top) segments.push({ x1: cx, y1: cy, x2: px, y2: py });
  }

  return segments;
}

function chainSegments(segments: Segment[]): number[][][] {
  if (segments.length === 0) return [];

  // Build adjacency: endpoint → list of segment indices
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

function chaikinSmooth(points: number[][], iterations: number): number[][] {
  let pts = points;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed: number[][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      smoothed.push([0.75 * x1 + 0.25 * x2, 0.75 * y1 + 0.25 * y2]);
      smoothed.push([0.25 * x1 + 0.75 * x2, 0.25 * y1 + 0.75 * y2]);
    }
    // Close the loop
    if (smoothed.length > 0) smoothed.push(smoothed[0]);
    pts = smoothed;
  }
  return pts;
}

function buildLakePath(
  cluster: GridPos[],
  lakeSet: Set<string>,
  lakeTriangles?: LakeTriangles,
): Path2D {
  const segments = collectBoundarySegments(cluster, lakeSet, lakeTriangles);
  const loops = chainSegments(segments);
  const path = new Path2D();

  for (const loop of loops) {
    if (loop.length < 3) continue;
    const smoothed = chaikinSmooth(loop, 3);
    path.moveTo(smoothed[0][0], smoothed[0][1]);
    for (let i = 1; i < smoothed.length; i++) {
      path.lineTo(smoothed[i][0], smoothed[i][1]);
    }
    path.closePath();
  }

  return path;
}

function getTriFlags(
  gx: number, gy: number,
  lakeSet: Set<string>,
  lakeTriangles?: LakeTriangles,
): Record<Quadrant, boolean> {
  const key = `${gx},${gy}`;
  if (!lakeSet.has(key)) return { top: false, right: false, bottom: false, left: false };
  const tri = lakeTriangles?.get(key);
  if (!tri) return { top: true, right: true, bottom: true, left: true };
  return {
    top: tri.top === true,
    right: tri.right === true,
    bottom: tri.bottom === true,
    left: tri.left === true,
  };
}

export class TerrainLayer {
  private backgroundColor = '#FFFFFF';
  private waterColor = LAKE_SHORE_COLOR;

  setBackgroundColor(color: string): void {
    this.backgroundColor = color;
  }

  setLakeColors(water: string): void {
    this.waterColor = water;
  }

  render(
    ctx: CanvasRenderingContext2D,
    lakeCells?: GridPos[],
    backgroundTiles?: Map<string, { top?: number; right?: number; bottom?: number; left?: number }>,
    paintPalette?: string[],
    lakeTriangles?: LakeTriangles,
  ): void {
    const w = GRID_COLS * TILE_SIZE;
    const h = GRID_ROWS * TILE_SIZE;

    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, w, h);

    // Paint background tiles (before lakes so lakes overlay on top)
    if (backgroundTiles && paintPalette && backgroundTiles.size > 0) {
      for (const [key, tile] of backgroundTiles) {
        const [gxStr, gyStr] = key.split(',');
        const px = Number(gxStr) * TILE_SIZE;
        const py = Number(gyStr) * TILE_SIZE;
        const cx = px + TILE_SIZE / 2;
        const cy = py + TILE_SIZE / 2;

        const quadrants: [string, number, number, number, number, number, number][] = [];
        if (tile.top !== undefined) {
          quadrants.push([paintPalette[tile.top], px, py, px + TILE_SIZE, py, cx, cy]);
        }
        if (tile.right !== undefined) {
          quadrants.push([paintPalette[tile.right], px + TILE_SIZE, py, px + TILE_SIZE, py + TILE_SIZE, cx, cy]);
        }
        if (tile.bottom !== undefined) {
          quadrants.push([paintPalette[tile.bottom], px + TILE_SIZE, py + TILE_SIZE, px, py + TILE_SIZE, cx, cy]);
        }
        if (tile.left !== undefined) {
          quadrants.push([paintPalette[tile.left], px, py + TILE_SIZE, px, py, cx, cy]);
        }

        for (const [color, x1, y1, x2, y2, x3, y3] of quadrants) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x3, y3);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Paint lake cell outlines — 1px triangle-aware boundary
    if (lakeCells && lakeCells.length > 0) {
      const lakeSet = new Set(lakeCells.map(p => `${p.gx},${p.gy}`));

      ctx.save();
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (const c of lakeCells) {
        const px = c.gx * TILE_SIZE;
        const py = c.gy * TILE_SIZE;
        const half = TILE_SIZE / 2;
        const cx = px + half;
        const cy = py + half;
        const me = getTriFlags(c.gx, c.gy, lakeSet, lakeTriangles);

        // Outer edges: draw when quadrant is active but neighbor's adjacent quadrant isn't
        if (me.top) {
          const above = getTriFlags(c.gx, c.gy - 1, lakeSet, lakeTriangles);
          if (!above.bottom) { ctx.moveTo(px, py); ctx.lineTo(px + TILE_SIZE, py); }
        }
        if (me.bottom) {
          const below = getTriFlags(c.gx, c.gy + 1, lakeSet, lakeTriangles);
          if (!below.top) { ctx.moveTo(px, py + TILE_SIZE); ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE); }
        }
        if (me.left) {
          const left = getTriFlags(c.gx - 1, c.gy, lakeSet, lakeTriangles);
          if (!left.right) { ctx.moveTo(px, py); ctx.lineTo(px, py + TILE_SIZE); }
        }
        if (me.right) {
          const right = getTriFlags(c.gx + 1, c.gy, lakeSet, lakeTriangles);
          if (!right.left) { ctx.moveTo(px + TILE_SIZE, py); ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE); }
        }

        // Internal diagonal edges where adjacent quadrants differ
        if (me.top !== me.right) { ctx.moveTo(cx, cy); ctx.lineTo(px + TILE_SIZE, py); }
        if (me.right !== me.bottom) { ctx.moveTo(cx, cy); ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE); }
        if (me.bottom !== me.left) { ctx.moveTo(cx, cy); ctx.lineTo(px, py + TILE_SIZE); }
        if (me.left !== me.top) { ctx.moveTo(cx, cy); ctx.lineTo(px, py); }
      }

      ctx.stroke();
      ctx.restore();

      // Smoothed inner outline
      const clusters = findClusters(lakeCells);
      ctx.save();
      ctx.strokeStyle = this.waterColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const cluster of clusters) {
        const path = buildLakePath(cluster, lakeSet, lakeTriangles);
        ctx.stroke(path);
      }
      ctx.restore();

      // Punch transparent holes for 3D lake mesh to show through
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      for (const cluster of clusters) {
        const path = buildLakePath(cluster, lakeSet, lakeTriangles);
        ctx.fill(path);
      }
      ctx.restore();
    }
  }
}
