/**
 * Pseudo-result prohibition tests.
 *
 * Scans all public channel formatResults to ensure they don't return
 * pseudo-error results like "xxx search failed" or "(no results)".
 *
 * These should be eliminated at the source. Legacy compatibility for
 * externally supplied pseudo-results is covered separately below, but real
 * channel formatters must not emit them.
 */

import { describe, it, expect } from "vitest";
import { isPseudoErrorResult } from "../src/search/schema.js";
import { testRegistry } from "./helpers/registry.js";

const channels = testRegistry
  .list()
  .filter((channel) => channel.category !== "internal");

// ── Test: empty/invalid input should not produce pseudo-error results ───────

describe("formatResults must not return pseudo-error results", () => {
  for (const ch of channels) {
    describe(`${ch.name} channel`, () => {
      it("empty string input → no pseudo-error results", () => {
        const results = ch.formatResults("", {});
        const pseudoErrors = results.filter((r) =>
          isPseudoErrorResult(r.title),
        );
        expect(pseudoErrors).toEqual([]);
      });

      it("non-JSON string input → no pseudo-error results", () => {
        const results = ch.formatResults("not json at all", {});
        const pseudoErrors = results.filter((r) =>
          isPseudoErrorResult(r.title),
        );
        expect(pseudoErrors).toEqual([]);
      });

      it("null input → throws or no pseudo-error results", () => {
        // Some channels may throw on null — that's OK (BaseChannel.search catches it)
        try {
          const results = ch.formatResults(null, {});
          const pseudoErrors = results.filter((r) =>
            isPseudoErrorResult(r.title),
          );
          expect(pseudoErrors).toEqual([]);
        } catch {
          // Throwing is acceptable — the caller (BaseChannel.search) catches
        }
      });

      it("empty array input → empty results, no pseudo-error", () => {
        try {
          const results = ch.formatResults([], {});
          // Empty array should return empty array, not pseudo-error
          const pseudoErrors = results.filter((r) =>
            isPseudoErrorResult(r.title),
          );
          expect(pseudoErrors.length).toBe(0);
        } catch {
          // Some channels may throw — acceptable
        }
      });

      it("valid JSON array input → no pseudo-error results", () => {
        const params: Record<string, unknown> = { query: "test" };
        const results = ch.formatResults(
          JSON.stringify([{ title: "Test", url: "https://example.com" }]),
          params,
        );
        // Some channels may not parse this format, but should not return pseudo-error
        const pseudoErrors = results.filter((r) =>
          isPseudoErrorResult(r.title),
        );
        expect(pseudoErrors.length).toBe(0);
      });
    });
  }
});

// ── Test: raw CLI text should not be stuffed into a single result ───────────

describe("formatResults must not stuff raw CLI text into single result", () => {
  for (const ch of channels) {
    const requests = ch.buildRequests(ch.parseArgs("test", []));
    if (!requests.some((request) => request.strategy === "cli")) continue;

    it(`${ch.name}: long CLI text (>500 chars) should not be a single result snippet`, () => {
      const longText = "a".repeat(1000);
      const results = ch.formatResults(longText, {});

      // If a single result is returned, its snippet should not be the entire raw text
      if (results.length === 1) {
        const snippet = results[0].snippet ?? "";
        expect(snippet.length).toBeLessThanOrEqual(500);
      }
    });
  }
});
