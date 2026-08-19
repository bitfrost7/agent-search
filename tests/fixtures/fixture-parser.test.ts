/**
 * Fixture parser tests — verify channel formatResults can correctly
 * parse raw API/CLI output from saved fixtures.
 *
 * Each fixture is a JSON file with:
 * - raw: the raw input string
 * - expectedCount: number of results expected
 * - expectedFields: field values to check (optional)
 * - expectedError: if true, expect pseudo-error or empty (optional)
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import V2exChannel from "../../src/channels/public/v2ex.js";
import { adaptSearchResults } from "../../src/search/result-adapter.js";
import { testRegistry } from "../helpers/registry.js";

interface Fixture {
  channel: string;
  raw: string;
  rawType?: "string" | "object";
  query?: string;
  backend?: string;
  expectedCount: number;
  expectedFields?: Record<string, string>;
  expectedError?: boolean;
}

const fixtureDir = join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): Fixture {
  const content = readFileSync(join(fixtureDir, name), "utf-8");
  return JSON.parse(content) as Fixture;
}

function getChannel(name: string) {
  const ch = testRegistry.get(name);
  if (!ch) throw new Error(`no channel for fixture: ${name}`);
  return ch;
}

// ── Auto-discover and test all fixtures ────────────────────────────────────

const fixtureFiles = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));

describe("Fixture parser tests", () => {
  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);
    const ch = getChannel(fixture.channel);

    it(`${fixture.channel}: ${file} → ${fixture.expectedCount} results`, () => {
      // Parse raw — some fixtures specify rawType: "object" for API JSON
      const rawInput = fixture.rawType === "object" ? JSON.parse(fixture.raw) : fixture.raw;
      // Some channels (e.g. web) need query/backend in params
      const params: Record<string, unknown> = {};
      if (fixture.query) params.query = fixture.query;
      if (fixture.backend) params.backend = fixture.backend;
      // Parse raw with channel's formatResults
      const legacyResults = ch.formatResults(rawInput, params);
      // Adapt to unified format
      const adapted = adaptSearchResults(legacyResults);

      if (fixture.expectedError) {
        // Channel formatters should not emit pseudo-error results anymore.
        // Parse failures/no extraction are represented as empty results here;
        // executor-level failures are covered separately.
        expect(adapted.errors.length).toBe(0);
        expect(adapted.results.length).toBe(0);
      } else {
        expect(adapted.results.length).toBe(fixture.expectedCount);
      }

      // Check expected fields
      if (fixture.expectedFields && adapted.results.length > 0) {
        for (const [key, value] of Object.entries(fixture.expectedFields)) {
          const result = adapted.results[0] as unknown as Record<string, unknown>;
          expect(result[key]).toBe(value);
        }
      }
    });
  }
});

// ── Specific fixture assertions ────────────────────────────────────────────

describe("Bilibili fixture details", () => {
  it("parses API response correctly (fixed JSON parsing)", () => {
    const fixture = loadFixture("bilibili.json");
    const ch = getChannel("bilibili");
    const results = ch.formatResults(fixture.raw, {});
    // Now formatResults correctly parses complete JSON first
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("测试视频");
    expect(results[0].url).toContain("BV1xx411c7mD");
  });

  it("handles browser bridge failure", () => {
    const fixture = loadFixture("bilibili-error.json");
    const ch = getChannel("bilibili");
    const results = ch.formatResults(fixture.raw, {});
    // Browser bridge success without extracted data should not produce a pseudo-error result.
    expect(results).toEqual([]);
    const adapted = adaptSearchResults(results);
    expect(adapted.errors.length).toBe(0);
    expect(adapted.results.length).toBe(0);
  });
});


describe("V2EX fixture details", () => {
  it("parses topic list", () => {
    const fixture = loadFixture("v2ex.json");
    const ch = new V2exChannel();
    const results = ch.formatResults(JSON.parse(fixture.raw), {});
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("测试主题");
  });
});
