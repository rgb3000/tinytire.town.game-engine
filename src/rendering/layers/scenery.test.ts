import { describe, it, expect } from 'vitest';
import { CELL_MARGIN, SceneryKind, planScenery, visibleScenery, type SceneryItem } from './scenery';

const COLS = 80;
const ROWS = 50;
const TILE = 40;

/** A 20x12 forest block at (10..29, 10..21), plus one lone painted cell at (60, 40). */
const block = (gx: number, gy: number): boolean =>
  (gx >= 10 && gx < 30 && gy >= 10 && gy < 22) || (gx === 60 && gy === 40);
const noForest = (): boolean => false;

const isTree = (i: SceneryItem): boolean => i.kind === SceneryKind.RoundTree || i.kind === SceneryKind.Pine;
const onCell = (items: SceneryItem[], gx: number, gy: number): SceneryItem[] =>
  items.filter(i => i.gx === gx && i.gy === gy);

describe('planScenery', () => {
  it('is deterministic in its seed and forest', () => {
    expect(planScenery(COLS, ROWS, TILE, 1234, block)).toEqual(planScenery(COLS, ROWS, TILE, 1234, block));
    expect(planScenery(COLS, ROWS, TILE, 1234, block)).not.toEqual(planScenery(COLS, ROWS, TILE, 4321, block));
  });

  it('keeps every item strictly inside its own cell, clear of the margin', () => {
    const items = planScenery(COLS, ROWS, TILE, 7, block);
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

  it('grows trees only in the forest', () => {
    const items = planScenery(COLS, ROWS, TILE, 5, block);
    expect(items.filter(isTree).length).toBeGreaterThan(100);
    expect(items.filter(i => isTree(i) && !block(i.gx, i.gy))).toEqual([]);
  });

  it('grows at least one item on every forest cell, even a lone one', () => {
    const items = planScenery(COLS, ROWS, TILE, 11, block);
    for (let gy = 0; gy < ROWS; gy++) {
      for (let gx = 0; gx < COLS; gx++) {
        if (block(gx, gy)) expect(onCell(items, gx, gy).some(i => i.kind !== SceneryKind.Pebble)).toBe(true);
      }
    }
  });

  it('packs the middle of a forest more densely than its edge', () => {
    const items = planScenery(COLS, ROWS, TILE, 3, block).filter(i => i.kind !== SceneryKind.Pebble);
    let edgeItems = 0, edgeCells = 0, innerItems = 0, innerCells = 0;
    for (let gy = 10; gy < 22; gy++) {
      for (let gx = 10; gx < 30; gx++) {
        const n = onCell(items, gx, gy).length;
        const edge = gx === 10 || gx === 29 || gy === 10 || gy === 21;
        if (edge) { edgeItems += n; edgeCells++; } else { innerItems += n; innerCells++; }
      }
    }
    expect(innerItems / innerCells).toBeGreaterThan(edgeItems / edgeCells + 0.3);
  });

  it('leaves open land bare but for the odd bush and pebble', () => {
    const items = planScenery(COLS, ROWS, TILE, 9, noForest);
    expect(items.every(i => i.kind === SceneryKind.Bush || i.kind === SceneryKind.Pebble)).toBe(true);
    const share = new Set(items.map(i => `${i.gx},${i.gy}`)).size / (COLS * ROWS);
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.1);
  });

  it('changes only the painted cell and its neighbours when one more cell is painted', () => {
    // The designer repaints a cell at a time; the rest of the map must not reshuffle under it.
    const before = planScenery(COLS, ROWS, TILE, 21, block);
    const after = planScenery(COLS, ROWS, TILE, 21, (gx, gy) => block(gx, gy) || (gx === 40 && gy === 30));
    const far = (i: SceneryItem): boolean => Math.abs(i.gx - 40) > 1 || Math.abs(i.gy - 30) > 1;
    expect(after.filter(far)).toEqual(before.filter(far));
    expect(onCell(after, 40, 30).length).toBeGreaterThan(0);
  });
});

describe('visibleScenery', () => {
  it('drops exactly the items on cells that are no longer free', () => {
    const items = planScenery(COLS, ROWS, TILE, 3, block);
    const blocked = new Set(items.slice(0, 40).map(i => `${i.gx},${i.gy}`));
    const visible = visibleScenery(items, (gx, gy) => !blocked.has(`${gx},${gy}`));

    expect(visible.every(i => !blocked.has(`${i.gx},${i.gy}`))).toBe(true);
    expect(visible).toHaveLength(items.filter(i => !blocked.has(`${i.gx},${i.gy}`)).length);
  });

  it('brings items back when their cell frees up again', () => {
    const items = planScenery(COLS, ROWS, TILE, 3, block);
    expect(visibleScenery(items, () => false)).toHaveLength(0);
    expect(visibleScenery(items, () => true)).toEqual(items);
  });
});
