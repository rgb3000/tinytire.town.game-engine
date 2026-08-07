import { TILE_SIZE } from '../constants';
import { SUBCELL } from './field';
import type { SignedField } from './distanceField';

/**
 * Trace closed isolines of a signed field at a given threshold.
 *
 * This replaces the old boundary-segment walker, which chose continuations arbitrarily
 * wherever four segments met a vertex — the common case for anything painted freehand in
 * the designer, and the source of the tangled silhouettes.
 *
 * Crossings are identified by *edge identity*, not by position. Every edge is shared by
 * exactly two cells, each contributing one connection through it, so every crossing has
 * degree exactly 2 and the walk is forced. The coverage field's zero-padded border
 * guarantees no crossing sits on an outer edge, so every walk closes.
 *
 * Returns loops of `[x, y]` world-pixel points, first point repeated at the end.
 */
export function traceIsolines(field: SignedField, threshold: number): number[][][] {
  const { width, height, data } = field;
  if (width < 2 || height < 2) return [];

  const hCount = (width - 1) * height;
  const horizontalEdge = (x: number, y: number) => y * (width - 1) + x;
  const verticalEdge = (x: number, y: number) => hCount + y * width + x;

  /** edge id -> the crossing point on it, in world pixels */
  const points = new Map<number, [number, number]>();
  /** edge id -> the up-to-two edge ids it links to */
  const links = new Map<number, number[]>();

  const worldX = (sx: number) => (field.originGx + (sx + 0.5) / SUBCELL) * TILE_SIZE;
  const worldY = (sy: number) => (field.originGy + (sy + 0.5) / SUBCELL) * TILE_SIZE;

  function crossing(id: number, ax: number, ay: number, bx: number, by: number): number {
    if (!points.has(id)) {
      const va = data[ay * width + ax];
      const vb = data[by * width + bx];
      let t = (threshold - va) / (vb - va);
      if (!Number.isFinite(t)) t = 0.5;
      t = Math.max(0, Math.min(1, t));
      points.set(id, [
        worldX(ax + (bx - ax) * t),
        worldY(ay + (by - ay) * t),
      ]);
    }
    return id;
  }

  function connect(a: number, b: number): void {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a)!.push(b);
    links.get(b)!.push(a);
  }

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = data[y * width + x];
      const tr = data[y * width + x + 1];
      const br = data[(y + 1) * width + x + 1];
      const bl = data[(y + 1) * width + x];

      const code =
        (tl >= threshold ? 1 : 0) |
        (tr >= threshold ? 2 : 0) |
        (br >= threshold ? 4 : 0) |
        (bl >= threshold ? 8 : 0);

      if (code === 0 || code === 15) continue;

      // Lazily resolve only the edges this case needs.
      const top = () => crossing(horizontalEdge(x, y), x, y, x + 1, y);
      const right = () => crossing(verticalEdge(x + 1, y), x + 1, y, x + 1, y + 1);
      const bottom = () => crossing(horizontalEdge(x, y + 1), x, y + 1, x + 1, y + 1);
      const left = () => crossing(verticalEdge(x, y), x, y, x, y + 1);

      switch (code) {
        case 1: case 14: connect(left(), top()); break;
        case 2: case 13: connect(top(), right()); break;
        case 3: case 12: connect(left(), right()); break;
        case 4: case 11: connect(right(), bottom()); break;
        case 6: case 9: connect(top(), bottom()); break;
        case 7: case 8: connect(left(), bottom()); break;
        case 5:
        case 10: {
          // Ambiguous saddle. The centre value decides which pair of corners is joined;
          // either choice keeps every crossing at degree 2, but they give different shapes.
          const centreInside = (tl + tr + br + bl) / 4 >= threshold;
          const joinAcross = code === 5 ? centreInside : !centreInside;
          if (joinAcross) {
            connect(top(), right());
            connect(bottom(), left());
          } else {
            connect(left(), top());
            connect(right(), bottom());
          }
          break;
        }
      }
    }
  }

  return walkLoops(points, links);
}

function walkLoops(
  points: Map<number, [number, number]>,
  links: Map<number, number[]>,
): number[][][] {
  const visited = new Set<number>();
  const loops: number[][][] = [];

  for (const start of links.keys()) {
    if (visited.has(start)) continue;

    const loop: number[][] = [];
    let current = start;
    let previous = -1;

    for (;;) {
      visited.add(current);
      const p = points.get(current)!;
      loop.push([p[0], p[1]]);

      const neighbours = links.get(current) ?? [];
      let next = -1;
      for (const n of neighbours) {
        if (n !== previous) { next = n; break; }
      }
      // A degenerate degree-1 crossing would end the walk here; the padded border makes
      // that unreachable, but bailing out is safer than looping forever.
      if (next === -1 || next === start) break;
      if (visited.has(next)) break;
      previous = current;
      current = next;
    }

    if (loop.length >= 3) {
      loop.push([loop[0][0], loop[0][1]]);
      loops.push(loop);
    }
  }

  return loops;
}
