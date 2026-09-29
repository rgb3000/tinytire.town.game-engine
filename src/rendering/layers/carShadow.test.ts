import { describe, it, expect } from 'vitest';
import { carShadowTexels, CAR_SHADOW_TEX_WIDTH as W, CAR_SHADOW_TEX_HEIGHT as H } from './carShadow';
import { groundShadowOffset, SUN_OFFSET } from '../sun';

const alphaAt = (data: Uint8Array, x: number, y: number) => data[(y * W + x) * 4 + 3];

describe('carShadowTexels', () => {
  const data = carShadowTexels();

  it('is black everywhere, carrying the shadow in alpha alone', () => {
    expect(data.length).toBe(W * H * 4);
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(0);
      expect(data[i + 1]).toBe(0);
      expect(data[i + 2]).toBe(0);
    }
  });

  it('fades to nothing at every edge, so no texture border shows as a hard line', () => {
    for (let x = 0; x < W; x++) {
      expect(alphaAt(data, x, 0)).toBe(0);
      expect(alphaAt(data, x, H - 1)).toBe(0);
    }
    for (let y = 0; y < H; y++) {
      expect(alphaAt(data, 0, y)).toBe(0);
      expect(alphaAt(data, W - 1, y)).toBe(0);
    }
  });

  it('is darkest at the core and never darkens moving outward', () => {
    const cx = W / 2;
    const cy = H / 2;
    expect(alphaAt(data, cx, cy)).toBeGreaterThan(130);
    for (let x = cx; x < W - 1; x++) expect(alphaAt(data, x + 1, cy)).toBeLessThanOrEqual(alphaAt(data, x, cy));
    for (let y = cy; y < H - 1; y++) expect(alphaAt(data, cx, y + 1)).toBeLessThanOrEqual(alphaAt(data, cx, y));
  });

  it('is symmetric about both axes', () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        expect(alphaAt(data, x, y)).toBe(alphaAt(data, W - 1 - x, y));
        expect(alphaAt(data, x, y)).toBe(alphaAt(data, x, H - 1 - y));
      }
    }
  });

  it('is longer than it is wide, like the car it stands in for', () => {
    const cx = W / 2;
    const cy = H / 2;
    let along = 0;
    let across = 0;
    for (let x = 0; x < W; x++) if (alphaAt(data, x, cy) > 70) along++;
    for (let y = 0; y < H; y++) if (alphaAt(data, cx, y) > 70) across++;
    expect(along).toBeGreaterThan(across * 1.5);
  });
});

describe('groundShadowOffset', () => {
  it('points away from the sun, in proportion to height', () => {
    const o = groundShadowOffset(2);
    expect(Math.sign(o.x)).toBe(-Math.sign(SUN_OFFSET.x));
    expect(Math.sign(o.z)).toBe(-Math.sign(SUN_OFFSET.z));
    expect(groundShadowOffset(4).x).toBeCloseTo(o.x * 2);
    expect(groundShadowOffset(0).x).toBeCloseTo(0);
    expect(groundShadowOffset(0).z).toBeCloseTo(0);
  });

  it('lands where the light ray through the point meets the ground', () => {
    // A ray along -SUN_OFFSET from (0, h, 0) reaches y = 0 after h / SUN_OFFSET.y of it.
    const h = 3;
    const t = h / SUN_OFFSET.y;
    const o = groundShadowOffset(h);
    expect(o.x).toBeCloseTo(-SUN_OFFSET.x * t);
    expect(o.z).toBeCloseTo(-SUN_OFFSET.z * t);
  });
});
