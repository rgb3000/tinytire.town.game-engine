/**
 * The road-debug overlay's colouring rule.
 *
 * Three.js geometry is pure maths — a `Scene` is a bare object graph and `EdgesGeometry`
 * needs no GPU — so the layer can be built and read back headless, the way
 * `LakeLayer.test.ts` and `ObstacleLayer.test.ts` already do.
 *
 * What is pinned here is which cells come out red. Until this test the layer reproduced the
 * `car.path` / `car.pathIndex` / `car.outboundPath` loops that `Game.tryRemoveRoad` used to
 * have; nothing has written those fields since the traffic simulation took over movement, so
 * the red set was permanently empty and the whole board drew green. The compiler had nothing
 * to say about it, which is why the assertions below name concrete cells rather than
 * comparing the layer against the same query the layer makes.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { Grid } from '../../core/Grid';
import { Car, CarState } from '../../entities/Car';
import { TrafficAdapter } from '../../systems/car/TrafficAdapter';
import { CellType, GameColor } from '../../types';
import { DEFAULT_GAME_CONSTANTS, TILE_SIZE } from '../../constants';
import type { PathStep } from '../../highways/types';
import { RoadDebugLayer } from './RoadDebugLayer';

const TICK = 1 / 60;
const ROAD_LEN = 8;
const RED = 0xff0000;
const GREEN = 0x00ff00;

interface Fixture {
  grid: Grid;
  adapter: TrafficAdapter;
  car: Car;
  /** Advance the simulation until the car's arc is inside [lo, hi] tiles, and prove it is. */
  driveTo(lo: number, hi: number): void;
}

/** One car on a straight eight-cell road along row zero. */
function fixture(): Fixture {
  const grid = new Grid();
  for (let i = 0; i < ROAD_LEN; i++) grid.setCell(i, 0, { type: CellType.Road });
  const adapter = new TrafficAdapter(grid, DEFAULT_GAME_CONSTANTS);
  const car = new Car('house-1', GameColor.Red, { gx: 0, gy: 0 }, DEFAULT_GAME_CONSTANTS.FUEL_CAPACITY);
  car.state = CarState.GoingToBusiness;
  const path: PathStep[] = Array.from(
    { length: ROAD_LEN },
    (_, i) => ({ kind: 'grid', pos: { gx: i, gy: 0 } } as PathStep),
  );
  expect(adapter.installRoute(car, path, false)).toBe(true);

  return {
    grid, adapter, car,
    driveTo(lo, hi) {
      for (let i = 0; i < 2000 && adapter.getArc(car) < lo * TILE_SIZE; i++) adapter.update(TICK);
      const tiles = adapter.getArc(car) / TILE_SIZE;
      expect(tiles).toBeGreaterThan(lo);
      expect(tiles).toBeLessThan(hi);
    },
  };
}

/** The grid coordinates of every outline in the scene, split by the colour it was drawn in. */
function outlines(scene: THREE.Scene): { red: string[]; green: string[]; other: number } {
  const red: string[] = [];
  const green: string[] = [];
  let other = 0;
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.LineSegments)) return;
    const hex = (obj.material as THREE.LineBasicMaterial).color.getHex();
    const gx = Math.round((obj.position.x - TILE_SIZE / 2) / TILE_SIZE);
    const gy = Math.round((obj.position.z - TILE_SIZE / 2) / TILE_SIZE);
    if (hex === RED) red.push(`${gx},${gy}`);
    else if (hex === GREEN) green.push(`${gx},${gy}`);
    else other++;
  });
  red.sort();
  green.sort();
  return { red, green, other };
}

/** `"lo,0" … "hi,0"`, sorted the way {@link outlines} sorts. */
function row(lo: number, hi: number): string[] {
  const out: string[] = [];
  for (let gx = lo; gx <= hi; gx++) out.push(`${gx},0`);
  return out.sort();
}

function draw(f: Fixture, adapter: TrafficAdapter | null = f.adapter): ReturnType<typeof outlines> {
  const layer = new RoadDebugLayer();
  const scene = new THREE.Scene();
  layer.update(scene, f.grid, [f.car], adapter);
  return outlines(scene);
}

describe('RoadDebugLayer', () => {
  it('outlines every road cell and nothing else', () => {
    const f = fixture();
    const { red, green, other } = draw(f);
    expect(other).toBe(0);
    expect([...red, ...green].sort()).toEqual(row(0, ROAD_LEN - 1));
  });

  it('reddens the cells behind a car heading for a business', () => {
    const f = fixture();
    // A cell is depended on while the car is anywhere inside it, so at 3.0–3.4 tiles the
    // car still stands in cell 3 and cell 3 is still behind it.
    f.driveTo(3.0, 3.4);

    const { red, green } = draw(f);

    expect(red).toEqual(row(0, 3));
    expect(green).toEqual(row(4, ROAD_LEN - 1));
  });

  it('reddens the cells ahead of a car heading home', () => {
    const f = fixture();
    f.driveTo(3.0, 3.4);
    f.car.state = CarState.GoingHome;

    const { red, green } = draw(f);

    expect(red).toEqual(row(3, ROAD_LEN - 1));
    expect(green).toEqual(row(0, 2));
  });

  it('reddens the whole route of a car that has stopped to unload', () => {
    const f = fixture();
    f.driveTo(3.0, 3.4);
    f.car.state = CarState.Unloading;

    const { red, green } = draw(f);

    expect(red).toEqual(row(0, ROAD_LEN - 1));
    expect(green).toEqual([]);
  });

  it('reddens nothing for a car whose state depends on no road', () => {
    // `Idle`, `Stranded` and `GoingToGasStation` had no branch in the loops this replaced
    // and have none now.
    const f = fixture();
    f.driveTo(3.0, 3.4);
    f.car.state = CarState.Idle;

    const { red, green } = draw(f);

    expect(red).toEqual([]);
    expect(green).toEqual(row(0, ROAD_LEN - 1));
  });

  it('reddens nothing when there is no simulation behind the renderer', () => {
    // The map designer's `Renderer` has no `TrafficAdapter`. It still wants the outlines.
    const f = fixture();
    f.driveTo(3.0, 3.4);

    const { red, green } = draw(f, null);

    expect(red).toEqual([]);
    expect(green).toEqual(row(0, ROAD_LEN - 1));
  });

  it('agrees cell for cell with the query that governs road deletion', () => {
    // The overlay exists to show what `Game.handleTryErase` will refuse to remove. If the
    // two ever disagree the overlay is worse than nothing.
    const f = fixture();
    f.driveTo(3.0, 3.4);

    const { red } = draw(f);
    expect(red.length).toBeGreaterThan(0);

    for (let gx = 0; gx < ROAD_LEN; gx++) {
      expect(
        red.includes(`${gx},0`),
        `cell ${gx},0 drawn ${red.includes(`${gx},0`) ? 'red' : 'green'}`,
      ).toBe(f.adapter.carDependsOnCell(f.car, gx, 0));
    }
  });

  it('replaces the previous frame instead of stacking outlines', () => {
    const f = fixture();
    const layer = new RoadDebugLayer();
    const scene = new THREE.Scene();

    layer.update(scene, f.grid, [f.car], f.adapter);
    f.driveTo(3.0, 3.4);
    layer.update(scene, f.grid, [f.car], f.adapter);

    const { red, green } = outlines(scene);
    expect([...red, ...green]).toHaveLength(ROAD_LEN);
    expect(red).toEqual(row(0, 3));
  });
});
