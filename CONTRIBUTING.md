# Contributing

Thanks for taking a look. This is a small project and the bar is not high — a clear bug
report is a real contribution.

## Getting set up

```
pnpm install
pnpm dev
```

That's the whole setup. The playground at `localhost:5173` runs the game and the map editor
against the local sources; there is no database, no API keys, and nothing to configure.

## Before opening a pull request

```
pnpm typecheck
pnpm lint
pnpm test
```

CI runs exactly these three, plus a demo build. All four must pass.

## How the code is laid out

`CLAUDE.md` has the architecture tour — systems, the fixed-timestep loop, coordinate spaces,
the map format. Worth ten minutes before a first change.

Two conventions cause most of the surprises:

**Configurable constants.** A constant a map is allowed to override must never be imported
as a module constant — it has to be read from the resolved config that `buildConfig()`
produces. Otherwise the map sets it and nothing happens. `src/constants.test.ts` enforces
this statically and will fail your build if you slip, including via a re-export.

**The public API is `src/index.ts` and only that.** Consumers import from there. If your
change needs to expose an internal, say so in the PR — often the better export is a narrower
operation than the thing you were reaching for.

## Testing

Tests run in Node with no DOM and no WebGL. That limits what can be tested directly: most of
the engine is only observable through `Game`, which needs a canvas. So the suite covers what
can be checked honestly — the map format's round trip, config resolution, and the constants
guard.

If your change is in rendering, input, or traffic behaviour, there is probably no test to
write. Verify it in the playground and say in the PR what you did to check it. "I built a map
with three gas stations and watched cars refuel at each" is more useful than a test that only
asserts the mock was called.

## Scope

The engine is deliberately free of web-shell concerns. Accounts, saved maps, the community
browser, and anything database-shaped belong to the website, not here. A change that needs
the engine to know about users or persistence is probably a change to the wrong repository —
open an issue and let's talk about where the seam should be.

## Licence

Contributions are accepted under the MIT licence, same as the rest of the project.
