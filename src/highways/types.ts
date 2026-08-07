import type { GridPos, PixelPos } from '../types';

export interface Highway {
  id: string;
  fromPos: GridPos;
  toPos: GridPos;
  cp1: PixelPos;       // bezier control point 1 (world px)
  cp2: PixelPos;       // bezier control point 2 (world px)
  arcLength: number;
  polyline: PixelPos[];   // precomputed dense sample of bezier curve
  cumDist: number[];      // cumulative arc-length distances along polyline
}

export type PathStep =
  | { kind: 'grid'; pos: GridPos }
  | { kind: 'highway'; highwayId: string; from: GridPos; to: GridPos };
