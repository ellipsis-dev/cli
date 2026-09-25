import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // dist/cli.js is the `bin` entry, so it needs a shebang.
  banner: { js: '#!/usr/bin/env node' },
})
