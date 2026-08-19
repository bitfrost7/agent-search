/**
 * Unit tests for bridge executor — searchWithParams integration
 * with mock BaseChannel.
 */
import { describe, it, expect, vi } from "vitest";
import { createBridgeExecutor } from "../src/search/bridge-executor.js";
import type { BaseChannel } from "../src/channel.js";
import type { SearchResult, ChannelOutcome } from "../src/types.js";

// ── createBridgeExecutor ────────────────────────────────────────────────────

describe("createBridgeExecutor", () => {
  function mockChannel(results: SearchResult[]): BaseChannel {
    return {
      name: "mock",
      category: "test",
      searchWithParams: vi.fn().mockResolvedValue({ ok: true, results } satisfies ChannelOutcome),
    } as unknown as BaseChannel;
  }

  it("returns unified results from BaseChannel.searchWithParams", async () => {
    const ch = mockChannel([
      { title: "Test", url: "https://example.com", snippet: "Summary", source: { channel: "mock", backend: "api" } },
    ]);
    const executor = createBridgeExecutor(() => ch);
    const result = await executor("mock", { query: "test" }, 5);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("Test");
    expect(result.results[0].source.channel).toBe("mock");
    expect(result.results[0].source.backend).toBe("api");
  });

  it("converts ChannelOutcome error to SearchError (结构化错误,非伪 result)", async () => {
    const ch = mockChannel([]);
    ch.searchWithParams = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "channel_failed", message: "mock: timeout", channel: "mock" },
    } satisfies ChannelOutcome);
    const executor = createBridgeExecutor(() => ch);
    const result = await executor("mock", { query: "test" }, 5);

    expect(result.results).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("channel_failed");
    expect(result.errors[0].message).toContain("timeout");
  });

  it("converts no_request outcome to empty_results SearchError", async () => {
    const ch = mockChannel([]);
    ch.searchWithParams = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "no_request", message: "mock: no request built", channel: "mock" },
    } satisfies ChannelOutcome);
    const executor = createBridgeExecutor(() => ch);
    const result = await executor("mock", { query: "test" }, 5);

    expect(result.results).toHaveLength(0);
    expect(result.errors[0].code).toBe("empty_results");
  });

  it("returns unknown_channel error for missing channel", async () => {
    const executor = createBridgeExecutor(() => undefined);
    const result = await executor("nonexistent", { query: "test" }, 5);

    expect(result.results).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("unknown_channel");
  });

  it("calls searchWithParams with mapped params + router limit", async () => {
    const ch = mockChannel([]);
    const executor = createBridgeExecutor(() => ch);
    await executor("mock", { query: "hello world", language: "python" }, 7);

    expect(ch.searchWithParams).toHaveBeenCalledWith({
      query: "hello world",
      language: "python",
      limit: 7, // router-allocated limit overrides
    });
  });

  it("handles BaseChannel.searchWithParams throwing", async () => {
    const ch = mockChannel([]);
    ch.searchWithParams = vi.fn().mockRejectedValue(new Error("network down"));
    const executor = createBridgeExecutor(() => ch);

    // Bridge executor doesn't catch — unifiedSearch catches at executor call
    await expect(executor("mock", { query: "test" }, 5)).rejects.toThrow("network down");
  });
});
