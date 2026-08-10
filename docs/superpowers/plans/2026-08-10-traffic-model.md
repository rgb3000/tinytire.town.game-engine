# Traffic Model Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the car traffic simulation with a pure, continuous car-following model in which a car's position is a single arc distance along one route curve, so overlap, position jumps, deadlock and stalls become structurally impossible rather than tuned against.

**Architecture:** A new pure module `src/traffic/` — no `three`, no `Grid`, no DOM — exposing `step(world, dt)`. `TrafficWorld` holds routes (polyline + cumulative distance + segment metadata) and vehicles (route id, `arcDistance`, `speed`). A seam, `src/systems/car/TrafficAdapter.ts`, compiles `Pathfinder` output plus `Grid` state into routes, runs the core, and copies positions back onto `Car` for renderers. Following uses the Intelligent Driver Model; junction right-of-way uses geometric chord intersection with greedy admission over a total order.

**Tech Stack:** TypeScript (no build step — package ships raw TS), Vitest (Node environment, no DOM), oxlint, `erasableSyntaxOnly` (no real `enum`s — use `as const` objects).

**Spec:** `docs/superpowers/specs/2026-08-10-traffic-model-design.md`

## Global Constraints

- **No `enum`.** `erasableSyntaxOnly` is on. Use `as const` objects with a matching type alias, as `CellType` and `Direction` do in `src/types.ts`.
- **Nothing under `src/traffic/` may import** `three`, `src/core/Grid`, any `src/rendering/**`, or any DOM global. Task 8 adds a test that enforces this.
- **No `Math.random()`, `Date.now()`, or `new Date()` anywhere under `src/traffic/`.** Determinism is a tested property. Use `mulberry32` from `src/utils/rng.ts` in tests.
- **Map-overridable constants must never be imported as module constants.** `src/constants.test.ts` enforces this statically, including through re-exports. `CAR_SPEED` and `HIGHWAY_SPEED_MULTIPLIER` are keys of `GameConstants` — they must arrive via the resolved config (`CarTuning`), never via `import { CAR_SPEED }`. All new IDM parameters are plain module constants and must NOT be added to `GameConstants`.
- **`src/index.ts` must not change.** Verify with `git diff --exit-code src/index.ts` before the final commit.
- **Units:** the traffic core works in **pixels** and **pixels/second**. `CAR_SPEED` is tiles/second; convert with `* TILE_SIZE` (40) at the adapter boundary.
- **Commands:** `npm test` (Vitest), `npm run typecheck` (`tsc --noEmit`), `npm run lint` (oxlint), `npm run dev` (demo).
- **Commit style:** Conventional Commits, as in `git log` (`feat(traffic): …`, `fix(input): …`, `refactor: …`).

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/traffic/types.ts` | `TrafficWorld`, `Vehicle`, `Route`, `RouteSegment`, `RouteInput`, `TrafficEvent`. Data only. |
| `src/traffic/route.ts` | Build a route from spans; sample position/angle/elevation/speed-limit at an arc. |
| `src/traffic/routeQueries.ts` | `routeCoversCell`, `cellsBetween`, `splitAt`. |
| `src/traffic/headway.ts` | `idmAcceleration` — the one deceleration function. |
| `src/traffic/lanes.ts` | Lane keys, `LaneIndex`, leader search along a route. |
| `src/traffic/junction.ts` | Maneuver chords, conflict test, greedy admission. |
| `src/traffic/obstacles.ts` | Collapse every constraint into one virtual leader. |
| `src/traffic/step.ts` | Two-pass stepper; emits events. |
| `src/traffic/tuning.ts` | IDM parameters and scan limits (module constants). |
| `src/traffic/index.ts` | Internal barrel. Not re-exported from `src/index.ts`. |
| `src/systems/car/TrafficAdapter.ts` | The only code that knows both `Grid`/`Car` and `TrafficWorld`. |

**Deleted:** `src/systems/car/CarMovement.ts`, `CarTrafficManager.ts`, `CarLeaderIndex.ts`, `IntersectionConflicts.ts`.

**Modified:** `src/entities/Car.ts`, `src/systems/CarSystem.ts`, `src/systems/car/CarRouter.ts`, `src/systems/car/CarParkingManager.ts`, `src/core/Game.ts`, `src/rendering/layers/CarRouteLayer.ts`, `src/rendering/layers/RoadDebugLayer.ts`, `src/constants.ts`, `CLAUDE.md`.

---

### Task 1: Route types, construction and sampling

**Files:**
- Create: `src/traffic/types.ts`
- Create: `src/traffic/route.ts`
- Test: `src/traffic/route.test.ts`

**Interfaces:**
- Consumes: `computeSmoothLanePath`, `sampleAtDistance` from `src/utils/roadGeometry.ts`; `computeHighwayElevation` from `src/highways/highwayGeometry.ts`; `GridPos`, `PixelPos` from `src/types.ts`.
- Produces: `buildRoute(input: RouteInput): Route | null`, `sampleRoute(route, arc): RouteSample`, `speedLimitAt(route, arc): number`, and the types in `types.ts`.

Background: `computeSmoothLanePath(path: GridPos[])` returns `{ points, cumDist, cellDist, totalDist }` where `cellDist[i]` is the arc distance of grid cell `i`. That is already exactly a route's spine, so this task assembles rather than reimplements.

- [ ] **Step 1: Write the failing test**

Create `src/traffic/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoute, sampleRoute, speedLimitAt } from './route';
import { SegmentKind } from './types';
import type { RouteInput } from './types';
import { TILE_SIZE } from '../constants';

/** A straight run of road cells along y = 0, from gx=0 to gx=n-1. */
function straightRoad(n: number, speed = 40): RouteInput {
  return {
    id: 'r1',
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: SegmentKind.Road,
        speedLimit: speed,
        pendingDeletion: false,
      })),
    }],
  };
}

describe('buildRoute', () => {
  it('returns null for a span with fewer than two cells', () => {
    expect(buildRoute(straightRoad(1))).toBeNull();
  });

  it('records one cell entry per input cell, in order', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(route.cells).toEqual([
      { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 },
    ]);
    expect(route.cellDist).toHaveLength(4);
  });

  it('spans three tiles of arc length across four cell centres', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(route.length).toBeCloseTo(3 * TILE_SIZE, 5);
  });

  it('gives strictly increasing cell distances', () => {
    const route = buildRoute(straightRoad(6))!;
    for (let i = 1; i < route.cellDist.length; i++) {
      expect(route.cellDist[i]).toBeGreaterThan(route.cellDist[i - 1]);
    }
  });
});

describe('sampleRoute', () => {
  it('samples the start at arc 0 and the end at arc length', () => {
    const route = buildRoute(straightRoad(4))!;
    const start = sampleRoute(route, 0);
    const end = sampleRoute(route, route.length);
    expect(start.x).toBeCloseTo(route.points[0].x, 5);
    expect(end.x).toBeCloseTo(route.points[route.points.length - 1].x, 5);
  });

  it('clamps beyond either end rather than extrapolating', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, -100).x).toBeCloseTo(sampleRoute(route, 0).x, 5);
    expect(sampleRoute(route, route.length + 100).x)
      .toBeCloseTo(sampleRoute(route, route.length).x, 5);
  });

  it('faces along +x on an eastbound straight', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, TILE_SIZE).angle).toBeCloseTo(0, 5);
  });

  it('reports zero elevation on plain road', () => {
    const route = buildRoute(straightRoad(4))!;
    expect(sampleRoute(route, TILE_SIZE).elevationY).toBe(0);
  });
});

describe('speedLimitAt', () => {
  it('returns the limit of the segment containing the arc', () => {
    const input = straightRoad(4);
    // Make the third cell an intersection with a lower limit.
    if (input.spans[0].kind === 'grid') {
      input.spans[0].cells[2].kind = SegmentKind.Intersection;
      input.spans[0].cells[2].speedLimit = 28;
    }
    const route = buildRoute(input)!;
    expect(speedLimitAt(route, route.cellDist[2])).toBe(28);
    expect(speedLimitAt(route, route.cellDist[0])).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Write `src/traffic/types.ts`**

```ts
import type { GridPos, PixelPos } from '../types';

/**
 * What a stretch of a route is made of. Affects only the speed limit and, for
 * `Highway`, whether an elevation profile applies. Position is always arc distance.
 */
export const SegmentKind = {
  Road: 0,
  Intersection: 1,
  Connector: 2,
  Highway: 3,
} as const;
export type SegmentKind = (typeof SegmentKind)[keyof typeof SegmentKind];

/** One grid cell as handed to the route builder by the adapter. */
export interface RouteCellInput {
  pos: GridPos;
  kind: SegmentKind;
  /** Pixels per second. Already resolved from the map config by the adapter. */
  speedLimit: number;
  pendingDeletion: boolean;
}

export type RouteSpan =
  | { kind: 'grid'; cells: RouteCellInput[] }
  | { kind: 'highway'; polyline: PixelPos[]; speedLimit: number };

export interface RouteInput {
  id: string;
  spans: RouteSpan[];
}

export interface RouteSegment {
  kind: SegmentKind;
  startArc: number;
  endArc: number;
  speedLimit: number;
  pendingDeletion: boolean;
}

export interface Route {
  id: string;
  points: PixelPos[];
  cumDist: number[];
  /** Grid cells traversed, in order. Highway spans contribute none. */
  cells: GridPos[];
  /** Arc distance of each entry in `cells`. Strictly increasing. */
  cellDist: number[];
  /**
   * Speed/kind metadata. **Not index-aligned with `cells`**: a highway span contributes
   * one segment and no cells, and adjacent grid spans share a joint cell that keeps a
   * half-segment from each side. Always look a segment up by arc (`segmentAt`), never by
   * cell index.
   */
  segments: RouteSegment[];
  length: number;
}

export interface RouteSample {
  x: number;
  y: number;
  angle: number;
  elevationY: number;
}

export const VehicleMode = {
  Driving: 0,
  /** Physically present and blocking, but not advancing. */
  Parked: 1,
} as const;
export type VehicleMode = (typeof VehicleMode)[keyof typeof VehicleMode];

export interface Vehicle {
  id: string;
  routeId: string;
  /** Position along the route, in pixels. The single source of truth. */
  arcDistance: number;
  /** Pixels per second. */
  speed: number;
  mode: VehicleMode;
  /** Set by the stepper each tick; diagnostic only. */
  lastAcceleration: number;
  /**
   * World time at which this vehicle began waiting at its current junction, or 0 if it is
   * not waiting. Feeds the arrival-time key in junction admission.
   */
  arrivalTime: number;
  /**
   * Arc distance covered in the most recent `step`, in pixels.
   *
   * Written every tick and read by the adapter to deduct fuel. Carried on the vehicle
   * rather than emitted as a per-tick event so that a 200-car world does not allocate 200
   * event objects every frame — events are reserved for things that actually happen.
   */
  distanceThisTick: number;
}

export interface TrafficWorld {
  routes: Map<string, Route>;
  vehicles: Vehicle[];
  /** Seconds since the world was created. Advanced by `step`. */
  time: number;
}

/**
 * Events report things that *happened*, not per-tick state. Continuous quantities like
 * distance travelled live on the vehicle, so a busy frame allocates nothing.
 */
export const TrafficEventKind = {
  Arrived: 0,
} as const;
export type TrafficEventKind = (typeof TrafficEventKind)[keyof typeof TrafficEventKind];

export interface TrafficEvent {
  kind: TrafficEventKind;
  vehicleId: string;
}

export function createWorld(): TrafficWorld {
  return { routes: new Map(), vehicles: [], time: 0 };
}
```

- [ ] **Step 4: Write `src/traffic/route.ts`**

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/traffic/route.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/traffic/types.ts src/traffic/route.ts src/traffic/route.test.ts
git commit -m "feat(traffic): add route construction and arc-length sampling"
```

---

### Task 2: Route queries — cell coverage and split-at-arc

**Files:**
- Create: `src/traffic/routeQueries.ts`
- Test: `src/traffic/routeQueries.test.ts`

**Interfaces:**
- Consumes: `Route` from `./types`.
- Produces: `routeCoversCell(route, gx, gy, fromArc, toArc): boolean`, `cellsBetween(route, fromArc, toArc): GridPos[]`, `splitAt(route, arc): { travelled: PixelPos[]; remaining: PixelPos[] }`.

These replace behaviour currently hand-rolled in two places: three loops in `Game.tryRemoveRoad` (`src/core/Game.ts:602-627`) and the dual smooth/grid drawing paths in `CarRouteLayer`.

- [ ] **Step 1: Write the failing test**

Create `src/traffic/routeQueries.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { routeCoversCell, cellsBetween, splitAt } from './routeQueries';
import { SegmentKind } from './types';
import type { RouteInput } from './types';

function straight(n: number): RouteInput {
  return {
    id: 'r1',
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: SegmentKind.Road,
        speedLimit: 40,
        pendingDeletion: false,
      })),
    }],
  };
}

describe('cellsBetween', () => {
  it('returns every cell for the full arc range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, 0, route.length)).toHaveLength(5);
  });

  it('returns only cells at or before the arc for a travelled range', () => {
    const route = buildRoute(straight(5))!;
    const cut = route.cellDist[2];
    expect(cellsBetween(route, 0, cut).map(c => c.gx)).toEqual([0, 1, 2]);
  });

  it('returns only cells at or after the arc for a remaining range', () => {
    const route = buildRoute(straight(5))!;
    const cut = route.cellDist[2];
    expect(cellsBetween(route, cut, route.length).map(c => c.gx)).toEqual([2, 3, 4]);
  });

  it('returns nothing for an inverted range', () => {
    const route = buildRoute(straight(5))!;
    expect(cellsBetween(route, route.length, 0)).toEqual([]);
  });
});

describe('routeCoversCell', () => {
  it('finds a cell inside the range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 1, 0, 0, route.length)).toBe(true);
  });

  it('rejects a cell outside the range', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 4, 0, 0, route.cellDist[2])).toBe(false);
  });

  it('rejects a cell the route never visits', () => {
    const route = buildRoute(straight(5))!;
    expect(routeCoversCell(route, 9, 9, 0, route.length)).toBe(false);
  });
});

describe('splitAt', () => {
  it('puts the whole route in remaining at arc 0', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, 0);
    // travelled is [points[0], cut] where cut === points[0]: a degenerate zero-length
    // stub. Drawing it is harmless; the invariant that matters is that `remaining`
    // carries the entire route.
    expect(travelled).toHaveLength(2);
    expect(remaining).toHaveLength(route.points.length);
  });

  it('puts the whole route in travelled at the far end', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, route.length);
    expect(travelled).toHaveLength(route.points.length);
    // Mirror of the arc-0 case: `remaining` is a degenerate two-point stub, both points
    // pinned to the route's final position. `hi` is capped at the last index, so t === 1
    // and the cut coincides with points[hi]. Consumers must tolerate a zero-length half
    // at EITHER end, not only at arc 0.
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toEqual(remaining[1]);
    expect(remaining[0]).toEqual(route.points[route.points.length - 1]);
  });

  it('shares the split point between both halves', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, route.length / 2);
    expect(travelled[travelled.length - 1]).toEqual(remaining[0]);
  });

  it('loses no length across the split', () => {
    const route = buildRoute(straight(4))!;
    const { travelled, remaining } = splitAt(route, route.length / 3);
    const len = (pts: { x: number; y: number }[]) => {
      let t = 0;
      for (let i = 1; i < pts.length; i++) {
        t += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      return t;
    };
    expect(len(travelled) + len(remaining)).toBeCloseTo(route.length, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/routeQueries.test.ts`
Expected: FAIL — `Failed to resolve import "./routeQueries"`.

- [ ] **Step 3: Write `src/traffic/routeQueries.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/traffic/routeQueries.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/traffic/routeQueries.ts src/traffic/routeQueries.test.ts
git commit -m "feat(traffic): add route cell-coverage and split-at-arc queries"
```

---

### Task 3: The headway model

**Files:**
- Create: `src/traffic/tuning.ts`
- Create: `src/traffic/headway.ts`
- Test: `src/traffic/headway.test.ts`

**Interfaces:**
- Produces: `idmAcceleration(v, v0, gap, leaderSpeed, p): number`, `IdmParams`, `DEFAULT_IDM`, `LEADER_SCAN_EDGES`, `SIMULTANEOUS_EPS`.

This is the single deceleration path in the system. It replaces `followingSpeedMultiplier` (a step function that snapped to zero) and the separate intersection decel ramp, which could disagree with it.

- [ ] **Step 1: Write the failing test**

Create `src/traffic/headway.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { idmAcceleration } from './headway';
import { DEFAULT_IDM } from './tuning';

const P = DEFAULT_IDM;

describe('idmAcceleration', () => {
  it('accelerates from rest on an empty road', () => {
    expect(idmAcceleration(0, 40, Infinity, 0, P)).toBeCloseTo(P.a, 5);
  });

  it('stops accelerating at the speed limit on an empty road', () => {
    expect(idmAcceleration(40, 40, Infinity, 0, P)).toBeCloseTo(0, 5);
  });

  it('brakes when closing on a stopped leader', () => {
    expect(idmAcceleration(40, 40, 30, 0, P)).toBeLessThan(0);
  });

  it('brakes harder the smaller the gap', () => {
    const far = idmAcceleration(40, 40, 60, 0, P);
    const near = idmAcceleration(40, 40, 20, 0, P);
    expect(near).toBeLessThan(far);
  });

  it('is non-decreasing in gap', () => {
    let prev = -Infinity;
    for (let gap = 5; gap <= 200; gap += 5) {
      const acc = idmAcceleration(30, 40, gap, 0, P);
      expect(acc).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = acc;
    }
  });

  it('barely brakes for a leader holding station at a comfortable gap', () => {
    // At v === v0 the free-road term is exactly zero while the interaction term never is,
    // so standard IDM always eases off slightly for any finite gap: here s* = 38,
    // (38/200)^2 = 0.0361, acc = -1.444. Asserting >= 0 would require a
    // "leader no faster than me" guard, which is a deviation from IDM, not a fix.
    const acc = idmAcceleration(40, 40, 200, 40, P);
    expect(acc).toBeLessThan(0);
    expect(Math.abs(acc)).toBeLessThan(P.b * 0.05);
  });

  it('accelerates toward a leader holding station when below the speed limit', () => {
    expect(idmAcceleration(20, 40, 200, 40, P)).toBeGreaterThan(0);
  });

  it('holds station at rest behind a stopped leader at the minimum gap', () => {
    expect(idmAcceleration(0, 40, P.s0, 0, P)).toBeCloseTo(0, 5);
  });

  it('never returns NaN, even at zero gap', () => {
    expect(Number.isNaN(idmAcceleration(40, 40, 0, 0, P))).toBe(false);
    expect(Number.isNaN(idmAcceleration(0, 0, 0, 0, P))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/headway.test.ts`
Expected: FAIL — `Failed to resolve import "./headway"`.

- [ ] **Step 3: Write `src/traffic/tuning.ts`**

```ts
import { TILE_SIZE } from '../constants';
import type { IdmParams } from './headway';

/**
 * Intelligent Driver Model parameters, in pixels and seconds.
 *
 * Deliberately module constants and **not** keys of `GameConstants`: a map may set
 * `CAR_SPEED`, but the feel of following distance is engine-wide. Adding any of these to
 * `GameConstants` would require a wire-schema change and would trip `constants.test.ts`
 * if they were then imported directly, as they are here.
 *
 * Starting values only. These want a tuning pass in the demo — the tests prove the model
 * is correct, not that it feels right at one tile per second.
 */
export const DEFAULT_IDM: IdmParams = {
  s0: TILE_SIZE * 0.35,   // 14px — standstill gap, a little over one car length (12px)
  T: 0.6,                 // desired time headway, seconds
  a: TILE_SIZE * 1.0,     // 40px/s² — reaches one tile/sec in about a second
  b: TILE_SIZE * 1.5,     // 60px/s² — comfortable braking
  delta: 4,
};

/** Hard ceiling on braking, used to clamp the integrator. Emergency, not comfort. */
export const MAX_DECELERATION = TILE_SIZE * 4;

/** How many route edges ahead the leader search scans. Beyond this, gaps are irrelevant. */
export const LEADER_SCAN_EDGES = 3;

/** Arrival times within this many seconds count as simultaneous for rechts vor links. */
export const SIMULTANEOUS_EPS = 0.05;

/** A car is "stopped" for exit-clearance purposes below this speed. */
export const STOPPED_SPEED = TILE_SIZE * 0.05;
```

- [ ] **Step 4: Write `src/traffic/headway.ts`**

```ts
export interface IdmParams {
  /** Standstill gap, px. */
  s0: number;
  /** Desired time headway, seconds. */
  T: number;
  /** Maximum acceleration, px/s². */
  a: number;
  /** Comfortable deceleration, px/s². */
  b: number;
  /** Free-road acceleration exponent. */
  delta: number;
}

/**
 * The Intelligent Driver Model: acceleration from own speed, desired speed, gap to the
 * obstacle ahead, and that obstacle's speed.
 *
 * Every constraint in the simulation reaches this function as a gap and a leader speed —
 * a real car ahead, a junction stop line, a parked car, the destination. There is exactly
 * one place where a car decides to slow down, which is what stops two mechanisms
 * disagreeing the way `followingSpeedMultiplier` and the intersection ramp used to.
 *
 * Unlike the multiplier it replaces, this eases to a stop rather than snapping to zero,
 * and bounded acceleration means a car cannot cross a gap within a single tick.
 */
export function idmAcceleration(
  v: number,
  v0: number,
  gap: number,
  leaderSpeed: number,
  p: IdmParams,
): number {
  const desired = Math.max(v0, 1e-6);
  const freeRoad = 1 - Math.pow(v / desired, p.delta);

  if (!Number.isFinite(gap)) return p.a * freeRoad;

  const closingSpeed = v - leaderSpeed;
  const dynamic = v * p.T + (v * closingSpeed) / (2 * Math.sqrt(p.a * p.b));
  const sStar = p.s0 + Math.max(0, dynamic);

  // Guard the division: a zero gap must brake hard, not produce Infinity or NaN.
  const s = Math.max(gap, 1e-3);
  const interaction = (sStar / s) * (sStar / s);

  return p.a * (freeRoad - interaction);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/traffic/headway.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/traffic/tuning.ts src/traffic/headway.ts src/traffic/headway.test.ts
git commit -m "feat(traffic): add the intelligent driver model as the single headway path"
```

---

### Task 4: Lane index and leader search

**Files:**
- Create: `src/traffic/lanes.ts`
- Test: `src/traffic/lanes.test.ts`

**Interfaces:**
- Consumes: `Route`, `Vehicle`, `TrafficWorld` from `./types`; `getDirection` from `src/utils/direction.ts`.
- Produces: `laneKey(gx, gy, dir): number`, `edgeIndexAt(route, arc): number`, `LaneIndex` with `rebuild(world)` and `findLeader(world, vehicle): { id: string; gap: number; speed: number } | null`.

**Why lane keys are directed edges, and what they deliberately do not cover:** a lane is one directed edge between adjacent cells, keyed by its *start cell and direction* — not by the observer's heading, which is what made merging traffic mutually invisible in `CarLeaderIndex`. Two cars converging on a cell from different approaches still occupy different edges and cannot see each other here. That is correct and intentional: a merge requires three or more connections, so the cell is always `_isIntersection`, and Task 5's admission serialises them. **The lane model and the junction model only cover the space together — do not remove the junction check on the grounds that following "already handles it".**

- [ ] **Step 1: Write the failing test**

Create `src/traffic/lanes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { laneKey, edgeIndexAt, LaneIndex } from './lanes';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { Direction } from '../types';
import { TILE_SIZE } from '../constants';

function straight(id: string, n: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: SegmentKind.Road,
        speedLimit: 40,
        pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(id: string, routeId: string, arc: number, speed = 0, mode = VehicleMode.Driving): Vehicle {
  return { id, routeId, arcDistance: arc, speed, mode, lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0 };
}

function worldWith(...vehicles: Vehicle[]): TrafficWorld {
  const world = createWorld();
  const route = buildRoute(straight('r1', 8))!;
  world.routes.set('r1', route);
  world.vehicles.push(...vehicles);
  return world;
}

describe('laneKey', () => {
  it('distinguishes the two directions of the same edge', () => {
    expect(laneKey(3, 4, Direction.Right)).not.toBe(laneKey(3, 4, Direction.Left));
  });

  it('distinguishes different cells in the same direction', () => {
    expect(laneKey(3, 4, Direction.Right)).not.toBe(laneKey(4, 4, Direction.Right));
  });

  it('is stable for the same inputs', () => {
    expect(laneKey(7, 2, Direction.Up)).toBe(laneKey(7, 2, Direction.Up));
  });
});

describe('edgeIndexAt', () => {
  it('reports edge 0 at the route start', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, 0)).toBe(0);
  });

  it('advances an edge per tile travelled', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, TILE_SIZE * 1.5)).toBe(1);
  });

  it('clamps to the last edge past the end', () => {
    const route = buildRoute(straight('r1', 5))!;
    expect(edgeIndexAt(route, route.length + 100)).toBe(3);
  });
});

describe('LaneIndex.findLeader', () => {
  it('finds a car ahead on the same edge and measures the gap along the route', () => {
    const me = vehicle('a', 'r1', 0);
    const ahead = vehicle('b', 'r1', 25);
    const world = worldWith(me, ahead);
    const index = new LaneIndex();
    index.rebuild(world);

    const leader = index.findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.gap).toBeCloseTo(25, 1);
  });

  it('ignores a car behind', () => {
    const me = vehicle('a', 'r1', 40);
    const behind = vehicle('b', 'r1', 10);
    const world = worldWith(me, behind);
    const index = new LaneIndex();
    index.rebuild(world);

    expect(index.findLeader(world, me)).toBeNull();
  });

  it('picks the nearest of several cars ahead', () => {
    const me = vehicle('a', 'r1', 0);
    const near = vehicle('b', 'r1', 30);
    const far = vehicle('c', 'r1', 70);
    const world = worldWith(me, far, near);
    const index = new LaneIndex();
    index.rebuild(world);

    expect(index.findLeader(world, me)?.id).toBe('b');
  });

  it('sees a parked car as an obstacle', () => {
    // The bug this fixes: CarLeaderIndex skipped Unloading and Refueling cars while they
    // still sat on the road, so followers drove onto them.
    const me = vehicle('a', 'r1', 0);
    const parked = vehicle('b', 'r1', 35, 0, VehicleMode.Parked);
    const world = worldWith(me, parked);
    const index = new LaneIndex();
    index.rebuild(world);

    const leader = index.findLeader(world, me);
    expect(leader?.id).toBe('b');
    expect(leader?.speed).toBe(0);
  });

  it('finds a car one edge further along the route', () => {
    const me = vehicle('a', 'r1', 5);
    const ahead = vehicle('b', 'r1', TILE_SIZE + 10);
    const world = worldWith(me, ahead);
    const index = new LaneIndex();
    index.rebuild(world);

    expect(index.findLeader(world, me)?.id).toBe('b');
  });

  it('reports the leader speed so the follower can match it', () => {
    const me = vehicle('a', 'r1', 0, 40);
    const ahead = vehicle('b', 'r1', 50, 22);
    const world = worldWith(me, ahead);
    const index = new LaneIndex();
    index.rebuild(world);

    expect(index.findLeader(world, me)?.speed).toBeCloseTo(22, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/lanes.test.ts`
Expected: FAIL — `Failed to resolve import "./lanes"`.

- [ ] **Step 3: Write `src/traffic/lanes.ts`**

```ts
import { Direction } from '../types';
import { getDirection } from '../utils/direction';
import { CAR_LENGTH } from '../constants';
import { LEADER_SCAN_EDGES } from './tuning';
import type { Route, TrafficWorld, Vehicle } from './types';

/** Direction bitmask (1,2,4,…,128) to a dense 0-7 index, for packing into a lane key. */
const DIR_INDEX: Record<number, number> = {
  [Direction.Up]: 0, [Direction.Down]: 1, [Direction.Left]: 2, [Direction.Right]: 3,
  [Direction.UpLeft]: 4, [Direction.UpRight]: 5, [Direction.DownLeft]: 6, [Direction.DownRight]: 7,
};

/**
 * A lane is one directed edge between adjacent cells, keyed by its start cell and the
 * direction of travel.
 *
 * The key deliberately does not involve the *observer's* heading, which is what
 * `CarLeaderIndex` did — it bucketed by `directionToLane(dir)` computed from whoever was
 * looking, so a car that entered a tile from a different approach landed in a different
 * bucket and was invisible. Keying on the edge itself makes every car on that ground
 * visible to every other car on it.
 */
export function laneKey(gx: number, gy: number, dir: Direction): number {
  return gx | (gy << 8) | (DIR_INDEX[dir] << 16);
}

/**
 * Which edge of the route the arc distance falls on: the edge from `cells[i]` to
 * `cells[i+1]`. Clamped to the last edge.
 */
export function edgeIndexAt(route: Route, arc: number): number {
  const lastEdge = Math.max(0, route.cells.length - 2);
  if (route.cells.length < 2) return 0;
  for (let i = 0; i < route.cells.length - 1; i++) {
    if (arc < route.cellDist[i + 1]) return i;
  }
  return lastEdge;
}

function laneKeyForEdge(route: Route, edgeIndex: number): number | null {
  if (edgeIndex < 0 || edgeIndex + 1 >= route.cells.length) return null;
  const from = route.cells[edgeIndex];
  const to = route.cells[edgeIndex + 1];
  return laneKey(from.gx, from.gy, getDirection(from, to));
}

interface LaneOccupant {
  vehicleId: string;
  /** Distance from the start cell of this edge, in px. Comparable across routes. */
  offset: number;
  speed: number;
}

export interface LeaderInfo {
  id: string;
  /**
   * **Net** gap: clear distance along the follower's own route to the leader's rear
   * bumper, in pixels. One car length is already subtracted here, so no consumer has to
   * remember to do it — which is the whole point. The no-overlap invariant is therefore
   * `gap >= 0`, a statement that cannot be mis-set, rather than `gap >= CAR_LENGTH`,
   * which every consumer would have to reproduce correctly and independently.
   *
   * This is also the convention the Intelligent Driver Model is defined on: Treiber's
   * `s0` is the jam distance between bumpers, so `DEFAULT_IDM.s0` means what the
   * literature says it means.
   *
   * May be negative if two cars ever overlap; `idmAcceleration`'s floor turns that into
   * hard braking rather than a division blow-up.
   */
  gap: number;
  speed: number;
}

/**
 * Which vehicles occupy which lane, rebuilt each tick.
 *
 * Offsets are measured from the shared start cell of the edge, so two vehicles on
 * different routes through the same edge are directly comparable. Their smoothed
 * geometry differs slightly where the surrounding cells differ, so the offset carries a
 * few pixels of error; the standstill gap `s0` is an order of magnitude larger, and the
 * stepper's hard clamp catches anything pathological.
 */
export class LaneIndex {
  private byLane = new Map<number, LaneOccupant[]>();
  private pool: LaneOccupant[][] = [];

  rebuild(world: TrafficWorld): void {
    for (const list of this.byLane.values()) {
      list.length = 0;
      this.pool.push(list);
    }
    this.byLane.clear();

    for (const v of world.vehicles) {
      const route = world.routes.get(v.routeId);
      if (!route || route.cells.length < 2) continue;

      const edge = edgeIndexAt(route, v.arcDistance);
      const key = laneKeyForEdge(route, edge);
      if (key === null) continue;

      let list = this.byLane.get(key);
      if (!list) {
        list = this.pool.pop() ?? [];
        this.byLane.set(key, list);
      }
      list.push({
        vehicleId: v.id,
        offset: v.arcDistance - route.cellDist[edge],
        speed: v.speed,
      });
    }
  }

  /**
   * The nearest vehicle ahead of `vehicle` along its own route, or null.
   *
   * Scans forward edge by edge and stops at the first edge that yields a candidate, so the
   * result is the nearest by route distance rather than by straight-line distance. The old
   * index measured Euclidean pixels (`CarLeaderIndex.ts:90`), which understated the
   * urgency of a leader around a corner and so under-applied braking exactly where the
   * geometry was tightest.
   */
  findLeader(world: TrafficWorld, vehicle: Vehicle): LeaderInfo | null {
    const route = world.routes.get(vehicle.routeId);
    if (!route || route.cells.length < 2) return null;

    const startEdge = edgeIndexAt(route, vehicle.arcDistance);

    for (let n = 0; n < LEADER_SCAN_EDGES; n++) {
      const edge = startEdge + n;
      const key = laneKeyForEdge(route, edge);
      if (key === null) break;

      const occupants = this.byLane.get(key);
      if (!occupants) continue;

      const edgeStart = route.cellDist[edge];
      let best: LeaderInfo | null = null;

      for (const o of occupants) {
        if (o.vehicleId === vehicle.id) continue;
        const theirArc = edgeStart + o.offset;
        // "Ahead" is decided by arc order; the gap reported is NET — clear distance to
        // the leader's rear bumper. It may go negative if geometry ever lets two cars
        // overlap, and the headway model's floor turns that into hard braking. Deciding
        // ahead-ness on the raw difference keeps an overlapping leader visible instead
        // of silently dropping the one car that most needs braking for.
        const rawAhead = theirArc - vehicle.arcDistance;
        if (rawAhead <= 0) continue;
        const gap = rawAhead - CAR_LENGTH;
        if (best === null || gap < best.gap) {
          best = { id: o.vehicleId, gap, speed: o.speed };
        }
      }

      if (best !== null) return best;
    }

    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/traffic/lanes.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/traffic/lanes.ts src/traffic/lanes.test.ts
git commit -m "feat(traffic): key lanes by directed edge so merging traffic is mutually visible"
```

---

### Task 5: Junction conflict geometry and admission

**Files:**
- Create: `src/traffic/junction.ts`
- Test: `src/traffic/junction.test.ts`

**Interfaces:**
- Consumes: `Direction`, `YIELD_TO_DIRECTION`, `DIRECTION_OFFSETS` from `src/utils/direction.ts` and `src/types.ts`.
- Produces: `maneuverChord(entry, exit): Chord`, `maneuversConflict(aEntry, aExit, bEntry, bExit): boolean`, `admit(candidates: JunctionCandidate[]): Set<string>`, `JunctionCandidate`.

**Design notes the implementer needs:**

`entry` is the direction of *travel into* the junction (as `getDirection(prevCell, junctionCell)` produces), and `exit` is the direction of travel out. A maneuver is modelled as a straight chord across the cell from its entry point to its exit point, both offset to the driver's right. Two maneuvers conflict if they share an exit (a merge) or their chords intersect. This handles diagonals for free and needs no left/right/straight classification — the spec dropped "straight beats turning", so no maneuver-class priority exists anywhere.

Admission is greedy over a **total order**, which is what makes deadlock impossible. Ranking a candidate by *how many simultaneous conflicting candidates are on its right* turns the pairwise, cyclic *rechts vor links* relation into a number. In the two-car case it reproduces the rule exactly; in the four-way cyclic case every rank is 1, the vehicle id breaks the tie, one car is admitted, and the cycle is gone. There is no timeout, and `INTERSECTION_DEADLOCK_TIMEOUT` is deleted in Task 14.

- [ ] **Step 1: Write the failing test**

Create `src/traffic/junction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { maneuversConflict, admit } from './junction';
import type { JunctionCandidate } from './junction';
import { Direction } from '../types';

function candidate(
  id: string, entry: Direction, exit: Direction,
  over: Partial<JunctionCandidate> = {},
): JunctionCandidate {
  return {
    vehicleId: id, entry, exit,
    inside: false, arrivalTime: 0, exitHasRoom: true,
    ...over,
  };
}

describe('maneuversConflict', () => {
  it('does not conflict with itself coming from the same approach', () => {
    // Two cars nose to tail from the same direction are a following problem, not a
    // junction problem.
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Right, Direction.Up))
      .toBe(false);
  });

  it('conflicts when two maneuvers merge into the same exit', () => {
    expect(maneuversConflict(Direction.Right, Direction.Up, Direction.Down, Direction.Up))
      .toBe(true);
  });

  it('conflicts for two perpendicular straights', () => {
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Down, Direction.Down))
      .toBe(true);
  });

  it('does not conflict for two opposing straights', () => {
    expect(maneuversConflict(Direction.Right, Direction.Right, Direction.Left, Direction.Left))
      .toBe(false);
  });

  it('does not conflict for two right turns from perpendicular approaches', () => {
    // Travelling right, turning right exits Down. Travelling down, turning right exits Left.
    expect(maneuversConflict(Direction.Right, Direction.Down, Direction.Down, Direction.Left))
      .toBe(false);
  });
});

describe('admit', () => {
  it('admits a lone car', () => {
    expect(admit([candidate('a', Direction.Right, Direction.Right)])).toEqual(new Set(['a']));
  });

  it('admits both cars when their maneuvers do not conflict', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Left, Direction.Left),
    ]);
    expect(got).toEqual(new Set(['a', 'b']));
  });

  it('admits exactly one of two conflicting cars', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Down, Direction.Down),
    ]);
    expect(got.size).toBe(1);
  });

  it('gives way to the right when two arrive together', () => {
    // Travelling Right, the car on my right approaches travelling Up.
    // YIELD_TO_DIRECTION[Right] === Up, so 'b' has priority.
    const got = admit([
      candidate('a', Direction.Right, Direction.Right),
      candidate('b', Direction.Up, Direction.Up),
    ]);
    expect(got.has('b')).toBe(true);
    expect(got.has('a')).toBe(false);
  });

  it('lets the earlier arrival through when arrivals are clearly separated', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 5 }),
      candidate('b', Direction.Down, Direction.Down, { arrivalTime: 1 }),
    ]);
    expect(got).toEqual(new Set(['b']));
  });

  it('gives a car already inside absolute priority', () => {
    const got = admit([
      candidate('a', Direction.Right, Direction.Right, { arrivalTime: 0 }),
      candidate('b', Direction.Down, Direction.Down, { arrivalTime: 9, inside: true }),
    ]);
    expect(got.has('b')).toBe(true);
    expect(got.has('a')).toBe(false);
  });

  it('breaks a four-way cycle instead of deadlocking', () => {
    // All four arrive together, each yielding to the one on its right. The old pairwise
    // rule cycled here and only the 2s timeout broke it — releasing everyone at once.
    const got = admit([
      candidate('a', Direction.Up, Direction.Up),
      candidate('b', Direction.Right, Direction.Right),
      candidate('c', Direction.Down, Direction.Down),
      candidate('d', Direction.Left, Direction.Left),
    ]);
    expect(got.size).toBeGreaterThanOrEqual(1);
  });

  it('refuses a car whose exit has no room', () => {
    // Don't block the intersection.
    const got = admit([candidate('a', Direction.Right, Direction.Right, { exitHasRoom: false })]);
    expect(got.size).toBe(0);
  });

  it('is deterministic regardless of input order', () => {
    const a = candidate('a', Direction.Right, Direction.Right);
    const b = candidate('b', Direction.Down, Direction.Down);
    const c = candidate('c', Direction.Left, Direction.Left);
    expect(admit([a, b, c])).toEqual(admit([c, b, a]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/junction.test.ts`
Expected: FAIL — `Failed to resolve import "./junction"`.

- [ ] **Step 3: Write `src/traffic/junction.ts`**

```ts
import { Direction } from '../types';
import { DIRECTION_OFFSETS, YIELD_TO_DIRECTION } from '../utils/direction';
import { LANE_OFFSET, TILE_SIZE } from '../constants';
import { SIMULTANEOUS_EPS } from './tuning';

export interface JunctionCandidate {
  vehicleId: string;
  /** Direction of travel into the junction. */
  entry: Direction;
  /** Direction of travel out of the junction. */
  exit: Direction;
  /** Already past the entry boundary. Absolute priority. */
  inside: boolean;
  /** When this vehicle first began waiting, in world seconds. */
  arrivalTime: number;
  /** Whether the cell beyond the junction has space. Enforces don't-block-the-box. */
  exitHasRoom: boolean;
}

interface Point { x: number; y: number }
interface Chord { a: Point; b: Point }

const LANE_FRAC = LANE_OFFSET / TILE_SIZE;

/** Unit vector along a direction. Diagonals are normalised so all points sit on a circle. */
function unit(dir: Direction): Point {
  const o = DIRECTION_OFFSETS[dir];
  const len = Math.sqrt(o.gx * o.gx + o.gy * o.gy) || 1;
  return { x: o.gx / len, y: o.gy / len };
}

/** Perpendicular to the driver's right. Screen y is down, matching `computeSmoothLanePath`. */
function right(dir: Direction): Point {
  const u = unit(dir);
  return { x: -u.y, y: u.x };
}

/**
 * The straight chord a maneuver traces across the junction cell, in cell-fraction units
 * centred on the cell (so ±0.5 is the cell boundary).
 *
 * Entering on `entry` means the car comes from the `-entry` side; leaving on `exit` means
 * it departs through the `+exit` side. Both endpoints sit on the right-hand lane.
 */
export function maneuverChord(entry: Direction, exit: Direction): Chord {
  const uIn = unit(entry);
  const rIn = right(entry);
  const uOut = unit(exit);
  const rOut = right(exit);

  return {
    a: { x: -uIn.x * 0.5 + rIn.x * LANE_FRAC, y: -uIn.y * 0.5 + rIn.y * LANE_FRAC },
    b: { x: uOut.x * 0.5 + rOut.x * LANE_FRAC, y: uOut.y * 0.5 + rOut.y * LANE_FRAC },
  };
}

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Proper segment intersection. Collinear touching counts as no crossing. */
function segmentsIntersect(p: Chord, q: Chord): boolean {
  const d1 = cross(p.a.x, p.a.y, p.b.x, p.b.y, q.a.x, q.a.y);
  const d2 = cross(p.a.x, p.a.y, p.b.x, p.b.y, q.b.x, q.b.y);
  const d3 = cross(q.a.x, q.a.y, q.b.x, q.b.y, p.a.x, p.a.y);
  const d4 = cross(q.a.x, q.a.y, q.b.x, q.b.y, p.b.x, p.b.y);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Whether two maneuvers through the same junction cannot be performed at once.
 *
 * Two rules only: a shared exit is a merge, and crossing chords are a crossing. There is
 * no left/right/straight taxonomy — the design dropped "straight beats turning", and
 * chord geometry covers diagonal approaches that a cardinal-only classification could not.
 */
export function maneuversConflict(
  aEntry: Direction, aExit: Direction,
  bEntry: Direction, bExit: Direction,
): boolean {
  // Same approach: they are queued behind one another. That is the following model's job.
  if (aEntry === bEntry) return false;
  if (aExit === bExit) return true;
  return segmentsIntersect(maneuverChord(aEntry, aExit), maneuverChord(bEntry, bExit));
}

/**
 * How many simultaneous, conflicting candidates have priority over this one under
 * *rechts vor links*.
 *
 * This is the trick that makes the rule usable: the pairwise relation "A gives way to B"
 * is cyclic at a four-way, but counting how many cars each driver must give way to is a
 * plain number, and numbers sort. Two cars reproduce the rule exactly; four cars in a
 * cycle all score 1, and the id tiebreak lets exactly one through.
 */
function yieldRank(c: JunctionCandidate, all: JunctionCandidate[]): number {
  let rank = 0;
  for (const other of all) {
    if (other.vehicleId === c.vehicleId) continue;
    if (Math.abs(other.arrivalTime - c.arrivalTime) > SIMULTANEOUS_EPS) continue;
    if (!maneuversConflict(c.entry, c.exit, other.entry, other.exit)) continue;
    if (other.entry === YIELD_TO_DIRECTION[c.entry]) rank++;
  }
  return rank;
}

/**
 * Choose the set of vehicles that may proceed through a junction this tick.
 *
 * Greedy admission over a total order — inside first, then yield rank, then arrival time,
 * then vehicle id. Because we walk a fixed sequence and only ever admit, no cycle of
 * "waiting for" relations can form, so no deadlock is possible and no escape timeout is
 * needed. A candidate whose exit has no room is never admitted, which is what stops a
 * junction filling up and gridlocking a ring of blocks.
 */
export function admit(candidates: JunctionCandidate[]): Set<string> {
  const ordered = candidates.slice().sort((x, y) => {
    if (x.inside !== y.inside) return x.inside ? -1 : 1;
    const rx = yieldRank(x, candidates);
    const ry = yieldRank(y, candidates);
    if (rx !== ry) return rx - ry;
    if (x.arrivalTime !== y.arrivalTime) return x.arrivalTime - y.arrivalTime;
    return x.vehicleId < y.vehicleId ? -1 : x.vehicleId > y.vehicleId ? 1 : 0;
  });

  const admitted: JunctionCandidate[] = [];
  const result = new Set<string>();

  for (const c of ordered) {
    if (!c.inside && !c.exitHasRoom) continue;

    let blocked = false;
    for (const other of admitted) {
      if (maneuversConflict(c.entry, c.exit, other.entry, other.exit)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    admitted.push(c);
    result.add(c.vehicleId);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/traffic/junction.test.ts`
Expected: PASS — 15 tests.

If "two right turns from perpendicular approaches" fails, the chord endpoints are too close to the cell corners for the lane offset to separate them. Reduce the endpoint radius from `0.5` to `0.45` in `maneuverChord` and re-run; do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/traffic/junction.ts src/traffic/junction.test.ts
git commit -m "feat(traffic): resolve junctions by chord conflict and acyclic greedy admission"
```

---

### Task 6: Collapse every constraint into one virtual leader

**Files:**
- Create: `src/traffic/obstacles.ts`
- Test: `src/traffic/obstacles.test.ts`

**Interfaces:**
- Consumes: `LaneIndex` from `./lanes`; `Route`, `Vehicle`, `TrafficWorld` from `./types`.
- Produces: `Constraint { arc: number; speed: number }`, `nearestConstraint(world, vehicle, index, admitted: Map<number, Set<string>>): Constraint`, `junctionKey(gx, gy): number`, `junctionEntryArc(route, cellIndex): number`.

- [ ] **Step 1: Write the failing test**

Create `src/traffic/obstacles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { LaneIndex } from './lanes';
import { nearestConstraint } from './obstacles';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { CAR_LENGTH } from '../constants';

function road(id: string, kinds: SegmentKind[]): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: kinds.map((kind, i) => ({
        pos: { gx: i, gy: 0 },
        kind,
        speedLimit: 40,
        pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(id: string, arc: number, speed = 0, mode = VehicleMode.Driving): Vehicle {
  return { id, routeId: 'r1', arcDistance: arc, speed, mode, lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0 };
}

function world(input: RouteInput, ...vehicles: Vehicle[]): TrafficWorld {
  const w = createWorld();
  w.routes.set(input.id, buildRoute(input)!);
  w.vehicles.push(...vehicles);
  return w;
}

const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

describe('nearestConstraint', () => {
  it('constrains an empty road only by its end', () => {
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0));
    const index = new LaneIndex();
    index.rebuild(w);
    const c = nearestConstraint(w, w.vehicles[0], index, new Set(['a']));
    expect(c.arc).toBeCloseTo(w.routes.get('r1')!.length, 5);
    expect(c.speed).toBe(0);
  });

  it('constrains by a car ahead when one is nearer than the end', () => {
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0), vehicle('b', 30, 10));
    const index = new LaneIndex();
    index.rebuild(w);
    const c = nearestConstraint(w, w.vehicles[0], index, new Set(['a']));
    // NET gap: the leader's centre is at 30, its rear bumper one car length nearer.
    // Derived from CAR_LENGTH rather than written as 18, so a change to car size cannot
    // quietly turn this into a value pin.
    expect(c.arc).toBeCloseTo(30 - CAR_LENGTH, 1);
    expect(c.speed).toBeCloseTo(10, 5);
  });

  it('constrains by a parked car at zero speed', () => {
    const w = world(road('r1', [R, R, R, R]), vehicle('a', 0), vehicle('b', 30, 0, VehicleMode.Parked));
    const index = new LaneIndex();
    index.rebuild(w);
    expect(nearestConstraint(w, w.vehicles[0], index, new Set(['a'])).speed).toBe(0);
  });

  it('stops at the junction boundary when not admitted', () => {
    const input = road('r1', [R, R, X, R]);
    const w = world(input, vehicle('a', 0));
    const index = new LaneIndex();
    index.rebuild(w);
    const route = w.routes.get('r1')!;
    const c = nearestConstraint(w, w.vehicles[0], index, new Set());
    const boundary = (route.cellDist[1] + route.cellDist[2]) / 2;
    expect(c.arc).toBeCloseTo(boundary, 5);
    expect(c.speed).toBe(0);
  });

  it('does not stop at the junction when admitted', () => {
    const input = road('r1', [R, R, X, R]);
    const w = world(input, vehicle('a', 0));
    const index = new LaneIndex();
    index.rebuild(w);
    const route = w.routes.get('r1')!;
    const boundary = (route.cellDist[1] + route.cellDist[2]) / 2;
    expect(nearestConstraint(w, w.vehicles[0], index, new Set(['a'])).arc)
      .toBeGreaterThan(boundary);
  });

  it('keeps the nearest constraint when several apply', () => {
    const input = road('r1', [R, R, X, R]);
    const w = world(input, vehicle('a', 0), vehicle('b', 24, 0, VehicleMode.Parked));
    const index = new LaneIndex();
    index.rebuild(w);
    // Parked centre at 24, rear bumper at 24 - CAR_LENGTH = 12 — still nearer than the
    // junction boundary, so the parked car wins.
    expect(nearestConstraint(w, w.vehicles[0], index, new Set()).arc)
      .toBeCloseTo(24 - CAR_LENGTH, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/obstacles.test.ts`
Expected: FAIL — `Failed to resolve import "./obstacles"`.

- [ ] **Step 3: Write `src/traffic/obstacles.ts`**

```ts
import { SegmentKind } from './types';
import type { Route, TrafficWorld, Vehicle } from './types';
import type { LaneIndex } from './lanes';
import { segmentAt } from './route';

export interface Constraint {
  /** Arc distance on the vehicle's own route that it must not pass. */
  arc: number;
  /** Speed of whatever is at that arc. Zero for stop lines and parked cars. */
  speed: number;
}

/**
 * Where a junction cell begins, in arc distance: midway between the previous cell centre
 * and the junction's own centre. Cars stop here, not at the centre.
 */
export function junctionEntryArc(route: Route, cellIndex: number): number {
  if (cellIndex <= 0) return route.cellDist[0] ?? 0;
  return (route.cellDist[cellIndex - 1] + route.cellDist[cellIndex]) / 2;
}

/**
 * Index of the next junction cell strictly ahead of `arc`, or -1.
 *
 * Looks the segment up **by arc**, never by cell index. `segments` and `cells` are not
 * index-aligned: a highway span contributes one segment and no cells, and adjacent grid
 * spans share a joint cell that keeps a half-segment from each side. Indexing one array
 * by the other silently reads the wrong segment on any route containing a highway.
 */
function nextJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    if (route.cellDist[i] <= arc) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return i;
  }
  return -1;
}

/**
 * The single obstacle a vehicle must respect this tick.
 *
 * Every reason a car might slow down produces one of these, and only the nearest
 * survives — so the headway model is the only place a deceleration is ever computed.
 * The old code combined a following multiplier and an intersection multiplier with
 * `Math.min`, which let two independently-tuned mechanisms disagree about how hard to
 * brake, and gave the intersection ramp no way to express "match the speed of the car
 * ahead".
 */
export function nearestConstraint(
  world: TrafficWorld,
  vehicle: Vehicle,
  index: LaneIndex,
  admitted: Map<number, Set<string>>,
): Constraint {
  const route = world.routes.get(vehicle.routeId);
  if (!route) return { arc: vehicle.arcDistance, speed: 0 };

  // The destination is always a constraint: a car stops when it arrives.
  let best: Constraint = { arc: route.length, speed: 0 };

  const leader = index.findLeader(world, vehicle);
  if (leader !== null) {
    const leaderArc = vehicle.arcDistance + leader.gap;
    if (leaderArc < best.arc) best = { arc: leaderArc, speed: leader.speed };
  }

  // A junction the vehicle has not been admitted to becomes a stop line at its boundary.
  // The lookup runs unconditionally and admission is consulted **for that junction**:
  // a flat "is this vehicle admitted" test would exempt a car from every stop line
  // ahead, so a car admitted to A would sail through adjacent junction B.
  const cellIndex = nextJunctionCell(route, vehicle.arcDistance);
  if (cellIndex >= 0) {
    const cell = route.cells[cellIndex];
    const admittedHere = admitted.get(junctionKey(cell.gx, cell.gy))?.has(vehicle.id) === true;
    if (!admittedHere) {
      const stopArc = junctionEntryArc(route, cellIndex);
      if (stopArc < best.arc) best = { arc: stopArc, speed: 0 };
    }
  }

  return best;
}

/** Whether the vehicle currently sits inside a junction cell. */
export function isInsideJunction(route: Route, arc: number): boolean {
  const seg = segmentAt(route, arc);
  return seg !== null && seg.kind === SegmentKind.Intersection;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/traffic/obstacles.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/traffic/obstacles.ts src/traffic/obstacles.test.ts
git commit -m "feat(traffic): collapse every constraint into a single virtual leader"
```

---

### Task 7: The two-pass stepper

**Files:**
- Create: `src/traffic/step.ts`
- Create: `src/traffic/index.ts`
- Test: `src/traffic/step.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `step(world: TrafficWorld, dt: number): TrafficEvent[]`; `src/traffic/index.ts` re-exports the module's public names for the adapter.

The two passes are the point: pass one reads only frame-start state, pass two writes. No vehicle's outcome may depend on its index in `world.vehicles`. That is what `CarSystem` violated by mutating a shared `occupied` map mid-loop (`CarSystem.ts:91-94`).

- [ ] **Step 1: Write the failing test**

Create `src/traffic/step.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { step } from './step';
import { SegmentKind, VehicleMode, TrafficEventKind, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { DEFAULT_IDM } from './tuning';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

const DT = 1 / 60;
const R = SegmentKind.Road;

function road(id: string, n: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 }, kind: R, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(id: string, arc: number, speed = 0, mode = VehicleMode.Driving): Vehicle {
  return { id, routeId: 'r1', arcDistance: arc, speed, mode, lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0 };
}

function world(n: number, ...vehicles: Vehicle[]): TrafficWorld {
  const w = createWorld();
  w.routes.set('r1', buildRoute(road('r1', n))!);
  w.vehicles.push(...vehicles);
  return w;
}

describe('step', () => {
  it('moves a lone car forward', () => {
    const w = world(8, vehicle('a', 0));
    step(w, DT);
    expect(w.vehicles[0].arcDistance).toBeGreaterThan(0);
  });

  it('never exceeds the segment speed limit', () => {
    const w = world(20, vehicle('a', 0));
    for (let i = 0; i < 600; i++) step(w, DT);
    expect(w.vehicles[0].speed).toBeLessThanOrEqual(40 + 1e-6);
  });

  it('advances world time by dt', () => {
    const w = world(8, vehicle('a', 0));
    step(w, DT);
    expect(w.time).toBeCloseTo(DT, 9);
  });

  it('never moves a car backwards', () => {
    const w = world(20, vehicle('a', 0), vehicle('b', 60));
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      step(w, DT);
      expect(w.vehicles[0].arcDistance).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = w.vehicles[0].arcDistance;
    }
  });

  it('keeps a follower at least the standstill gap behind a parked car', () => {
    const w = world(20, vehicle('a', 0, 40), vehicle('b', 200, 0, VehicleMode.Parked));
    for (let i = 0; i < 1200; i++) {
      step(w, DT);
      const gap = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance;
      expect(gap).toBeGreaterThan(CAR_LENGTH);
    }
    // Arc difference is centre-to-centre; the NET gap the model controls is that minus
    // one car length. At rest the follower settles at s0 of clear bumper space, so the
    // centre spacing is CAR_LENGTH + s0. The 0.9 absorbs 60Hz Euler undershoot, which
    // settles a couple of percent short.
    const finalGap = w.vehicles[1].arcDistance - w.vehicles[0].arcDistance;
    expect(finalGap).toBeGreaterThanOrEqual(CAR_LENGTH + DEFAULT_IDM.s0 * 0.9);
  });

  it('does not let a car jump more than its speed allows in one tick', () => {
    const w = world(20, vehicle('a', 0));
    for (let i = 0; i < 300; i++) {
      const before = w.vehicles[0].arcDistance;
      step(w, DT);
      const moved = w.vehicles[0].arcDistance - before;
      expect(moved).toBeLessThanOrEqual(40 * DT + 1e-6);
    }
  });

  it('emits an arrival event when a car reaches the end', () => {
    const w = world(4, vehicle('a', 0, 40));
    let arrived = false;
    for (let i = 0; i < 600 && !arrived; i++) {
      arrived = step(w, DT).some(e => e.kind === TrafficEventKind.Arrived && e.vehicleId === 'a');
    }
    expect(arrived).toBe(true);
  });

  it('records distance travelled on the vehicle so the adapter can deduct fuel', () => {
    const w = world(20, vehicle('a', 0, 40));
    step(w, DT);
    expect(w.vehicles[0].distanceThisTick).toBeGreaterThan(0);
  });

  it('emits arrival once, not on every tick spent at the end', () => {
    const w = world(4, vehicle('a', 0, 40));
    let arrivals = 0;
    for (let i = 0; i < 900; i++) {
      arrivals += step(w, DT).filter(e => e.kind === TrafficEventKind.Arrived).length;
    }
    expect(arrivals).toBe(1);
  });

  it('does not advance a parked car', () => {
    const w = world(20, vehicle('a', 100, 0, VehicleMode.Parked));
    for (let i = 0; i < 60; i++) step(w, DT);
    expect(w.vehicles[0].arcDistance).toBe(100);
  });

  it('produces the same result regardless of vehicle array order', () => {
    const forward = world(20, vehicle('a', 0, 20), vehicle('b', 80, 20), vehicle('c', 160, 20));
    const reverse = world(20, vehicle('c', 160, 20), vehicle('b', 80, 20), vehicle('a', 0, 20));
    for (let i = 0; i < 240; i++) { step(forward, DT); step(reverse, DT); }

    const arcOf = (w: TrafficWorld, id: string) => w.vehicles.find(v => v.id === id)!.arcDistance;
    for (const id of ['a', 'b', 'c']) {
      expect(arcOf(forward, id)).toBeCloseTo(arcOf(reverse, id), 9);
    }
  });

  it('stops at the end of the route rather than running past it', () => {
    const w = world(4, vehicle('a', 0, 40));
    for (let i = 0; i < 1200; i++) step(w, DT);
    expect(w.vehicles[0].arcDistance).toBeLessThanOrEqual(w.routes.get('r1')!.length + 1e-6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/traffic/step.test.ts`
Expected: FAIL — `Failed to resolve import "./step"`.

- [ ] **Step 3: Write `src/traffic/step.ts`**

```ts
import { CAR_DEBUG } from '../constants';
import { getDirection } from '../utils/direction';
import { idmAcceleration } from './headway';
import { LaneIndex, edgeIndexAt } from './lanes';
import { admit } from './junction';
import type { JunctionCandidate } from './junction';
import { nearestConstraint, isInsideJunction, junctionKey } from './obstacles';
import { segmentAt, speedLimitAt } from './route';
import { DEFAULT_IDM, MAX_DECELERATION, STOPPED_SPEED } from './tuning';
import { SegmentKind, TrafficEventKind, VehicleMode } from './types';
import type { Route, TrafficEvent, TrafficWorld, Vehicle } from './types';

/**
 * The junction cell a vehicle is approaching or occupying, or -1.
 *
 * Segments are looked up by arc, not by cell index — see the note on `nextJunctionCell`
 * in `obstacles.ts`. The two arrays are not index-aligned.
 */
/** The junction cell the vehicle is physically inside, or -1. */
function insideJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg === null || seg.kind !== SegmentKind.Intersection) continue;
    if (arc >= seg.startArc && arc <= seg.endArc) return i;
  }
  return -1;
}

/** The first junction cell strictly ahead of `arc`, or -1. Mirrors `nextJunctionCell`. */
function approachingJunctionCell(route: Route, arc: number): number {
  for (let i = 0; i < route.cells.length; i++) {
    if (route.cellDist[i] <= arc) continue;
    const seg = segmentAt(route, route.cellDist[i]);
    if (seg !== null && seg.kind === SegmentKind.Intersection) return i;
  }
  return -1;
}

/**
 * Whether the cell beyond a junction has room for one more car.
 *
 * This is the don't-block-the-intersection rule, and it is what stops a ring of junctions
 * gridlocking: a car never enters a junction it cannot leave, so the far side always
 * drains. The old model had no notion of this at all — cars entered and stopped dead
 * inside, blocking every crossing stream until the deadlock timeout fired.
 */
function exitHasRoom(world: TrafficWorld, route: Route, junctionCell: number): boolean {
  const exitCell = route.cells[junctionCell + 1];
  if (exitCell === undefined) return true;

  for (const other of world.vehicles) {
    const theirRoute = world.routes.get(other.routeId);
    if (!theirRoute) continue;
    if (other.speed > STOPPED_SPEED) continue;

    const edge = edgeIndexAt(theirRoute, other.arcDistance);
    const cell = theirRoute.cells[edge];
    if (cell !== undefined && cell.gx === exitCell.gx && cell.gy === exitCell.gy) return false;
  }
  return true;
}

/**
 * Offer every vehicle to the junctions that concern it.
 *
 * A vehicle produces **up to two** candidates, and emitting only one deadlocks adjacent
 * junctions. A car mid-crossing A is bound by B's stop line (`nextJunctionCell` in
 * `obstacles.ts` looks strictly ahead), so if it is offered only to A it can never be
 * admitted to B, halts ~`s0` short of B's line while still inside A, and stays there
 * forever — blocking A's cross traffic. Adjacent junction cells are ordinary:
 * `_isIntersection` is `cardinalConnectionCount >= 3`.
 *
 * So: the junction it is **inside** gets it as `inside: true`, which keeps A reserved
 * while the car physically occupies the box; the junction **ahead** gets it as an
 * entrant, which is what lets it earn its way out.
 */
function buildJunctionCandidates(world: TrafficWorld): {
  byJunction: Map<number, JunctionCandidate[]>;
  /** Vehicle id -> the junction it is queueing for, if any. Drives arrival-time ageing. */
  approaching: Map<string, number>;
} {
  const byJunction = new Map<number, JunctionCandidate[]>();
  const approaching = new Map<string, number>();

  const offer = (
    world: TrafficWorld, v: Vehicle, route: Route, cellIndex: number, inside: boolean,
  ): void => {
    if (cellIndex < 0) return;
    const junction = route.cells[cellIndex];
    const before = route.cells[cellIndex - 1];
    const after = route.cells[cellIndex + 1];
    if (before === undefined || after === undefined) return;

    const candidate: JunctionCandidate = {
      vehicleId: v.id,
      entry: getDirection(before, junction),
      exit: getDirection(junction, after),
      inside,
      arrivalTime: v.arrivalTime,
      exitHasRoom: exitHasRoom(world, route, cellIndex),
    };

    const key = junctionKey(junction.gx, junction.gy);
    const list = byJunction.get(key);
    if (list) list.push(candidate);
    else byJunction.set(key, [candidate]);
  };

  for (const v of world.vehicles) {
    if (v.mode === VehicleMode.Parked) continue;
    const route = world.routes.get(v.routeId);
    if (!route) continue;

    const insideCell = insideJunctionCell(route, v.arcDistance);
    const aheadCell = approachingJunctionCell(route, v.arcDistance);

    offer(world, v, route, insideCell, true);
    if (aheadCell !== insideCell) offer(world, v, route, aheadCell, false);

    if (aheadCell >= 0 && aheadCell !== insideCell) {
      const ahead = route.cells[aheadCell];
      approaching.set(v.id, junctionKey(ahead.gx, ahead.gy));
    }
  }

  return { byJunction, approaching };
}

interface Scratch {
  laneIndex: LaneIndex;
  accelerations: number[];
}

/**
 * Per-world scratch space, so two worlds stepped in the same process never share state.
 *
 * The lane index pools its bucket arrays across rebuilds, so it wants to outlive a single
 * tick — but making it a module-level singleton would make `step` non-reentrant, and the
 * determinism tests step two worlds alternately. Keyed by world, it gets the pooling
 * without the coupling.
 */
const scratchByWorld = new WeakMap<TrafficWorld, Scratch>();

function scratchFor(world: TrafficWorld): Scratch {
  let s = scratchByWorld.get(world);
  if (!s) {
    s = { laneIndex: new LaneIndex(), accelerations: [] };
    scratchByWorld.set(world, s);
  }
  return s;
}

/**
 * Advance the world by `dt`.
 *
 * Two passes, deliberately. Pass one reads only frame-start state and computes every
 * acceleration; pass two integrates and writes. No vehicle's outcome depends on its index
 * in `world.vehicles`, which is what makes a seeded run reproducible and what the old
 * `CarSystem` broke by mutating one shared occupancy map as it walked the array.
 */
export function step(world: TrafficWorld, dt: number): TrafficEvent[] {
  const events: TrafficEvent[] = [];
  const { laneIndex, accelerations } = scratchFor(world);

  laneIndex.rebuild(world);

  // Keyed by junction, not a flat set. Membership alone would mean "exempt from every
  // stop line ahead": adjacent cells can both be junctions (`_isIntersection` is
  // `cardinalConnectionCount >= 3`), so a car admitted to A would skip B's stop line and
  // exit straight into B's cross traffic.
  // Junction -> admitted vehicle ids. Keyed this way round because `admit` already
  // returns exactly that set per junction, and because a car mid-crossing A while
  // entering B is admitted to *both* — which a vehicle-keyed map cannot express.
  const { byJunction, approaching } = buildJunctionCandidates(world);
  const admitted = new Map<number, Set<string>>();
  for (const [key, candidates] of byJunction) {
    admitted.set(key, admit(candidates));
  }

  // Pass one: decide.
  accelerations.length = world.vehicles.length;
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i];
    if (v.mode === VehicleMode.Parked) { accelerations[i] = 0; continue; }

    const route = world.routes.get(v.routeId);
    if (!route) { accelerations[i] = 0; continue; }

    const constraint = nearestConstraint(world, v, laneIndex, admitted);
    const gap = constraint.arc - v.arcDistance;
    const limit = speedLimitAt(route, v.arcDistance);

    const raw = idmAcceleration(v.speed, limit, gap, constraint.speed, DEFAULT_IDM);
    accelerations[i] = Math.max(-MAX_DECELERATION, Math.min(DEFAULT_IDM.a, raw));
  }

  // Pass two: apply.
  for (let i = 0; i < world.vehicles.length; i++) {
    const v = world.vehicles[i];
    if (v.mode === VehicleMode.Parked) continue;

    const route = world.routes.get(v.routeId);
    if (!route) continue;

    const before = v.arcDistance;
    const limit = speedLimitAt(route, v.arcDistance);

    v.lastAcceleration = accelerations[i];
    v.speed = Math.max(0, Math.min(v.speed + accelerations[i] * dt, limit));
    v.arcDistance = Math.min(v.arcDistance + v.speed * dt, route.length);

    // Safety net. The headway model is collision-free in continuous time, so at a fixed
    // 60Hz timestep this must never bind. It asserts in dev rather than silently
    // correcting, so model drift surfaces as a failure instead of a visual glitch.
    const leader = laneIndex.findLeader(world, v);
    if (leader !== null) {
      // leader.gap is net, so this resolves to (leader's rear bumper - s0).
      const ceiling = before + leader.gap - DEFAULT_IDM.s0;
      if (v.arcDistance > ceiling) {
        if (CAR_DEBUG) {
          throw new Error(
            `traffic: ${v.id} overran leader ${leader.id} ` +
            `(arc ${v.arcDistance.toFixed(2)} > ceiling ${ceiling.toFixed(2)})`,
          );
        }
        v.arcDistance = Math.max(before, ceiling);
        v.speed = 0;
      }
    }

    // Track how long this vehicle has been waiting, for the junction arrival-time key.
    // Set on the tick it first comes to rest unadmitted; cleared the moment it is let in.
    //
    // Ages against the junction it is *queueing for*, never against admission in general.
    // A car mid-crossing A while blocked at B is admitted to A every tick, so a flat
    // "admitted anywhere" test would reset its clock forever and starve it at B — the
    // arrival-time key is the whole anti-starvation mechanism, so it must age.
    const queueingFor = approaching.get(v.id);
    const admittedThere = queueingFor !== undefined
      && admitted.get(queueingFor)?.has(v.id) === true;
    if (queueingFor === undefined || admittedThere) {
      v.arrivalTime = 0;
    } else if (v.arrivalTime === 0 && v.speed <= STOPPED_SPEED) {
      v.arrivalTime = world.time;
    }

    v.distanceThisTick = v.arcDistance - before;
    if (v.arcDistance >= route.length - 1e-6 && before < route.length - 1e-6) {
      events.push({ kind: TrafficEventKind.Arrived, vehicleId: v.id });
    }
  }

  world.time += dt;
  return events;
}
```

Note that `Arrived` fires only on the tick the vehicle crosses the end, not on every tick it
sits there — `before < route.length` is what makes it an edge rather than a level.

- [ ] **Step 4: Write `src/traffic/index.ts`**

```ts
/**
 * The traffic simulation's internal surface.
 *
 * Internal: `src/index.ts` re-exports none of this. The only consumer is
 * `src/systems/car/TrafficAdapter.ts`, which is the sole code that knows about both this
 * module's plain data and the engine's `Grid`, `Car` and renderers.
 */
export { buildRoute, sampleRoute, speedLimitAt, segmentAt } from './route';
export { cellsBetween, routeCoversCell, splitAt } from './routeQueries';
export { step } from './step';
export { createWorld, SegmentKind, VehicleMode, TrafficEventKind } from './types';
export type {
  Route, RouteInput, RouteSpan, RouteCellInput, RouteSample, RouteSegment,
  TrafficWorld, TrafficEvent, Vehicle,
} from './types';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/traffic/`
Expected: PASS — all traffic tests, including the 11 in `step.test.ts`.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/traffic/step.ts src/traffic/index.ts src/traffic/step.test.ts src/traffic/types.ts
git commit -m "feat(traffic): add the two-pass order-independent stepper"
```

---

### Task 8: Invariant sweeps, determinism, and the purity guard

**Files:**
- Create: `src/traffic/invariants.test.ts`
- Create: `src/traffic/purity.test.ts`

**Interfaces:**
- Consumes: `mulberry32` from `src/utils/rng.ts`; the whole traffic module.
- Produces: no source, tests only.

This is the task that proves the reported bugs are gone. Each invariant corresponds to a symptom: minimum gap to "cars drive on top of each other", bounded per-tick movement to "cars jump between positions", stall bound to "cars get stuck entirely".

- [ ] **Step 1: Write the invariant sweep**

Create `src/traffic/invariants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../utils/rng';
import { buildRoute } from './route';
import { step } from './step';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';
import { DEFAULT_IDM } from './tuning';
import { CAR_LENGTH, TILE_SIZE } from '../constants';

const DT = 1 / 60;
const SPEED_LIMIT = 40;

/** A ring road of `n` cells along one row, with junctions every `every` cells. */
function corridor(id: string, n: number, every: number): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: Array.from({ length: n }, (_, i) => ({
        pos: { gx: i, gy: 0 },
        kind: i > 0 && i % every === 0 ? SegmentKind.Intersection : SegmentKind.Road,
        speedLimit: SPEED_LIMIT,
        pendingDeletion: false,
      })),
    }],
  };
}

function populate(world: TrafficWorld, routeId: string, count: number, rand: () => number): void {
  const route = world.routes.get(routeId)!;
  const spacing = route.length / (count + 1);
  for (let i = 0; i < count; i++) {
    const v: Vehicle = {
      id: `v${i}`,
      routeId,
      // Descending so index order does not match arc order — the determinism test needs
      // the array order to be arbitrary.
      arcDistance: spacing * (count - i),
      speed: rand() * SPEED_LIMIT,
      mode: VehicleMode.Driving,
      lastAcceleration: 0,
      arrivalTime: 0,
      distanceThisTick: 0,
    };
    world.vehicles.push(v);
  }
}

function makeWorld(seed: number, cars: number): TrafficWorld {
  const rand = mulberry32(seed);
  const world = createWorld();
  world.routes.set('r1', buildRoute(corridor('r1', 60, 7))!);
  populate(world, 'r1', cars, rand);
  return world;
}

describe('traffic invariants', () => {
  it('never lets two cars on the same route overlap', () => {
    for (const seed of [1, 7, 42, 1337]) {
      const world = makeWorld(seed, 20);
      for (let tick = 0; tick < 3600; tick++) {
        step(world, DT);
        const arcs = world.vehicles.map(v => v.arcDistance).sort((a, b) => a - b);
        for (let i = 1; i < arcs.length; i++) {
          // Cars stack up at the route end once they arrive; ignore the terminal cluster.
          if (arcs[i] >= world.routes.get('r1')!.length - 1e-6) continue;
          expect(arcs[i] - arcs[i - 1], `seed ${seed} tick ${tick}`)
            // Net-gap convention: cars do not overlap iff their centres are more than
            // one car length apart. This is the physical invariant, not a tuning value.
            .toBeGreaterThan(CAR_LENGTH);
        }
      }
    }
  });

  it('never advances a car further than its speed permits in one tick', () => {
    const world = makeWorld(99, 20);
    for (let tick = 0; tick < 3600; tick++) {
      const before = world.vehicles.map(v => v.arcDistance);
      step(world, DT);
      for (let i = 0; i < world.vehicles.length; i++) {
        const moved = world.vehicles[i].arcDistance - before[i];
        expect(moved).toBeGreaterThanOrEqual(-1e-9);
        expect(moved).toBeLessThanOrEqual(SPEED_LIMIT * DT + 1e-6);
      }
    }
  });

  it('does not stall a car for more than fifteen seconds short of its destination', () => {
    const world = makeWorld(5, 20);
    const route = world.routes.get('r1')!;
    const stalled = new Map<string, number>();

    for (let tick = 0; tick < 3600; tick++) {
      const before = new Map(world.vehicles.map(v => [v.id, v.arcDistance]));
      step(world, DT);
      for (const v of world.vehicles) {
        if (v.arcDistance >= route.length - 1e-6) { stalled.set(v.id, 0); continue; }
        const moved = v.arcDistance - (before.get(v.id) ?? 0);
        const t = moved < 1e-6 ? (stalled.get(v.id) ?? 0) + DT : 0;
        stalled.set(v.id, t);
        expect(t, `${v.id} stalled at arc ${v.arcDistance.toFixed(1)}`).toBeLessThan(15);
      }
    }
  });

  it('keeps every car within the route bounds', () => {
    const world = makeWorld(11, 20);
    const route = world.routes.get('r1')!;
    for (let tick = 0; tick < 1800; tick++) {
      step(world, DT);
      for (const v of world.vehicles) {
        expect(v.arcDistance).toBeGreaterThanOrEqual(0);
        expect(v.arcDistance).toBeLessThanOrEqual(route.length + 1e-6);
      }
    }
  });

  it('is deterministic: the same seed twice gives identical state', () => {
    const a = makeWorld(2024, 25);
    const b = makeWorld(2024, 25);
    for (let tick = 0; tick < 1800; tick++) { step(a, DT); step(b, DT); }

    for (let i = 0; i < a.vehicles.length; i++) {
      expect(a.vehicles[i].arcDistance).toBe(b.vehicles[i].arcDistance);
      expect(a.vehicles[i].speed).toBe(b.vehicles[i].speed);
    }
  });

  it('is independent of vehicle array order', () => {
    const forward = makeWorld(77, 15);
    const reversed = makeWorld(77, 15);
    reversed.vehicles.reverse();

    for (let tick = 0; tick < 1800; tick++) { step(forward, DT); step(reversed, DT); }

    for (const v of forward.vehicles) {
      const other = reversed.vehicles.find(o => o.id === v.id)!;
      expect(other.arcDistance).toBeCloseTo(v.arcDistance, 9);
    }
  });

  it('holds with a parked car mid-corridor', () => {
    const world = makeWorld(3, 15);
    world.vehicles[0].mode = VehicleMode.Parked;
    world.vehicles[0].speed = 0;
    const parkedArc = world.vehicles[0].arcDistance;

    for (let tick = 0; tick < 1800; tick++) {
      step(world, DT);
      expect(world.vehicles[0].arcDistance).toBe(parkedArc);
      for (const v of world.vehicles) {
        if (v.id === world.vehicles[0].id) continue;
        // Nobody may occupy the parked car's space.
        if (v.arcDistance < parkedArc) {
          expect(parkedArc - v.arcDistance).toBeGreaterThan(CAR_LENGTH);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run the sweep**

Run: `npx vitest run src/traffic/invariants.test.ts`
Expected: PASS — 7 tests.

If the overlap test fails, do **not** relax the threshold. Reproduce with the reported seed and tick, and fix the model. A failure here is exactly the bug this project exists to remove.

- [ ] **Step 3: Write the purity guard**

Create `src/traffic/purity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+['"]three['"]/, why: 'three.js' },
  { pattern: /from\s+['"].*core\/Grid['"]/, why: 'Grid' },
  { pattern: /from\s+['"].*rendering\//, why: 'the renderer' },
  { pattern: /\bdocument\b|\bwindow\b/, why: 'the DOM' },
  { pattern: /Math\.random\s*\(/, why: 'Math.random (determinism)' },
  { pattern: /Date\.now\s*\(|new\s+Date\s*\(/, why: 'the clock (determinism)' },
];

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

describe('src/traffic purity', () => {
  it('has source files to check', () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`does not depend on ${why}`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles()) {
        const text = readFileSync(join(DIR, file), 'utf8');
        if (pattern.test(text)) offenders.push(file);
      }
      expect(offenders, `${why} must not appear under src/traffic/`).toEqual([]);
    });
  }
});
```

- [ ] **Step 4: Run the guard**

Run: `npx vitest run src/traffic/purity.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new traffic tests.

- [ ] **Step 6: Commit**

```bash
git add src/traffic/invariants.test.ts src/traffic/purity.test.ts
git commit -m "test(traffic): assert no-overlap, no-jump, no-stall, determinism and purity"
```

---

### Task 9: The adapter

**Files:**
- Create: `src/systems/car/TrafficAdapter.ts`
- Test: `src/systems/car/TrafficAdapter.test.ts`

**Interfaces:**
- Consumes: `src/traffic/index.ts`; `Grid`, `Car`, `CarState`, `PathStep`, `HighwaySystem`, `CarTuning`.
- Produces:
  - `class TrafficAdapter`
  - `constructor(grid: Grid, cfg: CarTuning, highwaySystem?: HighwaySystem)`
  - `installRoute(car: Car, path: PathStep[], preservePosition: boolean): boolean`
  - `removeVehicle(car: Car): void`
  - `setParked(car: Car, parked: boolean): void`
  - `update(dt: number): TrafficEvent[]`
  - `writeBack(cars: Car[]): void`
  - `carDependsOnCell(car: Car, gx: number, gy: number): boolean`
  - `getRouteFor(car: Car): Route | null`
  - `getArc(car: Car): number`
  - `getDistanceThisTick(car: Car): number`

This is the only file that knows both worlds. `preservePosition` distinguishes a reroute (project the current pixel position onto the new route) from a fresh start (begin at arc 0).

- [ ] **Step 1: Write the failing test**

Create `src/systems/car/TrafficAdapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Grid } from '../../core/Grid';
import { Car, CarState } from '../../entities/Car';
import { TrafficAdapter } from './TrafficAdapter';
import { CellType, GameColor } from '../../types';
import { DEFAULT_GAME_CONSTANTS } from '../../constants';
import type { PathStep } from '../../highways/types';

function roadRow(grid: Grid, n: number): void {
  for (let i = 0; i < n; i++) {
    grid.setCell(i, 0, { type: CellType.Road });
  }
}

function gridPath(n: number): PathStep[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'grid', pos: { gx: i, gy: 0 } } as PathStep));
}

function makeCar(): Car {
  return new Car('house-1', GameColor.Red, { gx: 0, gy: 0 }, DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
}

describe('TrafficAdapter.installRoute', () => {
  it('installs a route for a valid path', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();

    expect(adapter.installRoute(car, gridPath(6), false)).toBe(true);
    expect(adapter.getRouteFor(car)).not.toBeNull();
  });

  it('refuses a path too short to form a curve', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    expect(adapter.installRoute(makeCar(), gridPath(1), false)).toBe(false);
  });

  it('starts a fresh route at arc zero', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);
    expect(adapter.getArc(car)).toBe(0);
  });

  it('preserves position across a reroute instead of jumping to the start', () => {
    // The bug this fixes: reassignPath snapped arcDistance but clearPathState had already
    // reset pathIndex and segmentProgress, so the car rendered at the start of the route.
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();

    adapter.installRoute(car, gridPath(8), false);
    adapter.update(1 / 60);
    for (let i = 0; i < 120; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    const xBefore = car.pixelPos.x;
    expect(xBefore).toBeGreaterThan(50);

    adapter.installRoute(car, gridPath(8), true);
    adapter.writeBack([car]);

    expect(car.pixelPos.x).toBeCloseTo(xBefore, 0);
  });
});

describe('TrafficAdapter.writeBack', () => {
  it('derives pixel position and angle from the arc distance', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingToBusiness;
    adapter.installRoute(car, gridPath(6), false);

    for (let i = 0; i < 60; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    expect(car.pixelPos.x).toBeGreaterThan(20);
    expect(car.renderAngle).toBeCloseTo(0, 1);
  });

  it('records the previous position so the renderer can interpolate', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 6);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    adapter.installRoute(car, gridPath(6), false);

    for (let i = 0; i < 30; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);
    const first = car.pixelPos.x;
    for (let i = 0; i < 30; i++) adapter.update(1 / 60);
    adapter.writeBack([car]);

    expect(car.prevPixelPos.x).toBeCloseTo(first, 5);
    expect(car.pixelPos.x).toBeGreaterThan(first);
  });
});

describe('TrafficAdapter.carDependsOnCell', () => {
  it('depends on cells already travelled while heading to a business', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingToBusiness;
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 180; i++) adapter.update(1 / 60);

    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(false);
  });

  it('depends on cells still ahead while heading home', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingHome;
    adapter.installRoute(car, gridPath(8), false);
    for (let i = 0; i < 180; i++) adapter.update(1 / 60);

    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(false);
  });

  it('depends on the whole route while parked', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.Unloading;
    adapter.installRoute(car, gridPath(8), false);

    expect(adapter.carDependsOnCell(car, 0, 0)).toBe(true);
    expect(adapter.carDependsOnCell(car, 7, 0)).toBe(true);
  });

  it('does not depend on a cell the route never visits', () => {
    const grid = new Grid(20, 5);
    roadRow(grid, 8);
    const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
    const car = makeCar();
    car.state = CarState.GoingHome;
    adapter.installRoute(car, gridPath(8), false);

    expect(adapter.carDependsOnCell(car, 3, 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/systems/car/TrafficAdapter.test.ts`
Expected: FAIL — `Failed to resolve import "./TrafficAdapter"`.

- [ ] **Step 3: Write `src/systems/car/TrafficAdapter.ts`**

```ts
import type { Grid } from '../../core/Grid';
import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { PathStep } from '../../highways/types';
import type { HighwaySystem } from '../HighwaySystem';
import type { CarTuning } from './CarTuning';
import { CellType } from '../../types';
import type { GridPos, PixelPos } from '../../types';
import { INTERSECTION_SPEED_MULTIPLIER, TILE_SIZE } from '../../constants';
import {
  buildRoute, sampleRoute, step, createWorld, routeCoversCell,
  SegmentKind, VehicleMode,
} from '../../traffic';
import type {
  Route, RouteCellInput, RouteSpan, TrafficEvent, TrafficWorld, Vehicle,
} from '../../traffic';

/**
 * The seam between the engine and the traffic simulation.
 *
 * The only file that knows about both `Grid`/`Car` and `TrafficWorld`. Everything under
 * `src/traffic/` is plain data and pure functions; everything above it is the game. Game
 * rules — fuel, scoring, which building a car is going to — stay on this side, so the
 * simulation never grows a special case for them.
 */
export class TrafficAdapter {
  private world: TrafficWorld = createWorld();
  private vehiclesByCar = new Map<string, Vehicle>();
  private grid: Grid;
  private cfg: CarTuning;
  private highwaySystem: HighwaySystem | null;

  constructor(grid: Grid, cfg: CarTuning, highwaySystem?: HighwaySystem) {
    this.grid = grid;
    this.cfg = cfg;
    this.highwaySystem = highwaySystem ?? null;
  }

  /**
   * Compile a path into a route and attach the car to it.
   *
   * `preservePosition` is the difference between rerouting a moving car and starting a new
   * journey. When set, the car's current pixel position is projected onto the new route to
   * find its arc distance — and because arc distance *is* the rendered position, the car
   * stays where it is. The old `reassignPath` computed the same projection but wrote it to
   * a field the renderer ignored, which is why reroutes made cars jump.
   *
   * Returns false when the path cannot form a curve; the caller decides what that means.
   */
  installRoute(car: Car, path: PathStep[], preservePosition: boolean): boolean {
    const spans = this.buildSpans(path);
    const route = buildRoute({ id: car.id, spans });
    if (route === null) return false;

    this.world.routes.set(route.id, route);

    let vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) {
      vehicle = {
        id: car.id, routeId: route.id, arcDistance: 0, speed: 0,
        mode: VehicleMode.Driving, lastAcceleration: 0, arrivalTime: 0,
        distanceThisTick: 0,
      };
      this.vehiclesByCar.set(car.id, vehicle);
      this.world.vehicles.push(vehicle);
    }

    vehicle.routeId = route.id;
    vehicle.arrivalTime = 0;
    vehicle.mode = VehicleMode.Driving;
    vehicle.arcDistance = preservePosition ? projectOntoRoute(car.pixelPos, route) : 0;
    if (!preservePosition) vehicle.speed = 0;

    return true;
  }

  removeVehicle(car: Car): void {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return;
    this.vehiclesByCar.delete(car.id);
    this.world.routes.delete(vehicle.routeId);
    const i = this.world.vehicles.indexOf(vehicle);
    if (i >= 0) this.world.vehicles.splice(i, 1);
  }

  /** A parked car still occupies road and still blocks followers. */
  setParked(car: Car, parked: boolean): void {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return;
    vehicle.mode = parked ? VehicleMode.Parked : VehicleMode.Driving;
    if (parked) vehicle.speed = 0;
  }

  update(dt: number): TrafficEvent[] {
    return step(this.world, dt);
  }

  /**
   * Copy simulated positions onto cars for the renderers.
   *
   * `pixelPos` and `renderAngle` are derived from `arcDistance` every frame and never
   * written anywhere else. That single source of truth is what makes position jumps
   * impossible: there is no second representation to fall out of step with.
   */
  writeBack(cars: Car[]): void {
    for (const car of cars) {
      const vehicle = this.vehiclesByCar.get(car.id);
      if (!vehicle) continue;
      const route = this.world.routes.get(vehicle.routeId);
      if (!route) continue;

      car.prevPixelPos.x = car.pixelPos.x;
      car.prevPixelPos.y = car.pixelPos.y;
      car.prevRenderAngle = car.renderAngle;
      car.prevElevationY = car.elevationY;

      const sample = sampleRoute(route, vehicle.arcDistance);
      car.pixelPos.x = sample.x;
      car.pixelPos.y = sample.y;
      car.renderAngle = sample.angle;
      car.elevationY = sample.elevationY;
      car.onHighway = sample.elevationY !== 0;
    }
  }

  getRouteFor(car: Car): Route | null {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return null;
    return this.world.routes.get(vehicle.routeId) ?? null;
  }

  getArc(car: Car): number {
    return this.vehiclesByCar.get(car.id)?.arcDistance ?? 0;
  }

  /** Arc distance this car covered in the most recent `update`, in pixels. */
  getDistanceThisTick(car: Car): number {
    return this.vehiclesByCar.get(car.id)?.distanceThisTick ?? 0;
  }

  /**
   * Whether removing this road cell would strand or cut off the car.
   *
   * The asymmetry is the point, and it is preserved exactly from the three loops this
   * replaces in `Game.tryRemoveRoad`: a car on its way to a business depends on the road
   * *behind* it, because that is how it gets home; a car on its way home depends on the
   * road *ahead*; a parked car depends on all of it.
   */
  carDependsOnCell(car: Car, gx: number, gy: number): boolean {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return false;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route) return false;

    if (car.state === CarState.Unloading || car.state === CarState.Refueling) {
      return routeCoversCell(route, gx, gy, 0, route.length);
    }
    if (car.state === CarState.GoingToBusiness) {
      return routeCoversCell(route, gx, gy, 0, vehicle.arcDistance);
    }
    if (car.state === CarState.GoingHome) {
      return routeCoversCell(route, gx, gy, vehicle.arcDistance, route.length);
    }
    return false;
  }

  /** Group a path into contiguous grid runs and highway crossings. */
  private buildSpans(path: PathStep[]): RouteSpan[] {
    const spans: RouteSpan[] = [];
    let run: RouteCellInput[] = [];

    const flush = (): void => {
      if (run.length >= 2) spans.push({ kind: 'grid', cells: run });
      run = [];
    };

    for (const stepEntry of path) {
      if (stepEntry.kind === 'grid') {
        run.push(this.describeCell(stepEntry.pos));
        continue;
      }
      flush();
      const polyline = this.highwayPolyline(stepEntry.highwayId, stepEntry.from);
      if (polyline !== null) {
        spans.push({
          kind: 'highway',
          polyline,
          speedLimit: this.cfg.CAR_SPEED * this.cfg.HIGHWAY_SPEED_MULTIPLIER * TILE_SIZE,
        });
      }
    }
    flush();

    return spans;
  }

  private describeCell(pos: GridPos): RouteCellInput {
    const cell = this.grid.getCell(pos.gx, pos.gy);
    const isIntersection = cell !== null && cell._isIntersection;
    const isConnector = cell !== null && cell.type === CellType.Connector;

    const kind = isIntersection ? SegmentKind.Intersection
      : isConnector ? SegmentKind.Connector
      : SegmentKind.Road;

    const base = this.cfg.CAR_SPEED * TILE_SIZE;
    const speedLimit = (isIntersection || isConnector)
      ? base * INTERSECTION_SPEED_MULTIPLIER
      : base;

    return {
      pos,
      kind,
      speedLimit,
      pendingDeletion: cell !== null && cell.pendingDeletion,
    };
  }

  private highwayPolyline(highwayId: string, from: GridPos): PixelPos[] | null {
    if (!this.highwaySystem) return null;
    const hw = this.highwaySystem.getById(highwayId);
    if (!hw) return null;
    const reversed = from.gx === hw.toPos.gx && from.gy === hw.toPos.gy;
    return reversed ? [...hw.polyline].reverse() : hw.polyline;
  }
}

/** Nearest arc distance on a route to a pixel position. */
function projectOntoRoute(pos: PixelPos, route: Route): number {
  let bestDistSq = Infinity;
  let bestArc = 0;

  for (let i = 0; i < route.points.length - 1; i++) {
    const ax = route.points[i].x;
    const ay = route.points[i].y;
    const dx = route.points[i + 1].x - ax;
    const dy = route.points[i + 1].y - ay;
    const segLenSq = dx * dx + dy * dy;

    let t = 0;
    if (segLenSq > 0) {
      t = ((pos.x - ax) * dx + (pos.y - ay) * dy) / segLenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = (pos.x - px) * (pos.x - px) + (pos.y - py) * (pos.y - py);

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestArc = route.cumDist[i] + t * Math.sqrt(segLenSq);
    }
  }

  return bestArc;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/systems/car/TrafficAdapter.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: errors only in files not yet migrated (`CarSystem`, `CarMovement`). Those are addressed in Task 10. If errors appear in `TrafficAdapter.ts` itself, fix them here.

- [ ] **Step 6: Commit**

```bash
git add src/systems/car/TrafficAdapter.ts src/systems/car/TrafficAdapter.test.ts
git commit -m "feat(systems): add the traffic adapter seam between Grid/Car and the simulation"
```

---

### Task 10: Rewire CarSystem and delete the old traffic modules

**Files:**
- Modify: `src/systems/CarSystem.ts`
- Modify: `src/systems/car/CarRouter.ts`
- Modify: `src/systems/car/CarParkingManager.ts`
- Delete: `src/systems/car/CarMovement.ts`, `src/systems/car/CarTrafficManager.ts`, `src/systems/car/CarLeaderIndex.ts`, `src/systems/car/IntersectionConflicts.ts`
- Test: `src/systems/CarSystem.test.ts` (existing — must keep passing)

**Interfaces:**
- Consumes: `TrafficAdapter` from Task 9.
- Produces: `CarSystem` with an unchanged public shape — `getCars()`, `getScore()`, `setElapsedTime(t)`, `registerHouse(house)`, `update(dt, houses, businesses)`, `onRoadsChanged(houses)`, `onHomeReturn`, `onStranded` — plus `getTrafficAdapter(): TrafficAdapter` for `Game`.

- [ ] **Step 1: Verify the existing stranded-alert tests pass before touching anything**

Run: `npx vitest run src/systems/CarSystem.test.ts`
Expected: PASS — 6 tests. These describe behaviour that must survive; note the result so a later failure is unambiguous.

- [ ] **Step 2: Rewrite `CarSystem.moveCars` to drive the adapter**

Replace the body of `moveCars` and the movement wiring. `CarSystem` keeps `router`, `parkingManager`, `dispatcher`, `refuelingManager`, `rescueManager` and drops `trafficManager`, `movement`, `leaderIndex`.

```ts
  private moveCars(
    dt: number, houses: House[], businesses: Business[], houseMap: Map<string, House>,
  ): void {
    const bizMap = this._businessMap;
    bizMap.clear();
    for (const biz of businesses) bizMap.set(biz.id, biz);

    this.withStrandedDetection(() => {
      const events = this.adapter.update(dt);
      this.adapter.writeBack(this.cars);

      for (const car of this.cars) {
        if (car.state === CarState.Idle || car.state === CarState.Stranded) continue;

        // Fuel is a game rule, so it is deducted here rather than inside the simulation —
        // and from one distance, so road and highway can no longer disagree about cost.
        if (car.state !== CarState.Refueling) {
          car.fuel = Math.max(0, car.fuel - this.adapter.getDistanceThisTick(car) / TILE_SIZE);
        }

        if (car.state === CarState.Refueling) {
          this.refuelingManager.updateRefuelingCar(car, dt, bizMap, houseMap);
        } else if (car.state === CarState.Unloading) {
          this.parkingManager.updateUnloadingCar(car, dt, bizMap, houseMap, () => { this.score++; });
        } else if (car.fuel <= 0 && car.state !== CarState.GoingToGasStation) {
          car.state = CarState.Stranded;
          this.adapter.setParked(car, true);
        }
      }

      // Arrivals last: handleArrival may reset a car to idle or install a new route, and
      // doing that mid-loop would have the fuel pass above read a route the car has left.
      for (const event of events) {
        if (event.kind !== TrafficEventKind.Arrived) continue;
        const car = this.carsById.get(event.vehicleId);
        if (car) this.handleArrival(car, houses, bizMap, houseMap);
      }
    });
  }
```

Add to the class:

```ts
  private adapter: TrafficAdapter;
  private carsById = new Map<string, Car>();

  getTrafficAdapter(): TrafficAdapter {
    return this.adapter;
  }
```

Construct it alongside the others, and register cars in `carsById` inside `registerHouse`:

```ts
    this.adapter = new TrafficAdapter(grid, cfg, highwaySystem);
```

```ts
  registerHouse(house: House): void {
    for (let i = 0; i < this.cfg.CARS_PER_HOUSE; i++) {
      const car = new Car(house.id, house.color, house.pos, this.cfg.FUEL_CAPACITY);
      house.carIds.push(car.id);
      this.cars.push(car);
      this.carsById.set(car.id, car);
    }
  }
```

Remove the `occupied` argument threaded through `update` — the adapter owns occupancy now:

```ts
  update(dt: number, houses: House[], businesses: Business[]): void {
    const houseMap = this._houseMap;
    houseMap.clear();
    for (const h of houses) houseMap.set(h.id, h);

    this.dispatcher.dispatch(this.cars, houses, businesses);
    this.moveCars(dt, houses, businesses, houseMap);

    this._rescueTimer += dt;
    if (this._rescueTimer >= CarSystem.RESCUE_INTERVAL) {
      this._rescueTimer = 0;
      if (this.cars.some(c => c.state === CarState.Stranded)) {
        this.withStrandedDetection(() => {
          this.rescueManager.rescueStrandedCars(this.cars, houseMap);
        });
      }
    }
  }
```

`CarDispatcher.dispatch` currently takes `occupied` as its fourth parameter and uses it to avoid spawning a car onto occupied ground. Replace that check with `adapter.getRouteFor(car) === null` plus a spacing check against `adapter.getArc` for cars already on the same starting cell; pass the adapter into `CarDispatcher`'s constructor instead of threading a map through `dispatch`.

- [ ] **Step 3: Point `CarRouter` at the adapter**

`CarRouter.assignPath`, `reassignPath` and `snapToPathStart` all become adapter calls. Replace their bodies:

```ts
  assignPath(car: Car, path: PathStep[]): boolean {
    return this.adapter.installRoute(car, path, false);
  }

  /** Keep a moving car where it is and find that point on the new route. */
  reassignPath(car: Car, path: PathStep[]): boolean {
    return this.adapter.installRoute(car, path, true);
  }
```

`snapToPathStart` is deleted — `installRoute(..., false)` already starts at arc 0, and `writeBack` derives the pixel position from it. Delete `extractLeadingGridPositions`, `computeAndAssignSmoothPath`, `recomputeSmoothPathFromIndex` and `findClosestArcDistance`; the last of these moves into `TrafficAdapter` as `projectOntoRoute`.

In `rerouteCar`, replace `getCarCurrentTile(car)` with a call that reads the adapter's current cell, and replace the stranded branch's teleport:

```ts
    // Strand in place. The old code snapped to a tile centre here, which was a visible
    // jump at exactly the moment the player was watching the car fail.
    car.state = CarState.Stranded;
    this.adapter.setParked(car, true);
    if (home) car.destination = home.pos;
```

- [ ] **Step 4: Drop `outboundPath` from `CarParkingManager`**

Remove all four assignments (`CarParkingManager.ts:64`, `:84`, `:97`, `:109`). A parked car keeps its route installed, which is what `carDependsOnCell` reads for the `Unloading`/`Refueling` case. Replace the `car.outboundPath = [...car.path]` at line 64 with `this.adapter.setParked(car, true)`, and the clearing assignments with `this.adapter.setParked(car, false)` where the car resumes driving.

- [ ] **Step 5: Delete the superseded modules**

```bash
git rm src/systems/car/CarMovement.ts \
       src/systems/car/CarTrafficManager.ts \
       src/systems/car/CarLeaderIndex.ts \
       src/systems/car/IntersectionConflicts.ts
```

- [ ] **Step 6: Typecheck and fix fallout**

Run: `npm run typecheck`
Expected: errors in `Car.ts` (fields still referenced), `Game.ts`, `CarRouteLayer.ts`, `RoadDebugLayer.ts`. Those are Tasks 11-13. Fix anything inside `src/systems/` here.

- [ ] **Step 7: Run the existing CarSystem tests**

Run: `npx vitest run src/systems/CarSystem.test.ts`
Expected: PASS — the same 6 tests as Step 1. If any now fail, stop: stranded-alert behaviour was meant to survive this change untouched.

- [ ] **Step 8: Commit**

```bash
git add -A src/systems
git commit -m "refactor(systems): drive cars from the traffic simulation and delete the old model"
```

---

### Task 11: Strip the movement fields from Car

**Files:**
- Modify: `src/entities/Car.ts`
- Modify: `src/entities/Car.test.ts`

**Interfaces:**
- Produces: `Car` retaining `id`, `color`, `homeHouseId`, `state`, `targetBusinessId`, `destination`, `renderAngle`, `prevRenderAngle`, `pixelPos`, `prevPixelPos`, `elevationY`, `prevElevationY`, `onHighway`, `unloadTimer`, `hasLoad`, `fuel`, `fuelCapacity`, `targetGasStationId`, `refuelTimer`, `postRefuelIntent`; and `resetToIdle(homePos)`. `clearPathState()` is deleted.

- [ ] **Step 1: Remove the fields**

Delete from `src/entities/Car.ts`: `direction`, `path`, `pathIndex`, `outboundPath`, `segmentProgress`, `intersectionWaitTime`, `sameLaneWaitTime`, `stuckTimer`, `lastAdvancedPathIndex`, `wasBlocked`, `smoothPath`, `smoothCumDist`, `smoothCellDist`, `arcDistance`, `currentSpeed`, `leaderId`, `leaderGap`, `arrivalTime`, `highwayPolyline`, `highwayCumDist`, `highwayProgress`.

`direction` goes because it was written twice in `CarMovement` (`:48`, `:111`) and read nowhere — verify with `grep -rn '\.direction' src | grep -v terrainMesh` returning nothing outside `Car.ts` before deleting.

Delete `clearPathState()` entirely: route state now lives in the world, and `TrafficAdapter.installRoute` replaces it wholesale. Reduce `resetToIdle` to:

```ts
  /**
   * Reset all driving state back to idle defaults.
   *
   * Deliberately does *not* touch `fuel` — a car that reaches home keeps whatever is left
   * in the tank and must still visit a gas station.
   *
   * Route state is no longer reset here: it lives in the traffic world, and
   * `TrafficAdapter.removeVehicle` is what clears it. This method used to have a
   * `clearPathState` sibling precisely because route bookkeeping was scattered across the
   * car; there is nothing left to scatter.
   */
  resetToIdle(homePos: GridPos): void {
    this.state = CarState.Idle;
    this.targetBusinessId = null;
    this.destination = null;
    this.renderAngle = 0;
    this.prevRenderAngle = 0;
    this.onHighway = false;
    this.elevationY = 0;
    this.prevElevationY = 0;
    this.unloadTimer = 0;
    this.hasLoad = false;
    this.targetGasStationId = null;
    this.refuelTimer = 0;
    this.postRefuelIntent = 'business';

    const center = gridToPixelCenter(homePos);
    this.pixelPos = { ...center };
    this.prevPixelPos = { ...center };
  }
```

- [ ] **Step 2: Rewrite `src/entities/Car.test.ts`**

The existing file asserts an explicit field list for `clearPathState` (`Car.test.ts:96-99`) and touches `intersectionWaitTime`, `wasBlocked` and `arrivalTime`. Replace the whole file:

```ts
import { describe, it, expect } from 'vitest';
import { Car, CarState } from './Car';
import { GameColor } from '../types';

function movingCar(): Car {
  const car = new Car('house-1', GameColor.Red, { gx: 0, gy: 0 }, 30);
  car.state = CarState.GoingToBusiness;
  car.targetBusinessId = 'biz-1';
  car.destination = { gx: 5, gy: 5 };
  car.hasLoad = true;
  car.onHighway = true;
  car.elevationY = -12;
  car.unloadTimer = 0.4;
  car.targetGasStationId = 'gs-1';
  car.refuelTimer = 0.2;
  car.pixelPos = { x: 200, y: 200 };
  return car;
}

describe('Car', () => {
  it('starts idle with a full tank', () => {
    const car = new Car('house-1', GameColor.Blue, { gx: 1, gy: 1 }, 30);
    expect(car.state).toBe(CarState.Idle);
    expect(car.fuel).toBe(30);
    expect(car.fuelCapacity).toBe(30);
  });

  it('starts at the centre of its home tile', () => {
    const car = new Car('house-1', GameColor.Blue, { gx: 2, gy: 3 }, 30);
    expect(car.pixelPos).toEqual(car.prevPixelPos);
  });
});

describe('Car.resetToIdle', () => {
  it('clears the state a journey leaves behind', () => {
    const car = movingCar();
    car.resetToIdle({ gx: 2, gy: 2 });

    expect(car.state).toBe(CarState.Idle);
    expect(car.hasLoad).toBe(false);
    expect(car.targetBusinessId).toBeNull();
    expect(car.targetGasStationId).toBeNull();
    expect(car.destination).toBeNull();
    expect(car.onHighway).toBe(false);
    expect(car.elevationY).toBe(0);
    expect(car.unloadTimer).toBe(0);
    expect(car.refuelTimer).toBe(0);
    expect(car.postRefuelIntent).toBe('business');
  });

  it('moves the car to its home tile centre', () => {
    const car = movingCar();
    car.resetToIdle({ gx: 2, gy: 2 });
    expect(car.pixelPos).toEqual(car.prevPixelPos);
    expect(car.pixelPos.x).not.toBe(200);
  });

  it('keeps the fuel in the tank', () => {
    // A car that reaches home must still visit a gas station.
    const car = movingCar();
    car.fuel = 12;
    car.resetToIdle({ gx: 2, gy: 2 });
    expect(car.fuel).toBe(12);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/entities/Car.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 4: Commit**

```bash
git add src/entities/Car.ts src/entities/Car.test.ts
git commit -m "refactor(entities): strip route bookkeeping from Car now the world owns it"
```

---

### Task 12: Route-dependency query in Game

**Files:**
- Modify: `src/core/Game.ts:600-628`

**Interfaces:**
- Consumes: `CarSystem.getTrafficAdapter()`, `TrafficAdapter.carDependsOnCell`.

- [ ] **Step 1: Replace the three hand-rolled loops**

In `Game.tryRemoveRoad`, replace the whole `for (const car of cars)` block:

```ts
    const cars = this.carSystem.getCars();
    const adapter = this.carSystem.getTrafficAdapter();
    const dependentCarIds: string[] = [];
    for (const car of cars) {
      if (adapter.carDependsOnCell(car, gx, gy)) dependentCarIds.push(car.id);
    }
```

Remove the now-unused `stepGridPos` import if nothing else in `Game.ts` uses it — check with `grep -n stepGridPos src/core/Game.ts`.

The three-way asymmetry (travelled for `GoingToBusiness`, remaining for `GoingHome`, everything for parked) now lives once inside `carDependsOnCell` and is covered by the tests written in Task 9.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `CarRouteLayer.ts` and `RoadDebugLayer.ts`, addressed in Task 13.

- [ ] **Step 3: Commit**

```bash
git add src/core/Game.ts
git commit -m "refactor(core): ask the adapter which cars depend on a road cell"
```

---

### Task 13: Route rendering

**Files:**
- Modify: `src/rendering/layers/CarRouteLayer.ts`
- Modify: `src/rendering/layers/RoadDebugLayer.ts`

**Interfaces:**
- Consumes: `splitAt` via `TrafficAdapter.getRouteFor` and `getArc`.

- [ ] **Step 1: Replace CarRouteLayer's dual drawing paths**

`CarRouteLayer` currently branches on whether `smoothPath` is populated (`CarRouteLayer.ts:82-86`), drawing smoothed geometry when it is and a jagged tile-centre polyline when it is not, then splits by `pathIndex` inside `buildFromGridPath` (`:176-178`). Both collapse into one path:

```ts
    const route = adapter.getRouteFor(closestCar);
    if (route !== null) {
      const { travelled, remaining } = splitAt(route, adapter.getArc(closestCar));
      this.addRouteLine(group, travelled, color, 0.4, true);   // dashed, faded
      this.addRouteLine(group, remaining, color, 1.0, false);  // solid
    }
```

Where `addRouteLine(group, points, color, opacity, dashed)` is the existing `Line2`/`LineGeometry`/`LineMaterial` construction extracted from `buildFromSmoothPath` and `buildFromGridPath`, taking a point list instead of reading car fields. Delete `buildFromSmoothPath` and `buildFromGridPath`.

**`addRouteLine` must return early on a degenerate half.** `splitAt` yields a two-point stub whose points coincide at *both* extremes — `travelled` at arc 0, and `remaining` once the car reaches the end. A car sitting at its destination therefore hands `remaining` a zero-length polyline every frame. `LineGeometry.setPositions` with two identical points produces a degenerate segment that `Line2` renders as a stray dot or, with `dashed`, triggers a division by zero in `computeLineDistances`. Guard with a squared-distance check against a small epsilon before building geometry, and cover both ends with a test.

The layer needs the adapter. Pass it in from wherever `CarRouteLayer.update` is called in `Renderer`/`IsometricRenderer` — find with `grep -rn "CarRouteLayer" src/rendering/`. Replace the cached-invalidation field `this.cachedPathIndex = closestCar.pathIndex` (`:72`) with `this.cachedArc = adapter.getArc(closestCar)`, comparing with a small epsilon so the geometry is not rebuilt every frame:

```ts
    if (this.hoveredCarId === closestCar.id
        && Math.abs(this.cachedArc - arc) < 1
        && this.cachedFuel === fuelFloored) {
      return;
    }
```

- [ ] **Step 2: Replace RoadDebugLayer's path walk**

`RoadDebugLayer.ts:32-44` walks `car.path` split at `car.pathIndex`. Replace with `cellsBetween`:

```ts
      const route = adapter.getRouteFor(car);
      if (route === null) continue;
      const arc = adapter.getArc(car);
      for (const cell of cellsBetween(route, 0, arc)) markTravelled(cell);
      for (const cell of cellsBetween(route, arc, route.length)) markRemaining(cell);
```

Also replace the `car.outboundPath` loop (`RoadDebugLayer.ts:37`) with `cellsBetween(route, 0, route.length)` for parked cars, matching `carDependsOnCell`.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors anywhere. This is the first point at which the whole tree compiles again.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — everything.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/layers/CarRouteLayer.ts src/rendering/layers/RoadDebugLayer.ts
git commit -m "refactor(rendering): draw car routes from a single split-at-arc query"
```

---

### Task 14: Retire the superseded constants and update the docs

**Files:**
- Modify: `src/constants.ts`
- Modify: `CLAUDE.md`
- Test: `src/constants.test.ts` (existing — must keep passing)

- [ ] **Step 1: Delete the retired constants**

Remove from `src/constants.ts`: `INTERSECTION_DEADLOCK_TIMEOUT`, `CAR_MIN_GAP`, `CAR_COMFORT_GAP`, `INTERSECTION_STOP_DIST`, `INTERSECTION_DECEL_DIST`, `T_INTERSECTION_GAP_TIME`, `UNIVERSAL_STUCK_TIMEOUT`.

Keep `INTERSECTION_SPEED_MULTIPLIER` (now a route segment speed limit), `LANE_OFFSET`, `CAR_WIDTH`, `CAR_LENGTH`, `CAR_SPEED`.

Verify nothing still references them:

```bash
grep -rn "INTERSECTION_DEADLOCK_TIMEOUT\|CAR_MIN_GAP\|CAR_COMFORT_GAP\|INTERSECTION_STOP_DIST\|INTERSECTION_DECEL_DIST\|T_INTERSECTION_GAP_TIME\|UNIVERSAL_STUCK_TIMEOUT" src demo
```
Expected: no output.

- [ ] **Step 2: Confirm the static constants guard still passes**

Run: `npx vitest run src/constants.test.ts`
Expected: PASS. This guard is why `DEFAULT_IDM` lives in `src/traffic/tuning.ts` as a module constant and is not a key of `GameConstants` — if someone later adds an IDM parameter to `GameConstants` while `tuning.ts` still imports it directly, this test fails, which is the intended alarm.

- [ ] **Step 3: Confirm the map wire format is untouched**

Run: `npx vitest run src/maps/ && git diff --exit-code src/maps src/index.ts`
Expected: tests PASS and no diff. If `src/index.ts` shows a diff, revert it — the public surface must not change.

- [ ] **Step 4: Update `CLAUDE.md`**

Replace the `CarSystem` bullet under **Systems**:

```markdown
- **CarSystem** — Owns cars and their journeys. Movement itself is simulated by
  `src/traffic/`, reached through `src/systems/car/TrafficAdapter.ts`.
```

Add a new section after **Pathfinding**:

```markdown
### Traffic (`src/traffic/`)

Pure, canvas-free continuous car-following. A car's position is one number — `arcDistance`
along a single route curve — and `pixelPos` is derived from it every frame, never written
independently. That single source of truth is what makes position jumps impossible.

A route spans road and highway alike; segment kind affects only the speed limit, so there
is no separate highway integrator and no splice at the junction between them.

Two things are worth knowing. Following and junctions cover the space only *together*: a
lane is a directed edge, so two cars converging from different approaches are invisible to
each other there — but a merge implies three or more connections, so the cell is always an
intersection and admission serialises them. And junction admission is greedy over a total
order, which is why it cannot deadlock and needs no escape timeout; *rechts vor links*
shapes the order but cannot cycle it.

Nothing here imports Three.js or `Grid`, enforced by `src/traffic/purity.test.ts`, so the
whole model is exercised directly by the Node-only suite — including invariant sweeps that
assert no overlap, no position jumps, no stalls, and determinism.
```

Update the **Testing** section's last paragraph to mention the traffic sweeps alongside the terrain pipeline.

Remove the `UNIVERSAL_STUCK_TIMEOUT`-era claim if any remains, and check the **Key Patterns** list still reads true.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts CLAUDE.md
git commit -m "refactor: retire the traffic band-aid constants and document the new model"
```

---

### Task 15: Verify in the demo and tune

**Files:**
- Modify: `src/traffic/tuning.ts` (values only)

This is the step the tests cannot do. They prove the model is correct; they cannot prove it feels right.

- [ ] **Step 1: Run the demo**

Run: `npm run dev`

Draw a grid of roads with several houses and businesses. Let traffic build until there are twenty or more cars.

- [ ] **Step 2: Check each reported symptom against the running game**

| Symptom | What to look for |
|---|---|
| Cars on top of each other | Watch a queue at a busy junction and a car parked at a business. No sprite should ever overlap another. |
| Traffic rules ignored | At an unmarked four-way with cars arriving together, the car on the right should go first. No car should enter a junction whose far side is full. |
| Position jumps | Delete a road under a moving car. It must continue from where it was, not snap to the start of its new route or to a tile centre. |
| Cars stuck | Leave it running for several minutes. No car should sit still while its route ahead is clear. |

- [ ] **Step 3: Tune if needed**

Adjust only `DEFAULT_IDM` in `src/traffic/tuning.ts`:

- Cars too timid, large gaps, slow junctions → lower `T` toward `0.4`, raise `a`.
- Cars jerky or braking abruptly → lower `a`, raise `b` so braking starts earlier.
- Cars too tightly packed → raise `s0`.

After any change: `npm test` must still pass. If the invariant sweep fails after tuning, the parameters are outside the model's safe range — revert rather than relaxing the test.

- [ ] **Step 4: Confirm the public surface is unchanged**

```bash
git diff --exit-code src/index.ts
grep -rn "car\.path\|car\.pathIndex\|outboundPath\|smoothPath" src demo
```
Expected: no diff, no output.

- [ ] **Step 5: Final full verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build:demo`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/traffic/tuning.ts
git commit -m "tune(traffic): settle following parameters against the demo"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Continuous car-following, one position truth | 1, 7 |
| Sub-tile precision | 4 (arc offsets, not tile keys) |
| Highways unified into one arc | 1 (highway spans), 9 (`buildSpans`) |
| Conflict points + virtual leader | 5, 6 |
| Don't block the intersection | 5 (`exitHasRoom`), 7 (`exitHasRoom`) |
| Rechts vor links, acyclic | 5 (`yieldRank`, `admit`) |
| Keep right / no overtaking | 1 (lane offset), 4 (single leader per lane) |
| "Straight beats turning" dropped | 5 (no maneuver taxonomy) |
| Pure core + property tests | 8 |
| Route-dependency queries | 2, 9, 12 |
| `splitAt` for route rendering | 2, 13 |
| Fuel deducted by the adapter | 10 |
| Constants retired, no wire change | 14 |
| `src/index.ts` unchanged | 14, 15 |
| Existing tests updated | 10 (CarSystem), 11 (Car) |
| IDM tuning risk | 15 |

**Deliberate departure from the spec, stated rather than hidden:** the spec lists `enteredHighway` and `exitedHighway` events. The plan does not emit them. Nothing needs them — `writeBack` derives `car.onHighway` from the sampled elevation, which is the same information without a channel to keep in sync. Adding an event no consumer reads would be exactly the kind of dead pathway this rebuild exists to remove. If a consumer appears later, `segmentAt(route, before).kind !== segmentAt(route, after).kind` is the one-line test that produces them.

**Placeholder scan:** no TBD/TODO. Every code step carries real code. Task 15's tuning values are deliberately directional rather than fixed, because the correct values are only discoverable by running the game — this is flagged as a risk in the spec, not a gap in the plan.

**Type consistency:** `Vehicle.arrivalTime` is introduced in Task 7's note and must be added to `types.ts` in that task — every test helper constructing a `Vehicle` in Tasks 4, 6, 7 and 8 includes it. `LeaderInfo` (Task 4) is consumed by `nearestConstraint` (Task 6) as `{ id, gap, speed }`. `Constraint` (Task 6) is consumed by `step` (Task 7) as `{ arc, speed }`. `RouteCellInput.speedLimit` is in pixels/second throughout, converted once in `TrafficAdapter.describeCell`.
