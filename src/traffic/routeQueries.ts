import type { GridPos, PixelPos } from '../types';
import type { Route } from './types';

/**
 * The arc extent cell `i` occupies: from the midpoint with its predecessor to the midpoint
 * with its successor, clamped to the route's ends.
 *
 * `cellDist` records where a cell's *centre* falls, but a car is inside a cell for the whole
 * stretch between the midpoints either side of it. Testing an arc against centres would drop
 * the cell a car is standing on the instant it passed the centre — and for the "cells ahead"
 * query that means deleting road out from under a homebound car rather than marking it
 * pending. Extents reproduce what the loops in `Game.tryRemoveRoad` did with `pathIndex`.
 *
 * Derived from `cellDist` alone, deliberately. `route.segments` is not index-aligned with
 * `route.cells` — a highway span contributes one segment and no cells — so `segments[i]`
 * describes the wrong stretch of any route carrying a highway. The consequence is that a
 * highway stretches the two cells flanking it across its whole arc. That over-includes, and
 * over-including is the safe direction for both callers.
 */
function cellStartArc(route: Route, i: number): number {
  return i === 0 ? 0 : (route.cellDist[i - 1] + route.cellDist[i]) / 2;
}

function cellEndArc(route: Route, i: number): number {
  return i === route.cells.length - 1
    ? route.length
    : (route.cellDist[i] + route.cellDist[i + 1]) / 2;
}

/**
 * The grid cells a route occupies between two arc distances, inclusive of both bounds.
 *
 * A cell counts when the arc it occupies overlaps the range at all, so a car sitting
 * anywhere inside a cell keeps that cell in both its travelled and its remaining range.
 *
 * `Game.tryRemoveRoad` asks this to decide whether a road cell can be removed outright or
 * must be marked pending. The arc range encodes which part of the journey matters, and the
 * asymmetry is deliberate — see `carDependsOnCell` in `TrafficAdapter`.
 */
export function cellsBetween(route: Route, fromArc: number, toArc: number): GridPos[] {
  const out: GridPos[] = [];
  if (toArc < fromArc) return out;
  for (let i = 0; i < route.cells.length; i++) {
    if (cellStartArc(route, i) <= toArc && cellEndArc(route, i) >= fromArc) {
      out.push(route.cells[i]);
    }
  }
  return out;
}

/**
 * Allocation-free equivalent of `cellsBetween(...).some(...)`, for when the caller only
 * needs a yes or no — `carDependsOnCell`, which asks it once per car per road cell being
 * removed.
 */
export function routeCoversCell(
  route: Route, gx: number, gy: number, fromArc: number, toArc: number,
): boolean {
  if (toArc < fromArc) return false;
  for (let i = 0; i < route.cells.length; i++) {
    const c = route.cells[i];
    if (c.gx !== gx || c.gy !== gy) continue;
    if (cellStartArc(route, i) <= toArc && cellEndArc(route, i) >= fromArc) return true;
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
