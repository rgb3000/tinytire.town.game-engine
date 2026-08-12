import { Direction } from '../types';
import type { GridPos } from '../types';

// --- Bitmask direction utilities ---

/** Compute opposite direction via bit-pair swap.
 *  Pairs: Up/Down (bits 0-1), Left/Right (bits 2-3), UpLeft/DownRight (bits 4-5), UpRight/DownLeft (bits 6-7) */
// But our layout is: Up=1,Down=2,Left=4,Right=8,UpLeft=16,UpRight=32,DownLeft=64,DownRight=128
// Pairs: (Up,Down)=(1,2), (Left,Right)=(4,8), (UpLeft,DownRight)=(16,128), (UpRight,DownLeft)=(32,64)
// Bit swap for pairs at bits 0-1 and 2-3 works with 0x55/0xAA pattern within each pair
// But (UpLeft,DownRight) are bits 4 and 7, (UpRight,DownLeft) are bits 5 and 6
// So we need a lookup table instead for correctness.
const OPPOSITE_TABLE = new Uint8Array(256);
OPPOSITE_TABLE[Direction.Up] = Direction.Down;
OPPOSITE_TABLE[Direction.Down] = Direction.Up;
OPPOSITE_TABLE[Direction.Left] = Direction.Right;
OPPOSITE_TABLE[Direction.Right] = Direction.Left;
OPPOSITE_TABLE[Direction.UpLeft] = Direction.DownRight;
OPPOSITE_TABLE[Direction.DownRight] = Direction.UpLeft;
OPPOSITE_TABLE[Direction.UpRight] = Direction.DownLeft;
OPPOSITE_TABLE[Direction.DownLeft] = Direction.UpRight;

export function opposite(dir: Direction): Direction {
  return OPPOSITE_TABLE[dir] as Direction;
}

/** Lookup table: index = (dx+1)*3 + (dy+1), value = Direction */
const DELTA_TO_DIR = new Uint8Array(9);
DELTA_TO_DIR[(-1 + 1) * 3 + (-1 + 1)] = Direction.UpLeft;     // dx=-1, dy=-1
DELTA_TO_DIR[(-1 + 1) * 3 + (0 + 1)]  = Direction.Left;       // dx=-1, dy=0
DELTA_TO_DIR[(-1 + 1) * 3 + (1 + 1)]  = Direction.DownLeft;   // dx=-1, dy=1
DELTA_TO_DIR[(0 + 1) * 3 + (-1 + 1)]  = Direction.Up;         // dx=0, dy=-1
DELTA_TO_DIR[(0 + 1) * 3 + (0 + 1)]   = 0;                    // dx=0, dy=0 (invalid)
DELTA_TO_DIR[(0 + 1) * 3 + (1 + 1)]   = Direction.Down;       // dx=0, dy=1
DELTA_TO_DIR[(1 + 1) * 3 + (-1 + 1)]  = Direction.UpRight;    // dx=1, dy=-1
DELTA_TO_DIR[(1 + 1) * 3 + (0 + 1)]   = Direction.Right;      // dx=1, dy=0
DELTA_TO_DIR[(1 + 1) * 3 + (1 + 1)]   = Direction.DownRight;  // dx=1, dy=1

export function directionFromDelta(dx: number, dy: number): Direction {
  return DELTA_TO_DIR[(dx + 1) * 3 + (dy + 1)] as Direction;
}

export function isDiagonalDir(dir: Direction): boolean {
  return (dir & 0xF0) !== 0;
}

/**
 * How many of the eight directions a connection mask carries.
 *
 * All eight, deliberately. A `cardinalConnectionCount` sat next to this and masked to
 * `0x0F`; `Grid.recomputeIntersectionFlags` used it, which made a diagonal three-way merge
 * score 2 and escape being labelled a junction at all. Nothing wants a cardinal-only count,
 * so there is no longer one to reach for by mistake.
 */
export function connectionCount(mask: number): number {
  // Popcount for 8-bit value
  let v = mask;
  v = (v & 0x55) + ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (v & 0x0F) + ((v >> 4) & 0x0F);
}

export function forEachDirection(mask: number, callback: (dir: Direction) => void): void {
  let bits = mask;
  while (bits !== 0) {
    const lowest = bits & (-bits); // isolate lowest set bit
    callback(lowest as Direction);
    bits &= bits - 1; // clear lowest set bit
  }
}

/** All 8 directions as a constant array (allocated once) */
export const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.Up, Direction.Down, Direction.Left, Direction.Right,
  Direction.UpLeft, Direction.UpRight, Direction.DownLeft, Direction.DownRight,
];

/** Cardinal directions only */
export const CARDINAL_DIRECTIONS: readonly Direction[] = [
  Direction.Up, Direction.Down, Direction.Left, Direction.Right,
];

/** Direction offsets: single source of truth */
export const DIRECTION_OFFSETS: Record<Direction, GridPos> = {
  [Direction.Up]:        { gx: 0, gy: -1 },
  [Direction.Down]:      { gx: 0, gy: 1 },
  [Direction.Left]:      { gx: -1, gy: 0 },
  [Direction.Right]:     { gx: 1, gy: 0 },
  [Direction.UpLeft]:    { gx: -1, gy: -1 },
  [Direction.UpRight]:   { gx: 1, gy: -1 },
  [Direction.DownLeft]:  { gx: -1, gy: 1 },
  [Direction.DownRight]: { gx: 1, gy: 1 },
};

export function getDirection(from: GridPos, to: GridPos): Direction {
  const dx = to.gx - from.gx;
  const dy = to.gy - from.gy;

  // Diagonal: both axes move by exactly 1
  if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
    if (dx === 1 && dy === -1) return Direction.UpRight;
    if (dx === -1 && dy === -1) return Direction.UpLeft;
    if (dx === 1 && dy === 1) return Direction.DownRight;
    return Direction.DownLeft;
  }

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? Direction.Right : Direction.Left;
  }
  return dy >= 0 ? Direction.Down : Direction.Up;
}

export function directionAngle(dir: Direction): number {
  switch (dir) {
    case Direction.Right: return 0;
    case Direction.Down:  return Math.PI / 2;
    case Direction.Left:  return Math.PI;
    case Direction.Up:    return -Math.PI / 2;
    case Direction.UpRight:   return -Math.PI / 4;
    case Direction.DownRight:  return Math.PI / 4;
    case Direction.DownLeft:   return 3 * Math.PI / 4;
    case Direction.UpLeft:     return -3 * Math.PI / 4;
  }
}

export const YIELD_TO_DIRECTION: Record<Direction, Direction> = {
  [Direction.Up]: Direction.Left,
  [Direction.Right]: Direction.Up,
  [Direction.Down]: Direction.Right,
  [Direction.Left]: Direction.Down,
  [Direction.UpRight]: Direction.UpLeft,
  [Direction.DownRight]: Direction.UpRight,
  [Direction.DownLeft]: Direction.DownRight,
  [Direction.UpLeft]: Direction.DownLeft,
};

