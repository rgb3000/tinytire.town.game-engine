import type { GameColor, GridPos, BusinessRotation } from '../types';
import { generateId } from '../utils/math';

/** Cell offsets from anchor (top-left) for each rotation. */
const LAYOUT_OFFSETS: Record<BusinessRotation, {
  building: GridPos; pins: GridPos; connector: GridPos; groundPlate: GridPos;
}> = {
  0:   { building: { gx: 0, gy: 0 }, pins: { gx: 1, gy: 0 }, connector: { gx: 0, gy: 1 }, groundPlate: { gx: 1, gy: 1 } },
  90:  { building: { gx: 1, gy: 0 }, pins: { gx: 1, gy: 1 }, connector: { gx: 0, gy: 0 }, groundPlate: { gx: 0, gy: 1 } },
  180: { building: { gx: 1, gy: 1 }, pins: { gx: 0, gy: 1 }, connector: { gx: 1, gy: 0 }, groundPlate: { gx: 0, gy: 0 } },
  270: { building: { gx: 0, gy: 1 }, pins: { gx: 0, gy: 0 }, connector: { gx: 1, gy: 1 }, groundPlate: { gx: 1, gy: 0 } },
};

export class Business {
  readonly id: string;
  /** Anchor position (top-left of the 2x2 block). */
  readonly pos: GridPos;
  readonly color: GameColor;
  readonly rotation: BusinessRotation;
  readonly buildingPos: GridPos;
  readonly pinsPos: GridPos;
  /** The 4th cell of the 2x2 block — stays empty but reserved for ground plate rendering. */
  readonly groundPlatePos: GridPos;
  readonly connectorPos: GridPos;
  demandPins: number;
  connected: boolean = false;
  age: number = 0;
  pinCooldown: number = 0;
  pinOutputRate: number = 0;
  pinAccumulator: number = 0;

  constructor(
    pos: GridPos,
    color: GameColor,
    rotation: BusinessRotation,
  ) {
    this.id = generateId();
    this.pos = pos;
    this.color = color;
    this.rotation = rotation;
    this.demandPins = 1;

    const offsets = LAYOUT_OFFSETS[rotation];
    this.buildingPos = { gx: pos.gx + offsets.building.gx, gy: pos.gy + offsets.building.gy };
    this.pinsPos = { gx: pos.gx + offsets.pins.gx, gy: pos.gy + offsets.pins.gy };
    this.connectorPos = { gx: pos.gx + offsets.connector.gx, gy: pos.gy + offsets.connector.gy };
    this.groundPlatePos = { gx: pos.gx + offsets.groundPlate.gx, gy: pos.gy + offsets.groundPlate.gy };
  }

  /** Returns the 3 cell positions that are set on the grid (building, pins, connector). */
  getCells(): GridPos[] {
    return [this.buildingPos, this.pinsPos, this.connectorPos];
  }
}
