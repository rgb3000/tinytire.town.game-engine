import type { GridPos } from '../types';
import { TILE_SIZE } from '../constants';
import type { TriangleMap } from './field';
import { buildCoverageField, SUBCELL } from './field';
import type { SignedField } from './distanceField';
import { buildSignedDistanceField } from './distanceField';
import { traceIsolines } from './marchingSquares';
import type { NestedPolygon } from './polygons';
import { nestLoops, simplifyLoop } from './polygons';

/** Vertical spacing between terrace contours, in tiles. */
export const STEP_TILES = 0.3;

/** Ceiling on terrace count, so a huge massif does not become a hundred rings. */
export const MAX_TERRACES = 6;

/** Outer silhouettes keep a quarter-subcell tolerance so painted shapes stay recognisable. */
const OUTER_TOLERANCE = TILE_SIZE / SUBCELL / 4;
const INNER_TOLERANCE = TILE_SIZE / SUBCELL / 2;

export interface TerraceLevel {
  /** 0 is the footprint; higher indices step inward, toward the peak or the deepest water. */
  index: number;
  polygons: NestedPolygon[];
}

export interface TerrainContours {
  levels: TerraceLevel[];
  /** Ring outside the footprint. Empty when `shorelineTiles` is omitted or zero. */
  shoreline: NestedPolygon[];
  /** Retained so renderers can sample depth per vertex. */
  field: SignedField;
  maxDistanceTiles: number;
}

/** Sample-space coordinates for a world-space point, for depth lookups. */
export function worldToSample(field: SignedField, x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x / TILE_SIZE - field.originGx) * SUBCELL - 0.5,
    sy: (y / TILE_SIZE - field.originGy) * SUBCELL - 0.5,
  };
}

/**
 * Turn terrain cells into terrace contours.
 *
 * Terrace count is derived from how thick the shape actually is, never from how many cells
 * it contains. That is the fix for the collapsing silhouettes: a narrow ridge has no samples
 * deep enough to support many rings, so it cannot be assigned them.
 */
export function buildTerrainContours(
  cells: GridPos[],
  triangles?: TriangleMap,
  shorelineTiles = 0,
): TerrainContours | null {
  const coverage = buildCoverageField(cells, triangles);
  if (!coverage) return null;

  const field = buildSignedDistanceField(coverage);
  const maxDistanceTiles = field.maxInside;

  const levelCount = Math.max(1, Math.min(MAX_TERRACES, Math.floor(maxDistanceTiles / STEP_TILES)));

  const levels: TerraceLevel[] = [];
  for (let i = 0; i < levelCount; i++) {
    const tolerance = i === 0 ? OUTER_TOLERANCE : INNER_TOLERANCE;
    const polygons = tracePolygons(field, i * STEP_TILES, tolerance);
    // Unreachable as the numbers currently stand: `levelCount` floors against the field's
    // own maximum, so the innermost threshold sits a whole step below it and some sample is
    // always above it. Kept because that argument leans on three other modules — the
    // coverage field's zero padding, the tracer's minimum loop length, and `nestLoops`'
    // filter — and an empty level in the array is worse for a renderer than a missing one.
    if (polygons.length === 0) break;
    levels.push({ index: i, polygons });
  }

  const shoreline = shorelineTiles > 0
    ? tracePolygons(field, -shorelineTiles, OUTER_TOLERANCE)
    : [];

  return { levels, shoreline, field, maxDistanceTiles };
}

function tracePolygons(field: SignedField, threshold: number, tolerance: number): NestedPolygon[] {
  const loops = traceIsolines(field, threshold).map(l => simplifyLoop(l, tolerance));
  return nestLoops(loops);
}
