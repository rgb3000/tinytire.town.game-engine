import type { GridPos, PixelPos } from '../types';
import type { Route } from './types';

/**
 * The grid cells a route occupies between two arc distances, inclusive of both bounds.
 *
 * `Game.tryRemoveRoad` asks this to decide whether a road cell can be removed outright or
 * must be marked pending. The arc range encodes which part of the journey matters, and the
 * asymmetry is deliberate — see `carDependsOnCell` in `TrafficAdapter`.
 */
export function cellsBetween(route: Route, fromArc: number, toArc: number): GridPos[] {
  const out: GridPos[] = [];
  if (toArc < fromArc) return out;
  for (let i = 0; i < route.cells.length; i++) {
    const d = route.cellDist[i];
    if (d >= fromArc && d <= toArc) out.push(route.cells[i]);
  }
  return out;
}

/** Allocation-free equivalent of `cellsBetween(...).some(...)`, for the hover hot path. */
export function routeCoversCell(
  route: Route, gx: number, gy: number, fromArc: number, toArc: number,
): boolean {
  if (toArc < fromArc) return false;
  for (let i = 0; i < route.cells.length; i++) {
    const d = route.cellDist[i];
    if (d < fromArc || d > toArc) continue;
    const c = route.cells[i];
    if (c.gx === gx && c.gy === gy) return true;
  }
  return false;
}

/**
 * Cut the route polyline at an arc distance, returning both halves.
 *
 * The cut point belongs to both halves, so drawing them back to back reproduces the whole
 * route with no gap. `CarRouteLayer` uses this to shade travelled and remaining
 * differently; it replaces a pair of code paths that drew smoothed and unsmoothed
 * geometry depending on whether `smoothPath` happened to be populated.
 */
export function splitAt(route: Route, arc: number): { travelled: PixelPos[]; remaining: PixelPos[] } {
  const clamped = Math.max(0, Math.min(arc, route.length));

  let hi = 1;
  while (hi < route.cumDist.length - 1 && route.cumDist[hi] < clamped) hi++;
  const lo = hi - 1;

  const segLen = route.cumDist[hi] - route.cumDist[lo];
  const t = segLen > 0 ? (clamped - route.cumDist[lo]) / segLen : 0;
  const cut: PixelPos = {
    x: route.points[lo].x + (route.points[hi].x - route.points[lo].x) * t,
    y: route.points[lo].y + (route.points[hi].y - route.points[lo].y) * t,
  };

  const travelled = route.points.slice(0, lo + 1).map(p => ({ x: p.x, y: p.y }));
  travelled.push(cut);

  const remaining: PixelPos[] = [cut];
  for (let i = hi; i < route.points.length; i++) {
    remaining.push({ x: route.points[i].x, y: route.points[i].y });
  }

  return { travelled, remaining };
}
