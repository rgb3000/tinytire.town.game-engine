import * as THREE from 'three';

export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = w / 2, hh = h / 2;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return shape;
}

export const PLATE_EXTRUDE_OPTIONS = {
  depth: 1.0,
  bevelEnabled: true,
  bevelThickness: 0.75,
  bevelSize: 0.75,
  bevelSegments: 3,
  curveSegments: 4,
} as const;

export function createPlateNoiseTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  let seed = 31;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; };

  const low: number[] = [];
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    low.push(Math.sin(x * 0.3 + 1.2) * Math.cos(y * 0.25 + 0.8) * 25
      + Math.sin(x * 0.15 - y * 0.2) * 15);
  }

  for (let i = 0; i < size * size; i++) {
    const fine = (rand() - 0.5) * 40;
    const speckle = rand() < 0.15 ? (rand() - 0.5) * 70 : 0;
    const v = Math.max(0, Math.min(255, 235 + Math.round(low[i] * 0.4 + fine + speckle)));
    const idx = i * 4;
    data[idx] = v;
    data[idx + 1] = v;
    data[idx + 2] = v;
    data[idx + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

export function createPlateMat(): { mat: THREE.MeshStandardMaterial; tex: THREE.CanvasTexture } {
  const tex = createPlateNoiseTexture();
  const mat = new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: tex });
  return { mat, tex };
}

export function getPlateGeom(
  cache: Map<string, THREE.ExtrudeGeometry>,
  width: number,
  depth: number,
): THREE.ExtrudeGeometry {
  const key = `${width}x${depth}`;
  if (!cache.has(key)) {
    const shape = roundedRectShape(width, depth, 3);
    const geom = new THREE.ExtrudeGeometry(shape, PLATE_EXTRUDE_OPTIONS);
    geom.rotateX(-Math.PI / 2);
    cache.set(key, geom);
  }
  return cache.get(key)!;
}

export function addGroundPlate(
  group: THREE.Group,
  rect: { width: number; depth: number; centerX: number; centerZ: number },
  plateMat: THREE.MeshStandardMaterial,
  plateGeomCache: Map<string, THREE.ExtrudeGeometry>,
): void {
  const plate = new THREE.Mesh(getPlateGeom(plateGeomCache, rect.width, rect.depth).clone(), plateMat);
  plate.position.set(rect.centerX, 0.01, rect.centerZ);
  plate.castShadow = true;
  plate.receiveShadow = true;
  group.add(plate);
}

export function disposeGroup(
  group: THREE.Group,
  sharedResources: Set<THREE.Material | THREE.BufferGeometry>,
): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.dispose();
    } else if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      if (!sharedResources.has(obj.geometry)) obj.geometry.dispose();
      const mat = obj.material as THREE.Material;
      if (!sharedResources.has(mat)) mat.dispose();
    }
  });
  if (group.userData.pinMat) {
    (group.userData.pinMat as THREE.Material).dispose();
  }
  if (group.userData.deliveryBallMat) {
    (group.userData.deliveryBallMat as THREE.Material).dispose();
  }
}
