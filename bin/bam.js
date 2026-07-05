#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Structured under dist/cli/cli.js; also kept at dist/cli.js for backward compat
const distPath = join(__dirname, '..', 'dist', 'cli', 'cli.js');

import(distPath).then((mod) => {
  mod.main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
});
