import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server/index.ts'],
  outDir: 'dist/server',
  format: ['esm'],
  target: 'node22',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  external: [
    'electron',
    '@electron/remote',
  ],
});
