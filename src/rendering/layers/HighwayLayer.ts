import * as THREE from 'three';
import type { Highway } from '../../highways/types';
import type { HighwaySystem } from '../../systems/HighwaySystem';
import { HIGHWAY_HALF_WIDTH, HIGHWAY_COLOR_HEX, HIGHWAY_PEAK_Y, GROUND_Y_POSITION, TILE_SIZE } from '../../constants';
import { computeHighwayElevation } from '../../highways/highwayGeometry';
import { Tool } from '../../types';
import type { HighwayPlacementState } from '../../input/HighwayDrawer';

const CONTROL_POINT_RADIUS = 8;
const CONTROL_POINT_SEGMENTS = 16;
const CONTROL_POINT_Y = HIGHWAY_PEAK_Y + 2;
const PREVIEW_MARKER_RADIUS = TILE_SIZE * 0.3;
const HIGHWAY_DEPTH = 1.5;
const ENDPOINT_HANDLE_RADIUS = TILE_SIZE * 0.35;
const ENDPOINT_HANDLE_SEGMENTS = 32;
const GUIDE_LINE_THICKNESS = 1;

export class HighwayLayer {
  private group: THREE.Group | null = null;
  private highwaySurfaceMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.9,
    transparent: true,
    opacity: 0.65,
  });
  private highwayColor = new THREE.Color(HIGHWAY_COLOR_HEX);
  private roadColor = new THREE.Color(HIGHWAY_COLOR_HEX);
  private cpMat = new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false });
  private guideLineMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false });
  private previewMat = new THREE.MeshBasicMaterial({ color: HIGHWAY_COLOR_HEX, transparent: true, opacity: 0.4, depthTest: false });
  private endpointHandleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false });
  private cpGeom = new THREE.SphereGeometry(CONTROL_POINT_RADIUS, CONTROL_POINT_SEGMENTS, CONTROL_POINT_SEGMENTS);
  private previewGeom = new THREE.RingGeometry(PREVIEW_MARKER_RADIUS * 0.7, PREVIEW_MARKER_RADIUS, 32);
  private endpointHandleGeom = new THREE.RingGeometry(ENDPOINT_HANDLE_RADIUS * 0.7, ENDPOINT_HANDLE_RADIUS, ENDPOINT_HANDLE_SEGMENTS);

  setHighwayColor(highwayColor: string, roadColor: string): void {
    this.highwayColor.set(highwayColor);
    this.roadColor.set(roadColor);
    this.previewMat.color.set(highwayColor);
  }

  update(
    scene: THREE.Scene,
    highwaySystem: HighwaySystem,
    activeTool: Tool,
    placementState: HighwayPlacementState | null,
  ): void {
    this.clearFromScene(scene);

    const group = new THREE.Group();

    // Render all existing highways
    for (const hw of highwaySystem.getAll()) {
      this.buildHighwayMesh(group, hw);
    }

    // When highway tool is active, show edit handles for ALL highways
    if (activeTool === Tool.Highway) {
      for (const hw of highwaySystem.getAll()) {
        const fromX = (hw.fromPos.gx + 0.5) * TILE_SIZE;
        const fromZ = (hw.fromPos.gy + 0.5) * TILE_SIZE;
        const toX = (hw.toPos.gx + 0.5) * TILE_SIZE;
        const toZ = (hw.toPos.gy + 0.5) * TILE_SIZE;
        const endpointY = GROUND_Y_POSITION;

        // Endpoint drag handles (ring at start/end)
        this.addEndpointHandle(group, fromX, fromZ);
        this.addEndpointHandle(group, toX, toZ);

        // Control point handles
        this.addControlPointHandle(group, hw.cp1.x, hw.cp1.y);
        this.addControlPointHandle(group, hw.cp2.x, hw.cp2.y);

        // Guide lines from endpoints to control points
        this.addGuideLine(group, fromX, fromZ, endpointY, hw.cp1.x, hw.cp1.y, CONTROL_POINT_Y);
        this.addGuideLine(group, toX, toZ, endpointY, hw.cp2.x, hw.cp2.y, CONTROL_POINT_Y);
      }

      // Render placement preview marker
      if (placementState && placementState.phase === 'awaiting-second-click' && placementState.firstPos) {
        const marker = new THREE.Mesh(this.previewGeom, this.previewMat);
        marker.rotation.x = -Math.PI / 2;
        marker.position.set(
          (placementState.firstPos.gx + 0.5) * TILE_SIZE,
          GROUND_Y_POSITION + 0.5,
          (placementState.firstPos.gy + 0.5) * TILE_SIZE,
        );
        marker.renderOrder = 999;
        group.add(marker);
      }
    }

    this.group = group;
    scene.add(group);
  }

  private buildHighwayMesh(group: THREE.Group, hw: Highway): void {
    const polyline = hw.polyline;
    if (polyline.length < 2) return;

    const n = polyline.length;

    // Compute perpendicular offsets and elevations per point
    const lefts: THREE.Vector3[] = [];
    const rights: THREE.Vector3[] = [];

    const totalDist = hw.cumDist[hw.cumDist.length - 1];
    for (let i = 0; i < n; i++) {
      // Use arc-length ratio so elevation matches car distance-based traversal
      const t = totalDist > 0 ? hw.cumDist[i] / totalDist : 0;
      const elevation = computeHighwayElevation(t, totalDist);

      // Tangent direction
      let tx: number, tz: number;
      if (i === 0) {
        tx = polyline[1].x - polyline[0].x;
        tz = polyline[1].y - polyline[0].y;
      } else if (i === n - 1) {
        tx = polyline[n - 1].x - polyline[n - 2].x;
        tz = polyline[n - 1].y - polyline[n - 2].y;
      } else {
        tx = polyline[i + 1].x - polyline[i - 1].x;
        tz = polyline[i + 1].y - polyline[i - 1].y;
      }
      const len = Math.sqrt(tx * tx + tz * tz);
      if (len > 0) { tx /= len; tz /= len; }

      // Perpendicular (in XZ plane)
      const px = -tz, pz = tx;
      const cx = polyline[i].x;
      const cz = polyline[i].y; // polyline uses {x, y} for world XZ

      lefts.push(new THREE.Vector3(cx + px * HIGHWAY_HALF_WIDTH, elevation, cz + pz * HIGHWAY_HALF_WIDTH));
      rights.push(new THREE.Vector3(cx - px * HIGHWAY_HALF_WIDTH, elevation, cz - pz * HIGHWAY_HALF_WIDTH));
    }

    // Build box-profile extrusion: 4 vertices per cross-section (TL, TR, BL, BR)
    // Top = elevation, Bottom = elevation - HIGHWAY_DEPTH
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Helper to push a vertex and return its index
    let vertexCount = 0;
    const tmpColor = new THREE.Color();
    const addVertex = (x: number, y: number, z: number, r: number, g: number, b: number): number => {
      positions.push(x, y, z);
      colors.push(r, g, b);
      return vertexCount++;
    };

    // Per cross-section: TL, TR, BR, BL
    const sections: { tl: number; tr: number; br: number; bl: number }[] = [];
    const ramp = totalDist > 0 ? Math.min(TILE_SIZE / totalDist, 0.5) : 0;
    for (let i = 0; i < n; i++) {
      const t = totalDist > 0 ? hw.cumDist[i] / totalDist : 0;
      // Color interpolation using same smoothstep ramp as elevation
      let colorBlend: number;
      if (t < ramp) {
        const s = t / ramp;
        colorBlend = s * s * (3 - 2 * s);
      } else if (t > 1 - ramp) {
        const s = (1 - t) / ramp;
        colorBlend = s * s * (3 - 2 * s);
      } else {
        colorBlend = 1;
      }
      tmpColor.lerpColors(this.roadColor, this.highwayColor, colorBlend);
      const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;

      const elev = lefts[i].y;
      const bottomY = elev - HIGHWAY_DEPTH;
      const tl = addVertex(lefts[i].x, elev, lefts[i].z, cr, cg, cb);
      const tr = addVertex(rights[i].x, elev, rights[i].z, cr, cg, cb);
      const br = addVertex(rights[i].x, bottomY, rights[i].z, cr, cg, cb);
      const bl = addVertex(lefts[i].x, bottomY, lefts[i].z, cr, cg, cb);
      sections.push({ tl, tr, br, bl });
    }

    // Generate quads between consecutive sections
    for (let i = 0; i < n - 1; i++) {
      const a = sections[i];
      const b = sections[i + 1];

      // Top face (TL, TR → next TL, TR)
      indices.push(a.tl, b.tl, b.tr, a.tl, b.tr, a.tr);

      // Bottom face (BL, BR → next BL, BR) — reversed winding
      indices.push(a.bl, b.br, b.bl, a.bl, a.br, b.br);

      // Left wall (TL, BL → next TL, BL)
      indices.push(a.tl, a.bl, b.bl, a.tl, b.bl, b.tl);

      // Right wall (TR, BR → next TR, BR) — reversed winding
      indices.push(a.tr, b.tr, b.br, a.tr, b.br, a.br);
    }

    // End caps
    if (sections.length > 0) {
      // Front cap (first section)
      const f = sections[0];
      indices.push(f.tl, f.bl, f.br, f.tl, f.br, f.tr);
      // Back cap (last section)
      const bk = sections[n - 1];
      indices.push(bk.tl, bk.tr, bk.br, bk.tl, bk.br, bk.bl);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, this.highwaySurfaceMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  private addEndpointHandle(group: THREE.Group, x: number, z: number): void {
    const ring = new THREE.Mesh(this.endpointHandleGeom, this.endpointHandleMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, GROUND_Y_POSITION + 0.5, z);
    ring.renderOrder = 999;
    group.add(ring);
  }

  private addControlPointHandle(group: THREE.Group, x: number, z: number): void {
    const sphere = new THREE.Mesh(this.cpGeom, this.cpMat);
    sphere.position.set(x, CONTROL_POINT_Y, z);
    sphere.renderOrder = 999;
    group.add(sphere);
  }

  private addGuideLine(group: THREE.Group, x1: number, z1: number, y1: number, x2: number, z2: number, y2: number): void {
    // Use a thin cylinder mesh for cross-platform consistent thickness
    const start = new THREE.Vector3(x1, y1, z1);
    const end = new THREE.Vector3(x2, y2, z2);
    const dir = new THREE.Vector3().subVectors(end, start);
    const length = dir.length();
    if (length < 0.01) return;

    const geom = new THREE.CylinderGeometry(GUIDE_LINE_THICKNESS, GUIDE_LINE_THICKNESS, length, 4, 1);
    geom.translate(0, length / 2, 0);
    geom.rotateX(Math.PI / 2);

    const mesh = new THREE.Mesh(geom, this.guideLineMat);
    mesh.position.copy(start);
    mesh.lookAt(end);
    mesh.renderOrder = 998;
    group.add(mesh);
  }

  private clearFromScene(scene: THREE.Scene): void {
    if (this.group) {
      this.group.traverse((obj) => {
        if (obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
          // Don't dispose shared geometries
          if (obj.geometry !== this.cpGeom && obj.geometry !== this.previewGeom && obj.geometry !== this.endpointHandleGeom) {
            obj.geometry.dispose();
          }
        }
      });
      scene.remove(this.group);
      this.group = null;
    }
  }

  dispose(scene: THREE.Scene): void {
    this.clearFromScene(scene);
    this.highwaySurfaceMat.dispose();
    this.cpMat.dispose();
    this.guideLineMat.dispose();
    this.previewMat.dispose();
    this.endpointHandleMat.dispose();
    this.cpGeom.dispose();
    this.previewGeom.dispose();
    this.endpointHandleGeom.dispose();
  }
}
