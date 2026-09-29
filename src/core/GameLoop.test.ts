import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameLoop } from './GameLoop';

/**
 * Drives the loop with hand-made rAF timestamps: `frame(ms)` delivers one animation frame
 * at that time. Nothing here needs a DOM beyond `requestAnimationFrame` itself.
 */
function harness() {
  let pending: ((t: number) => void) | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { pending = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { pending = null; });

  let updates = 0;
  let renders = 0;
  const loop = new GameLoop(() => { updates++; }, () => { renders++; });
  return {
    loop,
    frame(ms: number) {
      const cb = pending;
      pending = null;
      cb?.(ms);
    },
    get updates() { return updates; },
    get renders() { return renders; },
  };
}

/** Deliver `seconds` worth of frames at `hz`, starting at `startMs`, with optional jitter. */
function run(h: ReturnType<typeof harness>, hz: number, seconds: number, jitterMs = 0, startMs = 0) {
  const period = 1000 / hz;
  const frames = Math.round(hz * seconds);
  for (let i = 1; i <= frames; i++) {
    const jitter = jitterMs * Math.sin(i * 1.7);
    h.frame(startMs + i * period + jitter);
  }
}

describe('GameLoop render cap', () => {
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws every frame of a 60 Hz display, even with timestamp jitter', () => {
    const h = harness();
    h.loop.start();
    run(h, 60, 2, 1.5);
    expect(h.renders).toBe(120);
  });

  it('draws only every other frame of a 120 Hz display', () => {
    const h = harness();
    h.loop.start();
    run(h, 120, 2, 0.5);
    expect(h.renders).toBe(120);
  });

  it('keeps the simulation at 60 ticks a second regardless of how often it draws', () => {
    const h = harness();
    h.loop.start();
    run(h, 120, 2);
    expect(h.updates).toBeGreaterThanOrEqual(119);
    expect(h.updates).toBeLessThanOrEqual(120);
  });

  it('draws every frame of a 90 Hz display', () => {
    const h = harness();
    h.loop.start();
    run(h, 90, 2);
    expect(h.renders).toBe(180);
  });
});
