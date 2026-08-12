export interface GridPos {
  gx: number;
  gy: number;
}

export interface PixelPos {
  x: number;
  y: number;
}

export const GameColor = {
  Red: 0,
  Blue: 1,
  Yellow: 2,
  Green: 3,
  Purple: 4,
  Orange: 5,
} as const;
export type GameColor = (typeof GameColor)[keyof typeof GameColor];

export const CellType = {
  Empty: 0,
  Road: 1,
  House: 2,
  Business: 3,
  Connector: 5,
  Mountain: 6,
  Lake: 7,
  GasStation: 8,
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

export const Direction = {
  Up:        1,    // 0b00000001
  Down:      2,    // 0b00000010
  Left:      4,    // 0b00000100
  Right:     8,    // 0b00001000
  UpLeft:    16,   // 0b00010000
  UpRight:   32,   // 0b00100000
  DownLeft:  64,   // 0b01000000
  DownRight: 128,  // 0b10000000
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const BusinessRotation = {
  R0: 0,
  R90: 90,
  R180: 180,
  R270: 270,
} as const;
export type BusinessRotation = (typeof BusinessRotation)[keyof typeof BusinessRotation];

export const GameState = {
  WaitingToStart: 3,
  Playing: 0,
  Paused: 1,
  GameOver: 2,
} as const;
export type GameState = (typeof GameState)[keyof typeof GameState];

export const Tool = {
  Road: 0,
  Eraser: 1,
  Highway: 2,
  GasStation: 3,
} as const;
export type Tool = (typeof Tool)[keyof typeof Tool];

export interface Cell {
  type: CellType;
  entityId: string | null;
  roadConnections: number;  // bitmask of Direction flags
  color: GameColor | null;
  connectorDir: Direction | null;
  pendingDeletion: boolean;
  /**
   * Cached `connectionCount(roadConnections) >= 3`, over all eight directions.
   *
   * Written only by `Grid.recomputeIntersectionFlags`, which owns the definition and the
   * reason it counts diagonals. `_isTIntersection` sat beside this — `=== 3` exactly — until
   * its sole reader was deleted with the old intersection code; nothing distinguishes a
   * three-way from a four-way any more, so the field went with it.
   */
  _isIntersection: boolean;
}
