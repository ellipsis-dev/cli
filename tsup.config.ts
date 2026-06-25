import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  // dist/cli.js is the `bin` entry, so it needs a shebang.
  banner: { js: '#!/usr/bin/env node' },
})
