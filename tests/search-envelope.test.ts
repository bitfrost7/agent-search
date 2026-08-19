/**
 * Unit tests for result adapter and envelope builder.
 * Tests conversion from legacy SearchResult to UnifiedSearchResult,
 * including pseudo-error detection and content response building.
 */
import { describe, it, expect } from "vitest";
import { adaptSearchResults, adaptSingleResult } from "../src/search/result-adapter.js";
import {
  buildContentResponse,
  buildContentErrorResponse,
} from "../src/search/envelope.js";
import type { SearchResult } from "../src/types.js";

// ── adaptSearchResults ──────────────────────────────────────────────────────

describe("adaptSearchResults", () => {
  it("converts normal results to unified format", () => {
    const legacy: SearchResult[] = [
      { title: "React", url: "https://github.com/facebook/react", snippet: "A JS library", source: { channel: "github", backend: "api" }, meta: { stars: 200000 } },
      { title: "Vue", url: "https://github.com/vuejs/core", snippet: "A progressive framework", source: { channel: "github", backend: "api" } },
    ];
    const { results, errors } = adaptSearchResults(legacy);
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(results[0].title).toBe("React");
    expect(results[0].summary).toBe("A JS library");
    expect(results[0].source.channel).toBe("github");
    expect(results[0].source.backend).toBe("api");
    expect(results[0].id).toMatch(/^github_/);
  });

  it("preserves ref only when channel provides it (P2: search-only 结果无 ref)", () => {
    const legacy: SearchResult[] = [
      { title: "web result", url: "https://example.com", snippet: "s", source: { channel: "tavily", backend: "api" } },
      { title: "github repo", url: "https://github.com/o/r", ref: "o/r", snippet: "s", source: { channel: "github", backend: "api" } },
    ];
    const { results } = adaptSearchResults(legacy);
    expect(results[0].ref).toBeUndefined(); // search-only:不带 ref
    expect(results[1].ref).toBe("o/r"); // search+content:保留 ref
  });

  it("mixes normal results (P1: 无伪错误拦截,错误由 ChannelOutcome 结构化透出)", () => {
    const legacy: SearchResult[] = [
      { title: "Good result", url: "https://example.com", snippet: "works", source: { channel: "web", backend: "api" } },
      { title: "github search failed", snippet: "timeout", source: { channel: "github", backend: "cli" } },
    ];
    const { results, errors } = adaptSearchResults(legacy);
    // 适配层不再做字符串猜测——伪错误 title 作为普通结果透传(上游已用 ChannelOutcome 拦截)
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("parses source with backend", () => {
    const legacy: SearchResult[] = [
      { title: "test", snippet: "s", source: { channel: "bilibili", backend: "cookie_fetch" } },
    ];
    const { results } = adaptSearchResults(legacy);
    expect(results[0].source.channel).toBe("bilibili");
    expect(results[0].source.backend).toBe("cookie_fetch");
  });

  it("handles source without backend", () => {
    const legacy: SearchResult[] = [
      { title: "test", snippet: "s", source: { channel: "web" } },
    ];
    const { results } = adaptSearchResults(legacy);
    expect(results[0].source.channel).toBe("web");
    expect(results[0].source.backend).toBeUndefined();
  });

  it("preserves meta from legacy results", () => {
    const legacy: SearchResult[] = [
      { title: "test", snippet: "s", source: { channel: "github" }, meta: { stars: 100, language: "TypeScript" } },
    ];
    const { results } = adaptSearchResults(legacy);
    expect(results[0].meta).toEqual({ stars: 100, language: "TypeScript" });
  });
});

// ── adaptSingleResult ───────────────────────────────────────────────────────

describe("adaptSingleResult", () => {
  it("converts a single result for content response", () => {
    const legacy: SearchResult = {
      title: "Article title",
      url: "https://example.com/article",
      snippet: "Article content...",
      source: { channel: "web", backend: "content" },
      meta: { wordCount: 500 },
    };
    const result = adaptSingleResult(legacy, "web");
    expect(result.title).toBe("Article title");
    expect(result.source.channel).toBe("web");
    expect(result.meta).toEqual({ wordCount: 500 });
  });
});

// ── buildContentResponse ────────────────────────────────────────────────────

describe("buildContentResponse", () => {
  it("builds ok content response", () => {
    const legacy: SearchResult[] = [
      { title: "Article", url: "https://example.com/a", snippet: "Full article content here", source: { channel: "web", backend: "content" } },
    ];
    const resp = buildContentResponse("web", "https://example.com/a", legacy);
    expect(resp.ok).toBe(true);
    expect(resp.title).toBe("Article");
    expect(resp.content).toBe("Full article content here");
    expect(resp.format).toBe("text");
  });

  it("detects JSON format", () => {
    const legacy: SearchResult[] = [
      { title: "API response", url: "https://api.example.com", snippet: '{"key": "value"}', source: { channel: "github" } },
    ];
    const resp = buildContentResponse("github", "https://api.example.com", legacy);
    expect(resp.format).toBe("json");
  });

  it("detects markdown format", () => {
    const legacy: SearchResult[] = [
      { title: "README", url: "https://github.com/repo", snippet: "# Title\n\nSome content", source: { channel: "github" } },
    ];
    const resp = buildContentResponse("github", "https://github.com/repo", legacy);
    expect(resp.format).toBe("markdown");
  });

  it("builds error response for empty results", () => {
    const resp = buildContentResponse("web", "https://example.com", []);
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("empty_results");
  });
});

// ── buildContentErrorResponse ───────────────────────────────────────────────

describe("buildContentErrorResponse", () => {
  it("builds error content response", () => {
    const resp = buildContentErrorResponse("web", "https://example.com", {
      code: "backend_unavailable",
      message: "no backend",
      channel: "web",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("backend_unavailable");
  });
});
