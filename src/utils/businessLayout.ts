import type { BusinessRotation } from '../types';

import { computeGroundPlate, computeInnerSpace, computeCellWithinPlate, cellCenter } from './buildingLayout';
import type { Rect2D, Point2D } from './buildingLayout';

// Re-export shared types for backward compatibility
export type { Rect2D, Point2D };

export interface BusinessLayoutInput {
  anchorPos: { gx: number; gy: number };
  rotation: BusinessRotation;
}

export interface BusinessLayout {
  groundPlate: Rect2D;
  building: Rect2D;
  pinSlots: Point2D[];        // 9 positions (3 cols x 3 rows)
  connector: Point2D;         // center of the connector cell
}

/** Cell offsets from anchor for each rotation (mirrors Business entity). */
const LAYOUT_OFFSETS: Record<BusinessRotation, {
  building: { gx: number; gy: number };
  pins: { gx: number; gy: number };
  connector: { gx: number; gy: number };
  groundPlate: { gx: number; gy: number };
}> = {
  0:   { building: { gx: 0, gy: 0 }, pins: { gx: 1, gy: 0 }, connector: { gx: 0, gy: 1 }, groundPlate: { gx: 1, gy: 1 } },
  90:  { building: { gx: 1, gy: 0 }, pins: { gx: 1, gy: 1 }, connector: { gx: 0, gy: 0 }, groundPlate: { gx: 0, gy: 1 } },
  180: { building: { gx: 1, gy: 1 }, pins: { gx: 0, gy: 1 }, connector: { gx: 1, gy: 0 }, groundPlate: { gx: 0, gy: 0 } },
  270: { building: { gx: 0, gy: 1 }, pins: { gx: 0, gy: 0 }, connector: { gx: 1, gy: 1 }, groundPlate: { gx: 1, gy: 0 } },
};

function getCellPositions(input: BusinessLayoutInput) {
  const { anchorPos, rotation } = input;
  const offsets = LAYOUT_OFFSETS[rotation];
  return {
    building: { gx: anchorPos.gx + offsets.building.gx, gy: anchorPos.gy + offsets.building.gy },
    pins: { gx: anchorPos.gx + offsets.pins.gx, gy: anchorPos.gy + offsets.pins.gy },
    connector: { gx: anchorPos.gx + offsets.connector.gx, gy: anchorPos.gy + offsets.connector.gy },
    groundPlate: { gx: anchorPos.gx + offsets.groundPlate.gx, gy: anchorPos.gy + offsets.groundPlate.gy },
  };
}

function getPlateInner(input: BusinessLayoutInput): Rect2D {
  const cells = getCellPositions(input);
  const plate = computeGroundPlate([cells.building, cells.pins, cells.connector, cells.groundPlate]);
  return computeInnerSpace(plate);
}

export function getGroundPlateLayout(input: BusinessLayoutInput): Rect2D {
  const cells = getCellPositions(input);
  return computeGroundPlate([cells.building, cells.pins, cells.connector, cells.groundPlate]);
}

export function getBuildingLayout(input: BusinessLayoutInput): Rect2D {
  const cells = getCellPositions(input);
  return computeCellWithinPlate(cells.building, getPlateInner(input));
}

export function getPinGridLayout(input: BusinessLayoutInput): Point2D[] {
  const cells = getCellPositions(input);
  const pinRect = computeCellWithinPlate(cells.pins, getPlateInner(input));

  // Spread pins evenly across the cell's inner rect (3 cols × 3 rows)
  const cols = 3;
  const rows = 3;
  const spacingX = pinRect.width / cols;
  const spacingZ = pinRect.depth / rows;

  const points: Point2D[] = [];
  for (let i = 0; i < 9; i++) {
    const col = i % cols;       // 0..2
    const row = (i / cols) | 0; // 0..2
    const offsetX = (col - (cols - 1) / 2) * spacingX;
    const offsetZ = (row - (rows - 1) / 2) * spacingZ;
    points.push({
      x: pinRect.centerX + offsetX,
      z: pinRect.centerZ + offsetZ,
    });
  }
  return points;
}

export function getConnectorCenter(input: BusinessLayoutInput): Point2D {
  const cells = getCellPositions(input);
  const c = cellCenter(cells.connector);
  return { x: c.x, z: c.z };
}

export function getBusinessLayout(input: BusinessLayoutInput): BusinessLayout {
  return {
    groundPlate: getGroundPlateLayout(input),
    building: getBuildingLayout(input),
    pinSlots: getPinGridLayout(input),
    connector: getConnectorCenter(input),
  };
}
