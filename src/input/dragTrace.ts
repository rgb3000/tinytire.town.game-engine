import type { GridPos } from '../types';

/** Arc length (as a fraction of tile size) a cardinal grid-line crossing is
 *  held back, waiting for the other axis to cross so the pair can become one
 *  diagonal step. Must exceed 1/√2 ≈ 0.707 so a 45° drag pairs its crossings
 *  at every lattice offset, not only when it happens to hug corners. */
export const DRAG_DIAGONAL_HOLD_RATIO = 0.75;

/** A crossing pair only becomes a diagonal step if the drag was actually
 *  heading diagonally: min/max of the heading's |dx|,|dy| must exceed
 *  tan(22.5°), i.e. the direction is within 22.5° of a 45° diagonal. */
const DIAGONAL_RATIO_MIN = Math.tan(Math.PI / 8);

/** Arc length (fraction of tile size) over which the drag heading is
 *  smoothed. Keeps per-frame wobble in a slow drag from flipping the
 *  cardinal/diagonal decision back and forth. */
const HEADING_SMOOTHING_RATIO = 0.35;

const EPS = 1e-9;

interface PendingStep {
  gx: number;
  gy: number;
  /** Cumulative arc length at which the crossing happened. */
  arc: number;
  /** Hold window granted when the crossing happened: the full pairing window
   *  if the drag was heading diagonally then, zero otherwise. Fixed at
   *  creation so a wobble that flips the heading can't cut a window short. */
  hold: number;
}

/**
 * Incremental tracer that converts a stream of cursor positions (world px)
 * into the 8-connected cell steps a road drag should take.
 *
 * Cell accuracy comes from walking the exact grid-line crossings of each
 * cursor segment (Amanatides–Woo). Diagonals come from pairing: while the
 * drag is heading diagonally (smoothed over recent arc length), a crossing
 * is held for up to `holdDistance`; when the other axis crosses inside that
 * window the pair collapses into one diagonal step, and a crossing that is
 * re-crossed inside it cancels silently. While the drag is heading straight
 * there is nothing to pair, so crossings commit immediately and cardinal
 * lines stay responsive.
 *
 * Consecutive emitted steps always differ by a king move. The committed cell
 * can trail the cursor by up to one held crossing; `flush()` commits it, so
 * callers flush when the drag ends. No bounds clamping — callers filter.
 */
export class DragTracer {
  private px: number;
  private py: number;
  /** Cell the cursor is in (leads `committed` while a step is pending). */
  private cursorX: number;
  private cursorY: number;
  private committedX: number;
  private committedY: number;
  private arc = 0;
  private pending: PendingStep | null = null;
  private headingX = 0;
  private headingY = 0;
  private readonly tileSize: number;
  private readonly holdDistance: number;

  constructor(x: number, y: number, tileSize: number, holdDistance: number = tileSize * DRAG_DIAGONAL_HOLD_RATIO) {
    this.px = x;
    this.py = y;
    this.tileSize = tileSize;
    this.holdDistance = holdDistance;
    this.cursorX = Math.floor(x / tileSize);
    this.cursorY = Math.floor(y / tileSize);
    this.committedX = this.cursorX;
    this.committedY = this.cursorY;
  }

  /** Feed the next cursor position; returns the steps committed by it. */
  advance(x: number, y: number): GridPos[] {
    const steps: GridPos[] = [];
    const dx = x - this.px;
    const dy = y - this.py;
    const len = Math.hypot(dx, dy);
    if (len === 0) return steps;

    const tile = this.tileSize;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    // A position exactly on a grid line belongs to the higher cell (floor),
    // so a negative-direction crossing at the segment's very end is excluded
    // while a positive-direction one counts.
    const tLimitX = stepX > 0 ? 1 + EPS : 1 - EPS;
    const tLimitY = stepY > 0 ? 1 + EPS : 1 - EPS;

    let tMaxX = Infinity;
    let tDeltaX = Infinity;
    if (dx !== 0) {
      const firstX = (stepX > 0 ? this.cursorX + 1 : this.cursorX) * tile;
      tMaxX = (firstX - this.px) / dx;
      tDeltaX = tile / Math.abs(dx);
    }
    let tMaxY = Infinity;
    let tDeltaY = Infinity;
    if (dy !== 0) {
      const firstY = (stepY > 0 ? this.cursorY + 1 : this.cursorY) * tile;
      tMaxY = (firstY - this.py) / dy;
      tDeltaY = tile / Math.abs(dy);
    }

    // Smooth the heading over ~a third of a tile of recent movement
    const weight = Math.min(1, len / (this.tileSize * HEADING_SMOOTHING_RATIO));
    this.headingX += (dx / len - this.headingX) * weight;
    this.headingY += (dy / len - this.headingY) * weight;
    const small = Math.min(Math.abs(this.headingX), Math.abs(this.headingY));
    const large = Math.max(Math.abs(this.headingX), Math.abs(this.headingY));
    const headingDiagonal = large > 0 && small / large > DIAGONAL_RATIO_MIN;

    // Cap: a segment of length len crosses at most len/tile + 2 lines per axis
    const cap = Math.ceil((len / tile + 2) * 2);
    for (let i = 0; i < cap; i++) {
      const crossX = tMaxX <= tLimitX;
      const crossY = tMaxY <= tLimitY;
      if (!crossX && !crossY) break;

      let eventArc: number;
      if (crossX && (!crossY || tMaxX <= tMaxY)) {
        eventArc = this.arc + tMaxX * len;
        tMaxX += tDeltaX;
        this.cursorX += stepX;
      } else {
        eventArc = this.arc + tMaxY * len;
        tMaxY += tDeltaY;
        this.cursorY += stepY;
      }
      this.resolve(eventArc, headingDiagonal, steps);
    }

    this.arc += len;
    this.px = x;
    this.py = y;

    // A held crossing commits as a cardinal step once its window has passed
    if (this.pending && this.arc - this.pending.arc > this.pending.hold) {
      this.commitPending(steps);
    }
    return steps;
  }

  /** Feed the final cursor position and commit any held crossing. */
  flush(x: number, y: number): GridPos[] {
    const steps = this.advance(x, y);
    if (this.pending) this.commitPending(steps);
    return steps;
  }

  /** Commit a held crossing without advancing the cursor. */
  flushPending(): GridPos[] {
    const steps: GridPos[] = [];
    if (this.pending) this.commitPending(steps);
    return steps;
  }

  /** Reconcile committed/pending state after the cursor changed cells. */
  private resolve(eventArc: number, headingDiagonal: boolean, steps: GridPos[]): void {
    if (this.pending && eventArc - this.pending.arc > this.pending.hold) {
      this.commitPending(steps);
    }

    const hold = headingDiagonal ? this.holdDistance : 0;
    const dgx = this.cursorX - this.committedX;
    const dgy = this.cursorY - this.committedY;

    if (this.pending === null) {
      // First crossing away from the committed cell: hold it
      this.pending = { gx: this.cursorX, gy: this.cursorY, arc: eventArc, hold };
      return;
    }
    if (dgx === 0 && dgy === 0) {
      // Crossed back inside the window: jitter, no step
      this.pending = null;
      return;
    }
    if (dgx !== 0 && dgy !== 0 && Math.abs(dgx) === 1 && Math.abs(dgy) === 1) {
      // The other axis crossed inside the window
      if (headingDiagonal) {
        this.committedX = this.cursorX;
        this.committedY = this.cursorY;
        this.pending = null;
        steps.push({ gx: this.committedX, gy: this.committedY });
      } else {
        // Deliberate corner: keep the L shape
        this.commitPending(steps);
        this.pending = { gx: this.cursorX, gy: this.cursorY, arc: eventArc, hold };
      }
      return;
    }
    // Same axis crossed again: commit the held step and hold the new one
    this.commitPending(steps);
    this.pending = { gx: this.cursorX, gy: this.cursorY, arc: eventArc, hold };
  }

  private commitPending(steps: GridPos[]): void {
    const pending = this.pending!;
    this.committedX = pending.gx;
    this.committedY = pending.gy;
    this.pending = null;
    steps.push({ gx: pending.gx, gy: pending.gy });
  }
}
