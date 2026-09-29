# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The game engine behind [TinyTire.town](https://tinytire.town), an open-source Mini
Motorways clone. Players draw roads to connect colour-matched houses and businesses on a
grid. Cars pathfind along roads to deliver goods; unmet demand causes game over.

This repository is **the engine only** — no React, no Next.js, no database, no auth. The
website that consumes it lives in a separate, private repository and depends on this one as
`@tinytire/engine`. Anything web-shaped belongs there, not here.

## Commands

- `npm run dev` — Vite dev server for the demo playground (the only way to actually run the game)
- `npm test` — Vitest unit tests (Node, no DOM)
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — oxlint
- `npm run build:demo` — production build of the demo into `dist-demo/`

## The public API boundary

`src/index.ts` is the entire public surface. Everything else is an implementation detail.

Adding an export is a promise; removing one is a breaking change. When a consumer needs
something new, the question to ask first is whether the *right* thing to expose is the
internal it asked for, or a narrower operation that hides it.

**No build step.** The package ships raw TypeScript and consumers transpile it. This is why
`tsconfig.json` carries a "keep in sync" warning — a consumer's own typecheck compiles
these sources under its options, not ours.

## Architecture

### Map System (`src/maps/`)

- **`types.ts`** — `MapConfig`, `ObstacleDefinition`, `GameConstants` types.
- **`schema.ts`** — the zod wire schema. One definition shared by the loader and serializer.
- **`loadMap.ts`** — wire → runtime (`validateMapConfig`). Inverse lives in `serializeMap.ts`.
- **`index.ts`** — `allMaps`, `getMapById()`, `homeBackgroundMap`.
- **Map files** (JSON) — each defines a `MapConfig` with optional predefined obstacles and constant overrides.

Maps can override any gameplay constant via `constants?: Partial<GameConstants>`. They can
also define fixed terrain via `obstacles?: ObstacleDefinition[]`.

### Core Game Loop (`src/core/`)

- **Game** — Central orchestrator. Constructor accepts `(canvas, mapConfig?)`. Calls
  `buildConfig(mapConfig?.constants)` and passes the resolved config to all systems. Has
  `dispose()` for full cleanup.
- **GameLoop** — Fixed-timestep (60Hz) with accumulator pattern.
- **Grid** — Flat array of `Cell` objects. Dimensions configurable via constructor params.
- **DemoGame** — Cut-down, non-interactive instance used as a decorative backdrop.

### Entity Model (`src/entities/`)

Entities (`House`, `Business`, `Car`, `GasStation`) are plain data classes with an `id`
field, grid position, and colour. `Car` carries a state machine (`CarState`), its cargo and
fuel, and the pose it is drawn at — and deliberately *not* its route, its progress along it
or its speed. Those live in the traffic world (see below) and are mirrored back onto the car
once a frame; a car is the render-side view of a vehicle, not a second copy of it.

### Systems (`src/systems/`)

Systems are stateful classes instantiated by `Game`:

- **SpawnSystem** — Spawns houses/businesses over time with increasing frequency.
- **DemandSystem** — Adds demand pins to businesses; triggers game over when max demand exceeded.
- **CarSystem** — Owns cars and their journeys: dispatch, cargo, fuel, score and what
  "arrived" means. Movement itself is simulated by `src/traffic/`, reached through
  `src/systems/car/TrafficAdapter.ts`. `CarSystem.inspect(car)` is the one read-only window
  onto simulated movement (speed, arc, route length, stalled time), surfaced publicly as
  `Game.inspectCar(car)`.
- **RoadSystem** — Manages road placement and deletion. There are no bridges, and roads
  cannot cross water. Islands are reached by highway instead, which validates only its two
  endpoints (`src/input/HighwayDrawer.ts`) and spans whatever lies between them.
- **HighwaySystem / GasStationSystem** — Highway routing and refuelling.
- **ObstacleSystem** — Generates mountains and lakes.
- **PendingDeletionSystem** — Defers road removal until traffic has cleared.
- **MusicSystem / SoundEffectSystem** — Tone.js-based procedural audio.

### Designer (`src/designer/`)

- **MapDesigner** — Designer-mode instance with `loadMapConfig(config)` for loading existing
  maps. `exportConfig()` outputs JSON, `toMapConfig()` creates a playable `MapConfig`.

The designer's *UI* is not here — this class is driven by whatever front end embeds it.

### Pathfinding (`src/pathfinding/`)

A* pathfinder with octile distance heuristic. Results cached and invalidated when roads change.

### Traffic (`src/traffic/`)

Pure, canvas-free continuous car-following — the model that actually moves the cars. The
game hands it routes and reads positions back; it knows nothing about houses, cargo, fuel or
score. `src/systems/car/TrafficAdapter.ts` is the only translator between the two, and
`src/traffic/index.ts` is an internal barrel that `src/index.ts` does not re-export.

A car's position is **one number** — `arcDistance` along a single route curve. While the
simulation is driving a car, `pixelPos`, heading and elevation are derived from that number
every frame by `TrafficAdapter.writeBack` and never written independently, which is what
makes position jumps impossible: there is no second representation to drift out of agreement
with the first. A car the simulation is *not* driving has no arc distance to derive from, so
the game side parks its `pixelPos` on a tile centre directly (`Car`'s constructor and
`resetToIdle`, and `CarDispatcher` when it stations a car at its house).

A route spans road and highway alike; segment kind affects only the speed limit and, for
highway, an elevation profile. So there is no separate highway integrator and no splice at
the junction between the two.

Three properties are worth knowing, because none is visible from any one file:

- **Following and junctions cover the space only together.** A lane is a *directed* edge, so
  two cars converging on a cell from different approaches are invisible to each other as
  leader and follower — but a merge implies three or more connections at that cell, which
  makes it an intersection, and junction admission serialises them there. Neither mechanism
  is complete alone.

  "Three or more connections" is counted over **all eight** directions, in
  `Grid.recomputeIntersectionFlags`. It was cardinal-only for the whole of this rebuild,
  which meant a cell wired `Left | Right | UpLeft` — a genuine three-way merge, since
  diagonals are first-class in `RoadSystem`, `RoadDrawer` and `Pathfinder` alike — scored 2,
  stayed plain road, and fell outside *both* mechanisms at once. Measured on the fixture in
  `TrafficAdapter.test.ts`: two cars sat inside the same merge cell for 47 consecutive ticks
  and closed to 9.79px, against a 12px car length. Do not reintroduce a cardinal-only count.

  What the pair still does not cover, in decreasing order of how much it matters:

  - A route that **begins inside a junction cell** has no approach to yield on and no entry
    direction, so `step.ts` offers no candidate for it and imposes no stop line, and the
    vehicle crosses unregulated. `TrafficAdapter.describeCell` strips
    `SegmentKind.Intersection` on a span start for the same reason, which also covers the
    second shape of it: a junction opening the grid span *after* a highway crossing. Both
    sites say so. It is bounded — one cell, at the start of a route — and consistent, so it
    cannot strand anybody.
  - **Two diagonal roads that cross without sharing a cell** — `(3,3)-(4,4)` against
    `(4,3)-(3,4)` — intersect geometrically while touching no common cell, so no junction
    exists to admit at and no lane is shared. Nothing in `src/traffic/` prevents this; what
    prevents it is `isDiagonalCutAllowed` in `RoadPlacementPathfinder`, which both
    `RoadDrawer` and the road-placement A* consult, so it cannot be drawn in play. It can
    still be *loaded*: `applyMapConfig` restores a saved `connections` mask verbatim without
    re-checking, so a hand-edited map file could carry one.

  Do not assume the coverage is total when deciding whether some new path needs regulating.
- **Junction admission is greedy over a total order, per junction *region*** — a region
  being a maximal set of 8-adjacent intersection cells (`junctionComponents`), admitted as
  one unit. Within a region the greedy order cannot deadlock and needs no escape timeout;
  *rechts vor links* shapes the order but cannot cycle it. The old model's
  `INTERSECTION_DEADLOCK_TIMEOUT` and `UNIVERSAL_STUCK_TIMEOUT` existed to break cycles
  that this construction cannot produce, and were deleted with it.

  Regions, not cells, because the per-junction guarantee says nothing *across* junctions,
  and adjacent junction cells couple geometrically: a stop line rests a car
  `STOP_LINE_SETBACK` before the boundary — inside the *previous* cell — so with two
  adjacent junction cells, each one's stop line lies inside the other's box. The first
  deadlock the demo's freeze watchdog ever captured was exactly that: two opposing cars,
  each regularly admitted through its first cell, each at rest at the second one's line
  inside the box the other needed, each holding it with the absolute priority `inside`
  demands — and no reroute could help, because the block was the cars' physical positions.
  Region admission removes the state: a car enters only when it can traverse the whole
  region, so every rest position is on plain ground — the cell before a region's entry
  cannot itself be a junction cell, or it would be *in* the region. Reproduced and pinned
  in `adjacentJunctions.test.ts`; candidates carry one maneuver per cell
  (`CellManeuver[]`), and conflict is any shared cell with conflicting chords.

  The guarantee covers only what the order decides, and `exitHasRoom` runs *before* the
  order — a candidate with no exit room is skipped unconditionally — so a mistake there
  deadlocks despite it. It happened: room was asked of the exit **cell**, cells are shared
  by both directions of a two-way road, and a car waiting at a stop line rests ~`s0`
  inside the oncoming car's exit cell. Two cars stopped at one junction from opposite
  sides therefore denied each other forever — maneuvers that do not even conflict — and
  one transient yield on any two-way road set it up, which is how whole boards froze with
  a handful of cars. Room is now asked of the directed exit **lanes** (`laneKeyForEdge`,
  the leader search's own definition), and asked by **measurement**: the nearest stopped
  vehicle on the two edges leaving the region must leave space for a full car to rest with
  its rear past the boundary (`EXIT_REST_MARGIN` absorbs the measurement's known errors).
  The binary form of that test held queues a whole junction back of a blockage while a
  tile of packable road stood empty, and scanned only the farther of the two exit edges,
  which made a car stopped just past the boundary invisible and admitted entrants into a
  rest position tail-in-the-box; both are pinned in `step.test.ts`. The two-way case is
  pinned at the adapter, on real lane geometry (`keeps four two-way streams flowing` in
  `TrafficAdapter.test.ts`).
- **Deceleration is computed once, at one site.** Every reason to slow down — a leader, a
  junction stop line, a route end — is collapsed into a single virtual leader and fed to IDM
  (`headway.ts`). Two independently-tuned ramps combined with `Math.min` was the old model
  and the source of its disagreements about how hard to brake.

`STALL_WATCHDOG_SECONDS` (`tuning.ts`) is *not* a deadlock escape: it is a report. After 12s
of unchosen standstill the adapter emits `Blocked` and the game decides whether to reroute or
strand — the remedy is game-side, so the threshold lives at the seam, not in the model.

**Debugging a frozen board.** `diagnose.ts` explains every standstill in the stepper's own
terms — it replays the tick's `junctionDecisions` and reads `nearestConstraint`'s identity
fields, so the reason reported ("behind car-3", "junction (4,2) no-exit-room by [car-7]") is
the decision the stepper acted on; it names any waits-for cycle outright, which is a
deadlock by construction, and lists any vehicle pair closer than a car length in world
space, which is how a visual overlap report becomes attributable. `snapshot.ts` serializes the whole world to JSON and restores it
tick-for-tick identical. The demo wires both (`demo/trafficDebug.ts`): a freeze auto-captures
once after 5s and `window.dumpTraffic()` captures on demand, stashing the snapshot on
`window.__lastTrafficDump`. The workflow for any future deadlock: copy that JSON, save it as
a fixture, load it with `deserializeWorld` in a test, and `step`/`diagnoseWorld` the exact
frozen state under Node. `Game.dumpTraffic()` is the public tap.

Nothing here imports Three.js or `Grid`, enforced by `src/traffic/purity.test.ts`, so the
whole model is exercised directly by the Node-only suite.

### Terrain (`src/terrain/`)

Pure, canvas-free geometry. Terrain cells become a coverage field, then a signed distance
field, then marching-squares isolines, and finally nested terrace polygons.

Two properties are worth knowing. Terrace count derives from how thick a landform actually
is — the deepest point of its distance field — and never from how many cells it contains, so
a long thin ridge cannot be assigned rings it has no room for. And holes nest to any depth,
resolved by containment parity rather than a single inside/outside test, which is what makes
a lake with an island in it, or a mountain with a crater, expressible at all.

`rendering/layers/` consumes this via `src/terrain/index.ts`. That barrel is internal:
`src/index.ts` does not re-export any of it. Nothing under `src/terrain/` imports Three.js,
so the whole pipeline is exercised directly by the Node-only suite.

### Rendering (`src/rendering/`)

Three.js with orthographic top-down camera. Layers: TerrainLayer, RoadLayer, BuildingLayer,
CarLayer, HighwayLayer, SceneryLayer.

**Scenery** (trees, bushes, pebbles) is decoration only. `scenery.ts` plans it once per
renderer from a random seed — pure, Node-tested — and `SceneryLayer` only toggles visibility
afterwards: an item shows while its cell is `CellType.Empty` and no highway passes over it.
The refresh piggybacks on `markGroundDirty`, which every cell-changing edit already raises,
so building clears the land and erasing lets it grow back. Its colour is the theme's
`foliage` key.

The ground texture is a `CanvasTexture` painted in sRGB hex colours, so it must carry
`colorSpace = SRGBColorSpace`; without it the ground is encoded twice and washes out to grey.
`Game` and `DemoGame` apply the resolved colour theme — defaults included — *before*
`rebuildTerrain`, because terrain colours are baked into materials at build time.

### Input (`src/input/`)

- **InputHandler** — Tracks mouse state and converts screen coords to world coords.
- **RoadDrawer / HighwayDrawer / GasStationPlacer** — Translate input gestures into operations.
- **UndoSystem** — Undo stack for road edits.

### Key Patterns

- **Configurable constants**: `buildConfig(overrides?)` merges map-specific overrides over
  defaults. A key that a map may override must **never** be imported as a module constant —
  `src/constants.test.ts` enforces this statically, including through re-exports.
- **Dirty flags**: Systems set `isDirty` after mutations for downstream updates.
- **Coordinate spaces**: Grid coords (`gx`, `gy`), pixel coords (grid × `TILE_SIZE`), screen coords.
- **Enums as const objects**: `GameState`, `CellType`, `Direction` use `as const` objects.
  `erasableSyntaxOnly` is on, so real `enum`s are not available.
- **Seeded generation**: `ObstacleSystem` takes an optional generation seed driving
  `mulberry32` (`src/utils/rng.ts`) rather than calling `Math.random()` directly. Unseeded
  construction still randomises, so gameplay stays varied; the seed exists so generated
  terrain can be asserted on in tests. It is **not** a wire-format field — maps do not carry
  one.
- **No dependency injection or ECS**: Systems directly instantiated in `Game`'s constructor.

### Configuration

Game balance constants centralised in `src/constants.ts`. Rendering constants (colours,
sizes) also in `constants.ts`.

Traffic tuning is the exception and lives in `src/traffic/tuning.ts`, not in `constants.ts`:
it is engine-wide *feel* rather than a per-map setting, so none of it may become a
`GameConstants` key. Each value there records the measurements that bracket it, because a
number defensible only by observation is not defensible from the code.

## Testing

Tests are Node-only: no DOM, no WebGL. Much of the engine is only observable through `Game`,
which needs a canvas, and that behaviour is still verified by running the demo rather than by
a test.

What the suite does cover is everything reducible to data: the map format's round trip,
config resolution, the static constants guard, seeded obstacle generation, the terrain
geometry pipeline end to end, and the traffic model in full. The last of those is the reason
`src/traffic/` is pure: because it touches neither canvas nor `Grid`, whole simulated cities
run in Node, and `src/traffic/invariants.test.ts` sweeps them for the properties no unit test
can state — no overlapping cars, no position jumps, no stalls beyond a bound, and identical
output from identical input. Importing Three.js under Node is fine — only the renderer needs
a context — so the layers that merely build geometry are testable too, and are tested.
