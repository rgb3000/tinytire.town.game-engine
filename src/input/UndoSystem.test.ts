/**
 * Covers what an undo group carries.
 *
 * Undo used to record only cells and only *some* of the inventory movement, which made it
 * quietly lossy: erasing refunded stock the group never heard about, so undoing an erase
 * restored the thing *and* kept its refund. Erase-then-undo minted roads indefinitely. It
 * also had no way to bring back a destroyed gas station or highway — the cell snapshot came
 * back pointing at an entity that no longer existed.
 *
 * `UndoSystem` records; `Game.performUndo` applies. Only the recording half is observable
 * without a canvas, so that is what this pins.
 */
import { describe, it, expect } from 'vitest';

import { Grid } from '../core/Grid';
import { UndoSystem } from './UndoSystem';
import { GasStation } from '../entities/GasStation';
import { CellType, Direction, GameColor } from '../types';
import type { Cell } from '../types';
import type { Highway } from '../highways/types';

function makeHighway(id: string): Highway {
  return {
    id,
    fromPos: { gx: 1, gy: 1 },
    toPos: { gx: 5, gy: 5 },
    cp1: { x: 40, y: 40 },
    cp2: { x: 200, y: 200 },
    arcLength: 100,
    polyline: [],
    cumDist: [],
  };
}

describe('UndoSystem', () => {
  it('hands back the entities an edit destroyed, by identity', () => {
    // By identity, not by value: the restored station has to keep the id that the restored
    // cell's `entityId` refers to, or the cell points at nothing.
    const undo = new UndoSystem(new Grid());
    const station = new GasStation({ gx: 3, gy: 4 });
    const highway = makeHighway('hw-1');

    undo.beginGroup();
    undo.snapshotCellAndNeighbors(3, 4);
    undo.addRemovedGasStation(station);
    undo.addRemovedHighway(highway);
    undo.endGroup();

    const group = undo.undo()!;
    expect(group.removedGasStations).toHaveLength(1);
    expect(group.removedGasStations[0]).toBe(station);
    expect(group.removedHighways[0]).toBe(highway);
  });

  it('accumulates inventory deltas across an edit', () => {
    const undo = new UndoSystem(new Grid());

    undo.beginGroup();
    undo.snapshotCellAndNeighbors(1, 1);
    undo.addInventoryDelta('roads', -1);
    undo.addInventoryDelta('roads', -1);
    undo.addInventoryDelta('gasStations', 1);
    undo.endGroup();

    const group = undo.undo()!;
    expect(group.inventoryDelta).toEqual({ roads: -2, highways: 0, gasStations: 1 });
  });

  it('keeps a group that recorded only entities', () => {
    // Today `RoadDrawer` snapshots the cell before delegating, so this cannot happen yet.
    // The guard used to test `cellSnapshots.size` alone, which would drop such a group.
    const undo = new UndoSystem(new Grid());

    undo.beginGroup();
    undo.addRemovedHighway(makeHighway('hw-1'));
    undo.endGroup();

    expect(undo.canUndo()).toBe(true);
  });

  it('still discards a group that recorded nothing', () => {
    const undo = new UndoSystem(new Grid());
    undo.beginGroup();
    undo.endGroup();
    expect(undo.canUndo()).toBe(false);
  });

  it('restores the cells it snapshotted', () => {
    const grid = new Grid();
    const undo = new UndoSystem(grid);

    undo.beginGroup();
    undo.snapshotCellAndNeighbors(6, 6);
    grid.setCell(6, 6, { type: CellType.Road, roadConnections: 3 });
    undo.endGroup();

    undo.undo();

    const cell = grid.getCell(6, 6)!;
    expect(cell.type).toBe(CellType.Empty);
    expect(cell.roadConnections).toBe(0);
  });

  /**
   * …and *every* field of them, which the test above cannot show: it restores a cell to the
   * empty state, and the empty state is what an unlisted field would be left at anyway.
   *
   * `deepCopyCell` names each field by hand, so a field added to `Cell` and forgotten there
   * is silently dropped by undo — the exact shape of the loss this file was written about,
   * one level down. This asserts against the populated cell's own key set rather than a
   * remembered list, so a new field fails here until it is copied. (`_isTIntersection` was
   * removed from `Cell` in the same change that added this; nothing else reads a cell field
   * carefully enough to have noticed either way.)
   */
  it('restores every field of a snapshotted cell, not the ones we remembered', () => {
    const grid = new Grid();
    const undo = new UndoSystem(grid);
    const populated: Cell = {
      type: CellType.Road,
      entityId: 'entity-1',
      roadConnections: Direction.Up | Direction.Left | Direction.UpRight,
      color: GameColor.Red,
      connectorDir: Direction.Down,
      pendingDeletion: true,
      _isIntersection: true,
    };
    grid.setCell(6, 6, populated);

    undo.beginGroup();
    undo.snapshotCellAndNeighbors(6, 6);
    grid.clearCell(6, 6);
    undo.endGroup();
    undo.undo();

    const cell = grid.getCell(6, 6)!;
    expect(cell).toEqual(populated);
    expect(Object.keys(cell).sort()).toEqual(Object.keys(populated).sort());
  });

  it('ignores recorders called outside a group', () => {
    const undo = new UndoSystem(new Grid());
    undo.addRemovedGasStation(new GasStation({ gx: 1, gy: 1 }));
    undo.addInventoryDelta('roads', 5);
    expect(undo.canUndo()).toBe(false);
  });
});
