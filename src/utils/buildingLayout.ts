import { TILE_SIZE, CELL_MARGIN, GROUND_PLATE_MARGIN } from '../constants';

export interface Rect2D {
  centerX: number;  // world X (Three.js X)
  centerZ: number;  // world Z (Three.js Z)
  width: number;    // X dimension
  depth: number;    // Z dimension
}

export interface Point2D {
  x: number;  // world X
  z: number;  // world Z
}

/** Center of a grid cell in world (pixel) coordinates. */
export function cellCenter(pos: { gx: number; gy: number }): { x: number; z: number } {
  return {
    x: pos.gx * TILE_SIZE + TILE_SIZE / 2,
    z: pos.gy * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Compute a ground plate rect covering the bounding box of given cells, inset by cellMargin. */
export function computeGroundPlate(
  cells: { gx: number; gy: number }[],
  cellMargin = CELL_MARGIN,
): Rect2D {
  let minGx = Infinity, maxGx = -Infinity;
  let minGy = Infinity, maxGy = -Infinity;
  for (const c of cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gy < minGy) minGy = c.gy;
    if (c.gy > maxGy) maxGy = c.gy;
  }
  const spanX = (maxGx - minGx + 1) * TILE_SIZE;
  const spanZ = (maxGy - minGy + 1) * TILE_SIZE;
  return {
    centerX: (minGx + maxGx) / 2 * TILE_SIZE + TILE_SIZE / 2,
    centerZ: (minGy + maxGy) / 2 * TILE_SIZE + TILE_SIZE / 2,
    width: spanX - 2 * cellMargin,
    depth: spanZ - 2 * cellMargin,
  };
}

/** Shrink a rect inward by margin on all sides. */
export function computeInnerSpace(plate: Rect2D, margin = GROUND_PLATE_MARGIN): Rect2D {
  return {
    centerX: plate.centerX,
    centerZ: plate.centerZ,
    width: plate.width - 2 * margin,
    depth: plate.depth - 2 * margin,
  };
}

/**
 * Compute the usable area for an element within a single cell of a multi-cell plate.
 * The element sits inside the plate's inner space (plateInner), and gets an additional
 * GROUND_PLATE_MARGIN inset on interior sides (sides facing neighboring cells).
 * Plate-edge sides are already bounded by plateInner so no extra inset is needed there.
 */
export function computeCellWithinPlate(
  cellPos: { gx: number; gy: number },
  plateInner: Rect2D,
  margin = GROUND_PLATE_MARGIN,
): Rect2D {
  const cellLeft = cellPos.gx * TILE_SIZE;
  const cellRight = cellLeft + TILE_SIZE;
  const cellTop = cellPos.gy * TILE_SIZE;
  const cellBottom = cellTop + TILE_SIZE;

  const plateLeft = plateInner.centerX - plateInner.width / 2;
  const plateRight = plateInner.centerX + plateInner.width / 2;
  const plateTop = plateInner.centerZ - plateInner.depth / 2;
  const plateBottom = plateInner.centerZ + plateInner.depth / 2;

  // Clip cell to plate inner space
  let left = Math.max(cellLeft, plateLeft);
  let right = Math.min(cellRight, plateRight);
  let top = Math.max(cellTop, plateTop);
  let bottom = Math.min(cellBottom, plateBottom);

  // Add margin on interior sides (where the cell edge is inside the plate, not on the plate edge)
  if (cellLeft > plateLeft) left += margin;
  if (cellRight < plateRight) right -= margin;
  if (cellTop > plateTop) top += margin;
  if (cellBottom < plateBottom) bottom -= margin;

  return {
    centerX: (left + right) / 2,
    centerZ: (top + bottom) / 2,
    width: right - left,
    depth: bottom - top,
  };
}

