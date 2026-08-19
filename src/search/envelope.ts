/**
 * Envelope builder — construct UnifiedSearchResponse for MCP output.
 *
 * This is the JSON envelope that MCP returns to the agent.
 * Separated from CLI formatter (which produces human-readable text/markdown).
 */

import type {
  UnifiedContentResponse,
  SearchError,
} from "./types.js";
import type { SearchResult } from "../types.js";
import { adaptSingleResult } from "./result-adapter.js";

// ── Content response builder ───────────────────────────────────────────────

/**
 * Build a UnifiedContentResponse from legacy SearchResult[] (content fetch).
 */
export function buildContentResponse(
  channel: string,
  url: string,
  legacyResults: SearchResult[],
): UnifiedContentResponse {
  if (legacyResults.length === 0) {
    return {
      ok: false,
      channel,
      url,
      title: "",
      content: "",
      format: "text",
      error: {
        code: "empty_results",
        message: `No content returned for "${url}"`,
        channel,
      },
    };
  }

  // Use first result as the content
  const first = legacyResults[0];
  const adapted = adaptSingleResult(first, channel);

  // Detect if content is HTML/JSON/plain text
  let format: "markdown" | "text" | "json" = "text";
  const content = first.snippet;

  if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
    format = "json";
  } else if (content.includes("# ") || content.includes("## ") || content.includes("- [")) {
    format = "markdown";
  }

  return {
    ok: true,
    channel,
    url,
    title: adapted.title,
    content,
    format,
    meta: adapted.meta,
  };
}

// ── Error response builder ─────────────────────────────────────────────────

/**
 * Build a UnifiedContentResponse for a failed content fetch.
 */
export function buildContentErrorResponse(
  channel: string,
  url: string,
  error: SearchError,
): UnifiedContentResponse {
  return {
    ok: false,
    channel,
    url,
    title: "",
    content: "",
    format: "text",
    error,
  };
}
