import { TILE_SIZE } from '../../constants';
import type { SignedField } from '../../terrain';
import { SUBCELL, STEP_TILES, sampleFieldBilinear, worldToSample } from '../../terrain';
import { mulberry32 } from '../../utils/rng';
import { valueNoise } from './scenery';

/**
 * Where the small things on mountains and in lakes go — pines, boulders, reeds, lily pads —
 * as plain data, so it runs under Node.
 *
 * Everything is placed by *depth*: the signed distance field the terraces were traced from.
 * Depth says which terrace a point stands on and how far it is from that terrace's edges,
 * which is all a placement rule needs, and it keeps every item strictly inside the landform's
 * footprint — ground the player can never build on, so decoration here never has to be
 * cleared the way `SceneryLayer`'s does.
 *
 * Seeded by a constant rather than per game. The designer rebuilds terrain on every brush
 * stroke, and a fresh seed each time would reshuffle every reed on the map while painting.
 */

const DECOR_SEED = 0x51ed27;

export const MountainDecorKind = { Pine: 0, Boulder: 1 } as const;
export type MountainDecorKind = (typeof MountainDecorKind)[keyof typeof MountainDecorKind];

export const LakeDecorKind = { Reed: 0, LilyPad: 1, Rock: 2 } as const;
export type LakeDecorKind = (typeof LakeDecorKind)[keyof typeof LakeDecorKind];

export interface DecorItem<K> {
  kind: K;
  x: number;
  z: number;
  /** Terrace index the item stands on (lakes: always 0 — lake decor sits at the surface). */
  level: number;
  scale: number;
  rotation: number;
  /** In [-1, 1], for colour variation. */
  tint: number;
}

interface Sample { x: number; z: number; depth: number }

/**
 * Jittered-grid samples over the field's extent, keeping only points inside the landform.
 *
 * `spacing` is in world pixels. Jitter is a full cell, so no row or column survives into the
 * result — which is what keeps a scatter from reading as a planted grid.
 */
export function sampleInterior(field: SignedField, spacing: number, rand: () => number): Sample[] {
  const x0 = field.originGx * TILE_SIZE;
  const z0 = field.originGy * TILE_SIZE;
  const x1 = x0 + (field.width / SUBCELL) * TILE_SIZE;
  const z1 = z0 + (field.height / SUBCELL) * TILE_SIZE;
  const out: Sample[] = [];
  for (let z = z0; z < z1; z += spacing) {
    for (let x = x0; x < x1; x += spacing) {
      const px = x + rand() * spacing;
      const pz = z + rand() * spacing;
      const { sx, sy } = worldToSample(field, px, pz);
      const depth = sampleFieldBilinear(field, sx, sy);
      if (depth > 0) out.push({ x: px, z: pz, depth });
    }
  }
  return out;
}

/** Terrace a depth falls on, and its clearance to that terrace's lower and upper edges. */
export function terraceAt(depth: number, levelCount: number): { level: number; below: number; above: number } {
  const level = Math.min(levelCount - 1, Math.floor(depth / STEP_TILES));
  const below = depth - level * STEP_TILES;
  const above = level === levelCount - 1 ? Infinity : (level + 1) * STEP_TILES - depth;
  return { level, below, above };
}

/**
 * Pines on the lower terraces and boulders higher up.
 *
 * Terraces are only `STEP_TILES` (0.3 tiles) wide, so a tree must keep clear of both edges or
 * it hangs off the step below or into the riser above. The top terrace is left bare on any
 * mountain tall enough to carry snow — see `ObstacleLayer`.
 */
export function planMountainDecor(field: SignedField, levelCount: number): DecorItem<MountainDecorKind>[] {
  const rand = mulberry32(DECOR_SEED);
  const noise = valueNoise(DECOR_SEED);
  const items: DecorItem<MountainDecorKind>[] = [];
  const snowy = levelCount >= SNOW_MIN_LEVELS;

  for (const s of sampleInterior(field, 9, rand)) {
    const { level, below, above } = terraceAt(s.depth, levelCount);
    const clump = noise(s.x / 50, s.z / 50);
    const roll = rand();
    if (snowy && level === levelCount - 1) continue;

    if (level <= 1 && below > 0.07 && above > 0.07) {
      const chance = (level === 0 ? 0.55 : 0.3) * (0.4 + clump);
      if (roll < chance) items.push(item(MountainDecorKind.Pine, s, level, 0.45 + rand() * 0.2, rand));
    } else if (level >= 1 && below > 0.05 && above > 0.05 && roll < 0.08) {
      items.push(item(MountainDecorKind.Boulder, s, level, 0.6 + rand() * 0.5, rand));
    }
  }
  return items;
}

/**
 * Reeds in clumps along the shore, lily pads in the shallows, the odd rock at the waterline.
 *
 * Clumping comes from value noise, not from the sampling: evenly spaced reeds around a whole
 * shoreline read as a fence.
 */
export function planLakeDecor(field: SignedField): DecorItem<LakeDecorKind>[] {
  const rand = mulberry32(DECOR_SEED ^ 0x1234);
  const noise = valueNoise(DECOR_SEED ^ 0x5678);
  const items: DecorItem<LakeDecorKind>[] = [];

  for (const s of sampleInterior(field, 5, rand)) {
    const clump = noise(s.x / 45, s.z / 45);
    const roll = rand();
    if (s.depth < 0.12) {
      if (clump > 0.5 && roll < 0.55) items.push(item(LakeDecorKind.Reed, s, 0, 0.7 + rand() * 0.6, rand));
      else if (roll > 0.985) items.push(item(LakeDecorKind.Rock, s, 0, 0.6 + rand() * 0.6, rand));
    } else if (s.depth > 0.18 && s.depth < 0.7 && clump > 0.6 && roll < 0.12) {
      items.push(item(LakeDecorKind.LilyPad, s, 0, 0.7 + rand() * 0.5, rand));
    }
  }
  return items;
}

/** A mountain with at least this many terraces gets a snow cap. */
export const SNOW_MIN_LEVELS = 4;

function item<K>(kind: K, s: Sample, level: number, scale: number, rand: () => number): DecorItem<K> {
  return { kind, x: s.x, z: s.z, level, scale, rotation: rand() * Math.PI * 2, tint: rand() * 2 - 1 };
}
