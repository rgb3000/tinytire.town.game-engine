/**
 * Covers the place → remove → restore round trip that undo depends on.
 *
 * `restore` exists because `placeGasStation` cannot serve: it mints a fresh id, while the
 * cell snapshot undo restores alongside it still refers to the old one.
 */
import { describe, it, expect } from 'vitest';

import { Grid } from '../core/Grid';
import { CellType } from '../types';
import { GasStationSystem } from './GasStationSystem';

describe('GasStationSystem', () => {
  it('restores a removed station under its original id', () => {
    const grid = new Grid();
    const system = new GasStationSystem(grid);
    const station = system.placeGasStation({ gx: 8, gy: 9 })!;
    const originalId = station.id;

    system.removeGasStation(station.id);
    expect(system.getGasStationById(originalId)).toBeUndefined();

    system.restore(station);

    expect(system.getGasStationById(originalId)).toBe(station);
    expect(system.getGasStations()).toHaveLength(1);
  });

  it('marks itself dirty on restore, which is what repaints it', () => {
    const grid = new Grid();
    const system = new GasStationSystem(grid);
    const station = system.placeGasStation({ gx: 8, gy: 9 })!;
    system.removeGasStation(station.id);
    system.clearDirty();

    system.restore(station);

    expect(system.isDirty).toBe(true);
  });

  it('leaves the grid alone on restore', () => {
    // Undo restores cells from its own snapshots. If `restore` re-placed the cell it would
    // be fighting them, and the order of the two would start to matter.
    const grid = new Grid();
    const system = new GasStationSystem(grid);
    const station = system.placeGasStation({ gx: 8, gy: 9 })!;
    system.removeGasStation(station.id);

    system.restore(station);

    expect(grid.getCell(8, 9)!.type).toBe(CellType.Empty);
  });

  it('fully clears the cell it vacates', () => {
    // This copy of the clear-cell literal used to omit `pendingDeletion`, so a station
    // erased from a cell that was mid-pending-deletion left the flag set forever.
    const grid = new Grid();
    const system = new GasStationSystem(grid);
    const station = system.placeGasStation({ gx: 2, gy: 3 })!;
    grid.getCell(2, 3)!.pendingDeletion = true;

    system.removeGasStation(station.id);

    const cell = grid.getCell(2, 3)!;
    expect(cell.type).toBe(CellType.Empty);
    expect(cell.entityId).toBeNull();
    expect(cell.pendingDeletion).toBe(false);
  });
});
