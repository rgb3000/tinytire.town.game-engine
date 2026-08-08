import type { GridPos } from '../../types';
import type { LakeTriangles } from '../../maps/types';
import { GRID_COLS, GRID_ROWS, TILE_SIZE, LAKE_SHORE_COLOR } from '../../constants';
import { buildTerrainContours } from '../../terrain';

/**
 * Every loop of a lake's footprint, in world pixels: outer boundaries and island holes alike.
 *
 * This is the geometry half of the ground texture's alpha hole, split out from the painting so
 * it can be tested without a canvas. It reads level 0 of `buildTerrainContours` — the *same*
 * source `LakeLayer` extrudes the water mesh from — because any disagreement between the two
 * silhouettes shows up as a seam of background colour at every shoreline.
 *
 * `LakeLayer` additionally asks for a shoreline width. That only traces one extra contour
 * outside the footprint; it does not move level 0, so the two footprints stay identical and
 * this must not pass one.
 *
 * Holes are returned flattened in with the outers, unlabelled, because the caller fills them
 * under the even-odd rule — which decides inside-ness by crossing count, not by winding or by
 * which loop was declared a hole.
 *
 * Empty when nothing is traceable: no cells, or cells whose triangle flags activate no
 * quadrant at all, which the map format permits.
 */
export function lakeFootprintLoops(
  lakeCells: GridPos[],
  lakeTriangles?: LakeTriangles,
): number[][][] {
  const contours = buildTerrainContours(lakeCells, lakeTriangles);
  if (!contours) return [];

  const loops: number[][][] = [];
  for (const polygon of contours.levels[0].polygons) {
    loops.push(polygon.outer);
    for (const hole of polygon.holes) loops.push(hole);
  }
  return loops;
}

function addLoop(path: Path2D, loop: number[][]): void {
  if (loop.length < 3) return;
  path.moveTo(loop[0][0], loop[0][1]);
  for (let i = 1; i < loop.length; i++) path.lineTo(loop[i][0], loop[i][1]);
  path.closePath();
}

export class TerrainLayer {
  private backgroundColor = '#FFFFFF';
  private waterColor = LAKE_SHORE_COLOR;

  setBackgroundColor(color: string): void {
    this.backgroundColor = color;
  }

  setLakeColors(water: string): void {
    this.waterColor = water;
  }

  render(
    ctx: CanvasRenderingContext2D,
    lakeCells?: GridPos[],
    backgroundTiles?: Map<string, { top?: number; right?: number; bottom?: number; left?: number }>,
    paintPalette?: string[],
    lakeTriangles?: LakeTriangles,
  ): void {
    const w = GRID_COLS * TILE_SIZE;
    const h = GRID_ROWS * TILE_SIZE;

    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, w, h);

    // Paint background tiles (before lakes so lakes overlay on top)
    if (backgroundTiles && paintPalette && backgroundTiles.size > 0) {
      for (const [key, tile] of backgroundTiles) {
        const [gxStr, gyStr] = key.split(',');
        const px = Number(gxStr) * TILE_SIZE;
        const py = Number(gyStr) * TILE_SIZE;
        const cx = px + TILE_SIZE / 2;
        const cy = py + TILE_SIZE / 2;

        const quadrants: [string, number, number, number, number, number, number][] = [];
        if (tile.top !== undefined) {
          quadrants.push([paintPalette[tile.top], px, py, px + TILE_SIZE, py, cx, cy]);
        }
        if (tile.right !== undefined) {
          quadrants.push([paintPalette[tile.right], px + TILE_SIZE, py, px + TILE_SIZE, py + TILE_SIZE, cx, cy]);
        }
        if (tile.bottom !== undefined) {
          quadrants.push([paintPalette[tile.bottom], px + TILE_SIZE, py + TILE_SIZE, px, py + TILE_SIZE, cx, cy]);
        }
        if (tile.left !== undefined) {
          quadrants.push([paintPalette[tile.left], px, py + TILE_SIZE, px, py, cx, cy]);
        }

        for (const [color, x1, y1, x2, y2, x3, y3] of quadrants) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x3, y3);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    if (lakeCells && lakeCells.length > 0) {
      const loops = lakeFootprintLoops(lakeCells, lakeTriangles);
      if (loops.length > 0) {
        const path = new Path2D();
        for (const loop of loops) addLoop(path, loop);

        // Soft inner outline in the water colour, matching the mesh silhouette exactly.
        ctx.save();
        ctx.strokeStyle = this.waterColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(path);
        ctx.restore();

        // Punch transparent holes so the 3D water mesh shows through. The even-odd rule keeps
        // islands opaque — without it the ground under an island would be cut away too.
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.fill(path, 'evenodd');
        ctx.restore();
      }
    }
  }
}
