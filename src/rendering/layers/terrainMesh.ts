import * as THREE from 'three';
import { GROUND_Y_POSITION } from '../../constants';
import type { NestedPolygon, TerraceLevel } from '../../terrain';
import { nestLoops, pointInPolygon, signedArea } from '../../terrain';

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
 * level 1's outer plus a second band inside level 1's hole, and the naive rule — punch the
 * polygon's own holes and each cutout's outer — gets both wrong: level 0's own hole ends up
 * nested inside the punched level-1 outer, which earcut cannot triangulate, and the inner
 * band is never emitted at all.
 *
 * The subtraction is left to `nestLoops`, over the union of both sides' loops. A cutout's
 * region is strictly inside `polygon`'s, so the boundary of the difference is exactly those
 * loops and no others, and even-odd containment parity — which is all `nestLoops` does —
 * sorts each one into the band it bounds. Spelling the cases out by hand instead works for a
 * crater but rebuilds the original defect one level down: an island in that crater puts a
 * cutout's *outer* inside a cutout's *hole*, and the hand-written rule punches it out of a
 * shape it no longer belongs to. Parity has no such depth limit.
 *
 * Cutouts are still filtered first, to those inside `polygon`'s *region* — inside its outer
 * loop and outside its holes. Parity is only sound over loops that bound the difference, and
 * `nestLoops` would read anything else as a further band and fill it in, painting the level
 * below over ground that belongs to the level above. Testing the outer loop alone is not
 * enough: the island in that crater is a polygon of *this* level too, sitting in one of its
 * holes, and its own cutout is inside this outer loop while belonging to that polygon's ring
 * rather than this one. Level polygons have disjoint regions, so each cutout lands on
 * exactly one of them.
 *
 * `nestLoops` also winds what it returns — outers positive, holes negative — which matters
 * because a band bounded by a cutout's hole is promoted from hole to outer boundary here.
 * `ExtrudeGeometry` reverses a positive outer into its own convention and fixes the holes on
 * the way; hand it a *negatively* wound outer and it leaves the holes alone, and that band's
 * hole walls end up facing into the solid.
 *
 * Containment is decided on a loop's first vertex, here and in `nestLoops`: contours at
 * different thresholds never cross, so one vertex settles the whole loop. Loops are only
 * read and passed on, never written to — `nestLoops` copies a loop when it has to reverse
 * one, and hands back the caller's own array when it does not.
 */
function ringShapes(polygon: NestedPolygon, cutouts: NestedPolygon[]): THREE.Shape[] {
  const inside = cutouts.filter(cutout => inRegion(cutout.outer[0], polygon));
  if (inside.length === 0) return [makeShape(polygon.outer, polygon.holes)];

  const loops = [polygon.outer, ...polygon.holes];
  for (const cutout of inside) loops.push(cutout.outer, ...cutout.holes);

  return nestLoops(loops)
    // `nestLoops` filters loops by point count, so a collinear one survives to become an
    // outer boundary here. `makeShape` guards its *holes* by area but not its outer loop,
    // and a zero-area outer extrudes into two coincident, back-to-back walls that z-fight
    // under these layers' `DoubleSide` materials. Same reasoning as `MIN_HOLE_AREA` itself.
    .filter(band => Math.abs(signedArea(band.outer)) >= MIN_HOLE_AREA)
    .map(band => makeShape(band.outer, band.holes));
}

/** Inside `polygon`'s outer loop and outside every one of its holes. */
function inRegion(point: number[], polygon: NestedPolygon): boolean {
  return pointInPolygon(point, polygon.outer)
    && !polygon.holes.some(hole => pointInPolygon(point, hole));
}
