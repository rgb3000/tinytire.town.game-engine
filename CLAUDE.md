# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Conventions

Do not include a `Co-Authored-By` line in commit messages. Do not commit without asking.

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
field, grid position, and colour. Cars have state machines and track their path as
`GridPos[]` arrays.

### Systems (`src/systems/`)

Systems are stateful classes instantiated by `Game`:

- **SpawnSystem** — Spawns houses/businesses over time with increasing frequency.
- **DemandSystem** — Adds demand pins to businesses; triggers game over when max demand exceeded.
- **CarSystem** — Moves cars along paths, handles lane-based traffic.
- **RoadSystem** — Manages road/bridge placement and deletion.
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

### Rendering (`src/rendering/`)

Three.js with orthographic top-down camera. Layers: TerrainLayer, RoadLayer, BuildingLayer,
CarLayer, HighwayLayer.

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
- **No dependency injection or ECS**: Systems directly instantiated in `Game`'s constructor.

### Configuration

Game balance constants centralised in `src/constants.ts`. Rendering constants (colours,
sizes) also in `constants.ts`.

## Testing

Tests are Node-only: no DOM, no WebGL. Most of the engine is only observable through `Game`,
which needs a canvas — so the suite covers the map format's round trip, config resolution,
and the static constants guard. Behaviour that needs a canvas is verified by running the
demo, not by a test.
