import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBackdropPlane, BACKDROP_RENDER_ORDER } from './backdrop';
import { LakeLayer } from './layers/LakeLayer';
import { GROUND_Y_POSITION } from '../constants';
import type { GridPos } from '../types';

/** The y the renderer parks the backdrop at: just under the ground plane. */
const BACKDROP_Y = -0.01;

function solidLake(size: number): GridPos[] {
  const cells: GridPos[] = [];
  for (let gx = 0; gx < size; gx++) {
    for (let gy = 0; gy < size; gy++) cells.push({ gx, gy });
  }
  return cells;
}

/** World-space vertical extent of every mesh a layer put in the scene. */
function meshExtents(scene: THREE.Scene): { top: number; bottom: number }[] {
  scene.updateMatrixWorld(true);
  const extents: { top: number; bottom: number }[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.computeBoundingBox();
    const box = obj.geometry.boundingBox!.clone().applyMatrix4(obj.matrixWorld);
    extents.push({ top: box.max.y, bottom: box.min.y });
  });
  return extents;
}

describe('createBackdropPlane', () => {
  const backdrop = () => createBackdropPlane(100, '#FFFFFF');

  it('writes no depth, so opaque geometry drawn after it always paints over it', () => {
    const material = backdrop().material as THREE.MeshStandardMaterial;
    expect(material.depthWrite).toBe(false);
  });

  it('keeps depthTest on as the fallback if it ever loses its place in the draw order', () => {
    // With `depthWrite` off, draw order is what keeps the backdrop behind the scene.
    // `depthTest: false` would remove the only other line of defence and let a mis-sorted
    // backdrop paint over the entire map, so the default must stay on.
    const material = backdrop().material as THREE.MeshStandardMaterial;
    expect(material.depthTest).toBe(true);
  });

  it('sorts ahead of scene geometry, which leaves renderOrder at the default', () => {
    expect(BACKDROP_RENDER_ORDER).toBeLessThan(0);
    expect(backdrop().renderOrder).toBe(BACKDROP_RENDER_ORDER);
  });

  it('faces up, so a top-down camera sees it', () => {
    const mesh = backdrop();
    const normal = mesh.geometry.getAttribute('normal');
    expect(normal.getY(0)).toBeCloseTo(1, 6);
  });
});

describe('backdrop against the lake it used to hide', () => {
  // The regression: the backdrop sits at y = -0.01 while the lake terraces step *down* from
  // GROUND_Y_POSITION, so all but the topmost terrace are below it. A depth-writing backdrop
  // is nearer a top-down camera than the lake bed and so erased it, leaving a teal rim at the
  // shore and a flat backdrop-coloured interior.
  const scene = new THREE.Scene();
  new LakeLayer().build(scene, solidLake(14));
  const extents = meshExtents(scene);

  it('confirms the lake really does extend below the backdrop', () => {
    const belowBackdrop = extents.filter((e) => e.top < BACKDROP_Y);
    expect(belowBackdrop.length).toBeGreaterThan(0);
    expect(Math.min(...extents.map((e) => e.bottom))).toBeLessThan(BACKDROP_Y);
  });

  it('confirms the surviving teal rim was the only water above the backdrop', () => {
    const aboveBackdrop = extents.filter((e) => e.top > BACKDROP_Y);
    for (const extent of aboveBackdrop) expect(extent.top).toBeCloseTo(GROUND_Y_POSITION, 6);
  });
});
