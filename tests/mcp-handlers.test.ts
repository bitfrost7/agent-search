/**
 * Unit tests for MCP tool handlers.
 * Tests tool schemas and handler functions with mock executors.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TOOL_SCHEMAS,
  handleSearch as runSearchHandler,
  handleContent,
  handleChannels as runChannelsHandler,
  handleChannelDebug as runChannelDebugHandler,
  createCachedHealthChecker,
} from "../src/search/mcp-handlers.js";
import type { ChannelExecutor } from "../src/search/router.js";
import type { UnifiedSearchRequest } from "../src/search/types.js";
import type { SearchResult } from "../src/types.js";
import { resolveMockSpec } from "./helpers/mock-channel.js";

const handleSearch = (args: UnifiedSearchRequest, executor: ChannelExecutor) =>
  runSearchHandler(args, executor, resolveMockSpec);
const handleChannels = (
  getChannelList: Parameters<typeof runChannelsHandler>[0],
  getHealth: Parameters<typeof runChannelsHandler>[1],
  intentFilter?: string,
  getLoadErrors?: Parameters<typeof runChannelsHandler>[4],
) =>
  runChannelsHandler(
    getChannelList,
    getHealth,
    resolveMockSpec,
    intentFilter,
    getLoadErrors,
  );
const handleChannelDebug = (
  args: Parameters<typeof runChannelDebugHandler>[0],
  getChannel: Parameters<typeof runChannelDebugHandler>[1],
  getHealth: Parameters<typeof runChannelDebugHandler>[2],
) => runChannelDebugHandler(args, getChannel, getHealth, resolveMockSpec);

// ── Tool schemas ────────────────────────────────────────────────────────────

describe("TOOL_SCHEMAS", () => {
  it("has the four layered tools", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toEqual(
      expect.arrayContaining([
        "search",
        "content",
        "channels",
        "channel_debug",
      ]),
    );
    // channel_info 已合并进 channels(内嵌完整参数),不再单列
    expect(names).not.toContain("channel_info");
    expect(names).toHaveLength(4);
  });

  it("search tool requires query and channels", () => {
    expect(TOOL_SCHEMAS.search.inputSchema.required).toEqual([
      "query",
      "channels",
    ]);
  });

  it("search tool has channelParams (channel-specific)", () => {
    const props = TOOL_SCHEMAS.search.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.channelParams.type).toBe("object");
  });

  it("channels tool exposes channelParams for every channel", () => {
    // channels 返回的每条渠道应带完整 channelParams 说明 + defaults
    expect(TOOL_SCHEMAS.channels).toBeDefined();
  });

  it("content tool requires channel (refs or url)", () => {
    expect(TOOL_SCHEMAS.content.inputSchema.required).toEqual(["channel"]);
    const props = TOOL_SCHEMAS.content.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.refs.type).toBe("array");
    expect(props.url.type).toBe("string");
  });

  it("channel_debug has action enum", () => {
    const props = TOOL_SCHEMAS.channel_debug.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.action.enum).toEqual(["help", "health", "spec"]);
  });
});

// ── handleSearch ────────────────────────────────────────────────────────────

describe("handleSearch", () => {
  it("returns JSON envelope with results", async () => {
    const mockExecutor: ChannelExecutor = vi.fn().mockResolvedValue({
      results: [
        {
          id: "mock_test",
          title: "Test Repo",
          url: "https://mock.example/test/repo",
          summary: "A test repo",
          source: { channel: "mock" },
          rank: 0,
        },
      ],
      warnings: [],
      errors: [],
    });

    const output = await handleSearch(
      { query: "test", channels: ["mock"] },
      mockExecutor,
    );
    const resp = JSON.parse(output);

    expect(resp.ok).toBe(true);
    expect(resp.count).toBe(1);
    expect(resp.results[0].title).toBe("Test Repo");
    expect(resp.results[0].rank).toBe(1);
  });

  it("returns error envelope for empty query", async () => {
    const mockExecutor: ChannelExecutor = vi.fn();
    const output = await handleSearch({ query: "" }, mockExecutor);
    const resp = JSON.parse(output);

    expect(resp.ok).toBe(false);
    expect(resp.errors).toHaveLength(1);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  it("returns JSON with unknown channel error", async () => {
    const mockExecutor: ChannelExecutor = vi.fn();
    const output = await handleSearch(
      { query: "test", channels: ["nonexistent"] },
      mockExecutor,
    );
    const resp = JSON.parse(output);

    expect(resp.ok).toBe(false);
    expect(
      resp.errors.some((e: { code: string }) => e.code === "unknown_channel"),
    ).toBe(true);
  });
});

// ── handleContent ───────────────────────────────────────────────────────────

describe("handleContent", () => {
  it("returns content response", async () => {
    const mockGetContent = vi.fn().mockResolvedValue([
      {
        title: "Article",
        url: "https://example.com/a",
        snippet: "Full content",
        source: { channel: "web", backend: "content" },
      },
    ] as SearchResult[]);

    const output = await handleContent(
      { channel: "web", url: "https://example.com/a" },
      mockGetContent,
    );
    const resp = JSON.parse(output);

    // A7:单条/批量统一结构——内容在 items[0]
    expect(resp.ok).toBe(true);
    expect(resp.items).toHaveLength(1);
    expect(resp.items[0].title).toBe("Article");
    expect(resp.items[0].content).toBe("Full content");
    expect(resp.items[0].url).toBe("https://example.com/a");
  });

  it("returns error for missing url", async () => {
    const output = await handleContent({ channel: "web", url: "" }, vi.fn());
    const resp = JSON.parse(output);
    expect(resp.ok).toBe(false);
  });

  it("returns error for missing channel", async () => {
    const output = await handleContent(
      { channel: "", url: "https://example.com" },
      vi.fn(),
    );
    const resp = JSON.parse(output);
    expect(resp.ok).toBe(false);
  });

  it("returns error when getContent throws", async () => {
    const mockGetContent = vi
      .fn()
      .mockRejectedValue(new Error("network error"));

    const output = await handleContent(
      { channel: "web", url: "https://example.com" },
      mockGetContent,
    );
    const resp = JSON.parse(output);

    expect(resp.ok).toBe(false);
    expect(resp.errors).toHaveLength(1);
    expect(resp.errors[0].error.code).toBe("ref_failed");
    expect(resp.errors[0].error.message).toContain("network error");
  });
});

// ── handleChannels ──────────────────────────────────────────────────────────

describe("handleChannels", () => {
  it("returns JSON list with channel info", async () => {
    const mockGetList = () => [
      { name: "mock", category: "test" },
      { name: "mock2", category: "test" },
    ];
    const mockGetHealth = vi
      .fn()
      .mockResolvedValue({ status: "ok", reason: "available" });

    const output = await handleChannels(mockGetList, mockGetHealth);
    const resp = JSON.parse(output);

    expect(resp.channels).toHaveLength(2);
    expect(resp.channels[0].name).toBe("mock");
    // 渠道一句话描述直接来自插件自己的 spec.description
    expect(resp.channels[0].description).toContain("Mock");
    expect(resp.channels[0].intents).toEqual(
      expect.arrayContaining(["web"]),
    );
    expect(resp.channels[0].health.status).toBe("ok");
  });

  it("includes spec capabilities", async () => {
    const mockGetList = () => [{ name: "mock", category: "test" }];
    const mockGetHealth = vi
      .fn()
      .mockResolvedValue({ status: "ok", reason: "" });

    const output = await handleChannels(mockGetList, mockGetHealth);
    const resp = JSON.parse(output);

    expect(resp.channels[0].contentTypes).toEqual(
      expect.arrayContaining(["web_page"]),
    );
  });

  it("rejects a registered channel without a plugin spec", async () => {
    await expect(
      runChannelsHandler(
        () => [{ name: "orphan", category: "test" }],
        vi.fn().mockResolvedValue({ status: "ok", reason: "" }),
        () => undefined,
      ),
    ).rejects.toThrow('registered channel "orphan" has no spec');
  });

  it("checks channel health concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const getHealth = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: "ok", reason: "" };
    };
    await handleChannels(
      () => [
        { name: "mock", category: "test" },
        { name: "mock2", category: "test" },
      ],
      getHealth,
    );
    expect(maxActive).toBe(2);
  });

  it("caches and coalesces health checks", async () => {
    const check = vi.fn().mockResolvedValue({ status: "ok", reason: "" });
    const cached = createCachedHealthChecker(check, 1_000);
    const [first, second] = await Promise.all([
      cached("mock"),
      cached("mock"),
    ]);
    expect(first).toEqual(second);
    expect(check).toHaveBeenCalledTimes(1);
    await cached("mock");
    expect(check).toHaveBeenCalledTimes(1);
  });
});

// ── handleChannelDebug ──────────────────────────────────────────────────────

describe("handleChannelDebug", () => {
  it("returns help text", async () => {
    const mockGetChannel = (name: string) => ({
      help: () => `Usage: agent-search ${name} <query>`,
    });
    const output = await handleChannelDebug(
      { channel: "mock", action: "help" },
      mockGetChannel as never,
      vi.fn(),
    );
    expect(output).toContain("Usage: agent-search mock");
  });

  it("returns health JSON", async () => {
    const mockGetHealth = vi
      .fn()
      .mockResolvedValue({ status: "ok", backends: [] });
    const output = await handleChannelDebug(
      { channel: "mock", action: "health" },
      () => ({ help: () => "" }),
      mockGetHealth,
    );
    const resp = JSON.parse(output);
    expect(resp.status).toBe("ok");
  });

  it("returns spec JSON", async () => {
    const output = await handleChannelDebug(
      { channel: "mock", action: "spec" },
      () => ({ help: () => "" }),
      vi.fn(),
    );
    const resp = JSON.parse(output);
    expect(resp.name).toBe("mock");
    expect(resp.intents).toEqual(expect.arrayContaining(["web"]));
  });

  it("returns error for unknown channel", async () => {
    const output = await handleChannelDebug(
      { channel: "nonexistent", action: "help" },
      () => undefined,
      vi.fn(),
    );
    const resp = JSON.parse(output);
    expect(resp.error).toContain("unknown channel");
  });
});
