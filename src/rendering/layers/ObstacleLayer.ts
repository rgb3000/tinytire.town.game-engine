import * as THREE from 'three';
import type { GridPos } from '../../types';
import type { MountainTriangles } from '../../maps/types';
import { MOUNTAIN_COLOR, GROUND_Y_POSITION } from '../../constants';
import { lerp } from '../../utils/math';
import { buildTerrainContours } from '../../terrain';
import { buildTerraceMeshes, buildFlatRing } from './terrainMesh';
import { SNOW_MIN_LEVELS } from './terrainDecor';

const LAYER_HEIGHT = 12;

/**
 * Shoreline width, in *tiles*. `buildTerrainContours` works in tile units, not pixels —
 * handing it the old `TILE_SIZE * 0.15` would ask for a six-tile beach, and `field.ts`'s
 * one-cell padding would clip most of it away without complaining.
 */
const SHORELINE_TILES = 0.15;

const defaultBaseColor = new THREE.Color(MOUNTAIN_COLOR);

export class ObstacleLayer {
  private group: THREE.Group | null = null;
  private materials: THREE.MeshPhysicalMaterial[] = [];

  build(scene: THREE.Scene, mountainCells: GridPos[], mountainColor?: string, mountainTriangles?: MountainTriangles, mountainShorelineColor?: string): void {
    this.dispose(scene);
    if (mountainCells.length === 0) return;

    // Null means nothing traceable was painted — reachable from the map format, where a cell
    // may carry triangle flags that activate no quadrant at all.
    const contours = buildTerrainContours(mountainCells, mountainTriangles, SHORELINE_TILES);
    if (!contours) return;

    const baseColor = mountainColor ? new THREE.Color(mountainColor) : defaultBaseColor;
    this.group = new THREE.Group();

    // Shoreline: the outset contour with the footprint punched out of it.
    if (contours.shoreline.length > 0) {
      const shoreMat = new THREE.MeshPhysicalMaterial({
        color: mountainShorelineColor
          ? new THREE.Color(mountainShorelineColor)
          : baseColor.clone().multiplyScalar(0.85),
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this.materials.push(shoreMat);
      const ring = buildFlatRing(contours.shoreline, GROUND_Y_POSITION, shoreMat, contours.levels[0].polygons);
      if (ring) this.group.add(ring);
    }

    const { meshes, materials } = buildTerraceMeshes(contours.levels, {
      direction: 1,
      stepHeight: LAYER_HEIGHT,
      baseOffset: 1,
      makeMaterial: (index, count) => makeRockMaterial(baseColor, index, count),
    });

    // Materials come from the builder's own list, not from walking the meshes: one material
    // is shared by every polygon at a level, so mesh-walking would hand `dispose` duplicates
    // and — when a level contributes no mesh — miss one outright.
    this.materials.push(...materials);
    for (const mesh of meshes) this.group.add(mesh);

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
   * mountain — an early return would strand that build's materials for good.
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

export const SNOW_COLOR = new THREE.Color(0xf6f7f4);
export const MOSS_COLOR = new THREE.Color(0x7f9a5a);

/** How far the foot terrace is blended toward moss, so a mountain grows out of the grass. */
export const MOSS_MIX = 0.35;

/** Alternate terraces are nudged this much lighter and darker, which reads as rock strata. */
const STRATA = 0.05;

/**
 * Per-terrace rock colour: mossy at the foot, banded strata above, lightening toward the
 * peak — base blended up to 35% toward white, as before — and snow on the top terrace of any
 * mountain with at least `SNOW_MIN_LEVELS` terraces. Small hills stay earthy all the way up.
 */
export function rockColor(baseColor: THREE.Color, index: number, count: number): THREE.Color {
  const t = count > 1 ? index / (count - 1) : 0;
  const lighten = t * 0.35;
  const color = new THREE.Color(
    lerp(baseColor.r, 1, lighten),
    lerp(baseColor.g, 1, lighten),
    lerp(baseColor.b, 1, lighten),
  );
  if (index === 0 && count > 1) color.lerp(MOSS_COLOR, MOSS_MIX);
  else color.offsetHSL(0, 0, index % 2 === 0 ? STRATA : -STRATA);

  if (count >= SNOW_MIN_LEVELS && index === count - 1) color.copy(SNOW_COLOR);
  return color;
}

function makeRockMaterial(baseColor: THREE.Color, index: number, count: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: rockColor(baseColor, index, count),
    roughness: 0.6,
    metalness: 0.0,
    sheen: 0.15,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xccbbaa),
    clearcoat: 0.3,
    clearcoatRoughness: 0.4,
    side: THREE.DoubleSide,
  });
}
