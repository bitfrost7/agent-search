/**
 * Channel tests — parseArgs / buildRequests / formatResults logic.
 * Tests pure parsing logic without real network calls.
 */
import { describe, it, expect } from "vitest";

// Mock daemon-client for channels that import it
vi.mock("../src/daemon-client.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue(true),
  getCookieHeader: vi.fn().mockResolvedValue("cookie=abc"),
  navigate: vi.fn().mockResolvedValue("page-1"),
  evalInPage: vi.fn().mockResolvedValue("[]"),
  checkDaemonHealth: vi
    .fn()
    .mockResolvedValue({ ok: true, reason: "available" }),
}));

import { vi } from "vitest";

// ── 引擎渠道(每搜索引擎一个渠道) ────────────────────────────────────────────

import TavilyChannel from "../src/channels/public/tavily.js";
import SerperChannel from "../src/channels/public/serper.js";
import JinaChannel from "../src/channels/public/jina.js";
import DdgChannel from "../src/channels/public/ddg.js";
import BochaChannel from "../src/channels/public/bocha.js";

describe("Engine channels (tavily/serper/jina/ddg)", () => {
  it("tavily parses results and filters reddit", () => {
    const ch = new TavilyChannel();
    const raw = JSON.stringify({
      results: [
        { title: "good", content: "c", url: "https://example.com/a" },
        { title: "reddit", content: "c", url: "https://www.reddit.com/r/x" },
      ],
    });
    const results = ch.formatResults(raw, { query: "x", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].source).toEqual({ channel: "tavily", backend: "api" });
  });

  it("serper parses organic results", () => {
    const ch = new SerperChannel();
    const raw = JSON.stringify({
      organic: [
        {
          title: "Rust async",
          snippet: "guide",
          link: "https://example.com/rust",
        },
      ],
    });
    const results = ch.formatResults(raw, { query: "rust", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].source).toEqual({ channel: "serper", backend: "api" });
  });

  it("jina parses data[]", () => {
    const ch = new JinaChannel();
    const raw = JSON.stringify({
      data: [{ title: "T", description: "S", url: "https://j.example.com" }],
    });
    const results = ch.formatResults(raw, { query: "x", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].source).toEqual({ channel: "jina", backend: "api" });
  });

  it("ddg parses lite HTML and resolves uddg redirect", () => {
    const ch = new DdgChannel();
    const raw = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/real")}">Title</a><td class="result-snippet">snippet</td>`;
    const results = ch.formatResults(raw, { query: "x", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/real");
    expect(results[0].source).toEqual({ channel: "ddg", backend: "api" });
  });

  it("engine channels are search-only (supportsContent=false, no fake content)", () => {
    const channels = [
      new BochaChannel(),
      new TavilyChannel(),
      new SerperChannel(),
      new JinaChannel(),
      new DdgChannel(),
    ];
    for (const ch of channels) {
      expect(ch.supportsContent).toBe(false);
    }
  });

  it("engine channels use unified default parseArgs (--key value → channelParams)", () => {
    const ch = new TavilyChannel();
    const params = ch.parseArgs("rust", ["--limit", "8", "--foo", "bar"]);
    expect(params.limit).toBe(8);
    expect(params.foo).toBe("bar");
  });
});

// ── Bilibili ────────────────────────────────────────────────────────────────

import BilibiliChannel from "../src/channels/public/bilibili.js";

describe("BilibiliChannel", () => {
  const ch = new BilibiliChannel();

  it("should parse --limit and --type", () => {
    const params = ch.parseArgs("大模型", ["--limit", "5", "--type", "user"]);
    expect(params.query).toBe("大模型");
    expect(params.limit).toBe(5);
    expect(params.type).toBe("user");
  });

  it("should build cookie_fetch → cli → browser_exec fallback chain", () => {
    const params = ch.parseArgs("test query", []);
    const reqs = ch.buildRequests(params);
    expect(reqs).toHaveLength(3);
    expect(reqs[0].strategy).toBe("cookie_fetch");
    expect(reqs[0].apiUrl).toContain("api.bilibili.com");
    expect(reqs[1].strategy).toBe("cli");
    expect(reqs[1].cmd).toBe("opencli");
    expect(reqs[2].strategy).toBe("browser_exec");
  });

  it("should format JSON string from evalInPage", () => {
    const raw = JSON.stringify([
      { title: "video1", url: "https://bilibili.com/1" },
    ]);
    const results = ch.formatResults(raw, {});
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("video1");
  });

  it("F4:formatError 识别业务错误 code !== 0", () => {
    const err = ch["formatError"](
      JSON.stringify({ code: -400, message: "request block" }),
    );
    expect(err?.code).toBe("channel_failed");
    expect(err?.message).toContain("-400");
    expect(ch["formatError"](JSON.stringify({ code: 0, data: {} }))).toBeNull();
  });

  it("should return empty for non-JSON output (not pseudo-error)", () => {
    const results = ch.formatResults("plain text output", {});
    expect(results).toEqual([]);
  });
});

// ── Bocha ───────────────────────────────────────────────────────────────────

describe("BochaChannel", () => {
  const ch = new BochaChannel();

  it("F4:formatError 识别业务错误 code !== 200", () => {
    const err = ch["formatError"](
      JSON.stringify({ code: 429, message: "rate limited" }),
    );
    expect(err?.code).toBe("channel_failed");
    expect(err?.message).toContain("429");
    expect(
      ch["formatError"](JSON.stringify({ code: 200, data: {} })),
    ).toBeNull();
    expect(ch["formatError"]("not json")).toBeNull();
  });
});

// ── Twitter ─────────────────────────────────────────────────────────────────

import TwitterChannel from "../src/channels/public/twitter.js";

describe("TwitterChannel", () => {
  const ch = new TwitterChannel();

  it("should default limit to 15", () => {
    const params = ch.parseArgs("AI agents", []);
    expect(params.limit).toBe(15);
  });

  it("should build CLI + browser_exec fallback", () => {
    const params = ch.parseArgs("test", []);
    const reqs = ch.buildRequests(params);
    expect(reqs[0].strategy).toBe("cli");
    expect(reqs[0].cmd).toBe("opencli");
    expect(reqs[1].strategy).toBe("browser_exec");
  });
});

// ── searchWithParams（unified pipeline 直接桥接）────────────────────────────

import type { Adapter } from "../src/types.js";

describe("searchWithParams — spec params bypass CLI parsing", () => {
  it("v2ex accepts spec params (tab) directly", async () => {
    const V2exChannel = (await import("../src/channels/public/v2ex.js"))
      .default;
    const ch = new V2exChannel();
    const mockAdapter: Adapter = {
      name: "mock",
      execute: vi.fn().mockResolvedValue({
        raw: JSON.stringify([]),
        fallbackUsed: false,
        failures: [],
      }),
    };
    ch.adapter = mockAdapter;

    const params = { query: "", tab: "latest" };
    await ch.searchWithParams(params);

    const requests = (mockAdapter.execute as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { url?: string }[];
    expect(requests[0].url).toContain("/api/topics/latest.json");
  });

  it("search() reuses searchWithParams", async () => {
    const ch = new V2exChannel();
    const mockAdapter: Adapter = {
      name: "mock",
      execute: vi.fn().mockResolvedValue({
        raw: "[]",
        fallbackUsed: false,
        failures: [],
      }),
    };
    ch.adapter = mockAdapter;
    const results = await ch.search("test", ["--limit", "3"]);
    expect(results).toHaveLength(0);
  });
});

// ── YouTube ────────────────────────────────────────────────────────────────

import YoutubeChannel from "../src/channels/public/youtube.js";

describe("YoutubeChannel", () => {
  const ch = new YoutubeChannel();

  it("should default limit to 10", () => {
    const params = ch.parseArgs("python tutorial", []);
    expect(params.limit).toBe(10);
  });

  it("should build CLI request with yt-dlp", () => {
    const params = ch.parseArgs("python tutorial", ["--limit", "3"]);
    const reqs = ch.buildRequests(params);
    expect(reqs[0].strategy).toBe("cli");
    expect(reqs[0].cmd).toBe("yt-dlp");
    expect(reqs[0].cmdArgs?.[0]).toContain("ytsearch3");
  });
});

// ── V2EX ───────────────────────────────────────────────────────────────────

import V2exChannel from "../src/channels/public/v2ex.js";

describe("V2exChannel", () => {
  const ch = new V2exChannel();

  it("buildRequests 默认 tab 为 hot(parseArgs 已用基类,A2)", () => {
    const reqs = ch.buildRequests(ch.parseArgs("", []));
    expect(reqs[0].url).toContain("/hot.json");
  });

  it("should build API request", () => {
    const params = ch.parseArgs("", ["--tab", "jobs"]);
    const reqs = ch.buildRequests(params);
    expect(reqs[0].strategy).toBe("api");
    expect(reqs[0].url).toContain("v2ex.com/api/topics/jobs");
  });
});
