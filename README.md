# @tinytire/engine

The game engine behind **[TinyTire.town](https://tinytire.town)** — an open-source Mini
Motorways clone. Draw roads to connect colour-matched houses and businesses on a grid; cars
pathfind along the roads to deliver goods, and unmet demand ends the run.

This repository is the engine and its map editor. The website that wraps it — accounts,
saved maps, the community browser — lives elsewhere and consumes this package.

```
pnpm install && pnpm dev
```

That opens the playground: pick a built-in map, play it, switch to design mode, build
something, export it as JSON. No accounts, no database, no configuration.

## What's in here

| | |
|---|---|
| `src/core` | `Game`, the fixed-timestep loop, and the grid |
| `src/systems` | Spawning, demand, traffic, roads, highways, fuel, audio |
| `src/entities` | Houses, businesses, cars, gas stations |
| `src/pathfinding` | A* with an octile heuristic, cached and invalidated on road changes |
| `src/rendering` | Three.js layers under an orthographic top-down camera |
| `src/input` | Pointer gestures → road, highway, and gas-station operations |
| `src/designer` | `MapDesigner`, the headless half of the map editor |
| `src/maps` | The map file format, its zod schema, and the built-in maps |
| `demo` | The playground you just ran |

## Using it

```ts
import { Game, getMapById } from '@tinytire/engine';

const canvas = document.querySelector('canvas')!;
const game = new Game(canvas, getMapById('classic'));
game.start();

// later
game.dispose();
```

`src/index.ts` is the whole public API — roughly 25 exports. Everything else is internal and
will change without warning. If you need something that isn't exported, open an issue rather
than reaching past the barrel; the odds are good that the right answer is a narrower export
than the internal you had in mind.

The map editor is available the same way:

```ts
import { MapDesigner, DesignerTool } from '@tinytire/engine';

const designer = new MapDesigner(canvas);
designer.start();
designer.setTool(DesignerTool.House);
const json = designer.exportConfig();
```

### Maps

A map is JSON, validated by a zod schema (`src/maps/schema.ts`) on the way in and out. It can
place terrain, roads, and buildings, and it can override any gameplay constant:

```jsonc
{
  "id": "my-map",
  "name": "My Map",
  "description": "…",
  "obstacles": [{ "gx": 12, "gy": 8, "type": "mountain" }],
  "constants": { "SPAWN_INTERVAL": 45, "STARTING_ROADS": 60 }
}
```

`validateMapConfig(json)` turns untrusted JSON into a runtime `MapConfig`, throwing with a
readable description of every problem it found.

## Consuming this package

Install it straight from git:

```jsonc
"dependencies": {
  "@tinytire/engine": "github:rgb3000/tinytire.town.game-engine#v0.1.0",
  "three": "^0.185.1",
  "tone": "^15.1.22"
}
```

`three` and `tone` are **peer** dependencies — install them yourself. If they were regular
dependencies you could end up with two copies of Three.js, and `instanceof` checks inside it
start failing in ways that are very hard to trace.

Three things are worth knowing before you adopt it:

**It ships raw TypeScript.** There is no build step and no `dist/`. Your bundler compiles the
sources. In Next.js that means one line:

```ts
// next.config.ts
transpilePackages: ['@tinytire/engine']
```

Vite needs nothing. The upside is that your own `tsc --noEmit` genuinely type-checks across
the boundary instead of trusting a generated `.d.ts`.

**Bundler resolution only.** Internal imports are extensionless and the built-in maps are
imported as JSON, so this needs `moduleResolution: "bundler"` and a bundler that loads JSON —
Vite, Next, esbuild. It will not run under native Node ESM without changes.

**Browser only, client side only.** The engine touches no DOM at module scope, and defers
`AudioContext` until a user gesture. But Tone.js is imported at module scope by the audio
systems and touches audio globals on import, so load the engine client-side. Under Next.js,
that means `dynamic(..., { ssr: false })`.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The engine is
young enough that the API is still allowed to move; nothing here is frozen yet.

## Licence

MIT
