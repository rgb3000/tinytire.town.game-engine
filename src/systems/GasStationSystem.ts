import type { Grid } from '../core/Grid';
import type { Pathfinder } from '../pathfinding/Pathfinder';
import { GasStation } from '../entities/GasStation';
import { CellType } from '../types';
import type { GridPos } from '../types';
import { computePathFuelCost } from '../pathfinding/pathCost';
import type { HighwaySystem } from './HighwaySystem';

export class GasStationSystem {
  private gasStations: GasStation[] = [];
  private grid: Grid;
  isDirty = false;

  constructor(grid: Grid) {
    this.grid = grid;
  }

  getGasStations(): GasStation[] {
    return this.gasStations;
  }

  getGasStationById(id: string): GasStation | undefined {
    return this.gasStations.find(gs => gs.id === id);
  }

  clearDirty(): void {
    this.isDirty = false;
  }

  /** Try to place a gas station at the given position. Returns the station if successful, null if invalid. */
  placeGasStation(pos: GridPos): GasStation | null {
    if (!this.grid.inBounds(pos.gx, pos.gy)) return null;
    const cell = this.grid.getCell(pos.gx, pos.gy);
    if (!cell || cell.type !== CellType.Empty) return null;

    const station = new GasStation(pos);

    // Set grid cell — GasStation type, traversable as destination
    this.grid.setCell(pos.gx, pos.gy, {
      type: CellType.GasStation,
      entityId: station.id,
    });

    this.gasStations.push(station);
    this.isDirty = true;
    return station;
  }

  removeGasStation(id: string): boolean {
    const idx = this.gasStations.findIndex(gs => gs.id === id);
    if (idx === -1) return false;

    const station = this.gasStations[idx];

    // Clear the single cell
    this.grid.setCell(station.pos.gx, station.pos.gy, {
      type: CellType.Empty,
      entityId: null,
      roadConnections: 0,
      connectorDir: null,
      color: null,
    });

    this.gasStations.splice(idx, 1);
    this.isDirty = true;
    return true;
  }

  /** Find the nearest reachable gas station from a position by path distance */
  findNearestReachable(
    fromPos: GridPos,
    pathfinder: Pathfinder,
    highwaySystem?: HighwaySystem | null,
  ): { station: GasStation; fuelCost: number } | null {
    let best: { station: GasStation; fuelCost: number } | null = null;

    for (const station of this.gasStations) {
      const path = pathfinder.findPath(fromPos, station.pos);
      if (!path || path.length < 2) continue;

      const fuelCost = computePathFuelCost(path, highwaySystem);

      if (!best || fuelCost < best.fuelCost) {
        best = { station, fuelCost };
      }
    }

    return best;
  }

  /** Find gas station that owns a given cell position */
  findByCellPos(gx: number, gy: number): GasStation | undefined {
    const cell = this.grid.getCell(gx, gy);
    if (!cell || !cell.entityId) return undefined;
    if (cell.type !== CellType.GasStation) return undefined;
    return this.gasStations.find(gs => gs.id === cell.entityId);
  }
}
