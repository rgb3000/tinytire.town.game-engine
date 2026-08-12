/**
 * The snapshot is the debugging seam: a frozen board in the demo becomes a JSON dump, and
 * the dump becomes a world this suite can step. Two properties carry it — the round trip
 * is lossless, and a restored world steps *identically* to the live one it was copied
 * from. Without the second the whole workflow is a lie: a fixture that diverges from the
 * board it came from reproduces some other bug or none.
 */
import { describe, it, expect } from 'vitest';
import { buildRoute } from './route';
import { step } from './step';
import { serializeWorld, deserializeWorld } from './snapshot';
import type { WorldSnapshot } from './snapshot';
import { SegmentKind, VehicleMode, createWorld } from './types';
import type { RouteInput, TrafficWorld, Vehicle } from './types';

const DT = 1 / 60;
const R = SegmentKind.Road;
const X = SegmentKind.Intersection;

function gridRoute(id: string, kinds: SegmentKind[], gy = 0): RouteInput {
  return {
    id,
    spans: [{
      kind: 'grid',
      cells: kinds.map((kind, i) => ({
        pos: { gx: i, gy }, kind, speedLimit: 40, pendingDeletion: false,
      })),
    }],
  };
}

function vehicle(id: string, routeId: string, arc: number, speed = 0): Vehicle {
  return {
    id, routeId, arcDistance: arc, speed, mode: VehicleMode.Driving,
    lastAcceleration: 0, arrivalTime: 0, distanceThisTick: 0, arrivedReported: false,
  };
}

function busyWorld(): TrafficWorld {
  const w = createWorld();
  w.routes.set('r1', buildRoute(gridRoute('r1', [R, R, X, R, R, R]))!);
  w.routes.set('r2', buildRoute(gridRoute('r2', [R, R, R, R], 1))!);
  w.vehicles.push(vehicle('a', 'r1', 10, 30), vehicle('b', 'r1', 70, 0), vehicle('c', 'r2', 5, 40));
  w.time = 12.5;
  return w;
}

describe('snapshot: round trip', () => {
  it('survives JSON and restores an identical world', () => {
    const w = busyWorld();
    const restored = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))));

    expect(restored.time).toBe(w.time);
    expect(restored.vehicles).toEqual(w.vehicles);
    expect([...restored.routes.keys()]).toEqual([...w.routes.keys()]);
    expect(restored.routes.get('r1')).toEqual(w.routes.get('r1'));
  });

  it('is a copy, not a view: stepping the live world does not touch the snapshot', () => {
    const w = busyWorld();
    const snap = serializeWorld(w);
    const arcsAtCapture = snap.vehicles.map((v) => v.arcDistance);

    for (let i = 0; i < 60; i++) step(w, DT);

    expect(snap.vehicles.map((v) => v.arcDistance)).toEqual(arcsAtCapture);
    expect(snap.time).toBe(12.5);
  });

  it('rejects a snapshot from another version instead of restoring half a world', () => {
    const snap = serializeWorld(busyWorld());
    const stale = { ...snap, version: 0 } as unknown as WorldSnapshot;
    expect(() => deserializeWorld(stale)).toThrow(/version/);
  });
});

describe('snapshot: a restored world is the world', () => {
  it('steps tick-for-tick identically to the live world it was captured from', () => {
    const live = busyWorld();
    const restored = deserializeWorld(serializeWorld(live));

    for (let i = 0; i < 600; i++) {
      step(live, DT);
      step(restored, DT);
    }

    for (let i = 0; i < live.vehicles.length; i++) {
      expect(restored.vehicles[i].arcDistance).toBe(live.vehicles[i].arcDistance);
      expect(restored.vehicles[i].speed).toBe(live.vehicles[i].speed);
      expect(restored.vehicles[i].arrivalTime).toBe(live.vehicles[i].arrivalTime);
    }
    expect(restored.time).toBe(live.time);
  });
});
