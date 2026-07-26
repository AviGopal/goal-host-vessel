#!/usr/bin/env bun
import { readFileSync } from 'fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: bun run line-count <file-path>');
  process.exit(1);
}

try {
  const content = readFileSync(filePath, 'utf8');
  const lineCount = content.split('\n').length;
  console.log(lineCount);
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}
