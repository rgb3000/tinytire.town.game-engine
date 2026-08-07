import type { InputHandler } from '../input/InputHandler';

/**
 * The slice of the renderer that camera gestures drive.
 *
 * A structural interface rather than a `Renderer` import, for the same reason
 * `SpawnDemandSource` exists in `src/systems/SpawnSystem.ts`: it keeps the dependency
 * narrow and states from the signature exactly what this class can affect. `Renderer`
 * satisfies it without declaring anything.
 */
export interface CameraView {
  onWheel(e: WheelEvent): void;
  panByScreen(screenDx: number, screenDy: number): void;
  tiltBy(delta: number): void;
  resetTilt(): void;
  getIsometric(): boolean;
}

/** Radians of tilt per pixel of vertical drag while space is held. */
const TILT_PER_PIXEL = 0.003;

/**
 * Space-to-pan, drag-to-tilt and wheel zoom for a canvas.
 *
 * Pulled out of `Game`, which had these five fields and four anonymous canvas listeners
 * inlined in its constructor. Two things came out in the wash:
 *
 * - `Game` never removed those listeners — it registered them as inline arrows and its
 *   `dispose()` only unbound the three `window` listeners. `dispose()` here is complete.
 * - The cursor was derived at four separate sites that disagreed with each other, so
 *   releasing space with the Highway or Gas tool selected reset the cursor to `default`
 *   instead of the tool's crosshair. There is now one place that decides: {@link syncCursor}.
 *
 * The renderer arrives as a getter, not an instance: `Game.buildWorld()` constructs a fresh
 * `Renderer` on every restart, so holding a reference here would pan a dead one.
 */
export class CameraController {
  private canvas: HTMLCanvasElement;
  private input: InputHandler;
  private getView: () => CameraView;
  private cursorForTool: () => string;

  private spaceDown = false;
  private isPanning = false;
  private lastPanX = 0;
  private lastPanY = 0;
  /** -1 until the first mousemove of a space-hold establishes a reference Y. */
  private lastTiltY = -1;

  private wheelHandler: (e: WheelEvent) => void;
  private mousedownHandler: (e: MouseEvent) => void;
  private mousemoveHandler: (e: MouseEvent) => void;
  private mouseupHandler: (e: MouseEvent) => void;

  constructor(
    canvas: HTMLCanvasElement,
    input: InputHandler,
    getView: () => CameraView,
    cursorForTool: () => string,
  ) {
    this.canvas = canvas;
    this.input = input;
    this.getView = getView;
    this.cursorForTool = cursorForTool;

    // Wheel: pan (normal scroll) or zoom (ctrl/pinch)
    this.wheelHandler = (e) => this.getView().onWheel(e);
    canvas.addEventListener('wheel', this.wheelHandler, { passive: false });

    this.mousedownHandler = (e) => {
      if (this.spaceDown && e.button === 0) {
        this.isPanning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.syncCursor();
      }
    };
    canvas.addEventListener('mousedown', this.mousedownHandler);

    this.mousemoveHandler = (e) => {
      if (this.isPanning) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        this.getView().panByScreen(dx, dy);
        return;
      }
      if (!this.spaceDown) return;
      // Isometric mode owns its own camera angle, so manual tilt is skipped there.
      if (this.getView().getIsometric()) return;
      if (this.lastTiltY < 0) {
        this.lastTiltY = e.clientY;
        return;
      }
      const dy = e.clientY - this.lastTiltY;
      this.lastTiltY = e.clientY;
      this.getView().tiltBy(-dy * TILT_PER_PIXEL);
    };
    canvas.addEventListener('mousemove', this.mousemoveHandler);

    this.mouseupHandler = (e) => {
      if (e.button === 0 && this.isPanning) {
        this.isPanning = false;
        this.syncCursor();
      }
    };
    canvas.addEventListener('mouseup', this.mouseupHandler);
  }

  /** Space pressed: arm panning and stop the drawing tools from seeing the drag. */
  beginPan(): void {
    this.spaceDown = true;
    this.lastTiltY = -1;
    this.input.panningActive = true;
    this.syncCursor();
  }

  /** Space released: disarm panning and level the camera again. */
  endPan(): void {
    this.spaceDown = false;
    this.isPanning = false;
    this.input.panningActive = false;
    this.syncCursor();
    this.getView().resetTilt();
  }

  /**
   * Re-derive the cursor. The only writer of `canvas.style.cursor` — call it whenever
   * something the cursor depends on changes, which outside this class means the active tool.
   */
  syncCursor(): void {
    this.canvas.style.cursor = this.isPanning
      ? 'grabbing'
      : this.spaceDown
        ? 'grab'
        : this.cursorForTool();
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.wheelHandler);
    this.canvas.removeEventListener('mousedown', this.mousedownHandler);
    this.canvas.removeEventListener('mousemove', this.mousemoveHandler);
    this.canvas.removeEventListener('mouseup', this.mouseupHandler);
  }
}
