import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GROUND_Y_POSITION } from '../../constants';
import type { NestedPolygon, TerraceLevel } from '../../terrain';
import { buildFlatRing, buildTerraceMeshes, makeShape } from './terrainMesh';
import type { TerraceMeshOptions } from './terrainMesh';

// Three.js geometry is pure maths: `Shape`, `Path`, `ExtrudeGeometry` and `rotateX` all run
// under plain Node. Only the *renderer* needs a GPU, and nothing here touches one.

/** Closed CCW square, matching the positive winding `nestLoops` gives outer loops. */
function square(x0: number, y0: number, size: number): number[][] {
  return [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];
}

/** Closed CW square, matching the negative winding `nestLoops` gives holes. */
function holeSquare(x0: number, y0: number, size: number): number[][] {
  return [...square(x0, y0, size)].reverse();
}

function polygon(outer: number[][], holes: number[][][] = []): NestedPolygon {
  return { outer, holes };
}

function levels(...polygonSets: NestedPolygon[][]): TerraceLevel[] {
  return polygonSets.map((polygons, index) => ({ index, polygons }));
}

const mountain: Omit<TerraceMeshOptions, 'makeMaterial'> = {
  direction: 1,
  stepHeight: 12,
  baseOffset: 1,
};

const water: Omit<TerraceMeshOptions, 'makeMaterial'> = {
  direction: -1,
  stepHeight: 4,
  baseOffset: 0,
};

function makeMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial();
}

/**
 * Area of the mesh's top cap, in the XZ plane.
 *
 * After `rotateX(PI / 2)` the shape's own plane is XZ and the extrusion runs down −Y, so the
 * cap is every triangle sitting at y ≈ 0. Its area is the honest read on what the shape
 * actually encloses: a ring reports outer minus holes, an unpunched solid reports the lot.
 */
function capArea(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  expect(geometry.getIndex()).toBeNull();

  let total = 0;
  for (let t = 0; t < position.count; t += 3) {
    const ys = [position.getY(t), position.getY(t + 1), position.getY(t + 2)];
    if (ys.some(y => Math.abs(y) > 1e-6)) continue;

    const ax = position.getX(t), az = position.getZ(t);
    const bx = position.getX(t + 1), bz = position.getZ(t + 1);
    const cx = position.getX(t + 2), cz = position.getZ(t + 2);
    total += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return total;
}

function hasNaN(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  const array = position.array;
  for (let i = 0; i < array.length; i++) if (Number.isNaN(array[i])) return true;
  return false;
}

/** Assert the mesh's XZ extent is exactly the given square — no stray geometry outside it. */
function expectFootprint(mesh: THREE.Mesh, x0: number, z0: number, size: number): void {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!;
  for (const [actual, expected] of [
    [box.min.x, x0], [box.min.z, z0], [box.max.x, x0 + size], [box.max.z, z0 + size],
  ]) expect(actual).toBeCloseTo(expected, 4);
}

/**
 * How many of the mesh's cap triangles cover `(x, z)`.
 *
 * Area alone cannot prove a shape was punched correctly — Three silently ignores a hole that
 * lies outside its shape, and a hole nested inside another hole triangulates into something
 * whose area may still come out plausible. Asking which points are actually covered, and how
 * often, is the assertion that pins the geometry down: 0 where the level has no ground, 1
 * where it does, never 2.
 */
function coverCount(mesh: THREE.Mesh, x: number, z: number): number {
  const position = mesh.geometry.getAttribute('position');
  let count = 0;

  for (let t = 0; t < position.count; t += 3) {
    const ys = [position.getY(t), position.getY(t + 1), position.getY(t + 2)];
    if (ys.some(y => Math.abs(y) > 1e-6)) continue;

    const ax = position.getX(t), az = position.getZ(t);
    const bx = position.getX(t + 1), bz = position.getZ(t + 1);
    const cx = position.getX(t + 2), cz = position.getZ(t + 2);
    const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
    const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
    const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
    const negative = d1 < 0 || d2 < 0 || d3 < 0;
    const positive = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(negative && positive)) count++;
  }
  return count;
}

/** Whether `(x, z)` falls inside any of `meshes`, and how many of them claim it. */
function coverCountAcross(meshes: THREE.Mesh[], x: number, z: number): number {
  return meshes.reduce((total, mesh) => total + coverCount(mesh, x, z), 0);
}

/**
 * Every half-unit sample over `[0, span]²` is covered by exactly one of `meshes` where
 * `hasGround` says the level owns that point, and by none of them where it does not.
 *
 * Samples are offset off every loop coordinate in the fixtures, so none lands on a region
 * boundary or on the diagonal a corner is triangulated along, where two triangles share it
 * legitimately. Mismatches are collected rather than thrown one at a time: which points are
 * wrong says what broke, where a first-failure message does not.
 */
function expectCoverMatches(
  meshes: THREE.Mesh[], span: number, hasGround: (x: number, z: number) => boolean,
): void {
  const mismatches: string[] = [];
  for (let i = 0; i * 0.5 < span; i++) {
    for (let j = 0; j * 0.5 < span; j++) {
      const x = 0.13 + i * 0.5;
      const z = 0.27 + j * 0.5;
      const want = hasGround(x, z) ? 1 : 0;
      const got = coverCountAcross(meshes, x, z);
      if (got !== want) mismatches.push(`(${x}, ${z}) want ${want} got ${got}`);
    }
  }
  expect(mismatches).toEqual([]);
}

/**
 * Mean x-component of the normals on the wall standing at `x = plane`, over `z ∈ [z0, z1]`.
 *
 * Winding is what decides which way an extruded wall faces, and a band built from a loop
 * that arrives wound as a hole has to be flipped before it can serve as an outer boundary.
 * `ExtrudeGeometry` normalises the outer contour itself, so that flip is invisible on the
 * outer walls; it is the band's *hole* walls that end up facing the wrong way without it.
 */
function wallNormalX(mesh: THREE.Mesh, plane: number, z0: number, z1: number): number {
  const position = mesh.geometry.getAttribute('position');
  const normal = mesh.geometry.getAttribute('normal');
  let total = 0;
  let count = 0;

  for (let t = 0; t < position.count; t += 3) {
    let onPlane = true;
    for (let k = 0; k < 3; k++) {
      const z = position.getZ(t + k);
      if (Math.abs(position.getX(t + k) - plane) > 1e-6) onPlane = false;
      if (z < z0 - 1e-6 || z > z1 + 1e-6) onPlane = false;
    }
    if (!onPlane) continue;
    for (let k = 0; k < 3; k++) total += normal.getX(t + k);
    count += 3;
  }

  expect(count).toBeGreaterThan(0);
  return total / count;
}

/** World-space top of a mesh: its own y plus the geometry's highest local y. */
function topY(mesh: THREE.Mesh): number {
  mesh.geometry.computeBoundingBox();
  return mesh.position.y + mesh.geometry.boundingBox!.max.y;
}

describe('makeShape', () => {
  it('builds an outer loop with its holes', () => {
    const shape = makeShape(square(0, 0, 10), [holeSquare(3, 3, 4)]);
    expect(shape.holes).toHaveLength(1);
    expect(capArea(new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
      .rotateX(Math.PI / 2))).toBeCloseTo(100 - 16, 5);
  });

  it('skips a collinear hole that bounds no area', () => {
    // Four points, so the point-count check this replaces would have let it through.
    const collinear = [[2, 5], [4, 5], [6, 5], [2, 5]];
    const shape = makeShape(square(0, 0, 10), [collinear]);
    expect(shape.holes).toHaveLength(0);

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
    expect(capArea(geometry)).toBeCloseTo(100, 5);
  });

  it('skips degenerate holes without indexing into them', () => {
    for (const degenerate of [[], [[1, 1]], [[1, 1], [2, 2]], [[1, 1], [2, 2], [1, 1]]]) {
      expect(makeShape(square(0, 0, 10), [degenerate]).holes).toHaveLength(0);
    }
  });

  it('keeps a triangular hole', () => {
    // Three distinct points: a real hole, and one the point-count check would have dropped.
    const triangle = [[2, 2], [2, 6], [6, 2]];
    const shape = makeShape(square(0, 0, 10), [triangle]);
    expect(shape.holes).toHaveLength(1);

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
    expect(capArea(geometry)).toBeCloseTo(100 - 8, 5);
  });

  it('keeps good holes when a degenerate one sits alongside', () => {
    const shape = makeShape(square(0, 0, 10), [
      [[1, 1], [2, 1], [3, 1], [1, 1]],
      holeSquare(3, 3, 4),
    ]);
    expect(shape.holes).toHaveLength(1);
  });
});

describe('buildTerraceMeshes nesting', () => {
  it('punches the level above out of the level below, producing a ring', () => {
    const stack = levels([polygon(square(0, 0, 10))], [polygon(square(3, 3, 4))]);
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(meshes).toHaveLength(2);
    // Level 0 is a ring: the level-1 footprint is gone from it.
    expect(capArea(meshes[0].geometry)).toBeCloseTo(100 - 16, 4);
    // The topmost level punches nothing and renders solid.
    expect(capArea(meshes[1].geometry)).toBeCloseTo(16, 4);
  });

  it('leaves a level-above polygon that is not contained alone', () => {
    const stack = levels([polygon(square(0, 0, 10))], [polygon(square(100, 100, 4))]);
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(meshes).toHaveLength(2);
    expect(capArea(meshes[0].geometry)).toBeCloseTo(100, 4);
    expect(capArea(meshes[1].geometry)).toBeCloseTo(16, 4);
    // A hole outside its shape leaves the cap area alone but still extrudes walls, so the
    // footprint is what proves the disjoint polygon was never punched into level 0.
    expectFootprint(meshes[0], 0, 0, 10);
  });

  it('punches only the contained candidates when several sit above', () => {
    const stack = levels(
      [polygon(square(0, 0, 10))],
      [polygon(square(1, 1, 2)), polygon(square(5, 5, 3)), polygon(square(40, 40, 5))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(capArea(meshes[0].geometry)).toBeCloseTo(100 - 4 - 9, 4);
    expectFootprint(meshes[0], 0, 0, 10);
  });

  it('routes each candidate to the polygon that contains it', () => {
    const stack = levels(
      [polygon(square(0, 0, 10)), polygon(square(50, 0, 20))],
      [polygon(square(2, 2, 3)), polygon(square(55, 5, 4))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(capArea(meshes[0].geometry)).toBeCloseTo(100 - 9, 4);
    expect(capArea(meshes[1].geometry)).toBeCloseTo(400 - 16, 4);
  });

  it('punches a polygon own holes as well as the level above', () => {
    const stack = levels(
      [polygon(square(0, 0, 20), [holeSquare(1, 15, 2)])],
      [polygon(square(5, 5, 4))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(capArea(meshes[0].geometry)).toBeCloseTo(400 - 4 - 16, 4);
  });

  it('renders a single level solid', () => {
    const { meshes } = buildTerraceMeshes(
      levels([polygon(square(0, 0, 10))]),
      { ...mountain, makeMaterial },
    );
    expect(meshes).toHaveLength(1);
    expect(capArea(meshes[0].geometry)).toBeCloseTo(100, 4);
  });

  it('builds nothing from no levels', () => {
    const { meshes, materials } = buildTerraceMeshes([], { ...mountain, makeMaterial });
    expect(meshes).toEqual([]);
    expect(materials).toEqual([]);
  });

  it('does not mutate the loops it is handed', () => {
    const stack = levels(
      [polygon(square(0, 0, 20), [holeSquare(1, 15, 2)])],
      [polygon(square(5, 5, 4))],
    );
    const before = JSON.stringify(stack);
    buildTerraceMeshes(stack, { ...mountain, makeMaterial });
    expect(JSON.stringify(stack)).toBe(before);
  });
});

/**
 * A mountain with a crater: two terrace levels whose loops nest outside-in as
 * `L0.outer ⊃ L1.outer ⊃ L1.hole ⊃ L0.hole`.
 *
 * That ordering is the whole point. As the terrain rises its silhouette shrinks *and* its
 * crater widens, so the upper level's hole is the *bigger* one and the lower level's hole
 * sits inside it. Level 0's ground is therefore two disjoint bands, and its own hole has
 * already been removed by the time level 1's outer is punched out.
 */
function annulus(): TerraceLevel[] {
  return levels(
    [polygon(square(0, 0, 20), [holeSquare(8, 8, 4)])],
    [polygon(square(2, 2, 16), [holeSquare(6, 6, 8)])],
  );
}

/**
 * A ring massif with an island standing in its crater.
 *
 * The crater floor drops below the footprint, so the island is a separate polygon of *both*
 * levels, nested inside the ring's hole. Loops then nest six deep —
 * `O0 ⊃ O1 ⊃ H1 ⊃ H0 ⊃ I0 ⊃ I1` — and a rule written for one level of nesting punches the
 * island's level-1 contour out of the massif's band, where it does not belong. Reachable
 * from the game: `ObstacleLayer` hands every mountain cell to `buildTerrainContours` at once.
 */
function craterIsland(): TerraceLevel[] {
  return levels(
    [polygon(square(0, 0, 24), [holeSquare(8, 8, 8)]), polygon(square(10, 10, 4))],
    [polygon(square(2, 2, 20), [holeSquare(6, 6, 12)]), polygon(square(11, 11, 2))],
  );
}

/** Inside the closed square `[x0, x0 + size]²`. */
function inSquare(x: number, z: number, x0: number, size: number): boolean {
  return x >= x0 && x <= x0 + size && z >= x0 && z <= x0 + size;
}

describe('buildTerraceMeshes with holed levels', () => {
  it('splits a level into two bands when the level above has a hole', () => {
    const { meshes } = buildTerraceMeshes(annulus(), { ...mountain, makeMaterial });

    // Level 0 is two bands — outside level 1, and inside level 1's crater — then level 1.
    expect(meshes).toHaveLength(3);
    expect(capArea(meshes[0].geometry)).toBeCloseTo(400 - 256, 4);
    expect(capArea(meshes[1].geometry)).toBeCloseTo(64 - 16, 4);
    // Level 0's region minus level 1's region, exactly: (400 − 16) − (256 − 64).
    const level0 = capArea(meshes[0].geometry) + capArea(meshes[1].geometry);
    expect(level0).toBeCloseTo((400 - 16) - (256 - 64), 4);
    expect(capArea(meshes[2].geometry)).toBeCloseTo(256 - 64, 4);
  });

  it('puts the inner band inside the crater, not merely somewhere of that area', () => {
    const { meshes } = buildTerraceMeshes(annulus(), { ...mountain, makeMaterial });

    // Three ignores a hole lying outside its shape, so area alone would pass even if this
    // band were built from the wrong loops. The footprint is the loop identity.
    expectFootprint(meshes[0], 0, 0, 20);
    expectFootprint(meshes[1], 6, 6, 8);
  });

  it('does not punch a hole that a punched cutout has already removed', () => {
    const { meshes } = buildTerraceMeshes(annulus(), { ...mountain, makeMaterial });

    // Level 0's own hole sits inside level 1's outer. Punching it again would nest a hole
    // inside a hole, which earcut cannot triangulate; the outer band must not mention it.
    expect(capArea(meshes[0].geometry)).toBeCloseTo(400 - 256, 4);
    expect(coverCount(meshes[0], 10, 10)).toBe(0);
    expect(coverCount(meshes[0], 4, 4)).toBe(0);
    // Off the corner diagonal, where two triangles legitimately share the sample point.
    expect(coverCount(meshes[0], 1, 0.5)).toBe(1);
  });

  it('covers the ground between the two levels exactly once, and nothing else', () => {
    const { meshes } = buildTerraceMeshes(annulus(), { ...mountain, makeMaterial });

    // A nested hole shows up as coverage inside level 0's own hole or as a missing inner
    // band; a hole punched outside its shape shows up as coverage under level 1.
    expectCoverMatches([meshes[0], meshes[1]], 20, (x, z) => {
      const inLevel0 = inSquare(x, z, 0, 20) && !inSquare(x, z, 8, 4);
      const inLevel1 = inSquare(x, z, 2, 16) && !inSquare(x, z, 6, 8);
      return inLevel0 && !inLevel1;
    });
  });

  it('faces a band hole wall into the void, like the wall around the band', () => {
    const { meshes } = buildTerraceMeshes(annulus(), { ...mountain, makeMaterial });

    // The inner band is solid between (6,6)-(14,14) and its hole (8,8)-(12,12), and both its
    // walls should face out of that solid: −x on the boundary at x = 6, where the solid lies
    // to the right, and +x on the hole at x = 8, where the solid lies to the left. The hole
    // wall is the one that flips when the promoted loop keeps its hole winding.
    expect(wallNormalX(meshes[1], 6, 6, 14)).toBeCloseTo(-1, 5);
    expect(wallNormalX(meshes[1], 8, 8, 12)).toBeCloseTo(1, 5);
  });

  it('keeps the island out of the ring band when nesting runs deeper than one level', () => {
    const { meshes } = buildTerraceMeshes(craterIsland(), { ...mountain, makeMaterial });

    // The ring contributes two bands, the island one, then the level above does the same in
    // reverse. The island's level-1 contour belongs to the island's ring, not the massif's:
    // punching it out of the massif band would double-cover it and bury level 1 under 0.
    expect(meshes).toHaveLength(5);
    expect(meshes.map(m => capArea(m.geometry))).toEqual([
      expect.closeTo(576 - 400, 4),
      expect.closeTo(144 - 64, 4),
      expect.closeTo(16 - 4, 4),
      expect.closeTo(400 - 144, 4),
      expect.closeTo(4, 4),
    ]);
  });

  it('covers a crater island exactly once at every level', () => {
    const { meshes } = buildTerraceMeshes(craterIsland(), { ...mountain, makeMaterial });
    const level0 = (x: number, z: number) =>
      (inSquare(x, z, 0, 24) && !inSquare(x, z, 8, 8)) || inSquare(x, z, 10, 4);
    const level1 = (x: number, z: number) =>
      (inSquare(x, z, 2, 20) && !inSquare(x, z, 6, 12)) || inSquare(x, z, 11, 2);

    expectCoverMatches(meshes.slice(0, 3), 24, (x, z) => level0(x, z) && !level1(x, z));
    expectCoverMatches(meshes.slice(3), 24, level1);
  });

  it('decomposes every level of a three-level crater', () => {
    const stack = levels(
      [polygon(square(0, 0, 24), [holeSquare(10, 10, 4)])],
      [polygon(square(2, 2, 20), [holeSquare(8, 8, 8)])],
      [polygon(square(4, 4, 16), [holeSquare(6, 6, 12)])],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(meshes).toHaveLength(5);
    const areas = meshes.map(m => capArea(m.geometry));
    expect(areas[0] + areas[1]).toBeCloseTo((576 - 16) - (400 - 64), 4);
    expect(areas[2] + areas[3]).toBeCloseTo((400 - 64) - (256 - 144), 4);
    expect(areas[4]).toBeCloseTo(256 - 144, 4);
    for (const mesh of meshes) expect(hasNaN(mesh.geometry)).toBe(false);
  });

  it('gives every band of a level that level height, material and index', () => {
    const decorated: number[] = [];
    const { meshes, materials } = buildTerraceMeshes(annulus(), {
      ...mountain,
      makeMaterial,
      decorate: (_mesh, level) => decorated.push(level),
    });

    expect(decorated).toEqual([0, 0, 1]);
    expect(materials).toHaveLength(2);
    expect(meshes[1].material).toBe(meshes[0].material);
    expect(meshes[2].material).not.toBe(meshes[0].material);
    expect(meshes.map(m => m.position.y)).toEqual([
      GROUND_Y_POSITION + 12,
      GROUND_Y_POSITION + 12,
      GROUND_Y_POSITION + 24,
    ]);
  });

  it('does not mutate the loops it is handed', () => {
    const stack = annulus();
    const before = JSON.stringify(stack);
    buildTerraceMeshes(stack, { ...mountain, makeMaterial });
    expect(JSON.stringify(stack)).toBe(before);
  });

  it('ignores a cutout hole that bounds no area', () => {
    const stack = levels(
      [polygon(square(0, 0, 20))],
      [polygon(square(2, 2, 16), [[[6, 6], [8, 6], [10, 6], [6, 6]]])],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    // The collinear loop would otherwise become a band's outer boundary, which `makeShape`
    // indexes into unguarded.
    expect(meshes).toHaveLength(2);
    expect(capArea(meshes[0].geometry)).toBeCloseTo(400 - 256, 4);
  });
});

describe('buildTerraceMeshes heights', () => {
  it('steps mountains up from ground, the lowest step a full height above it', () => {
    const stack = levels(
      [polygon(square(0, 0, 30))],
      [polygon(square(5, 5, 20))],
      [polygon(square(10, 10, 10))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    expect(meshes.map(m => m.position.y)).toEqual([
      GROUND_Y_POSITION + 12,
      GROUND_Y_POSITION + 24,
      GROUND_Y_POSITION + 36,
    ]);
    // `position.y` is the top face, so level 0's underside lands exactly on the ground.
    expect(topY(meshes[0]) - mountain.stepHeight).toBeCloseTo(GROUND_Y_POSITION, 5);
  });

  it('steps water down with level 0 top face exactly at ground level', () => {
    const stack = levels(
      [polygon(square(0, 0, 30))],
      [polygon(square(5, 5, 20))],
      [polygon(square(10, 10, 10))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...water, makeMaterial });

    expect(meshes.map(m => m.position.y)).toEqual([
      GROUND_Y_POSITION,
      GROUND_Y_POSITION - 4,
      GROUND_Y_POSITION - 8,
    ]);
    expect(topY(meshes[0])).toBeCloseTo(GROUND_Y_POSITION, 5);
  });

  it('gives every polygon at a level the same height', () => {
    const stack = levels([polygon(square(0, 0, 10)), polygon(square(50, 0, 10))]);
    const { meshes } = buildTerraceMeshes(stack, { ...water, makeMaterial });

    expect(meshes.map(m => m.position.y)).toEqual([GROUND_Y_POSITION, GROUND_Y_POSITION]);
  });

  it('extrudes by stepHeight so terraces meet without a gap', () => {
    const stack = levels([polygon(square(0, 0, 10))], [polygon(square(3, 3, 4))]);
    const { meshes } = buildTerraceMeshes(stack, { ...mountain, makeMaterial });

    for (const mesh of meshes) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      expect(box.max.y - box.min.y).toBeCloseTo(mountain.stepHeight, 5);
    }
    // Level 1's underside sits on level 0's top face.
    expect(topY(meshes[1]) - mountain.stepHeight).toBeCloseTo(meshes[0].position.y, 5);
  });

  it('casts and receives shadows', () => {
    const { meshes } = buildTerraceMeshes(
      levels([polygon(square(0, 0, 10))]),
      { ...mountain, makeMaterial },
    );
    expect(meshes[0].castShadow).toBe(true);
    expect(meshes[0].receiveShadow).toBe(true);
  });

  it('produces no NaN positions', () => {
    const stack = levels(
      [polygon(square(0, 0, 20), [holeSquare(1, 16, 2)]), polygon(square(60, 0, 10))],
      [polygon(square(4, 4, 6)), polygon(square(63, 3, 4))],
    );
    const { meshes } = buildTerraceMeshes(stack, { ...water, makeMaterial });

    expect(meshes).toHaveLength(4);
    for (const mesh of meshes) expect(hasNaN(mesh.geometry)).toBe(false);
  });
});

describe('buildTerraceMeshes materials', () => {
  it('returns every material it created, one per level, shared within a level', () => {
    const stack = levels(
      [polygon(square(0, 0, 10)), polygon(square(50, 0, 10))],
      [polygon(square(2, 2, 3))],
    );

    let created = 0;
    const seen: Array<[number, number]> = [];
    const { meshes, materials } = buildTerraceMeshes(stack, {
      ...mountain,
      makeMaterial(levelIndex, levelCount) {
        created++;
        seen.push([levelIndex, levelCount]);
        return new THREE.MeshPhysicalMaterial();
      },
    });

    // Task 8/9 dispose from `materials`; anything created but unreturned leaks a GPU program
    // on every designer brush stroke.
    expect(materials).toHaveLength(created);
    expect(new Set(materials).size).toBe(created);
    expect(seen).toEqual([[0, 2], [1, 2]]);

    for (const mesh of meshes) expect(materials).toContain(mesh.material);
    expect(meshes[0].material).toBe(meshes[1].material);
    expect(meshes[2].material).not.toBe(meshes[0].material);
  });

  it('still returns a level material when that level contributes no mesh', () => {
    let created = 0;
    const { meshes, materials } = buildTerraceMeshes(levels([], [polygon(square(0, 0, 4))]), {
      ...mountain,
      makeMaterial() {
        created++;
        return new THREE.MeshPhysicalMaterial();
      },
    });

    expect(meshes).toHaveLength(1);
    expect(materials).toHaveLength(created);
  });

  it('decorates every mesh with its own level index', () => {
    const stack = levels(
      [polygon(square(0, 0, 10)), polygon(square(50, 0, 10))],
      [polygon(square(2, 2, 3))],
    );

    const decorated: Array<{ mesh: THREE.Mesh; level: number }> = [];
    const { meshes } = buildTerraceMeshes(stack, {
      ...water,
      makeMaterial,
      decorate: (mesh, level) => decorated.push({ mesh, level }),
    });

    expect(decorated.map(d => d.level)).toEqual([0, 0, 1]);
    expect(decorated.map(d => d.mesh)).toEqual(meshes);
  });

  it('works without a decorate hook', () => {
    expect(() =>
      buildTerraceMeshes(levels([polygon(square(0, 0, 10))]), { ...mountain, makeMaterial }),
    ).not.toThrow();
  });
});

describe('buildFlatRing', () => {
  const material = new THREE.MeshPhysicalMaterial();

  it('returns null with no polygons', () => {
    expect(buildFlatRing([], 5, material, [])).toBeNull();
  });

  it('punches the contained cutouts and leaves the rest', () => {
    const ring = buildFlatRing(
      [polygon(square(0, 0, 20))],
      GROUND_Y_POSITION,
      material,
      [polygon(square(5, 5, 10)), polygon(square(100, 100, 4))],
    );

    expect(ring).not.toBeNull();
    expect(capArea(ring!.geometry)).toBeCloseTo(400 - 100, 4);
    expect(ring!.position.y).toBe(GROUND_Y_POSITION);
    expect(ring!.receiveShadow).toBe(true);
    expect(ring!.material).toBe(material);
    expect(hasNaN(ring!.geometry)).toBe(false);
  });

  it('punches a polygon own holes too', () => {
    const ring = buildFlatRing(
      [polygon(square(0, 0, 20), [holeSquare(1, 16, 2)])],
      0,
      material,
      [],
    );
    expect(capArea(ring!.geometry)).toBeCloseTo(400 - 4, 4);
  });

  it('emits the band inside a cutout hole as a further contour', () => {
    // A shoreline around a crater: the same two-band decomposition the terraces need, since
    // the beach runs round the outside of the mountain *and* round the inside of its crater.
    const ring = buildFlatRing(
      [polygon(square(0, 0, 20), [holeSquare(8, 8, 4)])],
      0,
      material,
      [polygon(square(2, 2, 16), [holeSquare(6, 6, 8)])],
    );

    expect(ring!.children).toHaveLength(1);
    expect(capArea(ring!.geometry)).toBeCloseTo(400 - 256, 4);
    const inner = ring!.children[0] as THREE.Mesh;
    expect(capArea(inner.geometry)).toBeCloseTo(64 - 16, 4);
    expectFootprint(inner, 6, 6, 8);
  });

  it('parents extra contours to the first so the ring moves and disposes as one', () => {
    const ring = buildFlatRing(
      [polygon(square(0, 0, 10)), polygon(square(50, 0, 6)), polygon(square(80, 0, 4))],
      3,
      material,
      [polygon(square(51, 1, 2))],
    );

    expect(ring!.children).toHaveLength(2);
    const children = ring!.children as THREE.Mesh[];
    expect(capArea(children[0].geometry)).toBeCloseTo(36 - 4, 4);
    expect(capArea(children[1].geometry)).toBeCloseTo(16, 4);
    for (const child of children) {
      expect(child.material).toBe(material);
      expect(child.receiveShadow).toBe(true);
      // Children inherit the parent's height rather than setting their own.
      expect(child.position.y).toBe(0);
    }
  });

  it('does not mutate the loops it is handed', () => {
    const polygons = [polygon(square(0, 0, 20), [holeSquare(1, 16, 2)])];
    const cutouts = [polygon(square(5, 5, 10))];
    const before = JSON.stringify([polygons, cutouts]);
    buildFlatRing(polygons, 0, material, cutouts);
    expect(JSON.stringify([polygons, cutouts])).toBe(before);
  });
});
