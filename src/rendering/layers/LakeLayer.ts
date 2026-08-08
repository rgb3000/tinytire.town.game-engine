import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { GROUND_Y_POSITION, LAKE_COLOR, LAKE_SHORE_COLOR } from '../../constants';
import { clamp, lerp } from '../../utils/math';
import type { NestedPolygon, TerrainContours } from '../../terrain';
import { buildTerrainContours, worldToSample, sampleFieldBilinear, signedArea, STEP_TILES } from '../../terrain';
import { buildTerraceMeshes, buildFlatRing } from './terrainMesh';

const LAKE_LAYER_HEIGHT = 4;

/**
 * Shoreline width, in *tiles*. `buildTerrainContours` works in tile units, not pixels —
 * handing it the old `TILE_SIZE * 0.15` would ask for a six-tile beach, and `field.ts`'s
 * one-cell padding would clip most of it away without complaining.
 */
const SHORELINE_TILES = 0.15;

/**
 * How far the deepest terrace is blended toward black.
 *
 * The deepest terrace of *any* lake reaches exactly this — see `applyDepthColors` — so this
 * is the one number to turn when the lakebed reads too dark or too washed out.
 */
const MAX_DEPTH_DARKEN = 0.85;

/**
 * How much of one terrace's darkening step the per-vertex ramp may spend inside that terrace.
 *
 * Strictly below 1, which is what leaves a visible tonal step at every terrace edge: the
 * terraces are physical steps with a wall between them, and the banding is the cue that reads
 * as depth under a top-down camera. At 0 the lakebed would be flat plateaus with no gradient;
 * at 1 the ramp would close every step and the banding would vanish.
 */
const INTRA_TERRACE_SHARE = 0.6;

/**
 * A loop this small bounds no visible wall, and extrudes into two coincident, back-to-back
 * faces that z-fight under this layer's `DoubleSide` materials. Same reasoning, and the same
 * absolute world-unit threshold, as `MIN_HOLE_AREA` in `terrainMesh.ts`.
 */
const MIN_LOOP_AREA = 1e-6;

/** Scene name of the shoreline cliff mesh, so it can be picked out when debugging a scene. */
export const LAKE_CLIFF_NAME = 'lake-cliff';

export class LakeLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(scene: THREE.Scene, lakeCells: GridPos[], lakeTriangles?: LakeTriangles, waterColor?: string, shorelineColor?: string): void {
    this.dispose(scene);
    if (lakeCells.length === 0) return;

    // Null means nothing traceable was painted — reachable from the map format, where a cell
    // may carry triangle flags that activate no quadrant at all.
    const contours = buildTerrainContours(lakeCells, lakeTriangles, SHORELINE_TILES);
    if (!contours) return;

    const baseColor = waterColor ? new THREE.Color(waterColor) : new THREE.Color(LAKE_COLOR);
    const earthColor = new THREE.Color(shorelineColor ?? LAKE_SHORE_COLOR);
    this.group = new THREE.Group();

    // Shoreline: the outset contour with the footprint punched out of it.
    if (contours.shoreline.length > 0) {
      const shoreMat = new THREE.MeshPhysicalMaterial({
        color: earthColor.clone(),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this.materials.push(shoreMat);
      const ring = buildFlatRing(contours.shoreline, GROUND_Y_POSITION, shoreMat, contours.levels[0].polygons);
      if (ring) this.group.add(ring);
    }

    const { meshes, materials } = buildTerraceMeshes(contours.levels, {
      // Water steps *down*, and `baseOffset: 0` puts level 0's top face exactly on the ground
      // plane — that face is the water surface.
      direction: -1,
      stepHeight: LAKE_LAYER_HEIGHT,
      baseOffset: 0,
      makeMaterial: () => makeWaterMaterial(),
      decorate: (mesh, levelIndex) => applyDepthColors(mesh, contours, baseColor, levelIndex),
    });

    // Materials come from the builder's own list, not from walking the meshes: one material
    // is shared by every polygon at a level, so mesh-walking would hand `dispose` duplicates
    // and — when a level contributes no mesh — miss one outright.
    this.materials.push(...materials);
    for (const mesh of meshes) this.group.add(mesh);

    const cliffMat = makeCliffMaterial(earthColor);
    this.materials.push(cliffMat);
    const cliff = buildCliffRing(
      contours.levels[0].polygons,
      contours.levels.length * LAKE_LAYER_HEIGHT,
      cliffMat,
    );
    if (cliff) this.group.add(cliff);

    scene.add(this.group);
  }

  /**
   * Drop everything this layer put in the scene — geometries *and* materials.
   *
   * There used to be two methods here: `dispose`, which `build()` calls before rebuilding,
   * and `disposeAll`, which additionally freed the materials. Every material is created
   * inside `build()` and attached to a mesh that lives only inside `this.group`, so the two
   * had identical preconditions and the only difference was whether they leaked. The
   * designer rebuilds terrain on every brush stroke, so the leaking one leaked a full set
   * of GPU material programs per stroke.
   *
   * The material loop must stay *above* the `group` guard: `build()` calls this and then
   * bails out when there are no cells left, which is what happens when you erase the last
   * lake — an early return would strand that build's materials for good.
   */
  dispose(scene: THREE.Scene): void {
    for (const mat of this.materials) mat.dispose();
    this.materials = [];

    if (!this.group) return;
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    scene.remove(this.group);
    this.group = null;
  }
}

function makeWaterMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    // Colour comes from per-vertex attributes, so the material itself stays white.
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.25,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.3,
    side: THREE.DoubleSide,
  });
}

/**
 * The earth wall the water is sunk into.
 *
 * `polygonOffset` is what keeps it in front of the water's own level-0 side wall, which runs
 * along the same contour over the same first step and would otherwise z-fight with it. The
 * alternative — nudging the wall outward along a mitred vertex normal — moves the shoreline
 * off the contour the ground texture's alpha hole is cut from, and mitres blow up on the
 * sharp corners a painted lake is full of.
 */
function makeCliffMaterial(earthColor: THREE.Color): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: earthColor.clone(),
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/**
 * A vertical skirt hanging from the water's edge down past the deepest terrace.
 *
 * The ground is a zero-thickness plane and lakes reach it through alpha holes punched in its
 * *texture*, so there is no earth at a shoreline for the water's depth to read against —
 * without this, a lake is a coloured patch floating over nothing. Every loop of the footprint
 * gets a wall, holes included: an island is where the cue matters most, and its shore is as
 * much a cliff as the outer bank is.
 */
function buildCliffRing(
  polygons: NestedPolygon[],
  depth: number,
  material: THREE.MeshPhysicalMaterial,
): THREE.Mesh | null {
  const positions: number[] = [];

  for (const polygon of polygons) {
    for (const loop of [polygon.outer, ...polygon.holes]) {
      if (Math.abs(signedArea(loop)) < MIN_LOOP_AREA) continue;
      addWall(positions, loop, depth);
    }
  }
  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = LAKE_CLIFF_NAME;
  // Same convention as the terraces: `position.y` is the mesh's top edge, and the wall hangs
  // below it in local coordinates.
  mesh.position.y = GROUND_Y_POSITION;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Two triangles per loop edge, in the contour's own world XZ with the drop along -Y.
 *
 * Built directly rather than by extruding an inset copy of the loop: insetting is what folded
 * inside out on narrow shapes, and a wall needs no thickness under a `DoubleSide` material.
 */
function addWall(out: number[], loop: number[][], depth: number): void {
  for (let i = 0; i < loop.length; i++) {
    const [ax, az] = loop[i];
    const [bx, bz] = loop[(i + 1) % loop.length];
    if (ax === bx && az === bz) continue;
    out.push(ax, 0, az, bx, 0, bz, bx, -depth, bz);
    out.push(ax, 0, az, bx, -depth, bz, ax, -depth, az);
  }
}

/**
 * Write a shore-to-bed depth ramp into the mesh's vertex colours.
 *
 * Two terms, and the split is the whole point of this function.
 *
 * The **terrace index** carries the bulk of it. It is uniform across a mesh, so it cannot be
 * washed out by a shortage of vertices — and there is a shortage. `ExtrudeGeometry`
 * triangulates a cap with earcut, which adds no interior points, so a large lake's deepest
 * cap has vertices only around its rim and everything inside that rim interpolates from it.
 * The purely per-vertex ramp this replaces was normalised by `maxDistanceTiles` while
 * `MAX_TERRACES` pinned the deepest contour at 1.5 tiles, so its darkening *fell* as lakes
 * grew — measured at 36% on a 3x3 and 14% on a 12x12. Indexing by terrace instead makes the
 * deepest terrace land on the cap exactly, at every size.
 *
 * The **distance field** then supplies a finer gradient within each terrace, worth at most
 * `INTRA_TERRACE_SHARE` of one step so the step itself survives. Sampling the same field the
 * contours were traced from is what makes the ramp shallow again around an island, whose edge
 * is a zero of that field.
 *
 * `levels.length - 1` is the number of steps between the shallowest terrace and the deepest.
 * A one-terrace lake — a single cell, whose field never reaches `STEP_TILES` — has none, and
 * `Math.max(1, …)` is what keeps that `0 / 0` out of the colour buffer: `NaN` there does not
 * throw, it just renders the water black or white with nothing to point at.
 */
function applyDepthColors(
  mesh: THREE.Mesh,
  contours: TerrainContours,
  baseColor: THREE.Color,
  levelIndex: number,
): void {
  const steps = Math.max(1, contours.levels.length - 1);
  const terraceFloor = levelIndex / steps;
  const rampSpan = INTRA_TERRACE_SHARE / steps;
  // The contour this terrace was traced at, and so the depth its own gradient starts from.
  const terraceDepth = levelIndex * STEP_TILES;

  const position = mesh.geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);

  for (let i = 0; i < position.count; i++) {
    // Contours are built in world XY; rotateX(PI/2) maps that onto world XZ.
    const { sx, sy } = worldToSample(contours.field, position.getX(i), position.getZ(i));
    const depth = sampleFieldBilinear(contours.field, sx, sy);
    const within = clamp((depth - terraceDepth) / STEP_TILES, 0, 1);
    const darken = Math.min(1, terraceFloor + within * rampSpan) * MAX_DEPTH_DARKEN;
    colors[i * 3 + 0] = lerp(baseColor.r, 0, darken);
    colors[i * 3 + 1] = lerp(baseColor.g, 0, darken);
    colors[i * 3 + 2] = lerp(baseColor.b, 0, darken);
  }

  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
