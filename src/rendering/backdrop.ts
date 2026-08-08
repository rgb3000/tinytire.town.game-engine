import * as THREE from 'three';

/**
 * Draw order for the backdrop plane.
 *
 * Negative so it sorts ahead of every other object in the scene: three.js orders the opaque
 * queue by `renderOrder` first, and everything else in this renderer leaves it at the default
 * `0` (ground, water, obstacles) or pushes it well above (overlays at 900+). Drawing first,
 * into a depth buffer the renderer has just cleared, is what lets the backdrop skip depth
 * writes without ever hiding anything.
 */
export const BACKDROP_RENDER_ORDER = -1;

/**
 * The large plane that fills the viewport behind the map when the camera tilts or rotates.
 *
 * It is a *backdrop*, not scene geometry, and the distinction matters because it does not sit
 * behind the scene in world space: it is a hair under the ground plane, which puts it above
 * every lake terrace below the water surface. Depth alone would therefore let it paint over
 * the lake bed. Instead it writes no depth and draws first, so each opaque mesh that follows
 * overwrites it no matter which is nearer the camera.
 *
 * `depthTest` is deliberately left on. In the normal path it decides nothing — the depth
 * buffer is empty when this draws — but it is the safety net if anything ever sorts ahead of
 * the backdrop: a depth-tested plane still loses to nearer geometry that has already written
 * depth, whereas `depthTest: false` would paint over the whole scene and blank the view.
 */
export function createBackdropPlane(size: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({ color, depthWrite: false });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = BACKDROP_RENDER_ORDER;
  return mesh;
}
