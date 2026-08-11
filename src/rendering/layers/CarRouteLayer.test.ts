/**
 * The hovered-car route overlay, end to end against a real simulation.
 *
 * `CarRouteLayer` reads two browser globals — `window.innerWidth`/`innerHeight` for the
 * `LineMaterial` resolution, and `document.createElement('canvas')` for the fuel percentage
 * sprite — so the suite's Node environment supplies both. They are stubs of eleven lines,
 * not a DOM: no layout, no events, no WebGL. Everything else in the layer is Three.js
 * geometry, which is pure maths, so the group the layer builds can be read straight back.
 *
 * That matters because the interesting decision is which halves of the route get geometry at
 * all. {@link routeOverlay} tests the decision; this file tests that the layer takes it —
 * the guard is worth nothing if `addRouteLine` is reached anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import { Grid } from '../../core/Grid';
import { Car, CarState } from '../../entities/Car';
import { TrafficAdapter } from '../../systems/car/TrafficAdapter';
import { CellType, GameColor } from '../../types';
import type { GridPos, PixelPos } from '../../types';
import { DEFAULT_GAME_CONSTANTS, TILE_SIZE } from '../../constants';
import type { PathStep } from '../../highways/types';
import { sampleRoute } from '../../traffic';
import type { Route } from '../../traffic';
import { CarRouteLayer } from './CarRouteLayer';

const TICK = 1 / 60;

const STRAIGHT: GridPos[] = Array.from({ length: 8 }, (_, i) => ({ gx: i, gy: 0 }));
const CORNER: GridPos[] = [
  { gx: 0, gy: 0 }, { gx: 1, gy: 0 }, { gx: 2, gy: 0 },
  { gx: 2, gy: 1 }, { gx: 2, gy: 2 }, { gx: 2, gy: 3 },
];

interface Fixture {
  adapter: TrafficAdapter;
  car: Car;
  route: Route;
  /** Advance the simulation `n` ticks and publish the result onto the car. */
  tick(n: number): void;
  /** Advance until the car's arc reaches `tiles`, then publish. */
  driveTo(tiles: number): void;
  /** Reinstall the route with the car standing on its very last point. */
  placeAtEnd(): void;
}

function fixture(cells: GridPos[] = STRAIGHT): Fixture {
  const grid = new Grid();
  for (const c of cells) grid.setCell(c.gx, c.gy, { type: CellType.Road });
  const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
  const car = new Car('house-1', GameColor.Red, cells[0], DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
  car.state = CarState.GoingToBusiness;
  const path: PathStep[] = cells.map(pos => ({ kind: 'grid', pos } as PathStep));
  expect(adapter.installRoute(car, path, false)).toBe(true);
  adapter.writeBack([car]);

  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) adapter.update(TICK);
    adapter.writeBack([car]);
  };

  const f: Fixture = {
    adapter, car, route: adapter.getRouteFor(car)!, tick,
    driveTo(tiles) {
      for (let i = 0; i < 4000 && adapter.getArc(car) < tiles * TILE_SIZE; i++) adapter.update(TICK);
      adapter.writeBack([car]);
    },
    placeAtEnd() {
      // Placed rather than driven, because driving there is not how a car gets there: the
      // destination is a stop line at `route.length`, so the headway model rests a car about
      // `s0` short of it (see ARRIVAL_SLACK in `src/traffic/step.ts`, which measures 13.72px
      // on a 3-tile route). `arcDistance` reaches `route.length` exactly by the projection
      // an `installRoute(preservePosition)` reroute performs, or by the clamp in `step`.
      //
      // The same two moves `placeAt` in `TrafficAdapter.test.ts` makes, and for the same
      // reason: the projection anchors on the *simulated* position when there is a vehicle,
      // so the old vehicle has to go first for the pixel position to be the anchor.
      const end = sampleRoute(f.route, f.route.length);
      adapter.removeVehicle(car);
      car.pixelPos.x = end.x;
      car.pixelPos.y = end.y;
      expect(adapter.installRoute(car, path, true)).toBe(true);
      f.route = adapter.getRouteFor(car)!;
      adapter.writeBack([car]);
    },
  };
  return f;
}

/**
 * Build the overlay with the mouse exactly on the car, which is what makes it the hovered
 * one — the layer picks the nearest car inside a third of a tile.
 */
function hover(f: Fixture, layer = new CarRouteLayer()): THREE.Scene {
  const scene = new THREE.Scene();
  layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x, f.car.pixelPos.y);
  return scene;
}

function routeLines(scene: THREE.Scene): Line2[] {
  const found: Line2[] = [];
  scene.traverse((obj) => { if (obj instanceof Line2) found.push(obj); });
  return found;
}

function isDashed(line: Line2): boolean {
  return (line.material as LineMaterial).dashed === true;
}

/** Read a `LineGeometry`'s polyline back: every segment start, plus the final end. */
function polyline(line: Line2): PixelPos[] {
  const start = line.geometry.attributes.instanceStart;
  const end = line.geometry.attributes.instanceEnd;
  const points: PixelPos[] = [];
  for (let i = 0; i < start.count; i++) points.push({ x: start.getX(i), y: start.getZ(i) });
  points.push({ x: end.getX(start.count - 1), y: end.getZ(start.count - 1) });
  return points;
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, innerHeight: 720 };
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => new Proxy({}, { get: () => () => {} }),
    }),
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe('CarRouteLayer route geometry', () => {
  it('draws both halves for a car partway along its route', () => {
    const f = fixture();
    f.driveTo(3);
    // The premise: the car really is between the ends, so two halves is the right answer.
    expect(f.adapter.getArc(f.car)).toBeGreaterThan(0);
    expect(f.adapter.getArc(f.car)).toBeLessThan(f.route.length);

    const lines = routeLines(hover(f));

    expect(lines).toHaveLength(2);
    expect(lines.filter(isDashed)).toHaveLength(1);
  });

  it('draws no travelled half for a car that has not moved yet', () => {
    const f = fixture();
    expect(f.adapter.getArc(f.car)).toBe(0);

    const lines = routeLines(hover(f));

    // `splitAt` hands back two coincident points for the half behind a car at arc zero.
    // Drawn, that is a segment whose direction the `Line2` shader normalises from a zero
    // vector — NaN vertices, and a stray dot or nothing at all depending on the driver.
    expect(lines).toHaveLength(1);
    expect(isDashed(lines[0])).toBe(false);
  });

  it('draws no remaining half for a car standing on the last point of its route', () => {
    const f = fixture();
    f.placeAtEnd();
    expect(f.adapter.getArc(f.car)).toBe(f.route.length);

    const lines = routeLines(hover(f));

    expect(lines).toHaveLength(1);
    expect(isDashed(lines[0])).toBe(true);
  });

  it('keeps drawing nothing ahead of it on later frames', () => {
    // The frame-by-frame version of the case above. The stub is not a one-off: the car is at
    // the end of its route and `arcDistance` is clamped there, so every frame it is hovered
    // offers the same zero-length half.
    //
    // Burning a unit of fuel per frame is what forces the rebuild — the layer caches on
    // (car, arc, floored fuel) and the first two do not move here — so these are five real
    // passes through the guard and not one pass plus four early returns.
    const f = fixture();
    f.placeAtEnd();
    const layer = new CarRouteLayer();
    const scene = new THREE.Scene();
    let previous: Line2 | null = null;

    for (let frame = 0; frame < 5; frame++) {
      f.tick(12);
      f.car.fuel -= 1;
      expect(f.adapter.getArc(f.car)).toBe(f.route.length);

      layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x, f.car.pixelPos.y);

      const lines = routeLines(scene);
      expect(lines).toHaveLength(1);
      expect(isDashed(lines[0])).toBe(true);
      expect(lines[0]).not.toBe(previous);
      previous = lines[0];
    }
  });

  it('draws a short remaining half for a car parked where the model stops it', () => {
    // The ordinary end of a journey, and it is *not* the degenerate case: the destination
    // is a stop line at `route.length`, so a car rests a standstill gap short of it. The
    // guard must not swallow that stub of real road ahead.
    const f = fixture();
    f.driveTo(100);
    const arc = f.adapter.getArc(f.car);
    expect(arc).toBeLessThan(f.route.length);
    expect(f.route.length - arc).toBeGreaterThan(1);

    const lines = routeLines(hover(f));

    expect(lines).toHaveLength(2);
  });

  it('draws the curve the car is driving, not the centres of the tiles it passes', () => {
    // The deleted `buildFromGridPath` emitted one point per `car.path` step at the tile
    // centre; the deleted `buildFromSmoothPath` read `car.smoothPath`. Neither field exists
    // any more — the route's own polyline is what the car's position is sampled from.
    const f = fixture(CORNER);
    const centres = CORNER.map(c => ({ x: (c.gx + 0.5) * TILE_SIZE, y: (c.gy + 0.5) * TILE_SIZE }));

    // The premise: on a corner the two really differ, so the assertion discriminates.
    expect(f.route.points.length).toBeGreaterThan(centres.length);

    const solid = routeLines(hover(f)).filter(l => !isDashed(l));
    expect(solid).toHaveLength(1);
    const drawn = polyline(solid[0]);

    expect(drawn).toHaveLength(f.route.points.length);
    drawn.forEach((p, i) => {
      expect(p.x).toBeCloseTo(f.route.points[i].x, 3);
      expect(p.y).toBeCloseTo(f.route.points[i].y, 3);
    });
  });

  it('floats the line above the ground at a constant height', () => {
    const f = fixture();
    f.driveTo(3);
    const lines = routeLines(hover(f));
    // Indexed only after the premise is asserted: an overlay that drew nothing at all
    // should fail here on the missing line, not on reading `geometry` off `undefined`.
    expect(lines).toHaveLength(2);

    const start = lines[0].geometry.attributes.instanceStart;
    expect(start.count).toBeGreaterThan(0);
    for (let i = 0; i < start.count; i++) expect(start.getY(i)).toBe(1);
  });
});

describe('CarRouteLayer rebuild cache', () => {
  it('leaves the geometry alone while the car has moved less than a pixel', () => {
    const f = fixture();
    f.driveTo(3);
    const layer = new CarRouteLayer();
    const first = routeLines(hover(f, layer));
    expect(first).toHaveLength(2);

    // No simulation step at all: the arc is identical, so there is nothing to redraw.
    const scene = new THREE.Scene();
    layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x, f.car.pixelPos.y);

    expect(routeLines(scene)).toHaveLength(0);
  });

  it('rebuilds once the car has moved a pixel', () => {
    const f = fixture();
    f.driveTo(3);
    const layer = new CarRouteLayer();
    const before = f.adapter.getArc(f.car);
    hover(f, layer);

    f.tick(30);
    // The premise: the car really has moved further than the rebuild epsilon.
    expect(f.adapter.getArc(f.car) - before).toBeGreaterThan(1);

    const scene = new THREE.Scene();
    layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x, f.car.pixelPos.y);

    expect(routeLines(scene)).toHaveLength(2);
  });

  it('clears the overlay when the mouse leaves every car', () => {
    const f = fixture();
    f.driveTo(3);
    const layer = new CarRouteLayer();
    const scene = new THREE.Scene();

    layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x, f.car.pixelPos.y);
    expect(routeLines(scene)).toHaveLength(2);

    layer.update(scene, f.adapter, [f.car], [], [], f.car.pixelPos.x + 10 * TILE_SIZE, f.car.pixelPos.y);

    expect(scene.children).toHaveLength(0);
  });

  it('draws no route for a car the simulation has no route for', () => {
    const f = fixture();
    f.driveTo(3);
    f.adapter.removeVehicle(f.car);
    expect(f.adapter.getRouteFor(f.car)).toBeNull();

    const scene = hover(f);

    // The fuel indicator and the house marker still belong to the hovered car; only the
    // route is missing.
    expect(routeLines(scene)).toHaveLength(0);
    expect(scene.children.length).toBeGreaterThan(0);
  });
});
