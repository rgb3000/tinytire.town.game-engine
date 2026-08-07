import { defineConfig } from 'vitest/config';

// Unit tests for the engine and the map format. Pure Node — no DOM, no WebGL.
//
// That constraint is why the suite is small: most of the engine only becomes
// observable through `Game`, which needs a canvas and a WebGL context. What is tested
// here is what can be tested honestly without one — the map format's round trip, the
// config-resolution rules, and the static guard that keeps configurable constants from
// being read directly.
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
