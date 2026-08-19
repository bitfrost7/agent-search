/**
 * Unit tests for Router and Execute (unified search pipeline).
 * Uses mock executors — no real network calls.
 */
import { describe, it, expect, vi } from "vitest";
import { routeRequest as route, allocateLimit } from "../src/search/router.js";
import { unifiedSearch as executeSearch } from "../src/search/execute.js";
import { normalizeSearchRequest as normalizeRequest } from "../src/search/schema.js";
import type { ChannelExecutor } from "../src/search/router.js";
import type {
  NormalizedSearchRequest,
  UnifiedSearchRequest,
  UnifiedSearchResult,
} from "../src/search/types.js";
import { resolveMockSpec } from "./helpers/mock-channel.js";

const normalizeSearchRequest = (req: UnifiedSearchRequest) =>
  normalizeRequest(req, resolveMockSpec);
const routeRequest = (req: NormalizedSearchRequest) =>
  route(req, resolveMockSpec);
const unifiedSearch = (req: UnifiedSearchRequest, executor: ChannelExecutor) =>
  executeSearch(req, executor, resolveMockSpec);

function makeResult(
  channel: string,
  title: string,
  url?: string,
): UnifiedSearchResult {
  return {
    id: `${channel}_${title}`,
    title,
    url,
    summary: `Result from ${channel}: ${title}`,
    source: { channel },
    rank: 0,
  };
}

// ── allocateLimit ───────────────────────────────────────────────────────────

describe("allocateLimit", () => {
  it("splits limit evenly across channels", () => {
    expect(allocateLimit(10, 2)).toBe(5);
    expect(allocateLimit(9, 3)).toBe(3);
  });

  it("rounds up for uneven splits", () => {
    expect(allocateLimit(5, 2)).toBe(3); // ceil(5/2) = 3
    expect(allocateLimit(7, 3)).toBe(3); // ceil(7/3) = 3
  });

  it("returns 0 for 0 channels", () => {
    expect(allocateLimit(10, 0)).toBe(0);
  });
});

// ── routeRequest ────────────────────────────────────────────────────────────

describe("routeRequest", () => {
  it("routes explicit single channel", () => {
    const { normalized } = normalizeSearchRequest({
      query: "react hooks",
      intent: "web",
      channels: ["mock"],
    });
    const { plans, errors } = routeRequest(normalized!);
    expect(errors).toHaveLength(0);
    expect(plans).toHaveLength(1);
    expect(plans[0].channel).toBe("mock");
  });

  it("routes channelParams to mock spec (type)", () => {
    const { normalized } = normalizeSearchRequest({
      query: "rust",
      channels: ["mock"],
      channelParams: { type: "b" },
    });
    const { plans, errors } = routeRequest(normalized!);
    expect(errors).toHaveLength(0);
    expect(plans[0].mapping.params!.type).toBe("b");
  });

  it("errors on invalid channelParam enum", () => {
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      channelParams: { type: "hackernews" }, // mock type enum: a/b
    });
    const { plans, errors } = routeRequest(normalized!);
    expect(errors.some((e) => e.message.includes("must be one of"))).toBe(true);
    expect(plans).toHaveLength(0);
  });

  it("warns on unknown channelParam", () => {
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      channelParams: { foo: "bar" },
    });
    const { warnings } = routeRequest(normalized!);
    expect(warnings.some((w) => w.field === "foo")).toBe(true);
  });

  it("errors on unknown channel", () => {
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["hackernews"],
    });
    const { plans, errors } = routeRequest(normalized!);
    expect(plans).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("unknown_channel");
  });

  it("collects warnings from spec mapping", () => {
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      timeRange: "week", // mock 不支持 timeRange → 应警告
    });
    const { warnings } = routeRequest(normalized!);
    expect(warnings.some((w) => w.field === "timeRange")).toBe(true);
  });
});

// ── unifiedSearch ───────────────────────────────────────────────────────────

describe("unifiedSearch", () => {
  it("returns ok response with results from mock executor", async () => {
    const mockExecutor: ChannelExecutor = vi.fn().mockResolvedValue({
      results: [makeResult("mock", "repo1", "https://mock.example/repo1")],
      warnings: [],
      errors: [],
    });

    const resp = await unifiedSearch(
      { query: "react", intent: "web", channels: ["mock"] },
      mockExecutor,
    );

    expect(resp.ok).toBe(true);
    expect(resp.count).toBe(1);
    expect(resp.results[0].title).toBe("repo1");
    expect(resp.results[0].rank).toBe(1);
    expect(resp.diagnostics?.channelsSucceeded).toEqual(["mock"]);
    expect(resp.diagnostics?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("treats a successful empty search as ok", async () => {
    const mockExecutor: ChannelExecutor = vi.fn().mockResolvedValue({
      results: [],
      warnings: [],
      errors: [],
    });
    const resp = await unifiedSearch(
      { query: "no matches", channels: ["mock"] },
      mockExecutor,
    );
    expect(resp.ok).toBe(true);
    expect(resp.count).toBe(0);
    expect(resp.diagnostics?.channelsSucceeded).toEqual(["mock"]);
    expect(resp.diagnostics?.channelsEmpty).toEqual(["mock"]);
    expect(resp.diagnostics?.channelsFailed).toEqual([]);
  });

  it("does not execute a channel when channelParams are invalid", async () => {
    const mockExecutor: ChannelExecutor = vi.fn();
    const resp = await unifiedSearch(
      {
        query: "test",
        channels: ["mock"],
        channelParams: { type: "invalid" },
      },
      mockExecutor,
    );
    expect(resp.ok).toBe(false);
    expect(mockExecutor).not.toHaveBeenCalled();
    expect(resp.errors.some((error) => error.code === "invalid_request")).toBe(
      true,
    );
  });

  it("aggregates results from single channel", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockImplementation(async (channel: string) => ({
        results: [
          makeResult(channel, `${channel}-result-1`),
          makeResult(channel, `${channel}-result-2`),
        ],
        warnings: [],
        errors: [],
      }));

    const resp = await unifiedSearch(
      { query: "tutorial", channels: ["mock"], limit: 10 },
      mockExecutor,
    );

    expect(resp.ok).toBe(true);
    expect(resp.count).toBe(2);
    expect(resp.results.every((r) => r.rank > 0)).toBe(true);
    expect(resp.diagnostics?.channelsSucceeded).toHaveLength(1);
  });

  it("agent 并行多渠道 = 多个独立 tool_call(框架单渠道)", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockImplementation(async (channel: string) => ({
        results: [makeResult(channel, `${channel}-result-1`)],
        warnings: [],
        errors: [],
      }));

    // 并行发起两个搜索(模拟 agent 两个 tool_call)
    const [r1, r2] = await Promise.all([
      unifiedSearch({ query: "a", channels: ["mock"] }, mockExecutor),
      unifiedSearch({ query: "b", channels: ["mock"] }, mockExecutor),
    ]);

    expect(r1.results[0].source.channel).toBe("mock");
    expect(r2.results[0].source.channel).toBe("mock");
  });

  it("returns ok=false when channel fails", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockImplementation(async (channel: string) => ({
        results: [],
        warnings: [],
        errors: [{ code: "channel_failed", message: "backend down", channel }],
      }));

    const resp = await unifiedSearch(
      { query: "test", channels: ["mock"] },
      mockExecutor,
    );

    expect(resp.ok).toBe(false);
    expect(resp.count).toBe(0);
    expect(resp.diagnostics?.channelsFailed).toEqual(["mock"]);
  });

  it("returns ok=false when all channels fail", async () => {
    const mockExecutor: ChannelExecutor = vi.fn().mockResolvedValue({
      results: [],
      warnings: [],
      errors: [
        {
          code: "backend_unavailable",
          message: "no backend",
          channel: "mock",
        },
      ],
    });

    const resp = await unifiedSearch(
      { query: "test", channels: ["mock"] },
      mockExecutor,
    );

    expect(resp.ok).toBe(false);
    expect(resp.count).toBe(0);
    expect(resp.results).toEqual([]);
  });

  it("truncates results to global limit", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockImplementation(async (channel: string) => ({
        results: Array.from({ length: 5 }, (_, i) =>
          makeResult(channel, `result-${i}`),
        ),
        warnings: [],
        errors: [],
      }));

    const resp = await unifiedSearch(
      { query: "test", channels: ["mock"], limit: 3 },
      mockExecutor,
    );

    expect(resp.count).toBe(3);
    expect(resp.results).toHaveLength(3);
  });

  it("handles executor throwing", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockRejectedValue(new Error("network down"));

    const resp = await unifiedSearch(
      { query: "test", channels: ["mock"] },
      mockExecutor,
    );

    expect(resp.ok).toBe(false);
    expect(resp.errors.some((e) => e.code === "channel_failed")).toBe(true);
  });

  it("returns normalization errors", async () => {
    const mockExecutor: ChannelExecutor = vi.fn();

    const resp = await unifiedSearch({ query: "" }, mockExecutor);

    expect(resp.ok).toBe(false);
    expect(resp.errors.some((e) => e.code === "invalid_request")).toBe(true);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  it("handles unknown channel in request", async () => {
    const mockExecutor: ChannelExecutor = vi.fn();

    const resp = await unifiedSearch(
      { query: "test", channels: ["nonexistent"] },
      mockExecutor,
    );

    expect(resp.ok).toBe(false);
    expect(resp.errors.some((e) => e.code === "unknown_channel")).toBe(true);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  it("assigns sequential ranks", async () => {
    const mockExecutor: ChannelExecutor = vi
      .fn()
      .mockImplementation(async (channel: string) => ({
        results: [
          makeResult(channel, "a", `https://${channel}.com/a`),
          makeResult(channel, "b", `https://${channel}.com/b`),
          makeResult(channel, "c", `https://${channel}.com/c`),
        ],
        warnings: [],
        errors: [],
      }));

    const resp = await unifiedSearch(
      { query: "test", channels: ["mock"], limit: 10 },
      mockExecutor,
    );

    const ranks = resp.results.map((r) => r.rank);
    expect(ranks).toEqual([1, 2, 3]);
  });
});
