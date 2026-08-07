/**
 * Covers `Grid.clearCell`.
 *
 * Five copies of this object literal used to live in `RoadSystem`, `GasStationSystem` and
 * `MapDesigner`, and they disagreed about which fields counted — the gas-station one left
 * `pendingDeletion` set. The point of the test is the *completeness*: it is derived from a
 * fully-populated cell, so a field added to `Cell` and forgotten here turns it red.
 */
import { describe, it, expect } from 'vitest';

import { Grid } from './Grid';
import { CellType, Direction, GameColor, type Cell } from '../types';

const OCCUPIED: Cell = {
  type: CellType.Road,
  entityId: 'entity-1',
  roadConnections: Direction.Up | Direction.Left,
  color: GameColor.Red,
  connectorDir: Direction.Down,
  pendingDeletion: true,
  _isIntersection: true,
  _isTIntersection: true,
};

describe('Grid.clearCell', () => {
  it('resets every field of the cell', () => {
    const grid = new Grid();
    grid.setCell(5, 5, OCCUPIED);

    grid.clearCell(5, 5);

    const cell = grid.getCell(5, 5)!;
    expect(cell).toEqual({
      type: CellType.Empty,
      entityId: null,
      roadConnections: 0,
      color: null,
      connectorDir: null,
      pendingDeletion: false,
      _isIntersection: false,
      _isTIntersection: false,
    });
    // Every key of a populated cell was considered, not just the ones we remembered.
    expect(Object.keys(cell).sort()).toEqual(Object.keys(OCCUPIED).sort());
  });

  it('leaves neighbouring cells untouched', () => {
    const grid = new Grid();
    grid.setCell(5, 5, OCCUPIED);
    grid.setCell(5, 6, OCCUPIED);

    grid.clearCell(5, 5);

    expect(grid.getCell(5, 6)!.type).toBe(CellType.Road);
  });

  it('is a no-op out of bounds', () => {
    const grid = new Grid();
    expect(() => grid.clearCell(-1, 0)).not.toThrow();
    expect(() => grid.clearCell(grid.cols, grid.rows)).not.toThrow();
  });
});
