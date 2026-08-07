import type { GridPos } from '../types';
import { computeGroundPlate, computeInnerSpace } from './buildingLayout';
import type { Rect2D, Point2D } from './buildingLayout';

export type { Rect2D, Point2D };

export interface GasStationLayoutInput {
  pos: GridPos;
}

export interface GasStationLayout {
  groundPlate: Rect2D;
  canopy: Rect2D;
}

export function getGasStationLayout(input: GasStationLayoutInput): GasStationLayout {
  const groundPlate = computeGroundPlate([input.pos]);
  const canopy = computeInnerSpace(groundPlate);

  return {
    groundPlate,
    canopy,
  };
}
