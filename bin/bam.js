#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', 'dist', 'cli.js');

import(distPath).then((mod) => {
  mod.main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
});
