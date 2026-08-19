/**
 * Unit tests for aggregate — deduplication, ranking, summary cleaning.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  deduplicateResults,
  rankResults,
  cleanSummary,
  cleanResultSummaries,
  aggregateResults,
} from "../src/search/aggregate.js";
import type { UnifiedSearchResult } from "../src/search/types.js";

function makeResult(
  title: string,
  url?: string,
  summary = "",
  meta?: Record<string, unknown>,
  publishedAt?: string,
): UnifiedSearchResult {
  return {
    id: `test_${title}`,
    title,
    url,
    summary,
    source: { channel: "test" },
    rank: 0,
    meta,
    publishedAt,
  };
}

// ── normalizeUrl ────────────────────────────────────────────────────────────

describe("normalizeUrl", () => {
  it("normalizes trailing slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("lowercases host", () => {
    expect(normalizeUrl("https://Example.COM/path")).toBe("https://example.com/path");
  });

  it("removes tracking params", () => {
    const url = "https://example.com/article?utm_source=google&utm_medium=cpc&id=123";
    const normalized = normalizeUrl(url);
    expect(normalized).not.toContain("utm_");
    expect(normalized).toContain("id=123");
  });

  it("returns empty for undefined", () => {
    expect(normalizeUrl(undefined)).toBe("");
  });

  it("returns trimmed string for non-URL", () => {
    expect(normalizeUrl("not-a-url/")).toBe("not-a-url");
  });
});

// ── deduplicateResults ──────────────────────────────────────────────────────

describe("deduplicateResults", () => {
  it("removes duplicates by URL", () => {
    const results = [
      makeResult("A", "https://example.com/a"),
      makeResult("A2", "https://example.com/a/"), // trailing slash → same URL
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
  });

  it("removes duplicates by tracking URL", () => {
    const results = [
      makeResult("A", "https://example.com/article?id=1"),
      makeResult("B", "https://example.com/article?id=1&utm_source=google"),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
  });

  it("keeps results with different URLs", () => {
    const results = [
      makeResult("A", "https://example.com/a"),
      makeResult("B", "https://example.com/b"),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(2);
  });

  it("deduplicates by title when no URL", () => {
    const results = [
      makeResult("Same Title"),
      makeResult("same title"),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
  });

  it("keeps longer summary when deduplicating", () => {
    const results = [
      makeResult("A", "https://example.com/a", "short"),
      makeResult("A", "https://example.com/a", "this is a longer summary"),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].summary).toBe("this is a longer summary");
  });
});

// ── rankResults ─────────────────────────────────────────────────────────────

describe("rankResults", () => {
  it("keeps original order for relevance sort", () => {
    const results = [
      makeResult("A", "https://a.com"),
      makeResult("B", "https://b.com"),
    ];
    const ranked = rankResults(results, "relevance");
    expect(ranked[0].title).toBe("A");
    expect(ranked[1].title).toBe("B");
  });

  it("sorts by publishedAt for latest", () => {
    const results = [
      makeResult("Old", "https://old.com", "", {}, "2024-01-01"),
      makeResult("New", "https://new.com", "", {}, "2024-06-01"),
    ];
    const ranked = rankResults(results, "latest");
    expect(ranked[0].title).toBe("New");
    expect(ranked[1].title).toBe("Old");
  });

  it("sorts by popularity score (P1: 只读 meta.popularity 契约字段)", () => {
    const results = [
      makeResult("Low", "https://low.com", "", { popularity: 10, stars: 9999 }),
      makeResult("High", "https://high.com", "", { popularity: 1000, stars: 5 }),
    ];
    const ranked = rankResults(results, "popular");
    // 引擎层只认 popularity——stars 是渠道专有字段,不再被猜
    expect(ranked[0].title).toBe("High");
    expect(ranked[1].title).toBe("Low");
  });

  it("no popularity → score 0 (不猜渠道专有字段)", () => {
    const results = [
      makeResult("NoMeta", "https://a.com", "", { stars: 1000 }),
      makeResult("Plain", "https://b.com"),
    ];
    const ranked = rankResults(results, "popular");
    // 两者 popularity 均为 0,保持原始顺序
    expect(ranked[0].title).toBe("NoMeta");
    expect(ranked[1].title).toBe("Plain");
  });

  it("re-assigns rank after sorting", () => {
    const results = [
      makeResult("B", "https://b.com"),
      makeResult("A", "https://a.com"),
    ];
    const ranked = rankResults(results, "relevance");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it("handles empty results", () => {
    expect(rankResults([], "relevance")).toEqual([]);
  });

  it("handles single result", () => {
    const results = [makeResult("Only", "https://only.com")];
    const ranked = rankResults(results, "latest");
    expect(ranked).toHaveLength(1);
  });
});

// ── cleanSummary ────────────────────────────────────────────────────────────

describe("cleanSummary", () => {
  it("strips HTML tags", () => {
    expect(cleanSummary("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML entities", () => {
    expect(cleanSummary("a &amp; b &lt; c")).toBe("a & b < c");
  });

  it("collapses whitespace", () => {
    expect(cleanSummary("hello    world\n\n\nnew")).toBe("hello world new");
  });

  it("truncates long summaries", () => {
    const long = "a".repeat(500);
    const cleaned = cleanSummary(long);
    expect(cleaned.length).toBeLessThanOrEqual(300);
    expect(cleaned.endsWith("...")).toBe(true);
  });

  it("handles empty string", () => {
    expect(cleanSummary("")).toBe("");
  });

  it("handles undefined", () => {
    expect(cleanSummary(undefined as unknown as string)).toBe("");
  });
});

// ── cleanResultSummaries ────────────────────────────────────────────────────

describe("cleanResultSummaries", () => {
  it("cleans all summaries in array", () => {
    const results = [
      makeResult("A", "https://a.com", "<p>summary A</p>"),
      makeResult("B", "https://b.com", "normal text"),
    ];
    const cleaned = cleanResultSummaries(results);
    expect(cleaned[0].summary).toBe("summary A");
    expect(cleaned[1].summary).toBe("normal text");
  });
});

// ── aggregateResults ────────────────────────────────────────────────────────

describe("aggregateResults", () => {
  it("runs full pipeline: clean → dedup → rank → truncate", () => {
    const results = [
      makeResult("A", "https://example.com/a", "<p>summary A</p>", { popularity: 10 }),
      makeResult("A2", "https://example.com/a/", "duplicate", { popularity: 10 }), // dup of A
      makeResult("B", "https://example.com/b", "summary B", { popularity: 100 }),
    ];
    const final = aggregateResults(results, "popular", 5);
    expect(final).toHaveLength(2); // deduped
    expect(final[0].title).toBe("B"); // higher popularity → rank 1
    expect(final[0].rank).toBe(1);
    expect(final[0].summary).toBe("summary B"); // cleaned
  });

  it("truncates to limit", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult(`Result${i}`, `https://example.com/${i}`),
    );
    const final = aggregateResults(results, "relevance", 3);
    expect(final).toHaveLength(3);
  });
});
