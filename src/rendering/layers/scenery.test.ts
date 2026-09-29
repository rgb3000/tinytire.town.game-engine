import { describe, it, expect } from 'vitest';
import { CELL_MARGIN, SceneryKind, planScenery, visibleScenery } from './scenery';

const COLS = 80;
const ROWS = 50;
const TILE = 40;

describe('planScenery', () => {
  it('is deterministic in its seed', () => {
    expect(planScenery(COLS, ROWS, TILE, 1234)).toEqual(planScenery(COLS, ROWS, TILE, 1234));
    expect(planScenery(COLS, ROWS, TILE, 1234)).not.toEqual(planScenery(COLS, ROWS, TILE, 4321));
  });

  it('keeps every item strictly inside its own cell, clear of the margin', () => {
    const items = planScenery(COLS, ROWS, TILE, 7);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const fx = item.x / TILE - item.gx;
      const fz = item.z / TILE - item.gy;
      expect(fx).toBeGreaterThanOrEqual(CELL_MARGIN);
      expect(fx).toBeLessThanOrEqual(1 - CELL_MARGIN);
      expect(fz).toBeGreaterThanOrEqual(CELL_MARGIN);
      expect(fz).toBeLessThanOrEqual(1 - CELL_MARGIN);
      expect(item.gx).toBeGreaterThanOrEqual(0);
      expect(item.gx).toBeLessThan(COLS);
      expect(item.gy).toBeGreaterThanOrEqual(0);
      expect(item.gy).toBeLessThan(ROWS);
    }
  });

  it('clusters trees into groves rather than sprinkling them evenly', () => {
    // Evenly scattered trees would put roughly the same count in every 10x10 block; groves
    // leave some blocks nearly bare and pack others. Compare the emptiest and fullest.
    const items = planScenery(COLS, ROWS, TILE, 99).filter(i => i.kind !== SceneryKind.Pebble);
    const counts = new Map<string, number>();
    for (const i of items) {
      const key = `${Math.floor(i.gx / 10)},${Math.floor(i.gy / 10)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const values = [];
    for (let bx = 0; bx < COLS / 10; bx++) {
      for (let by = 0; by < ROWS / 10; by++) values.push(counts.get(`${bx},${by}`) ?? 0);
    }
    expect(Math.max(...values)).toBeGreaterThan(Math.min(...values) * 4 + 10);
  });

  it('covers only part of the map', () => {
    const cells = new Set(planScenery(COLS, ROWS, TILE, 5).map(i => `${i.gx},${i.gy}`));
    const share = cells.size / (COLS * ROWS);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.5);
  });
});

describe('visibleScenery', () => {
  it('drops exactly the items on cells that are no longer free', () => {
    const items = planScenery(COLS, ROWS, TILE, 3);
    const blocked = new Set(items.slice(0, 40).map(i => `${i.gx},${i.gy}`));
    const visible = visibleScenery(items, (gx, gy) => !blocked.has(`${gx},${gy}`));

    expect(visible.every(i => !blocked.has(`${i.gx},${i.gy}`))).toBe(true);
    expect(visible).toHaveLength(items.filter(i => !blocked.has(`${i.gx},${i.gy}`)).length);
  });

  it('brings items back when their cell frees up again', () => {
    const items = planScenery(COLS, ROWS, TILE, 3);
    expect(visibleScenery(items, () => false)).toHaveLength(0);
    expect(visibleScenery(items, () => true)).toEqual(items);
  });
});
