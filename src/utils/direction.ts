import { Direction, LaneId } from '../types';
import type { GridPos, PixelPos } from '../types';
import { LANE_OFFSET } from '../constants';

const INV_SQRT2 = 1 / Math.sqrt(2);

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

export function connectionCount(mask: number): number {
  // Popcount for 8-bit value
  let v = mask;
  v = (v & 0x55) + ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (v & 0x0F) + ((v >> 4) & 0x0F);
}

export function cardinalConnectionCount(mask: number): number {
  const cardinal = mask & 0x0F; // Up|Down|Left|Right
  let v = cardinal;
  v = (v & 0x05) + ((v >> 1) & 0x05);
  return (v & 0x03) + ((v >> 2) & 0x03);
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

export function directionToLane(dir: Direction): LaneId {
  switch (dir) {
    case Direction.Right: return LaneId.HorizontalRight;
    case Direction.Left: return LaneId.HorizontalLeft;
    case Direction.Down: return LaneId.VerticalDown;
    case Direction.Up: return LaneId.VerticalUp;
    case Direction.DownRight: return LaneId.DiagDownRight;
    case Direction.UpLeft: return LaneId.DiagUpLeft;
    case Direction.DownLeft: return LaneId.DiagDownLeft;
    case Direction.UpRight: return LaneId.DiagUpRight;
  }
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

export function unitVector(dir: Direction): PixelPos {
  switch (dir) {
    case Direction.Right: return { x: 1, y: 0 };
    case Direction.Down:  return { x: 0, y: 1 };
    case Direction.Left:  return { x: -1, y: 0 };
    case Direction.Up:    return { x: 0, y: -1 };
    case Direction.UpRight:   return { x: INV_SQRT2, y: -INV_SQRT2 };
    case Direction.DownRight:  return { x: INV_SQRT2, y: INV_SQRT2 };
    case Direction.DownLeft:   return { x: -INV_SQRT2, y: INV_SQRT2 };
    case Direction.UpLeft:     return { x: -INV_SQRT2, y: -INV_SQRT2 };
  }
}

export function isOpposite(d1: Direction, d2: Direction): boolean {
  return d2 === opposite(d1);
}

export function isPerpendicularAxis(d1: Direction, d2: Direction): boolean {
  const a1 = directionAngle(d1);
  const a2 = directionAngle(d2);
  let diff = Math.abs(a1 - a2);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  // 90 degrees = PI/2, allow small epsilon
  return Math.abs(diff - Math.PI / 2) < 0.01;
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

export function laneOffset(dir: Direction): PixelPos {
  // Perpendicular offset to the right of travel direction
  switch (dir) {
    case Direction.Right: return { x: 0, y: +LANE_OFFSET };  // bottom lane
    case Direction.Left:  return { x: 0, y: -LANE_OFFSET };  // top lane
    case Direction.Down:  return { x: -LANE_OFFSET, y: 0 };  // left lane
    case Direction.Up:    return { x: +LANE_OFFSET, y: 0 };  // right lane
    // Diagonals: perpendicular is 90deg clockwise from travel direction
    case Direction.UpRight:   return { x: LANE_OFFSET * INV_SQRT2, y: LANE_OFFSET * INV_SQRT2 };
    case Direction.DownRight:  return { x: -LANE_OFFSET * INV_SQRT2, y: LANE_OFFSET * INV_SQRT2 };
    case Direction.DownLeft:   return { x: -LANE_OFFSET * INV_SQRT2, y: -LANE_OFFSET * INV_SQRT2 };
    case Direction.UpLeft:     return { x: LANE_OFFSET * INV_SQRT2, y: -LANE_OFFSET * INV_SQRT2 };
  }
}

export function laneIntersection(cx: number, cy: number, dir1: Direction, dir2: Direction): PixelPos {
  // General 2D line-line intersection:
  // Line 1: center + laneOffset(dir1) + t * unitVector(dir1)
  // Line 2: center + laneOffset(dir2) + s * unitVector(dir2)
  const off1 = laneOffset(dir1);
  const off2 = laneOffset(dir2);
  const u1 = unitVector(dir1);
  const u2 = unitVector(dir2);

  // Solve: off1 + t * u1 = off2 + s * u2
  // => t * u1.x - s * u2.x = off2.x - off1.x
  // => t * u1.y - s * u2.y = off2.y - off1.y
  const det = u1.x * (-u2.y) - u1.y * (-u2.x);

  if (Math.abs(det) < 1e-9) {
    // Parallel or same direction — just use offset of dir1
    return { x: cx + off1.x, y: cy + off1.y };
  }

  const dx = off2.x - off1.x;
  const dy = off2.y - off1.y;
  const t = (dx * (-u2.y) - dy * (-u2.x)) / det;

  return {
    x: cx + off1.x + t * u1.x,
    y: cy + off1.y + t * u1.y,
  };
}
