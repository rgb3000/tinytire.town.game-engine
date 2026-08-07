# Terrain Rebuild: Mountains and Water

**Date:** 2026-08-07
**Status:** Approved, not yet implemented

## Problem

Generated mountains render as jagged, self-intersecting shapes. Lakes read as flat — no
sense of depth — and a lake cannot contain an island. The faults are structural, not
cosmetic: three of them live in the geometry pipeline shared by both features.

### 1. The boundary walker tangles

`chainSegments` (`src/rendering/layers/terrainContourUtils.ts:118`) is a greedy segment
walker with no vertex-degree handling. Where four boundary segments meet one vertex —
diagonally touching tiles, or triangle quadrants meeting at a cell centre — it picks a
continuation arbitrarily. Chains cross themselves and are not guaranteed to close.

Free-form painting in the designer makes this the common case, not the edge case: a
diagonal brush stroke, a one-tile wall, two tiles touching at a corner, or a painted ring
all produce such vertices.

### 2. Only one loop per cluster survives

Both layers sort loops by length and use `loops[0]`, discarding the rest
(`ObstacleLayer.ts:50`, `LakeLayer.ts:41`). Interior loops are silently dropped. This is
the direct cause of "no islands in water" — the hole is computed and then thrown away.

### 3. Terraces collapse

`insetLoop` (`terrainContourUtils.ts:229`) is a naive per-vertex miter offset with no
self-intersection removal. Terrace count comes from `getTerraceCount(cluster.length)` —
cell *count*, not shape *width* — so a 30-cell ridge two tiles wide is assigned six
terraces and inset up to 1.2 tiles inward. The loop folds inside out. This is the spiky
geometry.

### Secondary findings

- `mountainHeightMap` is generated, written on every painted cell in the designer, and
  serialized to map JSON — and the renderer ignores it entirely. It is dead data. Note it
  is not a height *brush*: `MapDesigner.ts:417` assigns a random value per painted cell.
- `TerrainLayer` carries its own duplicate of `getTriFlags` and a parallel lake-path
  builder (`TerrainLayer.ts:183`) for punching alpha holes in the ground texture.
- CLAUDE.md describes `RoadSystem` as managing "road/bridge placement". There are no
  bridges in the codebase; `grep -r bridge src/` returns nothing. Lakes are pure obstacles.

## Decisions

| Question | Decision |
|---|---|
| Scope | Rendering **and** generation. Wire format unchanged. |
| Mountain look | Terraced contours, with correct maths underneath. |
| Water depth | Terraces **plus** a shore-to-centre colour gradient. |
| Islands | Full generality — holes in lakes *and* mountains, nested to any depth. |
| Unreachable land | No guard needed. See below. |
| Terrain character | Coherent landforms, not scattered blobs. |
| `height` field | Dropped. Terracing is purely width-driven. |

### Why no unreachable-land guard

`SpawnSystem.ts:404` already restricts spawning to `CellType.Empty`, so buildings never
land on mountain or water. Enclosed plain ground is reachable because highways only
validate their two *endpoints* (`HighwayDrawer.ts:224`) — the span crosses anything. A
player reaches an island by dropping a highway endpoint on it. Islands are a gameplay
feature, not a hazard.

## Approach

Replace boundary-extraction-plus-offsetting with **distance field plus marching squares**.

Rejected alternatives:

- *Fix the walker, add a real offsetter.* Preserves the tile-crisp silhouette, but robust
  polygon offsetting with self-intersection removal is the hard part of computational
  geometry and is precisely what the current code gets wrong. The realistic path is a
  runtime dependency (`clipper2-js`), which is a real cost given the package ships raw
  TypeScript with no build step.
- *Minimal repair* — render all loops, clamp inset to the inradius. Two small edits, fixes
  the worst symptoms, but the walker still tangles and nested holes stay out of reach.

The chosen approach is the only one where sane silhouettes, islands, and depth are
consequences of the representation rather than three separate features. It deletes more
code than it adds.

## Architecture

A new `src/terrain/` module holds the cells-to-geometry pipeline as pure, canvas-free
functions. This is the structural point of the rebuild: the geometry maths currently lives
in `rendering/layers/`, which the Node-only test suite cannot reach, so none of it has ever
been verified.

```
grid cells (+ triangle quadrants)
        |
        v
  coverage field      rasterise at 4x subcell -> Float32Array 320x200
        |             (a quadrant is partial coverage - no special case)
        v
  distance field      two-pass chamfer transform; each sample's distance
        |             to the nearest non-terrain sample
        v
  isoline loops       marching squares at N thresholds -> closed, oriented loops
        |
        v
  nested polygons     winding sign -> outer vs hole; containment -> nesting
        |
        v
  terrace levels      per level: a list of { outer, holes } polygons,
                      ready to extrude
```

Subcell resolution (4x) is a module constant in `field.ts`, not a tunable map constant.
A single terrace level holds *many* polygons: disjoint landforms are separate entries, and
marching squares handles them in one pass over the whole field. There is no clustering
step.

| File | Responsibility | Depends on |
|---|---|---|
| `src/terrain/field.ts` | cells + triangles -> coverage field | `types`, `constants` |
| `src/terrain/distanceField.ts` | coverage -> distance transform | field output only |
| `src/terrain/marchingSquares.ts` | field + threshold -> closed loops | field output only |
| `src/terrain/polygons.ts` | orientation, hole nesting, simplification | nothing |
| `src/terrain/contours.ts` | orchestrates the above -> terrace levels | the other four |

Each takes plain arrays and returns plain arrays. None imports Three.js.

### The two load-bearing properties

1. **Terrace count derives from the distance field's maximum, not cell count.** A shape can
   hold only as many steps as it has thickness. The collapse bug becomes unrepresentable:
   there is no inward march to overshoot. Step *height* stays a fixed per-layer constant
   (mountains 12, water 4, as today) — only the *number* of steps varies with width. This
   is what "purely width-driven" means: a wide massif is tall because it has many steps, not
   because its steps are taller.
2. **Marching squares emits closed, correctly-wound loops**, resolving saddle cases by
   rule. Nesting to arbitrary depth falls out of winding sign and containment, so
   lake-with-island and mountain-with-crater are the same code path as a plain blob.

### Fidelity rule

The **outer silhouette** is traced at the field's zero level with **no blur applied to the
coverage field**, and simplified with a Douglas-Peucker tolerance of at most a quarter
subcell. Inner terraces may use a wider tolerance. This is what keeps painted shapes
recognisable: a painted wall stays a wall, a painted square stays
square with softened corners, half-tile diagonals stay diagonal. Only **inner terraces** are
smooth, being isolines of distance. Crisp footprint, soft interior.

### Deleted

`terrainContourUtils.ts` is deleted in full: `collectBoundarySegments`, `chainSegments`,
`roughSmooth`, `insetLoop`, and `findClusters`. Clustering is no longer needed anywhere —
marching squares handles disjoint components in a single pass over the field, and generation
already knows each landform's identity from its seed. `TerrainLayer` carries a second,
duplicate copy of `findClusters` (`TerrainLayer.ts:12`); that goes too.

## Generation

Replace `growCluster`'s random frontier walk with seeded, noise-shaped landforms. The
current algorithm picks a random seed then repeatedly picks a uniformly random frontier
cell — a random-walk blob, which is what produces tendrils and one-tile spurs.

1. **Place seeds.** Poisson-disc sample `MOUNTAIN_CLUSTER_COUNT` / `LAKE_CLUSTER_COUNT`
   points so landforms spread rather than clump.
2. **Grow by noise-modulated radial falloff.** A cell joins when
   `falloff(distance to seed) + noise(cell) > threshold`. Radius comes from target area
   (`MIN_SIZE`..`MAX_SIZE`); noise perturbs the boundary, producing bays, peninsulas and
   occasional detached satellites.
3. **Interior dips become islands.** Where noise pushes an interior cell below threshold the
   landform gets a hole — which the new renderer draws instead of discarding.
4. **Guarantee islands.** Chance alone makes them rare. `LAKE_ISLAND_CHANCE` forces an
   interior peak in lakes above a size threshold. Boundary noise frequency is
   `TERRAIN_NOISE_SCALE`.

**Masks replace rejection sampling.** `OBSTACLE_EDGE_MARGIN` and
`OBSTACLE_CENTER_EXCLUSION` become smooth falloff multipliers on the field rather than hard
seed rejection, so terrain fades near the border and spawn area instead of stopping at a
straight invisible line.

**`hasAdjacentObstacle` is removed.** Mountains and lakes may sit adjacent — a range meeting
a shore is the point of coherent landforms. They may not overlap; a cell is one or the other.

**Seeding.** `ObstacleSystem` takes an optional seed driving a `mulberry32` PRNG in a new
`src/utils/rng.ts`, replacing bare `Math.random()`. This is what makes generation testable:
pin the seed, assert the output. Unseeded construction still randomises, so gameplay stays
varied. The seed is a **constructor parameter, not a wire-format field**. A per-map seed is
a reasonable follow-up and is explicitly out of scope here.

## Rendering

`ObstacleLayer` and `LakeLayer` are near-identical today — same terracing, same shoreline
ring, same dispose logic, differing only in direction and colour ramp. A new
`src/rendering/layers/terrainMesh.ts` takes terrace levels and builds the extruded stack;
each layer supplies direction, step height, and a colour function. Both shrink to roughly
configuration.

- **Holes reach `THREE.Shape` correctly.** `shape.holes` is populated from the nested
  polygon structure instead of a guessed inset loop, so `ExtrudeGeometry` triangulates a
  lake-with-island properly.
- **The shoreline ring stops being an outset.** It becomes an isoline at a small negative
  threshold — the same machinery as every other contour, rather than
  `insetLoop(loop, -width)` with its own failure modes.
- **Water gets a vertex-colour depth ramp.** Per-vertex distance-to-shore feeds vertex
  colours with `vertexColors: true`, so depth reads even on a small lake supporting only one
  geometric step. It shallows correctly around an island, the island edge being a zero point
  in the same field.

### Ground-texture holes must share the contour source

`TerrainLayer` punches transparent holes in the ground texture for water to show through,
using its own duplicate of `getTriFlags` and a parallel path builder (`TerrainLayer.ts:183`).
If that silhouette and the water mesh silhouette disagree at all, seams appear. It must
consume the same contour output. This also means the 2D path needs hole support, so the
ground is **not** punched away under an island.

### Dispose

Unchanged. The current contract — material loop above the `group` guard, so a build that
bails out on zero cells still frees the prior build's materials — is correct and is
preserved.

## Compatibility

- **Public API unchanged.** Nothing in `src/index.ts` moves.
- `MOUNTAIN_CLUSTER_COUNT` and `LAKE_CLUSTER_COUNT` keep their names and their meaning as
  *how many landforms*. The `0` in `narrow-pass`, `lakeland` and `traffic-stress-test` still
  means "none". (Those overrides are already redundant — `placePredefined` returns early
  when `obstacles` is present.)
- `MIN_SIZE`/`MAX_SIZE` become target-area bounds rather than exact cell counts. Same
  intent, softer edges.
- `classic` is the only built-in map whose appearance changes. It is the map exhibiting the
  reported problem.
- New `GameConstants` keys — `LAKE_ISLAND_CHANCE` (probability a qualifying lake is forced
  to contain an island) and `TERRAIN_NOISE_SCALE` (spatial frequency of the boundary noise;
  lower is smoother) — must be added to
  `DEFAULT_GAME_CONSTANTS`, the `GameConstants` type, **and** the zod `constants` schema,
  which is strict by design. Per `src/constants.test.ts` they must be read only through the
  resolved `cfg`, never imported as module constants.
- `height` is retained in the zod schema and on `MapConfig` as deprecated-and-ignored, so
  existing maps keep loading and the website's types are unaffected. It is no longer
  written or read.

## Removals

- `mountainHeightMap` and `getMountainHeightMap()` from `ObstacleSystem`.
- The two random-height writes in `MapDesigner` (`:417`, `:556`) and the height read at
  `:733`.
- `height` emission from `serializeMap`.
- `hasAdjacentObstacle` and `growCluster` from `ObstacleSystem`.
- `src/rendering/layers/terrainContourUtils.ts` in full, and `TerrainLayer`'s duplicate
  `findClusters` and `getTriFlags`.

`ObstacleSystem` is not exported from `src/index.ts`, so none of this is a public break.

## Testing

Everything in `src/terrain/` is pure functions over arrays, so this geometry becomes
testable in Node with no canvas — for the first time.

**Field:** a full cell covers 1.0; a single quadrant covers approximately 0.25; diagonal
quadrant orientation is correct.

**Distance transform:** known values on small hand-checked grids.

**Marching squares:** every emitted loop is closed; a painted square traces a square; a
painted ring traces two loops of opposite winding.

**Polygons:** a ring yields one hole; a ring-in-ring yields nesting depth 2; simplification
never drops a loop below 3 points.

**Contours — direct regression tests for the reported faults:**

- a single cell yields one terrace and does not collapse
- a two-wide ridge yields two or three terraces, not six
- a painted square's outer loop stays within tolerance of its painted bounds
- a painted ring renders as a ring, not a filled disc

**Generation:**

- same seed produces identical cells
- count `0` produces no cells
- a forced island produces a hole
- mountains and lakes never overlap
- edge margin is respected

**Degenerate cases:** an empty cell list builds nothing while `dispose` still frees
materials; loops under 3 points after simplification are skipped.

**Visual confirmation** stays per repo convention — `npm run dev` across `classic`,
`lakeland`, `narrow-pass`, plus free-painting mountains and water in the designer.

## Performance

Grid is 80x50 (`constants.ts:4`). At 4x subcell that is 320x200 = 64,000 samples. A two-pass
chamfer distance transform is linear and runs in well under a millisecond.
`MapDesigner.rebuildObstacles()` rebuilds all terrain on every brush stroke
(`MapDesigner.ts:618`) and continues to do so comfortably. Incremental per-cluster rebuild
is possible later but is not needed and is out of scope.

## Out of scope

- Per-map generation seed in the wire format.
- Bridges, or any way for roads to cross water.
- Incremental terrain rebuild in the designer.
- Animated water surface.
- Correcting CLAUDE.md's stale "road/bridge placement" line (worth doing, unrelated).
