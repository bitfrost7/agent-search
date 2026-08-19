#!/usr/bin/env node
/**
 * agent-search — unified multi-channel search CLI.
 * Entry point for npm bin.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Try compiled dist first
const distPath = resolve(projectRoot, "dist", "cli.js");
if (existsSync(distPath)) {
  await import(distPath);
} else {
  // Dev: use tsx to load TypeScript directly
  await import(resolve(projectRoot, "src", "cli.ts"));
}
