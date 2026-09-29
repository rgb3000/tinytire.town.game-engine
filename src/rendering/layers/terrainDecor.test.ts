import { describe, it, expect } from 'vitest';
import { buildTerrainContours, sampleFieldBilinear, worldToSample, STEP_TILES } from '../../terrain';
import type { SignedField } from '../../terrain';
import type { GridPos } from '../../types';
import {
  LakeDecorKind, MountainDecorKind, SNOW_MIN_LEVELS, planLakeDecor, planMountainDecor, terraceAt,
} from './terrainDecor';

function block(size: number, at = 10): GridPos[] {
  const cells: GridPos[] = [];
  for (let gx = at; gx < at + size; gx++) {
    for (let gy = at; gy < at + size; gy++) cells.push({ gx, gy });
  }
  return cells;
}

function depthAt(field: SignedField, x: number, z: number): number {
  const { sx, sy } = worldToSample(field, x, z);
  return sampleFieldBilinear(field, sx, sy);
}

describe('terraceAt', () => {
  it('names the terrace and the clearance to both of its edges', () => {
    const t = terraceAt(STEP_TILES * 1.25, 4);
    expect(t.level).toBe(1);
    expect(t.below).toBeCloseTo(STEP_TILES * 0.25, 9);
    expect(t.above).toBeCloseTo(STEP_TILES * 0.75, 9);
  });

  it('treats the top terrace as unbounded above', () => {
    const t = terraceAt(STEP_TILES * 10, 3);
    expect(t.level).toBe(2);
    expect(t.above).toBe(Infinity);
  });
});

describe('planMountainDecor', () => {
  const contours = buildTerrainContours(block(6))!;
  const levels = contours.levels.length;
  const items = planMountainDecor(contours.field, levels);

  it('is deterministic, so a designer rebuild does not reshuffle the slopes', () => {
    expect(planMountainDecor(contours.field, levels)).toEqual(items);
  });

  it('places both pines and boulders, all inside the footprint', () => {
    expect(items.some(i => i.kind === MountainDecorKind.Pine)).toBe(true);
    expect(items.some(i => i.kind === MountainDecorKind.Boulder)).toBe(true);
    for (const i of items) expect(depthAt(contours.field, i.x, i.z)).toBeGreaterThan(0);
  });

  it('keeps pines on the lower terraces, clear of both edges', () => {
    for (const i of items.filter(i => i.kind === MountainDecorKind.Pine)) {
      const t = terraceAt(depthAt(contours.field, i.x, i.z), levels);
      expect(t.level).toBe(i.level);
      expect(i.level).toBeLessThanOrEqual(1);
      expect(t.below).toBeGreaterThan(0.07);
      expect(t.above).toBeGreaterThan(0.07);
    }
  });

  it('leaves a snow-capped peak bare', () => {
    expect(levels).toBeGreaterThanOrEqual(SNOW_MIN_LEVELS);
    expect(items.every(i => i.level < levels - 1)).toBe(true);
  });
});

describe('planLakeDecor', () => {
  const contours = buildTerrainContours(block(8))!;
  const items = planLakeDecor(contours.field);

  it('is deterministic', () => {
    expect(planLakeDecor(contours.field)).toEqual(items);
  });

  it('puts reeds and rocks at the shore and lily pads further out', () => {
    expect(items.some(i => i.kind === LakeDecorKind.Reed)).toBe(true);
    expect(items.some(i => i.kind === LakeDecorKind.LilyPad)).toBe(true);
    for (const i of items) {
      const depth = depthAt(contours.field, i.x, i.z);
      expect(depth).toBeGreaterThan(0);
      if (i.kind === LakeDecorKind.LilyPad) expect(depth).toBeGreaterThan(0.18);
      else expect(depth).toBeLessThan(0.12);
    }
  });
});
