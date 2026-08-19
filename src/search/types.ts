/**
 * Unified search protocol — core type definitions.
 *
 * This is the agent-facing API. Agents only interact with these types.
 * Channel-specific types remain in src/types.ts and are internal.
 */

// ── Request ────────────────────────────────────────────────────────────────

export type SearchIntent =
  "web" | "code" | "video" | "social" | "internal" | "shopping" | "docs";

export type SearchSort = "relevance" | "latest" | "popular";

export type SearchTimeRange = "day" | "week" | "month" | "year" | "all";

export type SearchContentType =
  | "web_page"
  | "repo"
  | "code"
  | "issue"
  | "pr"
  | "video"
  | "user"
  | "post"
  | "product"
  | "doc"
  | "article";

/**
 * The request that agents send. All fields except `query` are optional.
 * The system normalizes this into a NormalizedSearchRequest internally.
 */
export interface UnifiedSearchRequest {
  query: string;
  /** 渠道选择:agent 自行指定,单次只搜一个渠道 */
  channels?: string[];
  /** 渠道专有参数(JSON Schema 由 spec.channelParams 声明,选渠道后查看) */
  channelParams?: Record<string, unknown>;
  limit?: number;
  page?: number;
  sort?: SearchSort;
  timeRange?: SearchTimeRange;
  language?: string;
  contentType?: SearchContentType;
  scope?: Record<string, unknown>;
}

/**
 * Internal normalized request — all fields resolved with defaults.
 * This is what the router and channel specs receive.
 */
export interface NormalizedSearchRequest {
  query: string;
  channels: string[]; // 单渠道(agent 显式指定)
  channelParams?: Record<string, unknown>;
  limit: number;
  page: number;
  sort: SearchSort;
  timeRange: SearchTimeRange;
  /** 用户是否显式传了 sort(normalize 填充的默认值不算)——validate 只对显式值报 unsupported_param */
  sortSpecified?: boolean;
  /** 用户是否显式传了 timeRange(同上) */
  timeRangeSpecified?: boolean;
  language?: string;
  contentType?: SearchContentType;
  scope?: Record<string, unknown>;
}

// ── Response ───────────────────────────────────────────────────────────────

export interface UnifiedSearchResponse {
  ok: boolean;
  query: string;
  channels: string[];
  count: number;
  results: UnifiedSearchResult[];
  warnings: SearchWarning[];
  errors: SearchError[];
  diagnostics?: SearchDiagnostics;
}

export interface UnifiedSearchResult {
  id: string;
  title: string;
  url?: string;
  /** 渠道内部 ID(如 bilibili 的 BV号、v2ex 的 topic id、youtube 的视频 id)——content 定位用,比 url 可靠 */
  ref?: string;
  summary: string;
  source: {
    channel: string;
    backend?: string;
  };
  rank: number;
  publishedAt?: string;
  author?: string;
  meta?: Record<string, unknown>;
  rawRef?: string;
}

// ── Warnings & Errors ──────────────────────────────────────────────────────

export interface SearchWarning {
  channel?: string;
  code: SearchWarningCode;
  message: string;
  field?: string;
}

export type SearchWarningCode =
  | "unsupported_param"
  | "param_degraded"
  | "partial_results"
  | "fallback_used"
  | "empty_channel";

export interface SearchError {
  channel?: string;
  code: SearchErrorCode;
  message: string;
}

export type SearchErrorCode =
  | "invalid_request"
  | "unknown_channel"
  | "unsupported_param"
  | "missing_required_param"
  | "backend_unavailable"
  | "auth_required"
  | "rate_limited"
  | "network_error"
  | "parse_failed"
  | "empty_results"
  | "channel_failed";

// ── Diagnostics ────────────────────────────────────────────────────────────

export interface SearchDiagnostics {
  durationMs?: number;
  channelsRequested?: string[];
  channelsSucceeded?: string[];
  channelsEmpty?: string[];
  channelsFailed?: string[];
  perChannel?: Record<string, ChannelDiagnostics>;
}

export interface ChannelDiagnostics {
  durationMs?: number;
  backend?: string;
  resultCount?: number;
  error?: string;
}

// ── Unified content response ───────────────────────────────────────────────

export interface UnifiedContentResponse {
  ok: boolean;
  channel: string;
  url: string;
  title: string;
  content: string;
  format: "markdown" | "text" | "json";
  meta?: Record<string, unknown>;
  error?: SearchError;
}
