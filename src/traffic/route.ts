import { computeSmoothLanePath, sampleAtDistance } from '../utils/roadGeometry';
import { computeHighwayElevation } from '../highways/highwayGeometry';
import { LANE_OFFSET } from '../constants';
import type { GridPos, PixelPos } from '../types';
import { SegmentKind } from './types';
import type { Route, RouteInput, RouteSample, RouteSegment } from './types';

/**
 * Assemble a route from spans of grid cells and highway polylines.
 *
 * A route is one continuous curve from origin to destination. Whether a stretch of it is
 * road or highway shows up only as segment metadata affecting the speed limit — never as a
 * separate integrator. That is what removes the highway-exit splice the old
 * `updateHighwayMovement` performed on `smoothCumDist`.
 *
 * Returns null for input that cannot form a curve (no span with two or more points).
 * Validation lives here, at the boundary, so the simulation carries no defensive branches.
 */
export function buildRoute(input: RouteInput): Route | null {
  const points: PixelPos[] = [];
  const cells: GridPos[] = [];
  const cellDist: number[] = [];
  const segments: RouteSegment[] = [];

  for (const span of input.spans) {
    // Arc distance already accumulated before this span begins.
    const base = points.length === 0 ? 0 : cumulativeLength(points);
    // Dropping the duplicated joint point keeps `cumDist` strictly increasing.
    const skipFirst = points.length > 0;

    if (span.kind === 'grid') {
      if (span.cells.length < 2) continue;
      const smooth = computeSmoothLanePath(span.cells.map(c => c.pos));
      for (let i = skipFirst ? 1 : 0; i < smooth.points.length; i++) {
        points.push({ x: smooth.points[i].x, y: smooth.points[i].y });
      }
      for (let i = 0; i < span.cells.length; i++) {
        cells.push(span.cells[i].pos);
        cellDist.push(base + smooth.cellDist[i]);
      }
      // One segment per cell, spanning the midpoints either side of its centre.
      for (let i = 0; i < span.cells.length; i++) {
        const c = span.cells[i];
        const here = base + smooth.cellDist[i];
        const prev = i > 0 ? base + smooth.cellDist[i - 1] : here;
        const next = i < span.cells.length - 1 ? base + smooth.cellDist[i + 1] : here;
        segments.push({
          kind: c.kind,
          startArc: i === 0 ? here : (prev + here) / 2,
          endArc: i === span.cells.length - 1 ? here : (here + next) / 2,
          speedLimit: c.speedLimit,
          pendingDeletion: c.pendingDeletion,
        });
      }
    } else {
      if (span.polyline.length < 2) continue;
      const offset = offsetRight(span.polyline, LANE_OFFSET);
      for (let i = skipFirst ? 1 : 0; i < offset.length; i++) {
        points.push(offset[i]);
      }
      const end = cumulativeLength(points);
      segments.push({
        kind: SegmentKind.Highway,
        startArc: base,
        endArc: end,
        speedLimit: span.speedLimit,
        pendingDeletion: false,
      });
    }
  }

  if (points.length < 2) return null;

  const cumDist = new Array<number>(points.length);
  cumDist[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }

  return {
    id: input.id,
    points,
    cumDist,
    cells,
    cellDist,
    segments,
    length: cumDist[cumDist.length - 1],
  };
}

function cumulativeLength(points: PixelPos[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/** Offset a polyline perpendicular to travel, to the driver's right (screen y is down). */
function offsetRight(polyline: PixelPos[], amount: number): PixelPos[] {
  const out = new Array<PixelPos>(polyline.length);
  for (let i = 0; i < polyline.length; i++) {
    const prev = polyline[Math.max(0, i - 1)];
    const next = polyline[Math.min(polyline.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    out[i] = len > 0
      ? { x: polyline[i].x + (-dy / len) * amount, y: polyline[i].y + (dx / len) * amount }
      : { x: polyline[i].x, y: polyline[i].y };
  }
  return out;
}

/** Index of the segment containing `arc`. Clamped to the ends. */
function segmentIndexAt(route: Route, arc: number): number {
  for (let i = 0; i < route.segments.length; i++) {
    if (arc <= route.segments[i].endArc) return i;
  }
  return route.segments.length - 1;
}

export function speedLimitAt(route: Route, arc: number): number {
  if (route.segments.length === 0) return 0;
  return route.segments[segmentIndexAt(route, arc)].speedLimit;
}

export function segmentAt(route: Route, arc: number): RouteSegment | null {
  if (route.segments.length === 0) return null;
  return route.segments[segmentIndexAt(route, arc)];
}

export function sampleRoute(route: Route, arc: number): RouteSample {
  const clamped = Math.max(0, Math.min(arc, route.length));
  const s = sampleAtDistance(route.points, route.cumDist, clamped);
  const seg = segmentAt(route, clamped);

  let elevationY = 0;
  if (seg !== null && seg.kind === SegmentKind.Highway) {
    const span = seg.endArc - seg.startArc;
    const t = span > 0 ? (clamped - seg.startArc) / span : 0;
    elevationY = computeHighwayElevation(t, span);
  }

  return { x: s.x, y: s.y, angle: s.angle, elevationY };
}
