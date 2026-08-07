import type { GridPos, PixelPos, Direction } from '../types';
import { TILE_SIZE } from '../constants';

let nextId = 0;

export function generateId(): string {
  return (++nextId).toString(36);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function manhattanDist(a: GridPos, b: GridPos): number {
  return Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy);
}

export function octileDist(a: GridPos, b: GridPos): number {
  const dx = Math.abs(a.gx - b.gx);
  const dy = Math.abs(a.gy - b.gy);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

export function isDiagonal(dir: Direction): boolean {
  return (dir & 0xF0) !== 0;
}

export function gridToPixelCenter(pos: GridPos): PixelPos {
  return {
    x: pos.gx * TILE_SIZE + TILE_SIZE / 2,
    y: pos.gy * TILE_SIZE + TILE_SIZE / 2,
  };
}

export function pixelToGrid(px: number, py: number): GridPos {
  return {
    gx: Math.floor(px / TILE_SIZE),
    gy: Math.floor(py / TILE_SIZE),
  };
}

export function gridPosEqual(a: GridPos, b: GridPos): boolean {
  return a.gx === b.gx && a.gy === b.gy;
}

export function gridPosKey(pos: GridPos): string {
  return `${pos.gx},${pos.gy}`;
}

export function hash2D(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263 + 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function smoothNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  // smoothstep
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);

  const v00 = hash2D(ix, iy);
  const v10 = hash2D(ix + 1, iy);
  const v01 = hash2D(ix, iy + 1);
  const v11 = hash2D(ix + 1, iy + 1);

  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

export function cubicBezier(
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number, t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return {
    x: uuu * p0x + 3 * uu * t * p1x + 3 * u * tt * p2x + ttt * p3x,
    y: uuu * p0y + 3 * uu * t * p1y + 3 * u * tt * p2y + ttt * p3y,
  };
}

export function cubicBezierTangent(
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number, t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1x - p0x) + 6 * u * t * (p2x - p1x) + 3 * t * t * (p3x - p2x),
    y: 3 * u * u * (p1y - p0y) + 6 * u * t * (p2y - p1y) + 3 * t * t * (p3y - p2y),
  };
}
