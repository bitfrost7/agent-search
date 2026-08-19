#!/usr/bin/env node
/**
 * agent-search MCP server — thin entry point (compat name kept).
 *
 * All logic lives in dist/mcp.js (compiled from src/mcp.ts).
 *
 * Register:
 *   hermes mcp add agent-search --command node \
 *     --args /path/to/agent-search/bin/mcp-server.js
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Try compiled dist first
const distPath = resolve(projectRoot, "dist", "mcp.js");
if (existsSync(distPath)) {
  await import(distPath);
} else {
  // Dev: use tsx to load TypeScript directly
  await import(resolve(projectRoot, "src", "mcp.ts"));
}
