/**
 * Result adapter — convert legacy SearchResult to UnifiedSearchResult.
 *
 * P1:错误已由 ChannelOutcome 结构化透出(见 types.ts/channel.ts),
 * 这里不再做任何"伪 result → error"的字符串猜测。
 */

import type { SearchResult } from "../types.js";
import type { UnifiedSearchResult, SearchError, SearchWarning } from "./types.js";
import { generateResultId } from "./schema.js";

// ── Conversion result ──────────────────────────────────────────────────────

export interface AdaptedResults {
  results: UnifiedSearchResult[];
  errors: SearchError[];
  warnings: SearchWarning[];
}

// ── Main adapter ───────────────────────────────────────────────────────────

/**
 * Convert SearchResult[] to UnifiedSearchResult[].
 * P1:source 已是结构化对象,不再做字符串 split。
 */
export function adaptSearchResults(
  legacyResults: SearchResult[],
): AdaptedResults {
  const results: UnifiedSearchResult[] = [];
  const errors: SearchError[] = [];
  const warnings: SearchWarning[] = [];

  for (const r of legacyResults) {
    const channel = r.source.channel;
    const backend = r.source.backend;
    const unified: UnifiedSearchResult = {
      id: generateResultId(channel, r.url, r.title),
      title: r.title,
      url: r.url,
      // P2:ref 只在渠道真正提供时保留——search-only 渠道(web 引擎)结果不带 ref,
      // 不诱导 agent 走 content 流程;search+content 渠道(github/bilibili/v2ex)用 ref 定位
      ref: r.ref,
      summary: r.snippet,
      source: { channel, backend },
      rank: 0, // rank assigned later by executor
      meta: r.meta,
    };
    results.push(unified);
  }

  return { results, errors, warnings };
}

// ── Single result adapter (for content) ────────────────────────────────────

/**
 * Convert a single legacy SearchResult to a UnifiedSearchResult.
 * Used by content fetching.
 */
export function adaptSingleResult(
  r: SearchResult,
  channel: string,
): UnifiedSearchResult {
  return {
    id: generateResultId(channel, r.url, r.title),
    title: r.title,
    url: r.url,
    ref: r.ref,
    summary: r.snippet,
    source: { channel },
    rank: 0,
    meta: r.meta,
  };
}
