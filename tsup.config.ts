import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/adapters/index.ts', 'src/stores/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
