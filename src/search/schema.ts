/**
 * Search protocol schema — normalization, validation, defaults.
 *
 * Pure functions, no I/O. Unit-testable without any channel.
 */

import type {
  UnifiedSearchRequest,
  NormalizedSearchRequest,
  UnifiedSearchResponse,
  SearchSort,
  SearchTimeRange,
  SearchContentType,
  SearchWarning,
  SearchError,
} from "./types.js";
import type { ChannelSpecResolver } from "./channel-spec.js";

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 5;
export const DEFAULT_PAGE = 1;
export const DEFAULT_SORT: SearchSort = "relevance";
export const DEFAULT_TIME_RANGE: SearchTimeRange = "all";

export const VALID_SORTS: SearchSort[] = ["relevance", "latest", "popular"];

export const VALID_TIME_RANGES: SearchTimeRange[] = [
  "day",
  "week",
  "month",
  "year",
  "all",
];

export const VALID_CONTENT_TYPES: SearchContentType[] = [
  "web_page",
  "repo",
  "code",
  "issue",
  "pr",
  "video",
  "user",
  "post",
  "product",
  "doc",
  "article",
];

// ── Normalize ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw UnifiedSearchRequest into a fully-resolved
 * NormalizedSearchRequest with defaults applied.
 *
 * Returns warnings for any fields that were coerced or ignored.
 * Returns errors for invalid values that make the request unusable.
 */
export function normalizeSearchRequest(
  req: UnifiedSearchRequest,
  resolveSpec: ChannelSpecResolver,
): {
  normalized: NormalizedSearchRequest | null;
  warnings: SearchWarning[];
  errors: SearchError[];
} {
  const warnings: SearchWarning[] = [];
  const errors: SearchError[] = [];

  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return {
      normalized: null,
      warnings,
      errors: [
        { code: "invalid_request", message: "request must be an object" },
      ],
    };
  }
  const rawReq = req as unknown as Record<string, unknown>;
  if (rawReq.query !== undefined && typeof rawReq.query !== "string") {
    return {
      normalized: null,
      warnings,
      errors: [{ code: "invalid_request", message: "query must be a string" }],
    };
  }
  if (rawReq.channels !== undefined && !Array.isArray(rawReq.channels)) {
    return {
      normalized: null,
      warnings,
      errors: [
        {
          code: "invalid_request",
          message: "channels must be an array of strings",
        },
      ],
    };
  }
  if (
    Array.isArray(rawReq.channels) &&
    rawReq.channels.some((channel) => typeof channel !== "string")
  ) {
    return {
      normalized: null,
      warnings,
      errors: [
        {
          code: "invalid_request",
          message: "channels must contain only strings",
        },
      ],
    };
  }
  if (
    rawReq.channelParams !== undefined &&
    (typeof rawReq.channelParams !== "object" ||
      rawReq.channelParams === null ||
      Array.isArray(rawReq.channelParams))
  ) {
    return {
      normalized: null,
      warnings,
      errors: [
        { code: "invalid_request", message: "channelParams must be an object" },
      ],
    };
  }
  if (
    rawReq.scope !== undefined &&
    (typeof rawReq.scope !== "object" ||
      rawReq.scope === null ||
      Array.isArray(rawReq.scope))
  ) {
    return {
      normalized: null,
      warnings,
      errors: [{ code: "invalid_request", message: "scope must be an object" }],
    };
  }

  // ── query (required unless all channels are list-type) ──────────────────
  const query = (req.query ?? "").trim();
  // D5:列表型渠道(requiresQuery=false,如 v2ex 按 tab 取列表)允许空 query
  const channelsHint = (req.channels ?? [])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);
  const queryOptional =
    channelsHint.length > 0 &&
    channelsHint.every((channel) => {
      const spec = resolveSpec(channel);
      return (
        spec?.requiresQuery === false || spec?.allowsEmptyQuery?.(req) === true
      );
    });
  if (!query && !queryOptional) {
    errors.push({
      code: "invalid_request",
      message: "query is required and must be a non-empty string",
    });
    return { normalized: null, warnings, errors };
  }

  // ── channels(单渠道,必须显式指定) ─────────────────────────────────────
  let channels: string[] = [];
  if (req.channels && Array.isArray(req.channels)) {
    channels = req.channels
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter((c) => c.length > 0);
  }
  if (channels.length === 0) {
    errors.push({
      code: "invalid_request",
      message:
        "channels is required — 先调用 agent_channels 查看渠道清单,选择渠道后显式指定(单次单渠道)",
    });
    return { normalized: null, warnings, errors };
  } else if (channels.length > 1) {
    // A5:强制单渠道——不静默取第一个,直接报错(agent 需要多渠道时并行发起多个 tool_call)
    errors.push({
      code: "invalid_request",
      message: `channels 只接受单渠道,收到 ${channels.length} 个 (${channels.join(", ")});需要多渠道请并行发起多个搜索,每次一个渠道`,
    });
    return { normalized: null, warnings, errors };
  }

  // ── channelParams(渠道专有参数,由 spec 校验) ──────────────────────────
  const channelParams =
    req.channelParams &&
    typeof req.channelParams === "object" &&
    !Array.isArray(req.channelParams)
      ? req.channelParams
      : undefined;

  // ── limit ────────────────────────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  if (req.limit !== undefined) {
    if (
      typeof req.limit === "number" &&
      req.limit > 0 &&
      Number.isFinite(req.limit)
    ) {
      limit = Math.floor(req.limit);
    } else {
      warnings.push({
        code: "param_degraded",
        message: `invalid limit "${req.limit}", using default ${DEFAULT_LIMIT}`,
        field: "limit",
      });
    }
  }
  // Cap at 50 to prevent abuse
  if (limit > 50) {
    warnings.push({
      code: "param_degraded",
      message: `limit ${limit} exceeds max 50, capped to 50`,
      field: "limit",
    });
    limit = 50;
  }

  // ── page ─────────────────────────────────────────────────────────────
  let page = DEFAULT_PAGE;
  if (req.page !== undefined) {
    if (
      typeof req.page === "number" &&
      req.page >= 1 &&
      Number.isFinite(req.page)
    ) {
      page = Math.floor(req.page);
    } else {
      warnings.push({
        code: "param_degraded",
        message: `invalid page "${req.page}", using default ${DEFAULT_PAGE}`,
        field: "page",
      });
    }
  }

  // ── sort ─────────────────────────────────────────────────────────────
  let sort: SearchSort = DEFAULT_SORT;
  if (req.sort) {
    if (VALID_SORTS.includes(req.sort)) {
      sort = req.sort;
    } else {
      warnings.push({
        code: "param_degraded",
        message: `unknown sort "${req.sort}", using default "${DEFAULT_SORT}"`,
        field: "sort",
      });
    }
  }

  // ── timeRange ────────────────────────────────────────────────────────
  let timeRange: SearchTimeRange = DEFAULT_TIME_RANGE;
  if (req.timeRange) {
    if (VALID_TIME_RANGES.includes(req.timeRange)) {
      timeRange = req.timeRange;
    } else {
      warnings.push({
        code: "param_degraded",
        message: `unknown timeRange "${req.timeRange}", using default "${DEFAULT_TIME_RANGE}"`,
        field: "timeRange",
      });
    }
  }

  // ── language ─────────────────────────────────────────────────────────
  const language =
    typeof req.language === "string" && req.language.trim()
      ? req.language.trim()
      : undefined;

  // ── contentType ──────────────────────────────────────────────────────
  let contentType: SearchContentType | undefined;
  if (req.contentType) {
    if (VALID_CONTENT_TYPES.includes(req.contentType)) {
      contentType = req.contentType;
    } else {
      warnings.push({
        code: "param_degraded",
        message: `unknown contentType "${req.contentType}", ignoring`,
        field: "contentType",
      });
    }
  }

  // ── scope ────────────────────────────────────────────────────────────
  const scope =
    req.scope && typeof req.scope === "object" && !Array.isArray(req.scope)
      ? req.scope
      : undefined;

  const normalized: NormalizedSearchRequest = {
    query,
    channels,
    channelParams,
    limit,
    page,
    sort,
    timeRange,
    // 显式传参标记:validate 只对用户显式值报 unsupported_param(默认值填充不报)
    sortSpecified: req.sort !== undefined && req.sort !== null,
    timeRangeSpecified: req.timeRange !== undefined && req.timeRange !== null,
    language,
    contentType,
    scope,
  };

  return { normalized, warnings, errors };
}

// ── Result helpers ─────────────────────────────────────────────────────────

let _idCounter = 0;

/** 稳定 hash(FNV-1a 32bit,hex)——同输入同输出,不依赖调用次数。 */
function stableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Generate a deterministic ID for a search result.
 * D4:不再用模块级计数器——同 URL(或同 title 兜底)每次搜索结果 ID 一致,
 * 无副作用、可缓存。
 */
export function generateResultId(
  channel: string,
  url?: string,
  title?: string,
): string {
  // 确定性:id 只依赖输入。url 优先,无 url 用 title 兜底(仍确定性),两者皆无才回退计数器。
  if (url) return `${channel}_${stableHash(url)}`;
  if (title) return `${channel}_${stableHash(title)}`;
  _idCounter += 1;
  return `${channel}_no-url-${_idCounter}`;
}

/**
 * Check if a result title indicates a pseudo-error result
 * (legacy behavior from BaseChannel.search catch block).
 */
export function isPseudoErrorResult(title: string): boolean {
  return (
    title.endsWith("search failed") ||
    title.endsWith("(no results)") ||
    title.includes("search failed")
  );
}

// ── Response builder ───────────────────────────────────────────────────────

export function buildEmptyResponse(
  query: string,
  warnings: SearchWarning[],
  errors: SearchError[],
): UnifiedSearchResponse {
  return {
    ok: errors.length === 0,
    query,
    channels: [],
    count: 0,
    results: [],
    warnings,
    errors,
  };
}
