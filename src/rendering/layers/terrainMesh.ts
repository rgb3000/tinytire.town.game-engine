import * as THREE from 'three';
import { GROUND_Y_POSITION } from '../../constants';
import type { NestedPolygon, TerraceLevel } from '../../terrain';
import { pointInPolygon, signedArea } from '../../terrain';

export interface TerraceMeshOptions {
  /** +1 builds upward (mountains), -1 downward (water). */
  direction: 1 | -1;
  stepHeight: number;
  /** 1 puts the lowest mountain step above ground; 0 puts the water surface at ground. */
  baseOffset: number;
  makeMaterial(levelIndex: number, levelCount: number): THREE.MeshPhysicalMaterial;
  /** Hook for per-level extras, e.g. the water depth ramp. */
  decorate?(mesh: THREE.Mesh, levelIndex: number): void;
}

/**
 * A hole this small removes nothing, so it is dropped rather than triangulated.
 *
 * `nestLoops` filters degenerate loops by point count, not by area, so a collinear loop can
 * arrive here bounding no area at all. Three's triangulator survives one — it produces no
 * NaN — but it bridges into the slit anyway, which costs cap triangles and leaves two
 * coincident, back-to-back extruded walls that z-fight under these layers' `DoubleSide`
 * materials. Skipping is the visually identical, cheaper option.
 *
 * The threshold is absolute because contour coordinates are world units, where a tile is
 * tens of units across: 1e-6 square units is far below anything renderable and only trips on
 * loops that are degenerate up to float noise. It also subsumes the point-count guard this
 * replaces — an empty, one-point or two-point loop has zero area by construction — which
 * matters because that guard rejected a legitimate triangular hole.
 */
const MIN_HOLE_AREA = 1e-6;

/**
 * Build a `THREE.Shape` from an outer loop and its holes.
 *
 * The outer loop must bound an area — every producer in `src/terrain` guarantees at least
 * three distinct points. Holes are filtered, since they are not so guaranteed.
 */
export function makeShape(outer: number[][], holes: number[][][]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i][0], outer[i][1]);
  shape.closePath();

  for (const hole of holes) {
    if (Math.abs(signedArea(hole)) < MIN_HOLE_AREA) continue;
    const path = new THREE.Path();
    path.moveTo(hole[0][0], hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }

  return shape;
}

/**
 * Build the stack of extruded terrace rings.
 *
 * Each level punches holes for its own interior loops *and* for the level above nested
 * inside it, so what renders is a ring rather than a stack of overlapping solids. The old
 * code guessed the inner boundary by insetting the outer loop, which is what folded inside
 * out on narrow shapes; here the inner boundary is simply the next contour.
 */
export function buildTerraceMeshes(
  levels: TerraceLevel[],
  options: TerraceMeshOptions,
): { meshes: THREE.Mesh[]; materials: THREE.MeshPhysicalMaterial[] } {
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.MeshPhysicalMaterial[] = [];
  const levelCount = levels.length;

  for (let i = 0; i < levelCount; i++) {
    const above = levels[i + 1]?.polygons ?? [];
    const material = options.makeMaterial(i, levelCount);
    materials.push(material);

    for (const polygon of levels[i].polygons) {
      const shape = makeShape(polygon.outer, [...polygon.holes, ...cutoutsInside(above, polygon)]);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: options.stepHeight,
        bevelEnabled: false,
      });
      // Shape is in XY, extruded along +Z. Rotating lays it into XZ with the extrusion
      // running along -Y, which makes `position.y` the mesh's *top* face.
      geometry.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y =
        GROUND_Y_POSITION + options.direction * (i + options.baseOffset) * options.stepHeight;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      options.decorate?.(mesh, i);
      meshes.push(mesh);
    }
  }

  return { meshes, materials };
}

/**
 * A thin flat ring at a fixed height — used for the shoreline, which is the shoreline
 * contour with the footprint punched out of it.
 */
export function buildFlatRing(
  polygons: NestedPolygon[],
  y: number,
  material: THREE.MeshPhysicalMaterial,
  innerCutouts: NestedPolygon[],
): THREE.Mesh | null {
  if (polygons.length === 0) return null;

  const geometries: THREE.ExtrudeGeometry[] = [];

  for (const polygon of polygons) {
    const shape = makeShape(
      polygon.outer,
      [...polygon.holes, ...cutoutsInside(innerCutouts, polygon)],
    );
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
    geometries.push(geometry);
  }

  // One mesh per contour, parented to the first, so the whole ring moves and is disposed as
  // a unit; merge only if profiling asks for it.
  const merged = new THREE.Mesh(geometries[0], material);
  merged.position.y = y;
  merged.receiveShadow = true;
  for (let i = 1; i < geometries.length; i++) {
    const extra = new THREE.Mesh(geometries[i], material);
    extra.receiveShadow = true;
    merged.add(extra);
  }
  return merged;
}

/**
 * The outer loops of `candidates` that fall inside `polygon`, ready to be punched out of it.
 *
 * Containment is decided on the candidate's first vertex: contours at different thresholds
 * never cross, so one vertex settles the whole loop. The returned arrays are the callers'
 * own — `ensureWinding` hands back its input unchanged when the winding already matches, so
 * these may alias loops the caller still holds. Nothing here writes to them.
 */
function cutoutsInside(candidates: NestedPolygon[], polygon: NestedPolygon): number[][][] {
  return candidates
    .filter(candidate => pointInPolygon(candidate.outer[0], polygon.outer))
    .map(candidate => candidate.outer);
}
