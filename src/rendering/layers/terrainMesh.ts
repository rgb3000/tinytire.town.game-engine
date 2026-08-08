import * as THREE from 'three';
import { GROUND_Y_POSITION } from '../../constants';
import type { NestedPolygon, TerraceLevel } from '../../terrain';
import { ensureWinding, pointInPolygon, signedArea } from '../../terrain';

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
 * Each level renders the ground that belongs to it and no more: its own polygons with the
 * level above subtracted, so what renders is a ring rather than a stack of overlapping
 * solids. The old code guessed the inner boundary by insetting the outer loop, which is what
 * folded inside out on narrow shapes; here the inner boundary is simply the next contour.
 *
 * A level may need more than one shape per polygon — see `ringShapes` — so the mesh count is
 * not the polygon count. Every shape a level produces shares that level's single material.
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
      for (const shape of ringShapes(polygon, above)) {
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
    for (const shape of ringShapes(polygon, innerCutouts)) {
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
      geometry.rotateX(Math.PI / 2);
      geometries.push(geometry);
    }
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
 * `polygon` with the *regions* of every cutout nested inside it removed.
 *
 * A cutout region is its outer loop minus its own holes, and subtracting one can leave two
 * disjoint bands, so this returns a list rather than a single shape. Take an annulus — a
 * mountain with a crater. Level 1's outer is smaller than level 0's, but level 1's *hole* is
 * larger, since the crater widens as it deepens. Level 0's ground is then the band outside
 * level 1's outer plus a second band inside level 1's hole, and the naive rule (punch the
 * polygon's own holes and each cutout's outer) gets both wrong: level 0's own hole ends up
 * nested inside the punched level-1 outer, which earcut cannot triangulate, and the inner
 * band is never emitted at all.
 *
 * So, for cutouts `Q*` nested inside `polygon`:
 *
 * - one shape bounded by `polygon.outer`, punched with every `Q.outer` plus those of
 *   `polygon.holes` that no `Q.outer` has already removed;
 * - one further shape per hole `H` of each `Q`, bounded by `H` and punched with those of
 *   `polygon.holes` that fall inside `H`.
 *
 * Containment is decided on a loop's first vertex: contours at different thresholds never
 * cross, so one vertex settles the whole loop. Loops are only ever read and passed on —
 * `ensureWinding` hands back its input unchanged when the winding already matches, so these
 * may alias loops the caller still holds, and nothing here writes to them.
 */
function ringShapes(polygon: NestedPolygon, cutouts: NestedPolygon[]): THREE.Shape[] {
  const inside = cutouts.filter(cutout => pointInPolygon(cutout.outer[0], polygon.outer));

  const shapes = [
    makeShape(polygon.outer, [
      ...inside.map(cutout => cutout.outer),
      ...polygon.holes.filter(hole => !inside.some(c => pointInPolygon(hole[0], c.outer))),
    ]),
  ];

  for (const cutout of inside) {
    for (const hole of cutout.holes) {
      // `makeShape` may index into an outer loop unguarded, so the zero-area check that
      // protects it there has to happen here too — this hole is about to become one.
      if (Math.abs(signedArea(hole)) < MIN_HOLE_AREA) continue;
      // A hole is wound the opposite way to an outer loop; promoting one to an outer loop
      // without flipping it back would leave this band's extruded walls facing inward.
      shapes.push(makeShape(
        ensureWinding(hole, true),
        polygon.holes.filter(own => pointInPolygon(own[0], hole)),
      ));
    }
  }

  return shapes;
}
