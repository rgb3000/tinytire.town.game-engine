import { mulberry32 } from '../../utils/rng';

/**
 * Decorative scenery — trees, bushes and pebbles — as plain data.
 *
 * This is the placement half of `SceneryLayer`, split out so it runs under Node: which cells
 * get something, where inside the cell it sits, and how it varies. Nothing here decides
 * *visibility*; a plan keeps every item, and the layer hides whichever ones stand on a cell
 * the game has since used. That is what makes building read as clearing land, and it means
 * the plan never has to change while a game is running.
 *
 * Trees grow only in the map's painted forest (`MapConfig.forests`). Outside it the ground
 * gets nothing but the odd bush and pebble, so a map with no forest has no trees at all.
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

/**
 * Spatial frequency, per cell, of the noise that sways a forest between broadleaf and
 * conifer. Lower means larger stands of one or the other.
 */
const STAND_SCALE = 0.17;

/** Chance of a lone bush on a cell outside the forest. */
const LONE_CHANCE = 0.035;

/** Chance of a pebble on any cell, forest or not. */
const PEBBLE_CHANCE = 0.02;

/**
 * Plan every scenery item for a `cols` x `rows` grid whose forest is `isForest`.
 *
 * Deterministic in `seed` and the forest: the same pair yields the same list, item for item.
 * Every cell draws from its own generator, seeded from its coordinates, so what grows on a
 * cell depends only on that cell and its eight neighbours. That is what lets the designer
 * repaint the forest a cell at a time without the rest of the map reshuffling under it.
 *
 * Density follows depth: a forest cell's depth is the share of its neighbours that are forest
 * too, so edges thin out into bushes and the middle packs with trees. Beyond the grid counts
 * as forest, so woods painted up to the map's edge read as running on past it rather than
 * stopping there. Every forest cell grows at least one item, so a freshly painted cell
 * always shows.
 */
export function planScenery(
  cols: number,
  rows: number,
  tileSize: number,
  seed: number,
  isForest: (gx: number, gy: number) => boolean,
): SceneryItem[] {
  const stand = valueNoise(seed);
  const items: SceneryItem[] = [];
  const forestAt = (gx: number, gy: number): boolean =>
    gx < 0 || gy < 0 || gx >= cols || gy >= rows || isForest(gx, gy);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const rand = mulberry32(latticeHash(gx, gy, seed ^ 0x9e3779b9));

      const place = (kind: SceneryKind, slot: number, slots: number): void => {
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

      if (isForest(gx, gy)) {
        let neighbours = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((dx !== 0 || dy !== 0) && forestAt(gx + dx, gy + dy)) neighbours++;
          }
        }
        // 0 on a lone painted cell, 1 deep inside the forest.
        const depth = neighbours / 8;
        const slots = 1 + (rand() < 0.3 + 0.6 * depth ? 1 : 0) + (rand() < 0.4 * depth ? 1 : 0);
        const bushShare = 0.08 + 0.45 * (1 - depth);
        const pineShare = clamp(stand(gx * STAND_SCALE, gy * STAND_SCALE) * 1.2 - 0.1, 0.1, 0.85);
        for (let s = 0; s < slots; s++) {
          const kind = rand() < bushShare ? SceneryKind.Bush
            : rand() < pineShare ? SceneryKind.Pine : SceneryKind.RoundTree;
          place(kind, s, slots);
        }
      } else if (rand() < LONE_CHANCE) {
        place(SceneryKind.Bush, 0, 1);
      }

      if (rand() < PEBBLE_CHANCE) place(SceneryKind.Pebble, 0, 1);
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
export function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (ix: number, iy: number): number => latticeHash(ix, iy, seed) / 4294967296;
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

/** A well-mixed unsigned 32-bit hash of an integer lattice point and a seed. */
function latticeHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
