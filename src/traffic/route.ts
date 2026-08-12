import { computeSmoothLanePath, sampleAtDistance } from '../utils/roadGeometry';
import { computeHighwayElevation } from '../highways/highwayGeometry';
import { LANE_OFFSET, TILE_SIZE } from '../constants';
import type { GridPos, PixelPos } from '../types';
import { SegmentKind } from './types';
import type { Route, RouteInput, RouteSample, RouteSegment } from './types';

/**
 * How far apart consecutive spans' endpoints may be and still count as the same joint.
 *
 * Exact coincidence is the wrong test. A grid span's last point carries `LANE_OFFSET`
 * applied by `computeSmoothLanePath`, whose perpendicular comes from neighbouring grid
 * cells, while a highway polyline is offset by `offsetRight`, whose perpendicular comes
 * from the polyline itself. The two agree in direction but not to the pixel, so demanding
 * equality would reject legitimate routes. A whole tile of separation is not rounding —
 * it is a bug in whatever assembled the spans.
 */
const JOINT_TOLERANCE = TILE_SIZE;

/**
 * Assemble a route from spans of grid cells and highway polylines.
 *
 * A route is one continuous curve from origin to destination. Whether a stretch of it is
 * road or highway shows up only as segment metadata affecting the speed limit — never as a
 * separate integrator. That is what removes the highway-exit splice the old
 * `updateHighwayMovement` performed on `smoothCumDist`.
 *
 * Returns null for input that cannot form a curve: a span with fewer than two points, or
 * a joint between spans wider than `JOINT_TOLERANCE`. Both would otherwise be absorbed
 * silently — a dropped span splices its neighbours together, and a wide joint becomes a
 * phantom straight line carrying the following span's speed limit and elevation profile.
 * Validation lives here, at the boundary, so the simulation carries no defensive branches.
 *
 * It does **not** refuse a route with fewer than two cells. A cell-less curve is a
 * perfectly well-formed one — `sampleRoute` and the stepper's arrival test need nothing
 * else — it is merely one no lane can hold, so a vehicle on it has no collision avoidance.
 * That is a rule about which routes the *game* may put a car on, and it is enforced where
 * the game is: `TrafficAdapter.installRoute`.
 */
export function buildRoute(input: RouteInput): Route | null {
  const points: PixelPos[] = [];
  const cells: GridPos[] = [];
  const cellDist: number[] = [];
  const segments: RouteSegment[] = [];
  /**
   * Whether the previous span recorded cells. When it did, this span's first cell is the
   * shared joint and is already in `cells`, so recording it again would put a zero-length
   * step in `cellDist`. Highway spans contribute no cells, so a grid span following one
   * keeps its first cell.
   */
  let prevSpanHadCells = false;

  for (const span of input.spans) {
    // Arc distance already accumulated before this span begins.
    const base = points.length === 0 ? 0 : cumulativeLength(points);
    // Dropping the duplicated joint point keeps `cumDist` strictly increasing.
    const skipFirst = points.length > 0;

    if (span.kind === 'grid') {
      if (span.cells.length < 2) return null;
      const smooth = computeSmoothLanePath(span.cells.map(c => c.pos));
      if (skipFirst && !joins(points[points.length - 1], smooth.points[0])) return null;
      for (let i = skipFirst ? 1 : 0; i < smooth.points.length; i++) {
        points.push({ x: smooth.points[i].x, y: smooth.points[i].y });
      }
      for (let i = prevSpanHadCells ? 1 : 0; i < span.cells.length; i++) {
        cells.push(span.cells[i].pos);
        cellDist.push(base + smooth.cellDist[i]);
      }
      // One segment per cell, spanning the midpoints either side of its centre. A shared
      // joint cell keeps a segment from each span: together they cover its full extent,
      // and each half carries the speed limit the span that owns it declared.
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
      prevSpanHadCells = true;
    } else {
      if (span.polyline.length < 2) return null;
      const offset = offsetRight(span.polyline, LANE_OFFSET);
      if (skipFirst && !joins(points[points.length - 1], offset[0])) return null;
      // Recorded before the points are pushed, so it lands at the crossing's first arc
      // rather than after it. A folded cell contributes no geometry and no segment — see
      // `RouteSpan.entryCell` — only its place in `cells`/`cellDist`.
      if (span.entryCell !== undefined && !prevSpanHadCells) {
        cells.push(span.entryCell);
        cellDist.push(base);
      }
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
      if (span.exitCell !== undefined) {
        cells.push(span.exitCell);
        cellDist.push(end);
      }
      // A crossing that carried an exit cell has already recorded the joint the next span
      // starts on, so that span must not record it twice — the same rule a grid span
      // following a grid span obeys, and the reason `cellDist` stays strictly increasing.
      prevSpanHadCells = span.exitCell !== undefined;
    }
  }

  if (points.length < 2) return null;

  // The tail extension continues the closing direction in a straight line. Appended
  // before `cumDist` is computed so every consumer sees one consistent geometry; the last
  // segment stretches to cover it, so the stub carries the destination cell's own speed
  // limit and no consumer meets an arc no segment answers for. `cells`/`cellDist` are
  // untouched — the stub is more of the last cell, not a new one.
  const tail = input.tailExtension ?? 0;
  if (tail > 0) {
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // cumDist is strictly increasing by construction (duplicate joints are dropped), so
    // the closing pair cannot coincide; the guard documents the division's precondition.
    if (len > 0) {
      points.push({ x: b.x + ((b.x - a.x) / len) * tail, y: b.y + ((b.y - a.y) / len) * tail });
      const last = segments[segments.length - 1];
      if (last !== undefined) last.endArc += tail;
    }
  }

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

/** Whether two span endpoints are close enough to be the same joint. */
function joins(a: PixelPos, b: PixelPos): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) <= JOINT_TOLERANCE;
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
