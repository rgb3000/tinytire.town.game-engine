import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { House } from '../../entities/House';
import type { Business } from '../../entities/Business';
import { COLOR_MAP, TILE_SIZE } from '../../constants';
import { stepGridPos } from '../../systems/car/CarRouter';

const LINE_Y = 1;
const HOVER_RADIUS = TILE_SIZE * 0.35;
const MARKER_RADIUS = TILE_SIZE * 0.3;
const MARKER_SEGMENTS = 16;
const LINE_WIDTH = 3; // px for Line2

export class CarRouteLayer {
  private group: THREE.Group | null = null;
  private hoveredCarId: string | null = null;
  private gameColors: Record<number, string> = { ...COLOR_MAP };

  setGameColors(colors: Record<number, string>): void {
    this.gameColors = { ...colors };
  }
  private cachedPathIndex = -1;
  private cachedFuel = -1;
  private resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);

  update(
    scene: THREE.Scene,
    cars: Car[],
    houses: House[],
    businesses: Business[],
    mouseWorldX: number,
    mouseWorldY: number,
  ): void {
    // Find closest car to mouse
    let closestCar: Car | null = null;
    let closestDist = HOVER_RADIUS;

    for (const car of cars) {
      if (car.state === CarState.Idle) continue;
      const dx = mouseWorldX - car.pixelPos.x;
      const dy = mouseWorldY - car.pixelPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestCar = car;
      }
    }

    if (!closestCar) {
      this.clearFromScene(scene);
      this.hoveredCarId = null;
      this.cachedPathIndex = -1;
      return;
    }

    // Skip rebuild if same car and same progress
    const fuelFloored = Math.floor(closestCar.fuel);
    if (
      closestCar.id === this.hoveredCarId &&
      closestCar.pathIndex === this.cachedPathIndex &&
      fuelFloored === this.cachedFuel
    ) {
      return;
    }

    this.clearFromScene(scene);
    this.hoveredCarId = closestCar.id;
    this.cachedPathIndex = closestCar.pathIndex;
    this.cachedFuel = fuelFloored;

    // Update resolution for LineMaterial
    this.resolution.set(window.innerWidth, window.innerHeight);

    const group = new THREE.Group();
    const color = new THREE.Color(this.gameColors[closestCar.color]);

    // Use smoothPath if available, otherwise fall back to grid path
    if (closestCar.smoothPath.length > 1) {
      this.buildFromSmoothPath(group, closestCar, color);
    } else if (closestCar.path.length > 1) {
      this.buildFromGridPath(group, closestCar, color);
    }

    // Fuel indicator
    this.addFuelIndicator(group, closestCar);

    // Origin house marker
    const house = houses.find(h => h.id === closestCar!.homeHouseId);
    if (house) {
      const hx = (house.pos.gx + 0.5) * TILE_SIZE;
      const hz = (house.pos.gy + 0.5) * TILE_SIZE;
      this.addCircleMarker(group, hx, hz, color, 0.6);
    }

    // Destination business marker (X instead of circle)
    if (closestCar.targetBusinessId) {
      const biz = businesses.find(b => b.id === closestCar!.targetBusinessId);
      if (biz) {
        const bx = (biz.connectorPos.gx + 0.5) * TILE_SIZE;
        const bz = (biz.connectorPos.gy + 0.5) * TILE_SIZE;
        this.addCircleMarker(group, bx, bz, color, 1.0);
      }
    }

    this.group = group;
    scene.add(group);
  }

  private buildFromSmoothPath(group: THREE.Group, car: Car, color: THREE.Color): void {
    const sp = car.smoothPath;

    // Find split point: closest smoothPath point to car's current pixel position
    let splitIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < sp.length; i++) {
      const dx = sp[i].x - car.pixelPos.x;
      const dy = sp[i].y - car.pixelPos.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) {
        minDist = d;
        splitIdx = i;
      }
    }

    // Traveled portion (start -> current position): dashed
    if (splitIdx > 0) {
      const positions: number[] = [];
      for (let i = 0; i <= splitIdx; i++) {
        positions.push(sp[i].x, LINE_Y, sp[i].y);
      }
      const geom = new LineGeometry();
      geom.setPositions(positions);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: LINE_WIDTH,
        resolution: this.resolution,
        transparent: true,
        opacity: 0.4,
        dashed: true,
        dashSize: 6,
        gapSize: 4,
        dashScale: 1,
        depthTest: false,
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 998;
      line.computeLineDistances();
      group.add(line);
    }

    // Remaining portion (current position -> end): solid line
    if (splitIdx < sp.length - 1) {
      const positions: number[] = [];
      positions.push(car.pixelPos.x, LINE_Y, car.pixelPos.y);
      for (let i = splitIdx; i < sp.length; i++) {
        positions.push(sp[i].x, LINE_Y, sp[i].y);
      }
      const geom = new LineGeometry();
      geom.setPositions(positions);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: LINE_WIDTH,
        resolution: this.resolution,
        depthTest: false,
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 998;
      group.add(line);
    }
  }

  private buildFromGridPath(group: THREE.Group, car: Car, color: THREE.Color): void {
    const path = car.path;
    const idx = car.pathIndex;

    // Traveled portion
    if (idx > 0) {
      const positions: number[] = [];
      for (let i = 0; i <= idx; i++) {
        const p = stepGridPos(path[i]);
        positions.push((p.gx + 0.5) * TILE_SIZE, LINE_Y, (p.gy + 0.5) * TILE_SIZE);
      }
      const geom = new LineGeometry();
      geom.setPositions(positions);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: LINE_WIDTH,
        resolution: this.resolution,
        transparent: true,
        opacity: 0.4,
        dashed: true,
        dashSize: 6,
        gapSize: 4,
        dashScale: 1,
        depthTest: false,
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 998;
      line.computeLineDistances();
      group.add(line);
    }

    // Remaining portion
    if (idx < path.length - 1) {
      const positions: number[] = [];
      positions.push(car.pixelPos.x, LINE_Y, car.pixelPos.y);
      for (let i = idx + 1; i < path.length; i++) {
        const p = stepGridPos(path[i]);
        positions.push((p.gx + 0.5) * TILE_SIZE, LINE_Y, (p.gy + 0.5) * TILE_SIZE);
      }
      const geom = new LineGeometry();
      geom.setPositions(positions);
      const mat = new LineMaterial({
        color: color.getHex(),
        linewidth: LINE_WIDTH,
        resolution: this.resolution,
        depthTest: false,
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 998;
      group.add(line);
    }
  }

  private addFuelIndicator(group: THREE.Group, car: Car): void {
    // Against the car's own capacity, not the module default: a map that overrides
    // FUEL_CAPACITY would otherwise render a full tank as a partial (or >full) arc.
    const fuelPct = car.fuel / car.fuelCapacity;
    const radius = TILE_SIZE * 0.3;
    const cx = car.pixelPos.x + TILE_SIZE * 0.45;
    const cz = car.pixelPos.y;
    const y = 2;

    // Background disc
    const bgGeom = new THREE.CircleGeometry(radius, 32);
    bgGeom.rotateX(-Math.PI / 2);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    });
    const bgMesh = new THREE.Mesh(bgGeom, bgMat);
    bgMesh.position.set(cx, y, cz);
    bgMesh.renderOrder = 999;
    group.add(bgMesh);

    // Fuel arc
    if (fuelPct > 0) {
      const thetaLength = fuelPct * Math.PI * 2;
      const arcGeom = new THREE.CircleGeometry(radius * 0.85, 32, -Math.PI / 2, thetaLength);
      arcGeom.rotateX(-Math.PI / 2);
      const arcColor = fuelPct > 0.5 ? 0x66FF66 : fuelPct > 0.2 ? 0xFFC107 : 0xF44336;
      const arcMat = new THREE.MeshBasicMaterial({
        color: arcColor,
        depthTest: false,
      });
      const arcMesh = new THREE.Mesh(arcGeom, arcMat);
      arcMesh.position.set(cx, y + 0.1, cz);
      arcMesh.renderOrder = 1000;
      group.add(arcMesh);
    }

    // Percentage text sprite
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 48;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 96, 48);
    // Text shadow for readability
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(fuelPct * 100)}%`, 49, 25);
    // Main text
    ctx.fillStyle = 'white';
    ctx.fillText(`${Math.round(fuelPct * 100)}%`, 48, 24);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(20, 10, 1);
    sprite.position.set(cx, y + 8, cz);
    sprite.renderOrder = 1000;
    group.add(sprite);
  }

  private addCircleMarker(group: THREE.Group, x: number, z: number, color: THREE.Color, opacity: number): void {
    const geom = new THREE.RingGeometry(MARKER_RADIUS * 0.7, MARKER_RADIUS, MARKER_SEGMENTS);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, LINE_Y, z);
    mesh.renderOrder = 998;
    group.add(mesh);
  }

  clear(scene: THREE.Scene): void {
    this.clearFromScene(scene);
    this.hoveredCarId = null;
    this.cachedPathIndex = -1;
    this.cachedFuel = -1;
  }

  private clearFromScene(scene: THREE.Scene): void {
    if (this.group) {
      this.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof Line2) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) {
            mat.forEach(m => m.dispose());
          } else {
            (mat as THREE.Material).dispose();
          }
        } else if (obj instanceof THREE.Sprite) {
          const mat = obj.material as THREE.SpriteMaterial;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      });
      scene.remove(this.group);
      this.group = null;
    }
  }

  dispose(scene: THREE.Scene): void {
    this.clearFromScene(scene);
  }
}
