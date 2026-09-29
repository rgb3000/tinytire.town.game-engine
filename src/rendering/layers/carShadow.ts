/**
 * The soft, car-shaped patch drawn under each moving car in place of a cast shadow.
 *
 * Cars are the only shadow casters that move every frame. Casting theirs for real meant
 * re-rendering and re-blurring the whole 4096² shadow map every frame — about 10 of the
 * 12 ms the GPU spent per frame — for shadows a dozen pixels long. With cars excluded, the
 * shadow map only changes when the world does, and `Renderer` redraws it only then.
 *
 * Pure: an alpha mask computed here, wrapped in a `DataTexture` by `CarLayer`, so the
 * shape is testable in Node and needs no canvas.
 */

/** Texture size. The patch is a few dozen screen pixels at most zoom levels. */
export const CAR_SHADOW_TEX_WIDTH = 64;
export const CAR_SHADOW_TEX_HEIGHT = 40;

/**
 * The patch's footprint relative to the car's, and the height its centre is projected
 * from. Tuned by eye against the cast shadow it replaces, at maximum zoom: that shadow
 * reaches past the car on the side away from the sun and is soft all round.
 */
export const CAR_SHADOW_LENGTH_SCALE = 1.45;
export const CAR_SHADOW_WIDTH_SCALE = 1.75;
export const CAR_SHADOW_HEIGHT = 2.2;

/** Opacity at the patch's core. */
const CORE_ALPHA = 0.55;
/** The solid core as a fraction of the texture, and its corner radius and edge softness in texels. */
const CORE_HALF_W = 0.3375;
const CORE_HALF_H = 0.27;
const CORNER_RADIUS = 5.6;
const FEATHER = 6;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Signed distance from `(px, py)` to a rounded rectangle centred on the origin. */
function roundedRectDistance(px: number, py: number, halfW: number, halfH: number, radius: number): number {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/**
 * RGBA texels, row-major, black with the shadow's opacity in alpha. The texture's long axis
 * is the car's length.
 */
export function carShadowTexels(
  width = CAR_SHADOW_TEX_WIDTH,
  height = CAR_SHADOW_TEX_HEIGHT,
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const halfW = CORE_HALF_W * width;
  const halfH = CORE_HALF_H * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = roundedRectDistance(x + 0.5 - width / 2, y + 0.5 - height / 2, halfW, halfH, CORNER_RADIUS);
      const alpha = CORE_ALPHA * (1 - smoothstep(-FEATHER, FEATHER, d));
      data[(y * width + x) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return data;
}
