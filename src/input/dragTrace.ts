import type { GridPos } from '../types';

/** Perpendicular distance (as a fraction of tile size) within which a drag
 *  segment must pass a lattice corner to produce a diagonal step. */
export const DRAG_CORNER_TOLERANCE_RATIO = 0.25;

const EPS = 1e-9;

/**
 * Cells an 8-connected road drag visits while the cursor moves from (x0,y0)
 * to (x1,y1) in world pixels.
 *
 * Amanatides–Woo grid traversal with a corner rule: the walk advances at the
 * segment's actual grid-line crossings, and when both an X and a Y crossing
 * remain ahead, it steps diagonally iff the segment passes within
 * `cornerTolerance` of the shared corner — a 45° drag through cell centers
 * yields clean diagonals, anything farther from the corner staircases.
 *
 * Returns visited cells in order, excluding the start cell; consecutive
 * entries always differ by a king move; the last entry is the end cell.
 * Zero-length segments return []. No bounds clamping — callers filter.
 */
export function traceDragCells(
  x0: number, y0: number, x1: number, y1: number,
  tileSize: number,
  cornerTolerance: number = tileSize * DRAG_CORNER_TOLERANCE_RATIO,
): GridPos[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];

  let cx = Math.floor(x0 / tileSize);
  let cy = Math.floor(y0 / tileSize);
  const ex = Math.floor(x1 / tileSize);
  const ey = Math.floor(y1 / tileSize);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);

  // Parameter t of the next grid-line crossing per axis, and t per full tile.
  // A start exactly on a grid line crosses at t=0 when moving negative
  // (the cell boundary is behind floor()'s cell), never when moving positive.
  let tMaxX = Infinity;
  let tDeltaX = Infinity;
  if (dx !== 0) {
    const firstX = (stepX > 0 ? cx + 1 : cx) * tileSize;
    tMaxX = (firstX - x0) / dx;
    tDeltaX = tileSize / Math.abs(dx);
  }
  let tMaxY = Infinity;
  let tDeltaY = Infinity;
  if (dy !== 0) {
    const firstY = (stepY > 0 ? cy + 1 : cy) * tileSize;
    tMaxY = (firstY - y0) / dy;
    tDeltaY = tileSize / Math.abs(dy);
  }

  const out: GridPos[] = [];
  const cap = Math.abs(ex - cx) + Math.abs(ey - cy) + 4;
  for (let i = 0; i < cap && (cx !== ex || cy !== ey); i++) {
    const crossX = tMaxX <= 1 + EPS;
    const crossY = tMaxY <= 1 + EPS;
    if (!crossX && !crossY) break;

    let diagonal = false;
    if (crossX && crossY) {
      const cornerX = (cx + (stepX > 0 ? 1 : 0)) * tileSize;
      const cornerY = (cy + (stepY > 0 ? 1 : 0)) * tileSize;
      const d = Math.abs(dx * (y0 - cornerY) - dy * (x0 - cornerX)) / len;
      diagonal = d < cornerTolerance;
    }

    if (diagonal) {
      cx += stepX;
      cy += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (crossX && (!crossY || tMaxX <= tMaxY)) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      tMaxY += tDeltaY;
    }
    out.push({ gx: cx, gy: cy });
  }

  // Float-precision safety: if the walk stopped one king move shy of the end
  // cell, finish the path so the last entry is always the end cell.
  if ((cx !== ex || cy !== ey) && Math.max(Math.abs(ex - cx), Math.abs(ey - cy)) === 1) {
    out.push({ gx: ex, gy: ey });
  }
  return out;
}
