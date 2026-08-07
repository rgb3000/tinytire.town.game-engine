import * as THREE from 'three';
import type { Grid } from '../../core/Grid';
import type { House } from '../../entities/House';
import type { Business } from '../../entities/Business';
import { CellType, Direction } from '../../types';
import { GRID_COLS, GRID_ROWS, TILE_SIZE, ROAD_COLOR, ROAD_HALF_WIDTH, ROAD_GRAPH_DEBUG } from '../../constants';

import { forEachDirection, opposite, DIRECTION_OFFSETS } from '../../utils/direction';

const CIRCLE_RADIUS = 3;
const CIRCLE_SEGMENTS = 16;
const LINE_Y = 0.1;

const ROAD_SURFACE_Y = 0;
const CAP_SEGMENTS = 10;

/**
 * Build a capsule-shaped mesh between two points (rectangle + semicircle caps).
 * The shape lies in the XZ plane, extruded upward along Y.
 */
function buildCapsuleMesh(
  ax: number, az: number,
  bx: number, bz: number,
  halfWidth: number,
  yLevel: number,
  material: THREE.Material,
): THREE.Mesh {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);

  // Normalized tangent and perpendicular
  const tx = len > 0 ? dx / len : 1;
  const tz = len > 0 ? dz / len : 0;
  const px = -tz; // perpendicular
  const pz = tx;

  // Build shape in (worldX, -worldZ) space (matching extrude rotation)
  const shape = new THREE.Shape();

  // Left side of rectangle: A + perp * halfWidth → B + perp * halfWidth
  const lax = ax + px * halfWidth, laz = az + pz * halfWidth;
  const lbx = bx + px * halfWidth, lbz = bz + pz * halfWidth;
  // Right side at A: A - perp * halfWidth
  const rax = ax - px * halfWidth, raz = az - pz * halfWidth;

  // Start at left-A
  shape.moveTo(lax, -laz);
  // Left edge to left-B
  shape.lineTo(lbx, -lbz);

  // Semicircle cap at B (from left-B around to right-B)
  for (let i = 1; i <= CAP_SEGMENTS; i++) {
    const angle = (i / CAP_SEGMENTS) * Math.PI;
    // Rotate from +perp to -perp around B
    const cx = bx + (px * Math.cos(angle) + tx * Math.sin(angle)) * halfWidth;
    const cz = bz + (pz * Math.cos(angle) + tz * Math.sin(angle)) * halfWidth;
    shape.lineTo(cx, -cz);
  }

  // Right edge from right-B back to right-A
  shape.lineTo(rax, -raz);

  // Semicircle cap at A (from right-A around to left-A)
  for (let i = 1; i <= CAP_SEGMENTS; i++) {
    const angle = (i / CAP_SEGMENTS) * Math.PI;
    // Rotate from -perp to +perp around A
    const cx = ax + (-px * Math.cos(angle) - tx * Math.sin(angle)) * halfWidth;
    const cz = az + (-pz * Math.cos(angle) - tz * Math.sin(angle)) * halfWidth;
    shape.lineTo(cx, -cz);
  }

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 1.0,
    bevelEnabled: true,
    bevelThickness: 0.75,
    bevelSize: 0.75,
    bevelSegments: 3,
    curveSegments: 1,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = yLevel;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

export class RoadLayer {
  private grid: Grid;
  private getHouses: () => House[];
  private getBusinesses: () => Business[];
  private group: THREE.Group | null = null;

  private lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 3, depthTest: false });
  private connectorLineMat = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 3, depthTest: false });
  private pathLineMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 3, depthTest: false });
  private circleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  private connectorCircleMat = new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false });
  private circleGeom = new THREE.CircleGeometry(CIRCLE_RADIUS, CIRCLE_SEGMENTS);
  private roadSurfaceMat = new THREE.MeshStandardMaterial({
    color: ROAD_COLOR,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  private pendingOverlayMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });

  setRoadColor(color: string): void {
    this.roadSurfaceMat.color.set(color);
  }

  constructor(grid: Grid, getHouses: () => House[], getBusinesses: () => Business[]) {
    this.grid = grid;
    this.getHouses = getHouses;
    this.getBusinesses = getBusinesses;
  }

  update(scene: THREE.Scene): void {
    this.clearFromScene(scene);

    const group = new THREE.Group();
    const half = TILE_SIZE / 2;

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const cell = this.grid.getCell(gx, gy);
        if (!cell || (cell.type !== CellType.Road && cell.type !== CellType.Connector)) continue;

        const cx = gx * TILE_SIZE + half;
        const cz = gy * TILE_SIZE + half;

        if (ROAD_GRAPH_DEBUG) {
          // Circle at cell center
          const circle = new THREE.Mesh(this.circleGeom, this.circleMat);
          circle.rotation.x = -Math.PI / 2;
          circle.position.set(cx, LINE_Y, cz);
          circle.renderOrder = 900;
          group.add(circle);

          // Lines to connected neighbors (only draw if neighbor index > current to avoid duplicates)
          const currentIdx = gy * GRID_COLS + gx;
          forEachDirection(cell.roadConnections, (dir) => {
            const off = DIRECTION_OFFSETS[dir];
            const nx = gx + off.gx;
            const ny = gy + off.gy;
            const neighborIdx = ny * GRID_COLS + nx;
            if (neighborIdx <= currentIdx) return;

            const ncx = nx * TILE_SIZE + half;
            const ncz = ny * TILE_SIZE + half;

            const points = [
              new THREE.Vector3(cx, LINE_Y, cz),
              new THREE.Vector3(ncx, LINE_Y, ncz),
            ];
            const geom = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geom, this.lineMat);
            line.renderOrder = 900;
            group.add(line);
          });
        }
      }
    }

    if (ROAD_GRAPH_DEBUG) {
      // House debug circles
      for (const house of this.getHouses()) {
        const hcx = house.pos.gx * TILE_SIZE + half;
        const hcz = house.pos.gy * TILE_SIZE + half;

        const hCircle = new THREE.Mesh(this.circleGeom, this.connectorCircleMat);
        hCircle.rotation.x = -Math.PI / 2;
        hCircle.position.set(hcx, 10, hcz);
        hCircle.renderOrder = 900;
        group.add(hCircle);
      }

      // Connector debug circles
      for (const biz of this.getBusinesses()) {
        const ccx = biz.connectorPos.gx * TILE_SIZE + half;
        const ccz = biz.connectorPos.gy * TILE_SIZE + half;

        const bCircle = new THREE.Mesh(this.circleGeom, this.connectorCircleMat);
        bCircle.rotation.x = -Math.PI / 2;
        bCircle.position.set(ccx, LINE_Y, ccz);
        bCircle.renderOrder = 900;
        group.add(bCircle);
      }
    }

    // Green debug center lines on top of white lines
    const GREEN_Y = LINE_Y + 0.1;

    // Build adjacency with direction info
    const cellKey = (gx: number, gy: number) => gy * GRID_COLS + gx;
    const adjacency = new Map<number, Array<{ neighbor: number; dir: Direction }>>();

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const cell = this.grid.getCell(gx, gy);
        if (!cell || (cell.type !== CellType.Road && cell.type !== CellType.Connector && cell.type !== CellType.House && cell.type !== CellType.GasStation)) continue;
        if (cell.roadConnections === 0) continue;

        const key = cellKey(gx, gy);
        const neighbors: Array<{ neighbor: number; dir: Direction }> = [];
        forEachDirection(cell.roadConnections, (dir) => {
          const off = DIRECTION_OFFSETS[dir];
          const nx = gx + off.gx;
          const ny = gy + off.gy;
          const nCell = this.grid.getCell(nx, ny);
          if (!nCell || (nCell.type !== CellType.Road && nCell.type !== CellType.Connector && nCell.type !== CellType.House && nCell.type !== CellType.GasStation)) return;
          neighbors.push({ neighbor: cellKey(nx, ny), dir });
        });
        adjacency.set(key, neighbors);
      }
    }

    // Opposite direction lookup for routing chains through intersections

    // Trace chains, routing through intersections when opposite directions pair up
    const visited = new Set<string>(); // edge keys "a-b"
    const edgeKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;
    // Track which through-pairs at intersections have been used
    const usedThroughPairs = new Set<string>(); // "nodeKey-dir"

    const chains: number[][] = [];
    const startNodes: number[] = [];

    for (const [node, neighbors] of adjacency) {
      if (neighbors.length !== 2) {
        startNodes.push(node);
      }
    }

    // Given prev and curr node keys, determine the direction from prev to curr
    const getDirection = (prevKey: number, currKey: number): Direction | null => {
      const prevNeighbors = adjacency.get(prevKey);
      if (!prevNeighbors) return null;
      const entry = prevNeighbors.find(e => e.neighbor === currKey);
      return entry ? entry.dir : null;
    };

    // Try to continue a chain through an intersection node
    const tryPassThrough = (prevKey: number, currKey: number): number | null => {
      const incomingDir = getDirection(prevKey, currKey);
      if (incomingDir === null) return null;

      // The "through" direction is the opposite of incoming
      const throughDir = opposite(incomingDir);
      const currNeighbors = adjacency.get(currKey);
      if (!currNeighbors) return null;

      const throughEntry = currNeighbors.find(e => e.dir === throughDir);
      if (!throughEntry) return null;

      // Check if this through-pair hasn't been used yet
      const pairKeyIn = `${currKey}-${incomingDir}`;
      const pairKeyOut = `${currKey}-${throughDir}`;
      if (usedThroughPairs.has(pairKeyIn) || usedThroughPairs.has(pairKeyOut)) return null;

      // Mark both directions as used at this intersection
      usedThroughPairs.add(pairKeyIn);
      usedThroughPairs.add(pairKeyOut);

      return throughEntry.neighbor;
    };

    // Walk a chain from start→next, continuing through intersections when possible
    const walkChain = (start: number, next: number): number[] | null => {
      const ek = edgeKey(start, next);
      if (visited.has(ek)) return null;
      visited.add(ek);

      const chain = [start, next];
      let prev = start;
      let curr = next;

      while (true) {
        const currNeighbors = adjacency.get(curr);
        if (!currNeighbors) break;

        if (currNeighbors.length === 2) {
          // Simple degree-2 node: continue normally
          const nextEntry = currNeighbors[0].neighbor === prev ? currNeighbors[1] : currNeighbors[0];
          const ek2 = edgeKey(curr, nextEntry.neighbor);
          if (visited.has(ek2)) break;
          visited.add(ek2);

          chain.push(nextEntry.neighbor);
          prev = curr;
          curr = nextEntry.neighbor;
        } else {
          // Intersection or endpoint: try to pass through
          const throughNode = tryPassThrough(prev, curr);
          if (throughNode === null) break;

          const ek2 = edgeKey(curr, throughNode);
          if (visited.has(ek2)) break;
          visited.add(ek2);

          chain.push(throughNode);
          prev = curr;
          curr = throughNode;
        }
      }

      return chain;
    };

    // Walk chains from each start node
    for (const start of startNodes) {
      const neighbors = adjacency.get(start)!;
      for (const entry of neighbors) {
        const chain = walkChain(start, entry.neighbor);
        if (chain) chains.push(chain);
      }
    }

    // Also handle pure loops (all degree-2, no start nodes found them)
    for (const [node, neighbors] of adjacency) {
      if (neighbors.length !== 2) continue;
      const chain = walkChain(node, neighbors[0].neighbor);
      if (chain) chains.push(chain);
    }

    // Render each chain as per-segment capsule meshes
    const pendingOverlayY = ROAD_SURFACE_Y + 0.01;
    const keyToWorld = (key: number) => {
      const gx = key % GRID_COLS;
      const gy = Math.floor(key / GRID_COLS);
      return { x: gx * TILE_SIZE + half, z: gy * TILE_SIZE + half };
    };

    for (const chain of chains) {
      // Detect closed loops (first node == last node)
      const isLoop = chain.length > 2 && chain[0] === chain[chain.length - 1];
      if (isLoop) chain.pop(); // Remove duplicate end node

      // Road surface: one capsule per consecutive pair
      const segCount = isLoop ? chain.length : chain.length - 1;
      for (let s = 0; s < segCount; s++) {
        const a = keyToWorld(chain[s]);
        const b = keyToWorld(chain[(s + 1) % chain.length]);
        group.add(buildCapsuleMesh(a.x, a.z, b.x, b.z, ROAD_HALF_WIDTH, ROAD_SURFACE_Y, this.roadSurfaceMat));
      }

      if (ROAD_GRAPH_DEBUG) {
        // Green straight center lines per segment
        for (let s = 0; s < segCount; s++) {
          const a = keyToWorld(chain[s]);
          const b = keyToWorld(chain[(s + 1) % chain.length]);
          const points = [
            new THREE.Vector3(a.x, GREEN_Y, a.z),
            new THREE.Vector3(b.x, GREEN_Y, b.z),
          ];
          const geom = new THREE.BufferGeometry().setFromPoints(points);
          const greenLine = new THREE.Line(geom, this.pathLineMat);
          greenLine.renderOrder = 900;
          group.add(greenLine);
        }
      }

      // Pending-deletion overlay: capsules for segments that touch pending cells
      const isPending = (key: number) => {
        const cell = this.grid.getCell(key % GRID_COLS, Math.floor(key / GRID_COLS));
        return cell?.pendingDeletion === true;
      };
      for (let s = 0; s < segCount; s++) {
        const keyA = chain[s];
        const keyB = chain[(s + 1) % chain.length];
        if (isPending(keyA) || isPending(keyB)) {
          const a = keyToWorld(keyA);
          const b = keyToWorld(keyB);
          group.add(buildCapsuleMesh(a.x, a.z, b.x, b.z, ROAD_HALF_WIDTH, pendingOverlayY, this.pendingOverlayMat));
        }
      }
    }

    this.group = group;
    scene.add(group);
  }

  private clearFromScene(scene: THREE.Scene): void {
    if (this.group) {
      scene.remove(this.group);
      this.group.traverse((obj) => {
        if (obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
        }
      });
      this.group = null;
    }
  }

  dispose(scene: THREE.Scene): void {
    this.clearFromScene(scene);
    this.lineMat.dispose();
    this.connectorLineMat.dispose();
    this.pathLineMat.dispose();
    this.circleMat.dispose();
    this.connectorCircleMat.dispose();
    this.circleGeom.dispose();
    this.roadSurfaceMat.dispose();
    this.pendingOverlayMat.dispose();
  }
}
