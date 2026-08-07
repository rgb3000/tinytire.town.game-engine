export interface NestedPolygon {
  outer: number[][];
  holes: number[][][];
}

/** Shoelace area. Sign encodes winding; magnitude is the enclosed area. */
export function signedArea(loop: number[][]): number {
  const n = closedCount(loop);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function ensureWinding(loop: number[][], wantPositive: boolean): number[][] {
  const positive = signedArea(loop) > 0;
  return positive === wantPositive ? loop : [...loop].reverse();
}

/** Ray casting, winding-agnostic. */
export function pointInPolygon(point: number[], loop: number[][]): boolean {
  const [px, py] = point;
  const n = closedCount(loop);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    const straddles = (yi > py) !== (yj > py);
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Douglas-Peucker on a closed loop.
 *
 * Terrain contours come off marching squares with a vertex on every crossed lattice edge,
 * which is far more than the mesh needs. Outer silhouettes get a tight tolerance so painted
 * shapes stay recognisable; inner terraces can afford a looser one.
 */
export function simplifyLoop(loop: number[][], tolerance: number): number[][] {
  const n = closedCount(loop);
  if (n <= 3) return loop;

  const open = loop.slice(0, n);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  douglasPeucker(open, 0, n - 1, tolerance, keep);

  const result: number[][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) result.push(open[i]);

  // A closed loop needs three distinct points to bound any area at all.
  if (result.length < 3) return loop;

  result.push([result[0][0], result[0][1]]);
  return result;
}

function douglasPeucker(
  pts: number[][], first: number, last: number, tolerance: number, keep: Uint8Array,
): void {
  if (last <= first + 1) return;

  const [ax, ay] = pts[first];
  const [bx, by] = pts[last];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  let worst = -1;
  let worstIndex = -1;

  for (let i = first + 1; i < last; i++) {
    const [px, py] = pts[i];
    let d: number;
    if (lengthSq === 0) {
      d = Math.hypot(px - ax, py - ay);
    } else {
      let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    if (d > worst) { worst = d; worstIndex = i; }
  }

  if (worst > tolerance && worstIndex !== -1) {
    keep[worstIndex] = 1;
    douglasPeucker(pts, first, worstIndex, tolerance, keep);
    douglasPeucker(pts, worstIndex, last, tolerance, keep);
  }
}

/**
 * Sort loops into outer boundaries with their holes.
 *
 * Containment depth decides the role: a loop contained by an even number of larger loops is
 * an outer boundary, an odd number makes it a hole of the smallest loop containing it. This
 * nests to any depth, so a lake can hold an island that itself holds a pond. The code this
 * replaces kept only the longest loop and discarded the rest, which is why islands were
 * impossible.
 */
export function nestLoops(loops: number[][][]): NestedPolygon[] {
  const sorted = [...loops]
    .filter(l => closedCount(l) >= 3)
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  const parents: number[] = sorted.map(() => -1);
  const depths: number[] = sorted.map(() => 0);

  for (let i = 0; i < sorted.length; i++) {
    // Larger loops come first, so any container is at a lower index.
    for (let j = i - 1; j >= 0; j--) {
      if (pointInPolygon(sorted[i][0], sorted[j])) {
        parents[i] = j;
        depths[i] = depths[j] + 1;
        break;
      }
    }
  }

  const polygons: NestedPolygon[] = [];
  const outerIndex = new Map<number, number>();

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 0) {
      outerIndex.set(i, polygons.length);
      polygons.push({ outer: ensureWinding(sorted[i], true), holes: [] });
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (depths[i] % 2 === 0) continue;
    const target = outerIndex.get(parents[i]);
    if (target === undefined) continue;
    polygons[target].holes.push(ensureWinding(sorted[i], false));
  }

  return polygons;
}

/** Point count ignoring a repeated closing vertex. */
function closedCount(loop: number[][]): number {
  const n = loop.length;
  if (n < 2) return n;
  const first = loop[0];
  const last = loop[n - 1];
  return first[0] === last[0] && first[1] === last[1] ? n - 1 : n;
}
