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
