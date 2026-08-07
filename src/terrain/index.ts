/**
 * Internal barrel for the terrain geometry pipeline.
 *
 * Rendering imports terrain from here rather than reaching into individual modules. This is
 * *not* part of the package's public surface: `src/index.ts` is, and it must not re-export
 * any of this.
 */
export { SUBCELL, buildCoverageField, sampleAt, sampleToWorld } from './field';
export type { CoverageField, TriangleMap } from './field';
export { buildSignedDistanceField, sampleFieldBilinear } from './distanceField';
export type { SignedField } from './distanceField';
export { traceIsolines } from './marchingSquares';
export { signedArea, ensureWinding, pointInPolygon, simplifyLoop, nestLoops } from './polygons';
export type { NestedPolygon } from './polygons';
export { buildTerrainContours, worldToSample, STEP_TILES, MAX_TERRACES } from './contours';
export type { TerraceLevel, TerrainContours } from './contours';
