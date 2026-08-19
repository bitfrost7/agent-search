#!/usr/bin/env node
/**
 * Scaffold a new channel.
 *
 * Usage:
 *   npm run new-channel -- --name hackernews --category public
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

// ── Parse args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let name = "";
let category = "public";
let outputRoot = projectRoot;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name" && i + 1 < args.length) {
    name = args[++i];
  } else if (args[i] === "--category" && i + 1 < args.length) {
    category = args[++i];
  } else if (args[i] === "--root" && i + 1 < args.length) {
    outputRoot = resolve(args[++i]);
  }
}

if (!name) {
  console.error(
    "Usage: npm run new-channel -- --name <channel-name> [--category public]",
  );
  process.exit(1);
}

// Normalize: kebab-case
name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
  console.error(
    "Channel name must contain letters, numbers, or single hyphens",
  );
  process.exit(1);
}
if (!new Set(["public", "internal"]).has(category)) {
  console.error("--category must be public or internal");
  process.exit(1);
}
const className = name
  .split("-")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join("");
const channelPath = join(outputRoot, "src", "channels", category, `${name}.ts`);

if (existsSync(channelPath)) {
  console.error(`Channel already exists: ${channelPath}`);
  process.exit(1);
}

// ── Create channel file ────────────────────────────────────────────────────

mkdirSync(dirname(channelPath), { recursive: true });

const template = readFileSync(
  join(projectRoot, "templates", "channel.ts"),
  "utf-8",
);
const channelCode = template
  .replace(/TemplateChannel/g, `${className}Channel`)
  .replace(/template/g, name)
  .replace(/__CATEGORY__/g, category);

writeFileSync(channelPath, channelCode);
console.log(`✅ Created: src/channels/${category}/${name}.ts`);

// ── Create fixture ─────────────────────────────────────────────────────────

const fixtureDir = join(outputRoot, "tests", "fixtures");
mkdirSync(fixtureDir, { recursive: true });

const fixturePath = join(fixtureDir, `${name}.json`);
const fixtureTemplate = readFileSync(
  join(projectRoot, "templates", "channel.fixture.json"),
  "utf-8",
);
writeFileSync(fixturePath, fixtureTemplate);
console.log(`✅ Created: tests/fixtures/${name}.json`);

const errorFixturePath = join(fixtureDir, `${name}-error.json`);
writeFileSync(
  errorFixturePath,
  JSON.stringify(
    {
      channel: name,
      raw: "invalid response",
      rawType: "string",
      expectedCount: 0,
      expectedError: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`✅ Created: tests/fixtures/${name}-error.json`);

const testDir = join(outputRoot, "tests", "channels");
mkdirSync(testDir, { recursive: true });
const testTemplate = readFileSync(
  join(projectRoot, "templates", "channel.test.ts"),
  "utf-8",
);
const testCode = testTemplate
  .replace(/TemplateChannel/g, `${className}Channel`)
  .replace(/template/g, name)
  .replace(/__CATEGORY__/g, category);
writeFileSync(join(testDir, `${name}.test.ts`), testCode);
console.log(`✅ Created: tests/channels/${name}.test.ts`);

// ── Instructions ───────────────────────────────────────────────────────────

console.log(`
📋 Next steps:
  1. Edit src/channels/${category}/${name}.ts — implement buildRequests/formatResults(parseArgs 用基类默认,别覆写;见 docs/channel-development.md 规则 0c)
  2. Edit the co-located exported spec (description/intents/params/supports)
  3. Replace the generated fixture payloads with real backend responses
  4. Expand tests/channels/${name}.test.ts with parser and error cases
  5. Run: npm run typecheck && npm test
`);
