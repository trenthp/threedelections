import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any subpath (e.g. GitHub Pages).
  base: './',
  build: {
    // Three.js gets its own chunk: it's most of the JS and rarely changes, so
    // browsers can keep it cached across site updates.
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
    chunkSizeWarningLimit: 700,
  },
});
