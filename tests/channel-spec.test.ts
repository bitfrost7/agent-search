/**
 * Unit tests for ChannelSpec mapRequest and validation.
 * Tests parameter mapping and warning generation — no network.
 */
import { describe, it, expect } from "vitest";
import { spec as bochaSpec } from "../src/channels/public/bocha.js";
import { spec as bilibiliSpec } from "../src/channels/public/bilibili.js";
import { spec as youtubeSpec } from "../src/channels/public/youtube.js";
import { spec as twitterSpec } from "../src/channels/public/twitter.js";
import { spec as v2exSpec } from "../src/channels/public/v2ex.js";
import { normalizeSearchRequest } from "../src/search/schema.js";
import type { NormalizedSearchRequest } from "../src/search/types.js";
import { registeredTestSpecs, resolveTestSpec } from "./helpers/registry.js";

function normReq(
  overrides: Partial<NormalizedSearchRequest> = {},
): NormalizedSearchRequest {
  return {
    query: "test",
    intent: "web",
    channels: [],
    limit: 5,
    page: 1,
    sort: "relevance",
    timeRange: "all",
    ...overrides,
    // 测试直接构造 NormalizedSearchRequest:overrides 里显式传了 sort/timeRange 就标记 specified
    sortSpecified:
      overrides.sortSpecified ??
      (overrides.sort !== undefined ? true : undefined),
    timeRangeSpecified:
      overrides.timeRangeSpecified ??
      (overrides.timeRange !== undefined ? true : undefined),
  };
}

// ── Spec registry ───────────────────────────────────────────────────────────

describe("channel spec registry", () => {
  it("discovers specs from channel plugins", () => {
    const specs = registeredTestSpecs();
    expect(specs.length).toBeGreaterThan(0);
    expect(new Set(specs.map((spec) => spec.name)).size).toBe(specs.length);
  });

  it("resolves discovered specs by name", () => {
    expect(resolveTestSpec("v2ex")?.name).toBe("v2ex");
    expect(resolveTestSpec("nonexistent")).toBeUndefined();
  });
});

// ── GitHub spec ─────────────────────────────────────────────────────────────


