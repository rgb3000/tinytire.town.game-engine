/**
 * Covers `cancelPending` — until now dead code, and load-bearing since `Game.performUndo`
 * started calling it.
 *
 * A cell snapshot is taken *before* the `markPending` that follows it, so undo restores a
 * cell whose `pendingDeletion` flag is already false while this system still holds the
 * entry. Left alone, the next `update()` with no cars left on the cell would finalise the
 * deletion and strip the connections the player just restored — the undo would undo itself
 * a second later.
 */
import { describe, it, expect } from 'vitest';

import { Grid } from '../core/Grid';
import { CellType, Direction } from '../types';
import { RoadSystem } from './RoadSystem';
import { PendingDeletionSystem } from './PendingDeletionSystem';

function makeRoadWithNeighbour() {
  const grid = new Grid();
  const roadSystem = new RoadSystem(grid);
  const pending = new PendingDeletionSystem(grid, roadSystem);

  roadSystem.placeRoad(5, 5);
  roadSystem.placeRoad(6, 5);
  roadSystem.connectRoads(5, 5, 6, 5);

  return { grid, roadSystem, pending };
}

describe('PendingDeletionSystem.cancelPending', () => {
  it('drops the entry so a later update cannot finalise the deletion', () => {
    const { grid, pending } = makeRoadWithNeighbour();
    const cell = grid.getCell(5, 5)!;
    const connectionsBefore = cell.roadConnections;
    expect(connectionsBefore).not.toBe(0);

    pending.markPending(5, 5, ['car-1']);
    expect(pending.isPending(5, 5)).toBe(true);

    pending.cancelPending(5, 5);

    // The car is gone, which is exactly when a surviving entry would finalise.
    pending.update();
    pending.update();

    expect(pending.isPending(5, 5)).toBe(false);
    expect(cell.type).toBe(CellType.Road);
    expect(cell.roadConnections).toBe(connectionsBefore);
  });

  it('clears the faded-render flag on the cell', () => {
    const { grid, pending } = makeRoadWithNeighbour();
    pending.markPending(5, 5, ['car-1']);
    expect(grid.getCell(5, 5)!.pendingDeletion).toBe(true);

    pending.cancelPending(5, 5);

    expect(grid.getCell(5, 5)!.pendingDeletion).toBe(false);
  });

  it('shows what an uncancelled entry would have done', () => {
    // The failure mode this guards against, spelled out: with no cars left the entry
    // finalises and the connections go away on their own.
    const { grid, pending } = makeRoadWithNeighbour();
    pending.markPending(5, 5, ['car-1']);
    pending.notifyCarPassed('car-1', 5, 5);

    pending.update();

    expect(grid.getCell(5, 5)!.roadConnections).toBe(0);
  });

  it('is harmless on a cell that was never pending', () => {
    const { grid, pending } = makeRoadWithNeighbour();
    const connections = grid.getCell(5, 5)!.roadConnections;

    expect(() => pending.cancelPending(5, 5)).not.toThrow();

    expect(grid.getCell(5, 5)!.roadConnections).toBe(connections);
    expect(grid.getCell(5, 5)!.type).toBe(CellType.Road);
  });

  it('only rescues the connections that were rescued', () => {
    // Sanity check on the neighbouring behaviour `cancelPending` sits next to.
    const { grid, pending } = makeRoadWithNeighbour();
    pending.markPending(5, 5, ['car-1']);

    pending.rescueConnection(5, 5, Direction.Right);

    expect(grid.getCell(5, 5)!.pendingDeletion).toBe(false);
    expect(pending.isPending(5, 5)).toBe(false);
  });
});
