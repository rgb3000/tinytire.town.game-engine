import { FIXED_DT, MAX_FRAME_TIME } from '../constants';

/**
 * The shortest gap between two drawn frames, in seconds.
 *
 * The simulation advances at `FIXED_DT` (60 Hz), so on a faster display the extra frames
 * only re-interpolate between the same two simulation states. On a 120 Hz MacBook that was
 * half of all GPU work, for motion no smoother than the ticks behind it.
 *
 * Deliberately well under `FIXED_DT` rather than equal to it: rAF timestamps jitter, and
 * a 60 Hz frame that arrives a fraction early must still be drawn, or a 60 Hz display
 * would drop frames. 10 ms skips alternate frames at 120 Hz (8.3 ms), draws every frame at
 * 90 Hz (11.1 ms) and below, and settles at 72 fps on a 144 Hz display.
 */
export const MIN_RENDER_INTERVAL = 0.010;

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private lastRenderTime = -Infinity;
  private running = false;
  private rafId = 0;
  private onUpdate: (dt: number) => void;
  private onRender: (alpha: number) => void;

  constructor(
    onUpdate: (dt: number) => void,
    onRender: (alpha: number) => void,
  ) {
    this.onUpdate = onUpdate;
    this.onRender = onRender;
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.lastRenderTime = -Infinity;
    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(timestamp: number): void {
    if (!this.running) return;

    const currentTime = timestamp / 1000;
    let frameTime = currentTime - this.lastTime;
    this.lastTime = currentTime;

    if (frameTime > MAX_FRAME_TIME) {
      frameTime = MAX_FRAME_TIME;
    }

    this.accumulator += frameTime;

    while (this.accumulator >= FIXED_DT) {
      this.onUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }

    if (currentTime - this.lastRenderTime >= MIN_RENDER_INTERVAL) {
      this.lastRenderTime = currentTime;
      const alpha = this.accumulator / FIXED_DT;
      this.onRender(alpha);
    }

    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }
}
