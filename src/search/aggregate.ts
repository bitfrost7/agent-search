/**
 * Aggregate — post-processing for search results.
 *
 * Implements:
 * 1. Deduplication (URL normalize, same title/URL merge)
 * 2. Ranking (relevance/latest/popular)
 * 3. Summary cleaning (strip HTML, length limit)
 */

import type { UnifiedSearchResult, SearchSort } from "./types.js";

// ── URL normalization ──────────────────────────────────────────────────────

/**
 * Normalize a URL for deduplication.
 * Strips trailing slashes, fragments, query params for tracking.
 */
export function normalizeUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    // Remove tracking query params
    const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source"];
    trackingParams.forEach((p) => u.searchParams.delete(p));
    // Normalize: no trailing slash, lowercase host
    let normalized = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
    if (u.search) normalized += u.search;
    return normalized;
  } catch {
    // Not a valid URL — return as-is for string comparison
    return url.trim().replace(/\/$/, "");
  }
}

// ── Deduplication ──────────────────────────────────────────────────────────

/**
 * Deduplicate results by normalized URL.
 * When duplicates are found, merge their sources (keep first occurrence).
 */
export function deduplicateResults(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
  const seen = new Map<string, UnifiedSearchResult>();
  const deduped: UnifiedSearchResult[] = [];

  for (const r of results) {
    const key = normalizeUrl(r.url) || r.title.toLowerCase().trim();

    if (seen.has(key)) {
      // Merge: if the existing result has fewer sources, add this one
      const existing = seen.get(key)!;
      // Keep the one with more meta or longer summary
      if (r.summary.length > existing.summary.length) {
        const idx = deduped.findIndex((d) => d === existing);
        deduped[idx] = { ...r, rank: existing.rank };
        seen.set(key, deduped[idx]);
      }
      // Skip duplicate
    } else {
      seen.set(key, r);
      deduped.push(r);
    }
  }

  return deduped;
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Sort results by the specified sort order.
 * - relevance: keep original order (already ranked by channels)
 * - latest: sort by publishedAt descending
 * - popular: sort by meta popularity signals descending
 */
export function rankResults(
  results: UnifiedSearchResult[],
  sort: SearchSort,
): UnifiedSearchResult[] {
  if (results.length <= 1) {
    return results.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  const sorted = [...results];

  if (sort === "latest") {
    sorted.sort((a, b) => {
      const aDate = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bDate = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bDate - aDate;
    });
  } else if (sort === "popular") {
    sorted.sort((a, b) => {
      const aScore = extractPopularityScore(a);
      const bScore = extractPopularityScore(b);
      return bScore - aScore;
    });
  }

  // Re-assign ranks (1-based, sequential)
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Extract a numeric popularity score from result meta.
 * P1:meta 契约字段 `popularity` 是引擎层排序唯一信号——
 * 渠道在 formatResults 里自行把 stars/play/replies 等折算为 popularity;
 * 引擎层不再猜各渠道的字段叫法。
 */
function extractPopularityScore(r: UnifiedSearchResult): number {
  if (!r.meta) return 0;
  const popularity = (r.meta as Record<string, unknown>).popularity;
  if (typeof popularity === "number") return popularity;
  if (typeof popularity === "string") {
    const num = parseInt(popularity.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(num)) return num;
  }
  return 0;
}

// ── Summary cleaning ───────────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 300;

/**
 * Clean a summary string:
 * - Strip HTML tags
 * - Collapse whitespace
 * - Truncate to max length
 */
export function cleanSummary(summary: string): string {
  if (!summary) return "";

  let cleaned = summary;

  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Truncate to max length
  if (cleaned.length > MAX_SUMMARY_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SUMMARY_LENGTH - 3) + "...";
  }

  return cleaned;
}

/**
 * Apply summary cleaning to all results.
 */
export function cleanResultSummaries(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
  return results.map((r) => ({
    ...r,
    summary: cleanSummary(r.summary),
  }));
}

// ── Full aggregation pipeline ──────────────────────────────────────────────

/**
 * Run the full post-processing pipeline on search results:
 * 1. Clean summaries
 * 2. Deduplicate
 * 3. Rank
 * 4. Re-assign sequential ranks
 * 5. Truncate to limit
 */
export function aggregateResults(
  results: UnifiedSearchResult[],
  sort: SearchSort,
  limit: number,
): UnifiedSearchResult[] {
  const cleaned = cleanResultSummaries(results);
  const deduped = deduplicateResults(cleaned);
  const ranked = rankResults(deduped, sort);
  // Always re-assign sequential ranks (1-based)
  const withRanks = ranked.map((r, i) => ({ ...r, rank: i + 1 }));
  return withRanks.slice(0, limit);
}
