import { mulberry32 } from '../../utils/rng';

/**
 * Decorative scenery — trees, bushes and pebbles — as plain data.
 *
 * This is the placement half of `SceneryLayer`, split out so it runs under Node: which cells
 * get something, where inside the cell it sits, and how it varies. Nothing here decides
 * *visibility*; a plan is made once per renderer and every item is kept, and the layer hides
 * whichever ones stand on a cell the game has since used. That is what makes building read
 * as clearing land, and it means the plan never has to change while a game is running.
 */

export const SceneryKind = {
  RoundTree: 0,
  Pine: 1,
  Bush: 2,
  Pebble: 3,
} as const;
export type SceneryKind = (typeof SceneryKind)[keyof typeof SceneryKind];

export interface SceneryItem {
  gx: number;
  gy: number;
  kind: SceneryKind;
  /** Position in world pixels. Always strictly inside cell (`gx`, `gy`), with a margin. */
  x: number;
  z: number;
  /** Uniform scale around 1. */
  scale: number;
  /** Rotation about the vertical axis, radians. */
  rotation: number;
  /** In [-1, 1]: how far this item's colour is pushed darker (negative) or lighter. */
  tint: number;
}

/**
 * Fraction of a cell, from each edge, that no item's centre may enter.
 *
 * Canopies are wider than a point, so this bounds how far a tree on an empty cell can lean
 * into its neighbours. At 0.18 of a 40px tile a centre stays 7.2px inside the edge, so the
 * largest canopy (radius ~9px) overhangs by at most ~2px — well short of a neighbouring
 * road, whose surface begins 12px into its own cell. Any tighter and groves line up in rows.
 */
export const CELL_MARGIN = 0.18;

/** Spatial frequency of the grove noise, per cell. Lower means larger groves. */
const GROVE_SCALE = 0.17;

/** Noise level above which a cell is inside a grove. */
const GROVE_THRESHOLD = 0.64;

/** Chance of a lone tree or bush on a cell that is not in a grove. */
const LONE_CHANCE = 0.035;

/** Chance of a pebble on any cell, grove or not. */
const PEBBLE_CHANCE = 0.02;

/**
 * Plan every scenery item for a `cols` x `rows` grid.
 *
 * Deterministic in `seed`: the same seed yields the same list, item for item. Groves come
 * from smooth value noise, so trees cluster the way woodland does rather than sprinkling
 * evenly, and the density ramps up towards a grove's middle.
 */
export function planScenery(cols: number, rows: number, tileSize: number, seed: number): SceneryItem[] {
  const noise = valueNoise(seed);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const items: SceneryItem[] = [];

  const place = (gx: number, gy: number, kind: SceneryKind, slot: number, slots: number): void => {
    // Split the free square into `slots` columns so two items in a cell do not coincide.
    const free = 1 - 2 * CELL_MARGIN;
    const colW = free / slots;
    const fx = CELL_MARGIN + colW * (slot + rand());
    const fz = CELL_MARGIN + free * rand();
    items.push({
      gx,
      gy,
      kind,
      x: (gx + fx) * tileSize,
      z: (gy + fz) * tileSize,
      scale: 0.8 + rand() * 0.4,
      rotation: rand() * Math.PI * 2,
      tint: rand() * 2 - 1,
    });
  };

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const n = noise(gx * GROVE_SCALE, gy * GROVE_SCALE);
      const roll = rand();

      if (n > GROVE_THRESHOLD) {
        // 0 at the grove's edge, 1 deep inside it.
        const depth = Math.min(1, (n - GROVE_THRESHOLD) / (1 - GROVE_THRESHOLD) * 3);
        if (roll < 0.4 + 0.45 * depth) {
          const slots = 1 + (rand() < 0.4 + 0.5 * depth ? 1 : 0) + (rand() < 0.35 * depth ? 1 : 0);
          for (let s = 0; s < slots; s++) {
            const r = rand();
            const kind = r < 0.5 ? SceneryKind.RoundTree : r < 0.85 ? SceneryKind.Pine : SceneryKind.Bush;
            place(gx, gy, kind, s, slots);
          }
        }
      } else if (roll < LONE_CHANCE) {
        place(gx, gy, rand() < 0.5 ? SceneryKind.Bush : SceneryKind.RoundTree, 0, 1);
      }

      if (rand() < PEBBLE_CHANCE) place(gx, gy, SceneryKind.Pebble, 0, 1);
    }
  }

  return items;
}

/**
 * The items still standing, given which cells are free.
 *
 * `isFree` is asked once per distinct cell, not once per item.
 */
export function visibleScenery(
  items: readonly SceneryItem[],
  isFree: (gx: number, gy: number) => boolean,
): SceneryItem[] {
  const out: SceneryItem[] = [];
  let lastKey = -1;
  let lastFree = false;
  for (const item of items) {
    // Items are planned in row-major order, so consecutive items share a cell.
    const key = item.gy * 65536 + item.gx;
    if (key !== lastKey) {
      lastKey = key;
      lastFree = isFree(item.gx, item.gy);
    }
    if (lastFree) out.push(item);
  }
  return out;
}

/** Smooth 2D value noise in [0, 1], on an integer lattice hashed from `seed`. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (ix: number, iy: number): number => {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const tx = smooth(x - ix);
    const ty = smooth(y - iy);
    const a = lattice(ix, iy);
    const b = lattice(ix + 1, iy);
    const c = lattice(ix, iy + 1);
    const d = lattice(ix + 1, iy + 1);
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
  };
}
