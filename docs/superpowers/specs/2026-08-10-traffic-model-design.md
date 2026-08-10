# Traffic Model Rebuild: Continuous Car-Following

**Date:** 2026-08-10
**Status:** Approved, not yet implemented

## Problem

Cars drive on top of each other, ignore right-of-way, jump between positions, and
sometimes freeze. These read as four bugs. They are one: **there is no single source of
truth for where a car is, and no invariant that prevents two cars occupying the same
space.**

Four parallel position representations exist, each with a different exclusion filter, and
none authoritative:

| Representation | Built by | Excludes |
|---|---|---|
| `occupied: Map<tile+lane, carId>` | `CarTrafficManager.buildOccupancyMap` | Idle, Unloading, Refueling, on-highway |
| Leader buckets `Map<tile+lane, entries>` | `CarLeaderIndex.rebuild` | the above, **plus** cars at `pathIndex >= length-1` |
| `arcDistance` along `smoothPath` | `CarMovement` | — |
| `highwayProgress` along `highwayPolyline` | `CarMovement.updateHighwayMovement` | — |

### 1. Occupancy is advisory, never enforced

`CarMovement` deletes the old occupancy key (`CarMovement.ts:118`) and writes the new one
(`CarMovement.ts:257`), but never asks whether the target key is already taken. The map's
only readers are the T-intersection gap scan and the dispatcher. Overlap is not prevented
by construction — it is hoped against.

### 2. Parked and arrived cars are invisible

`CarLeaderIndex.rebuild` skips `Unloading` and `Refueling` cars (`CarLeaderIndex.ts:47`)
and cars sitting at their final step (`CarLeaderIndex.ts:50`), while those cars remain
physically on the road. Followers drive onto them. `buildOccupancyMap` has the same
exclusions (`CarTrafficManager.ts:75`).

### 3. Merging traffic cannot see itself

Both indices key on `directionToLane(dir)` where `dir` derives from **the observer's own**
heading. A car that entered the same tile from a different approach is filed under a
different key and is invisible. This is why merges overlap.

### 4. Leader gap is Euclidean, not along-path

`CarLeaderIndex.ts:90` measures straight-line pixel distance. Around a corner the true
arc gap is shorter than the straight-line gap, so braking is under-applied exactly where
geometry is tightest.

### 5. `arcDistance` is write-only for positioning

Rendering uses `(pathIndex, segmentProgress)` via `interpolateCarPosition`
(`CarMovement.ts:42`, called at `CarMovement.ts:231`). `reassignPath`
(`CarRouter.ts:54`) carefully snaps `arcDistance` to the nearest point on the new path —
but `assignPath` has already called `clearPathState()` (`CarRouter.ts:63`), resetting
`pathIndex` and `segmentProgress` to zero. **The car therefore renders at the start of the
new route.** This is the position-jump bug, precisely.

`rerouteCar` also teleports to a tile centre on the stranded path (`CarRouter.ts:213`).

### 6. Deadlock release is simultaneous and at full speed

`computeIntersectionYield` returns `1` — full speed, no deceleration — once
`INTERSECTION_DEADLOCK_TIMEOUT` elapses (`CarTrafficManager.ts:257`). Yield-to-right at a
four-way is cyclic by construction (A yields B yields C yields D yields A), so the timeout
fires routinely and releases every car in the cycle at the same instant, into each other.

### 7. No following inside intersections

`computeIntersectionYield` bails when `car.segmentProgress >= 0.5`
(`CarTrafficManager.ts:206`). Once a car is inside a junction it never re-checks anything.

### 8. Cars on highways ignore each other entirely

`updateHighwayMovement` (`CarMovement.ts:284`) has no leader logic at all. It is a separate
integrator with its own progress variable, its own fuel arithmetic, and no traffic model.

### 9. Frame-order dependence

`occupied` is built once (`CarSystem.ts:91`), passed to the dispatcher
(`CarSystem.ts:92`), then mutated in place as cars update sequentially inside `moveCars`
(`CarSystem.ts:94`). A car's decision depends on its index in the array.

### 10. Tile granularity is too coarse

`occupancyKey(gx, gy, lane)` quantises a car to one tile and one of a handful of lanes.
Two cars 4 px apart and two cars 60 px apart within the same tile are indistinguishable to
the model. Every mechanism built on that key inherits the resolution.

`UNIVERSAL_STUCK_TIMEOUT` (8 s reroute) and `INTERSECTION_DEADLOCK_TIMEOUT` (2 s release)
are band-aids over the above.

## Decisions

| Question | Decision |
|---|---|
| Model | Continuous car-following along arc length. One position truth: `arcDistance`. |
| Precision | Sub-tile. A car occupies a continuous interval, not a tile. |
| Highways | Unified. One route curve spans road and highway alike. |
| Intersections | Geometric conflict points; braking expressed as a virtual leader. |
| Rules enforced | Don't block the intersection; *rechts vor links*; keep right / no overtaking. |
| Rules dropped | "Straight beats turning" — no maneuver-class priority anywhere. |
| Verification | Pure canvas-free core + property tests under Node. |
| Wire format | Unchanged. |
| Public API | `src/index.ts` unchanged; some in-engine readers of `Car` internals change. |

### Why "straight beats turning" is dropped

It exists today only at T-intersections, inside `shouldYield`, alongside a gap-acceptance
scan of the major road. Removing it makes every unmarked junction pure *rechts vor links* —
which is the actual rule the T-intersection branch was approximating — and deletes the
left/right/straight taxonomy in `IntersectionConflicts.ts` along with it.

## Design

### Architecture

A new pure module `src/traffic/`, importing nothing from `three`, `Grid`, or anything
canvas-shaped. One entry point:

```ts
step(world: TrafficWorld, dt: number): void
```

`TrafficWorld` is plain data: **routes** (polyline, cumulative-distance array, per-segment
metadata) and **vehicles** (route index, `arcDistance`, `speed`, small state enum). Grid
cells, road connections and intersection flags are compiled *into* route metadata up front.

`src/systems/car/TrafficAdapter.ts` is the only code that knows both worlds. It builds
routes from `Grid` + `Pathfinder` output, installs them, runs `step`, and copies resulting
positions back onto `Car` for the renderers.

`pixelPos` and `renderAngle` are **derived** every frame by sampling the route at
`arcDistance`. They are never written independently. `pathIndex`, `segmentProgress`,
`smoothCellDist` and `highwayProgress` are deleted, not kept in sync.

A route is one continuous curve from origin to destination. Segment kind
(`road | intersection | highway | connector`) rides as metadata and affects only the speed
limit at a given arc position. This is what removes the highway-exit splice, where
`updateHighwayMovement` currently rewrites `smoothPath[0]` and shifts every `cumDist` entry
by a delta.

### Components

**`route.ts`** — `{ points, cumDist, segments }`. Sampling `arc → { x, y, angle }` and
`arc → speedLimit`. The only place that knows a route is a polyline. Highways are segments
with a higher limit and an elevation profile.

It also answers the two queries that today's consumers get by walking `path` and
`pathIndex` directly:

```ts
cellsBetween(route, fromArc, toArc): Iterable<GridPos>
splitAt(route, arc): { travelled: Point[]; remaining: Point[] }
```

These are not incidental. `cellsBetween` is what `Game.tryRemoveRoad` needs (see
*Route-dependency queries* below) and `splitAt` is what `CarRouteLayer` needs to draw the
hovered car's route in two colours. Both are cheap on a route — a binary search in
`cumDist` and a slice — and `splitAt` is strictly better than the current fallback, which
draws a jagged tile-centre polyline when `smoothPath` is empty.

**`lanes.ts`** — every directed grid edge is a **lane** with a stable id; a car at arc `d`
maps to `(laneId, offsetInLane)`. The key is *the lane being occupied*, not the observer's
heading — which is what makes merging traffic mutually visible. Cars are held arc-sorted
per lane, so "nearest car ahead" is a scan forward, and the gap it yields is along-path.

**`headway.ts`** — the Intelligent Driver Model:

```
s*  = s0 + v·T + v·Δv / (2·√(a·b))
acc = a · (1 − (v/v₀)⁴ − (s*/s)²)
```

Returns a bounded acceleration from gap `s`, own speed `v`, closing speed `Δv`. It eases to
a stop rather than snapping to zero as `followingSpeedMultiplier` does, and bounded
acceleration means a car cannot teleport within a tick.

**`obstacles.ts`** — a car's constraint each tick is a single **virtual leader**
`{ arcDistance, speed }`. Five situations collapse into one:

| Situation | Virtual leader |
|---|---|
| Real car ahead in lane | its arc, its speed |
| Must yield at junction | stop line, speed 0 |
| Exit side of junction full | stop line, speed 0 |
| Parked / unloading / refuelling car ahead | its arc, speed 0 |
| Approaching destination | final arc, speed 0 |

Only the nearest is kept. There is exactly **one** deceleration code path in the system.
This replaces `min(followingMult, intersectionMult)`, where two independent mechanisms
could disagree. Row four is the fix for §2: parked cars become first-class obstacles.

**`junction.ts`** — at each junction, collect the cars wanting in, sort them by a **total
order** — already-inside first, then arrival time, then *rechts vor links* among
simultaneous arrivals, then car id as final tiebreak — and greedily admit in that order.
A car is admitted only if its maneuver's conflict points do not overlap an already-admitted
car's, **and** its exit lane has room.

Greedy admission over a total order cannot cycle. We never ask "does A yield to B?"
pairwise; we walk a fixed sequence and only ever admit. *Rechts vor links* shapes the
sequence but cannot deadlock it. `INTERSECTION_DEADLOCK_TIMEOUT` is therefore deleted
rather than retuned.

The exit-clearance check prevents gridlock around a ring of junctions: since no car enters
a junction it cannot leave, the far side always drains.

**`step.ts`** — two passes. Pass one reads frame-start state and computes every
acceleration; pass two integrates and writes. No outcome depends on array position, which
is what makes a seeded sweep reproducible.

After integration each car's arc is hard-clamped to its leader's arc minus a minimum gap.
At the fixed 60 Hz timestep this should never trigger, so in dev builds it **asserts**
rather than silently correcting — model drift becomes a test failure, not a visual glitch.

### Data flow

```
dispatcher      assigns destinations                 (unchanged)
pathfinder      GridPos[] -> PathStep[]              (unchanged)
adapter         PathStep[] -> Route, install in world
traffic.step    world, dt -> new arc positions + events
adapter         arc -> pixelPos, renderAngle, elevationY on Car
CarSystem       drains events -> state transitions
```

The core knows nothing about houses, businesses, fuel or scoring. It reports each vehicle's
new arc position and an event list (`arrived`, `enteredHighway`, `exitedHighway`). Fuel is
deducted by the adapter from the distance the core reports travelled — keeping game rules
out of the simulation, and incidentally ending the current situation where road and highway
fuel are computed by different arithmetic.

**Rerouting** is where this pays off most. Road change → adapter builds the new route →
projects the car's current `pixelPos` onto it for the new `arcDistance`. That is what
`reassignPath` already attempts; the difference is that it will now work, because
`arcDistance` *is* the rendered position rather than a parallel value the renderer ignores.

### Route-dependency queries

`Game.tryRemoveRoad` (`src/core/Game.ts:602-627`) decides whether a road cell can be
removed outright or must be marked pending, by asking which cars still depend on it. It
does this today by walking `car.path`, `car.pathIndex` and `car.outboundPath` directly.
This is gameplay logic, not debug output, and its exact semantics must be preserved:

| Car state | Cells it depends on |
|---|---|
| `GoingToBusiness` | the portion **already travelled** — it must be able to retrace it home |
| `GoingHome` | the portion **remaining** ahead of it |
| `Unloading`, `Refueling` | its **entire** inbound route, retained while parked |

The adapter exposes one predicate, `carDependsOnCell(car, gx, gy)`, implemented over
`cellsBetween` with the arc ranges `[0, arcDistance]`, `[arcDistance, length]` and
`[0, length]` respectively. That replaces the three hand-rolled loops in `Game` and keeps
the asymmetry — travelled versus remaining — stated once instead of re-derived at the call
site.

`outboundPath` disappears as a field: a parked car simply keeps its route installed, and
the `Unloading`/`Refueling` row above is the whole-route case.

### Disposition of existing files

| File | Fate |
|---|---|
| `CarMovement.ts` | Deleted — split into `traffic/step.ts` + adapter |
| `CarTrafficManager.ts` | Deleted — occupancy/intersection maps replaced by `lanes.ts` |
| `CarLeaderIndex.ts` | Deleted — replaced by the arc-sorted lane index |
| `IntersectionConflicts.ts` | Conflict-point geometry moves to `traffic/junction.ts`; the left/right/straight taxonomy and T-intersection gap scan are dropped |
| `CarRouter.ts` | Keeps pathfinding and reroute *decisions*; loses all smooth-path bookkeeping |
| `CarDispatcher`, `CarRefuelingManager`, `CarRescueManager` | Essentially unchanged — game logic, not traffic |
| `CarParkingManager` | Loses its `outboundPath` bookkeeping (four assignments); otherwise unchanged |
| `Car.ts` | Loses the movement fields listed below; gains `routeId` + `arcDistance` |
| `Game.tryRemoveRoad` | Three hand-rolled path loops replaced by `carDependsOnCell` |
| `CarRouteLayer` | Route drawing switches to `splitAt`; the dual smooth/grid code path collapses to one |
| `RoadDebugLayer` | Debug overlay rebuilt on the same two queries |

`Car` fields removed: `path`, `pathIndex`, `segmentProgress`, `outboundPath`,
`smoothPath`, `smoothCumDist`, `smoothCellDist`, `intersectionWaitTime`,
`sameLaneWaitTime`, `stuckTimer`, `lastAdvancedPathIndex`, `wasBlocked`, `leaderId`,
`leaderGap`, `currentSpeed`, `arrivalTime`, `highwayPolyline`, `highwayCumDist`,
`highwayProgress`, and `direction` — the last of these is written twice in `CarMovement`
(`CarMovement.ts:48`, `CarMovement.ts:111`) and read nowhere.

`Car` fields retained: `id`, `color`, `homeHouseId`, `state`, `targetBusinessId`,
`destination`, `renderAngle`, `prevRenderAngle`, `pixelPos`, `prevPixelPos`, `elevationY`,
`prevElevationY`, `onHighway`, `unloadTimer`, `hasLoad`, `fuel`, `fuelCapacity`,
`targetGasStationId`, `refuelTimer`, `postRefuelIntent`.

### Constants

Retired, all currently module-level and non-configurable: `CAR_MIN_GAP`,
`CAR_COMFORT_GAP`, `INTERSECTION_STOP_DIST`, `INTERSECTION_DECEL_DIST`,
`INTERSECTION_DEADLOCK_TIMEOUT`, `T_INTERSECTION_GAP_TIME`, `UNIVERSAL_STUCK_TIMEOUT`.

The new IDM parameters (`s0`, `T`, `a`, `b`) replace them at the same level — module
constants, not `GameConstants` keys. `CAR_SPEED` and `HIGHWAY_SPEED_MULTIPLIER` remain the
only map-overridable traffic keys.

Consequence: `GameConstants`, the zod wire schema, and every existing map file are
untouched, and `constants.test.ts` continues to pass unchanged.

`INTERSECTION_SPEED_MULTIPLIER` survives as a route-segment speed limit.

### Public API

`src/index.ts` is untouched, and `Car` remains exported.

`CarLayer` needs no changes — it reads only `pixelPos`, `prevPixelPos`, `renderAngle`,
`elevationY`, `color` and `state`, all retained.

`CarRouteLayer`, `RoadDebugLayer` and `Game.tryRemoveRoad` **do** change, because they
reach into `path`/`pathIndex`/`outboundPath` today. They move to `splitAt` and
`carDependsOnCell`. This is internal — all three live inside the engine — so the package's
public surface is unaffected; but it is more than a mechanical rename and the plan must
budget for it.

An external consumer that reads `Car.path` would break. Nothing documents that field as
supported, `Car` is exported "for debug/inspection UI, not for construction", and the
website is the only consumer today — worth a grep there before release, and a minor
version bump rather than a patch.

### Failure handling

| Situation | Behaviour |
|---|---|
| No path to destination | `Stranded` — the one legitimate use of the state |
| Road deleted under a moving car | Adapter rebuilds route, projects `pixelPos` onto it. If the car is near no road, strand **in place** — no teleport to tile centre |
| Destination building removed | Existing dispatcher/parking logic, unchanged |
| Degenerate route (< 2 points, zero-length segments) | Rejected at construction by the adapter |
| `PendingDeletionSystem` cells | Preserved: `GoingHome` cars may still traverse pending cells; becomes a route-segment flag |

The core's contract is that it receives well-formed routes. Validation lives in the
adapter, so the simulation carries no defensive branches — the split `src/terrain/` uses.

`CarRescueManager` and the `Stranded` state survive but shrink to "no path exists".
`UNIVERSAL_STUCK_TIMEOUT` is deleted: a stall is a bug to be caught by the property test,
not a condition to be papered over at runtime.

Dev-only assertions gated behind `CAR_DEBUG`: arc distance never decreases and never
advances more than `maxSpeed · dt`; no two cars on a lane closer than the minimum gap; no
car admitted to a junction whose conflict point is already claimed. Compiled away in
production; always on in tests.

### Testing

*Unit* — IDM properties (larger gap ⇒ non-decreasing acceleration; a stopped leader at
exactly `s0` yields zero speed; acceleration always within `[−b, a]`), route sampling
round-trips, lane mapping, junction admission.

*Invariant sweeps* — seeded worlds run for simulated minutes with assertions live: minimum
pairwise gap positive every tick, no car stalled beyond 15 s, arc travel monotonic. Uses
`mulberry32` from `src/utils/rng.ts`, as `ObstacleSystem` does, so failures reproduce from
a seed.

*Determinism* — the same seed stepped twice produces identical world state. This is what
keeps the two-pass stepper honest; reintroducing order dependence fails it.

*Regression fixtures* — one per reported symptom: two cars converging on a merge lane; four
cars arriving simultaneously at a four-way; a car queued behind an unloading car; a reroute
triggered mid-segment, asserting position continuity across the swap.

*Route-dependency semantics* — a direct test of `carDependsOnCell` against the table in
*Route-dependency queries*, since that predicate now carries behaviour previously spread
across three loops in `Game`. Getting it wrong deletes a road under a car, or leaves roads
permanently undeletable. It is pure and takes plain data, so it tests cleanly under Node —
which the current loops, sitting inside `Game`, do not.

*Static guard* — a test asserting nothing under `src/traffic/` imports `three`, `Grid`, or
anything DOM-shaped, in the spirit of `constants.test.ts`. This is what stops the pure
boundary eroding later.

**Existing tests that must change.** `src/entities/Car.test.ts` asserts an explicit field
list for `clearPathState`/`resetToIdle` (`Car.test.ts:96-99`) and touches
`intersectionWaitTime`, `wasBlocked` and `arrivalTime` — all removed. `clearPathState` and
`resetToIdle` themselves shrink substantially once route state lives in the world rather
than on the car, so these tests get rewritten against the new field set rather than
patched. `src/systems/CarSystem.test.ts` covers stranded-alert behaviour, which is
preserved; it should keep passing, and if it does not, that is a signal worth stopping on.

## Non-goals

- No change to the map wire format, `GameConstants`, or `src/index.ts`.
- No change to spawning, demand, economy, or scoring.
- No change to pathfinding. `Pathfinder` output remains the input to route construction.
- No traffic lights, stop signs, or multi-lane roads.
- No change to how the designer works.

## Risks

**IDM needs tuning.** `s0`, `T`, `a` and `b` must be tuned for a stylised game at one tile
per second. The tests prove the model is *correct* — no overlap, no deadlock, no jumps —
but not that it *feels* right. Expect a tuning pass in the demo after the model lands.

**Conflict-point geometry at diagonals.** Roads support diagonal movement, so junction
maneuver curves are not limited to four cardinal approaches. Conflict-point computation
must handle diagonal entries and exits, which is more cases than a cardinal-only junction
model would need.

**Route rebuild cost.** Every road edit reroutes affected cars and rebuilds their routes.
This is already true today; the new route carries more precomputed metadata, so the
rebuild is somewhat heavier. If it shows up in profiling, segment metadata can be computed
lazily on first sample.
