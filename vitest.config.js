import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
