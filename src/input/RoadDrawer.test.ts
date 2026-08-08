import { describe, it, expect } from 'vitest';
import { RoadDrawer, type RoadDrawerInput, type InventorySlot } from './RoadDrawer';
import type { InputState } from './InputHandler';
import { Grid } from '../core/Grid';
import { RoadSystem } from '../systems/RoadSystem';
import { UndoSystem } from '../input/UndoSystem';
import { CellType, Direction, Tool } from '../types';
import { TILE_SIZE } from '../constants';

function center(gx: number, gy: number): { x: number; y: number } {
  return { x: (gx + 0.5) * TILE_SIZE, y: (gy + 0.5) * TILE_SIZE };
}

function makeFixture(opts: { stock?: number } = {}) {
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);
  const undoSystem = new UndoSystem(grid);
  let stock = opts.stock ?? 1000;
  const slot: InventorySlot = {
    hasStock: (n) => stock >= n,
    consume: (n) => { stock -= n; },
    restore: (n) => { stock += n; },
  };
  const state: InputState = {
    leftDown: false, rightDown: false, shiftDown: false,
    gridPos: { gx: -1, gy: -1 }, canvasX: 0, canvasY: 0,
  };
  const input: RoadDrawerInput = { state, panningActive: false };
  const drawer = new RoadDrawer(input, roadSystem, grid, slot, undoSystem, () => Tool.Road);

  const moveTo = (gx: number, gy: number) => {
    const { x, y } = center(gx, gy);
    state.canvasX = x;
    state.canvasY = y;
    state.gridPos = { gx: Math.floor(x / TILE_SIZE), gy: Math.floor(y / TILE_SIZE) };
  };
  const press = (gx: number, gy: number) => { moveTo(gx, gy); state.leftDown = true; drawer.update(); };
  const dragTo = (gx: number, gy: number) => { moveTo(gx, gy); drawer.update(); };
  const release = () => { state.leftDown = false; drawer.update(); };

  return { grid, roadSystem, undoSystem, drawer, state, input, press, dragTo, release, moveTo, getStock: () => stock };
}

function cellTypeAt(grid: Grid, gx: number, gy: number): CellType {
  return grid.getCell(gx, gy)!.type;
}
function connectionsAt(grid: Grid, gx: number, gy: number): number {
  return grid.getCell(gx, gy)!.roadConnections;
}

describe('RoadDrawer drag placement', () => {
  it('places a connected road along a horizontal drag and charges stock per cell', () => {
    const f = makeFixture({ stock: 10 });
    f.press(1, 1);
    f.dragTo(4, 1);
    f.release();

    for (let gx = 1; gx <= 4; gx++) {
      expect(cellTypeAt(f.grid, gx, 1)).toBe(CellType.Road);
    }
    expect(connectionsAt(f.grid, 1, 1)).toBe(Direction.Right);
    expect(connectionsAt(f.grid, 2, 1)).toBe(Direction.Left | Direction.Right);
    expect(connectionsAt(f.grid, 4, 1)).toBe(Direction.Left);
    expect(f.getStock()).toBe(6);
    expect(f.drawer.getLastBuiltPos()).toEqual({ gx: 4, gy: 1 });
  });

  it('is idempotent when update() runs repeatedly against unchanged input', () => {
    const f = makeFixture({ stock: 10 });
    f.press(1, 1);
    f.dragTo(3, 1);
    const stockAfter = f.getStock();
    const snapshot = JSON.stringify(f.grid);
    f.drawer.update();
    f.drawer.update();
    f.drawer.update();
    expect(f.getStock()).toBe(stockAfter);
    expect(JSON.stringify(f.grid)).toBe(snapshot);
  });

  it('does not advance the anchor over a blocked cell and never connects across it', () => {
    const f = makeFixture({ stock: 10 });
    f.grid.setCell(3, 1, { type: CellType.Mountain });
    f.press(1, 1);
    f.dragTo(5, 1);
    f.release();

    expect(cellTypeAt(f.grid, 3, 1)).toBe(CellType.Mountain);
    expect(connectionsAt(f.grid, 2, 1) & Direction.Right).toBe(0);
    expect(cellTypeAt(f.grid, 4, 1)).toBe(CellType.Road);
    expect(connectionsAt(f.grid, 4, 1)).toBe(Direction.Right);
    expect(connectionsAt(f.grid, 5, 1)).toBe(Direction.Left);
    expect(f.drawer.getLastBuiltPos()).toEqual({ gx: 5, gy: 1 });
  });

  it('freezes the anchor when stock runs out mid-drag', () => {
    const f = makeFixture({ stock: 2 });
    f.press(1, 1);
    f.dragTo(4, 1);
    f.release();

    expect(cellTypeAt(f.grid, 1, 1)).toBe(CellType.Road);
    expect(cellTypeAt(f.grid, 2, 1)).toBe(CellType.Road);
    expect(cellTypeAt(f.grid, 3, 1)).toBe(CellType.Empty);
    expect(cellTypeAt(f.grid, 4, 1)).toBe(CellType.Empty);
    expect(f.getStock()).toBe(0);
    expect(f.drawer.getLastBuiltPos()).toEqual({ gx: 2, gy: 1 });
  });

  it('connects into a house and stops the chain there', () => {
    const f = makeFixture({ stock: 10 });
    f.grid.setCell(4, 1, { type: CellType.House, entityId: 'h1' });
    f.press(1, 1);
    f.dragTo(5, 1);
    f.release();

    expect(connectionsAt(f.grid, 4, 1)).toBe(Direction.Left);
    expect(connectionsAt(f.grid, 3, 1)).toBe(Direction.Left | Direction.Right);
    expect(cellTypeAt(f.grid, 5, 1)).toBe(CellType.Empty);
    expect(f.getStock()).toBe(7);
  });

  it('places nothing for a click that never leaves the start cell', () => {
    const f = makeFixture({ stock: 10 });
    f.press(1, 1);
    f.drawer.update();
    f.release();

    expect(cellTypeAt(f.grid, 1, 1)).toBe(CellType.Empty);
    expect(f.getStock()).toBe(10);
  });

  it('refuses an illegal diagonal and staircases through the passable side', () => {
    const f = makeFixture({ stock: 10 });
    f.grid.setCell(2, 1, { type: CellType.Mountain });
    f.press(1, 1);
    f.dragTo(2, 2);
    f.release();

    expect(cellTypeAt(f.grid, 1, 2)).toBe(CellType.Road);
    expect(connectionsAt(f.grid, 1, 1) & Direction.DownRight).toBe(0);
    expect(connectionsAt(f.grid, 1, 1) & Direction.Down).toBe(Direction.Down);
    expect(connectionsAt(f.grid, 2, 2)).toBe(Direction.Left);
  });

  it('restores cells and reports the stock delta on undo', () => {
    const f = makeFixture({ stock: 10 });
    f.press(1, 1);
    f.dragTo(4, 1);
    f.release();
    expect(f.getStock()).toBe(6);

    const group = f.undoSystem.undo();
    expect(group).not.toBeNull();
    expect(group!.inventoryDelta.roads).toBe(-4);
    for (let gx = 1; gx <= 4; gx++) {
      expect(cellTypeAt(f.grid, gx, 1)).toBe(CellType.Empty);
      expect(connectionsAt(f.grid, gx, 1)).toBe(0);
    }
  });

  it('pauses while panning and resumes without bridging the gap', () => {
    const f = makeFixture({ stock: 20 });
    f.press(1, 1);
    f.dragTo(2, 1);
    f.input.panningActive = true;
    f.dragTo(10, 8);
    f.drawer.update();
    f.input.panningActive = false;
    f.drawer.update();
    f.dragTo(12, 8);
    f.release();

    expect(cellTypeAt(f.grid, 1, 1)).toBe(CellType.Road);
    expect(cellTypeAt(f.grid, 2, 1)).toBe(CellType.Road);
    // Nothing placed along the pan-induced jump
    expect(cellTypeAt(f.grid, 5, 4)).toBe(CellType.Empty);
    expect(cellTypeAt(f.grid, 10, 8)).toBe(CellType.Empty);
    // The resumed stretch exists but is not connected to the pre-pan one
    expect(cellTypeAt(f.grid, 11, 8)).toBe(CellType.Road);
    expect(cellTypeAt(f.grid, 12, 8)).toBe(CellType.Road);
    expect(connectionsAt(f.grid, 2, 1)).toBe(Direction.Left);
    expect(connectionsAt(f.grid, 11, 8)).toBe(Direction.Right);
    expect(f.getStock()).toBe(16);
  });

  it('redirects a connected house to a new neighbor when dragged from it', () => {
    const f = makeFixture({ stock: 10 });
    f.grid.setCell(2, 2, { type: CellType.House, entityId: 'h1' });
    f.roadSystem.placeRoad(3, 2);
    f.roadSystem.connectRoads(2, 2, 3, 2);
    expect(connectionsAt(f.grid, 2, 2)).toBe(Direction.Right);

    f.press(2, 2);
    f.dragTo(1, 2);
    f.release();

    expect(connectionsAt(f.grid, 2, 2)).toBe(Direction.Left);
    expect(connectionsAt(f.grid, 3, 2) & Direction.Left).toBe(0);
    expect(cellTypeAt(f.grid, 1, 2)).toBe(CellType.Road);
    expect(connectionsAt(f.grid, 1, 2)).toBe(Direction.Right);
  });
});
