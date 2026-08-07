import { defineConfig } from 'vite';

// Serves the demo playground in `demo/`, which imports the engine from `../src`.
export default defineConfig({
  root: 'demo',
  // `root` is a subdirectory, so the demo's imports of `../src/**` climb out of it.
  // Vite's default `fs.allow` is the detected workspace root, which normally covers
  // this; stating it removes the dependency on that detection.
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    // Out of `demo/`, so a build never lands next to the sources it was built from.
    outDir: '../dist-demo',
    emptyOutDir: true,
  },
});
