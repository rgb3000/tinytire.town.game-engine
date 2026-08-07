import { FIXED_DT, MAX_FRAME_TIME } from '../constants';

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
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

    const alpha = this.accumulator / FIXED_DT;
    this.onRender(alpha);

    this.rafId = requestAnimationFrame((t) => this.tick(t));
  }
}
