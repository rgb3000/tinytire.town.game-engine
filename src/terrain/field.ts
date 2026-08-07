import type { GridPos } from '../types';
import { TILE_SIZE } from '../constants';

/** Both mountain and lake triangle maps share this structure. */
export type TriangleMap = Map<string, { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean }>;

/**
 * Samples per cell edge. Four is enough to resolve the half-tile triangle quadrants the
 * designer paints, which are the finest feature the map format can express.
 */
export const SUBCELL = 4;

/** Cells of padding around the bounding box, so no contour crossing lands on the border. */
const PAD_CELLS = 1;

/**
 * Supersamples per axis within one subsample, used only for triangle-subdivided cells.
 *
 * A single point test per subsample is not good enough: the quadrant diagonals run exactly
 * through the sample centres of an even lattice, which skews the four quadrant areas to
 * 2 / 4 / 4 / 6 instead of 4 / 4 / 4 / 4. Averaging an 8x8 grid brings them within 0.25.
 */
const SUPERSAMPLE = 8;

/** Nudges the u axis off the diagonals so no supersample sits exactly on a boundary. */
const U_EPSILON = 1e-4;

export interface CoverageField {
  /** Sample counts, not cell counts. */
  width: number;
  height: number;
  /** Grid coordinate of the field's top-left corner. */
  originGx: number;
  originGy: number;
  /** Row-major, `width * height` entries, each a coverage fraction in `[0, 1]`. */
  data: Float32Array;
}

export function sampleAt(field: CoverageField, sx: number, sy: number): number {
  if (sx < 0 || sy < 0 || sx >= field.width || sy >= field.height) return 0;
  return field.data[sy * field.width + sx];
}

/** World-space pixel position of a sample's centre. */
export function sampleToWorld(field: CoverageField, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (field.originGx + (sx + 0.5) / SUBCELL) * TILE_SIZE,
    y: (field.originGy + (sy + 0.5) / SUBCELL) * TILE_SIZE,
  };
}

/**
 * Rasterise terrain cells into a binary coverage field.
 *
 * Triangle quadrants are not a special case here: a quadrant simply claims the subsamples
 * whose centres fall inside it. Everything downstream sees one uniform field, which is why
 * the old `getTriFlags` branching in the contour extractor is gone.
 */
export function buildCoverageField(cells: GridPos[], triangles?: TriangleMap): CoverageField | null {
  if (cells.length === 0) return null;

  let minGx = Infinity, minGy = Infinity, maxGx = -Infinity, maxGy = -Infinity;
  for (const c of cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gy < minGy) minGy = c.gy;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gy > maxGy) maxGy = c.gy;
  }

  const originGx = minGx - PAD_CELLS;
  const originGy = minGy - PAD_CELLS;
  const cols = maxGx - minGx + 1 + 2 * PAD_CELLS;
  const rows = maxGy - minGy + 1 + 2 * PAD_CELLS;
  const width = cols * SUBCELL;
  const height = rows * SUBCELL;
  const data = new Float32Array(width * height);

  for (const c of cells) {
    const tri = triangles?.get(`${c.gx},${c.gy}`);
    const full = !tri || (tri.top === true && tri.right === true && tri.bottom === true && tri.left === true);

    const baseX = (c.gx - originGx) * SUBCELL;
    const baseY = (c.gy - originGy) * SUBCELL;

    for (let j = 0; j < SUBCELL; j++) {
      for (let i = 0; i < SUBCELL; i++) {
        const coverage = full ? 1 : quadrantCoverage(tri!, i, j);
        if (coverage > 0) data[(baseY + j) * width + (baseX + i)] = coverage;
      }
    }
  }

  return { width, height, originGx, originGy, data };
}

/** Fraction of subsample `(i, j)` covered by the cell's active quadrants. */
function quadrantCoverage(
  tri: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean },
  i: number,
  j: number,
): number {
  let hits = 0;
  for (let n = 0; n < SUPERSAMPLE; n++) {
    for (let m = 0; m < SUPERSAMPLE; m++) {
      const u = (i + (m + 0.5) / SUPERSAMPLE) / SUBCELL + U_EPSILON;
      const v = (j + (n + 0.5) / SUPERSAMPLE) / SUBCELL;
      if (quadrantActive(tri, u, v)) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/**
 * Which quadrant a cell-local point falls in, matching the designer's brush
 * (`MapDesigner.ts:389`) exactly so that what you paint is what gets rasterised.
 */
function quadrantActive(
  tri: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean },
  u: number,
  v: number,
): boolean {
  const aboveDiag1 = v < u;
  const aboveDiag2 = v < 1 - u;
  if (aboveDiag1 && aboveDiag2) return tri.top === true;
  if (aboveDiag1 && !aboveDiag2) return tri.right === true;
  if (!aboveDiag1 && !aboveDiag2) return tri.bottom === true;
  return tri.left === true;
}
