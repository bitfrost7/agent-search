/**
 * ChannelSpec — capability declaration for each channel.
 *
 * A ChannelSpec declares:
 * - What intents and content types the channel supports
 * - What parameters it accepts (supports)
 * - Default values
 * - How to map a NormalizedSearchRequest to channel-specific params
 *
 * Specs do NOT execute searches. They only describe capabilities
 * and translate parameters.
 */

import type {
  NormalizedSearchRequest,
  UnifiedSearchRequest,
  SearchIntent,
  SearchSort,
  SearchTimeRange,
  SearchContentType,
  SearchWarning,
  SearchError,
} from "./types.js";

// ── ChannelSupports ────────────────────────────────────────────────────────

export interface ChannelSupports {
  limit?: boolean;
  page?: boolean;
  sort?: SearchSort[] | false;
  timeRange?: SearchTimeRange[] | false;
  language?: boolean;
  contentType?: SearchContentType[];
  scope?: string[];
}

// ── ChannelMappingResult ───────────────────────────────────────────────────

export interface ChannelMappingResult<TParams = Record<string, unknown>> {
  ok: boolean;
  params?: TParams;
  warnings: SearchWarning[];
  errors: SearchError[];
}

// ── ChannelParamSchema ─────────────────────────────────────────────────────

/**
 * 渠道专有参数声明(JSON Schema 子集)。
 * 渠道自己声明;框架统一校验、解析、渲染成文档(channels 内嵌 channelParams)。
 */
export interface ChannelParamSchema {
  type: "string" | "integer" | "number" | "boolean";
  /** 枚举值(与 type 对应) */
  enum?: Array<string | number>;
  default?: unknown;
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: boolean;
}

// ── ChannelSpec ────────────────────────────────────────────────────────────

export interface ChannelSpec<TParams = Record<string, unknown>> {
  /** Channel name — must match the BaseChannel.name */
  name: string;

  /** Category label, e.g. "public", "internal", "social/video" */
  category: string;

  /** 一句话描述(搜什么的/适合什么场景)——agent 渠道清单靠它做选择 */
  description: string;

  /** Intents this channel can serve */
  intents: SearchIntent[];

  /** Content types this channel can return */
  contentTypes: SearchContentType[];

  /** Parameter support declaration (公共参数) */
  supports: ChannelSupports;

  /** 渠道专有参数(JSON Schema 声明),由 channels 清单内嵌展示给 agent */
  channelParams?: Record<string, ChannelParamSchema>;

  /** Default values */
  defaults: {
    limit: number;
    sort?: SearchSort;
  };

  /**
   * 渠道是否需要 query(默认 true)。列表型渠道(如 v2ex 按 tab 取列表)
   * 设 false —— 允许空 query 搜索,引擎层不报 "query is required"。
   */
  requiresQuery?: boolean;

  /** Operation-specific exception, such as GitHub's repo file view mode. */
  allowsEmptyQuery?: (req: UnifiedSearchRequest) => boolean;

  /**
   * 内容获取(content)能力描述。
   * 若渠道 supportsContent = true，在此描述 content() 返回什么数据。
   * 渲染到帮助文档中，告知用户通过 agent_content 能拿到什么。
   */
  contentDescription?: string;

  /**
   * Map a normalized request to channel-specific params.
   * Must NOT throw — return errors[] for unresolvable issues.
   * Return warnings[] for ignored/downgraded params.
   */
  mapRequest(req: NormalizedSearchRequest): ChannelMappingResult<TParams>;
}

export type ChannelSpecResolver = (name: string) => ChannelSpec | undefined;

// ── Shared mapping utilities ───────────────────────────────────────────────

import { createSearchWarning, createSearchError } from "./errors.js";

/**
 * Check a request against a ChannelSupports declaration.
 * Returns warnings for unsupported params and errors for missing required params.
 */
export function validateRequestAgainstSupports(
  req: NormalizedSearchRequest,
  supports: ChannelSupports,
  channelName: string,
): { warnings: SearchWarning[]; errors: SearchError[] } {
  const warnings: SearchWarning[] = [];
  const errors: SearchError[] = [];

  // limit
  if (req.limit !== undefined && supports.limit === false) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support limit`,
        channelName,
        "limit",
      ),
    );
  }

  // page
  if (req.page > 1 && supports.page !== true) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support pagination`,
        channelName,
        "page",
      ),
    );
  }

  // sort — 仅校验用户显式传入的非默认值(默认 relevance 由引擎填充,不算用户参数)
  const sortExplicit = req.sortSpecified === true && req.sort !== "relevance";
  if (sortExplicit && supports.sort === false) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support sort`,
        channelName,
        "sort",
      ),
    );
  } else if (
    sortExplicit &&
    supports.sort &&
    !supports.sort.includes(req.sort)
  ) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support sort="${req.sort}"`,
        channelName,
        "sort",
      ),
    );
  }

  // timeRange — 仅校验用户显式传入的非默认值("all" 是引擎填充的默认,任何渠道都适用)
  const timeRangeExplicit =
    req.timeRangeSpecified === true && req.timeRange !== "all";
  if (timeRangeExplicit && supports.timeRange === false) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support timeRange`,
        channelName,
        "timeRange",
      ),
    );
  } else if (
    timeRangeExplicit &&
    supports.timeRange &&
    !supports.timeRange.includes(req.timeRange)
  ) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support timeRange="${req.timeRange}"`,
        channelName,
        "timeRange",
      ),
    );
  }

  // language
  if (req.language && supports.language !== true) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support language filter`,
        channelName,
        "language",
      ),
    );
  }

  // contentType
  if (
    req.contentType &&
    supports.contentType &&
    !supports.contentType.includes(req.contentType)
  ) {
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not support contentType="${req.contentType}"`,
        channelName,
        "contentType",
      ),
    );
  }

  return { warnings, errors };
}

/**
 * 校验渠道专有参数(按 spec.channelParams 的 JSON Schema)。
 * - 未知参数 → warning
 * - 类型不匹配 / 枚举外 / 必填缺失 → error
 * 返回清洗后的有效参数 + 默认值填充。
 */
export function validateChannelParams(
  input: Record<string, unknown> | undefined,
  schema: Record<string, ChannelParamSchema> | undefined,
  channelName: string,
): {
  valid: Record<string, unknown>;
  warnings: SearchWarning[];
  errors: SearchError[];
} {
  const warnings: SearchWarning[] = [];
  const errors: SearchError[] = [];
  if (!schema) {
    // 渠道无专有参数声明
    const keys = Object.keys(input ?? {});
    for (const k of keys) {
      warnings.push(
        createSearchWarning(
          "unsupported_param",
          `Channel "${channelName}" has no channelParams declared — "${k}" ignored`,
          channelName,
          k,
        ),
      );
    }
    return { valid: {}, warnings, errors };
  }

  const valid: Record<string, unknown> = {};
  const inputKeys = new Set(Object.keys(input ?? {}));

  for (const [name, ps] of Object.entries(schema)) {
    const raw = input?.[name];
    if (raw === undefined) {
      if (ps.required) {
        errors.push(
          createSearchError(
            "invalid_request",
            `Channel "${channelName}" requires channelParam "${name}"`,
            channelName,
          ),
        );
      } else if (ps.default !== undefined) {
        valid[name] = ps.default;
      }
      continue;
    }
    inputKeys.delete(name);

    // 类型检查
    let ok = true;
    if (ps.type === "integer") {
      ok = typeof raw === "number" && Number.isInteger(raw);
    } else {
      ok = typeof raw === ps.type;
    }
    if (!ok) {
      errors.push(
        createSearchError(
          "invalid_request",
          `Channel "${channelName}" channelParam "${name}" must be ${ps.type}, got ${typeof raw}`,
          channelName,
        ),
      );
      continue;
    }

    // 枚举检查
    if (ps.enum && !ps.enum.includes(raw as string | number)) {
      errors.push(
        createSearchError(
          "invalid_request",
          `Channel "${channelName}" channelParam "${name}" must be one of ${ps.enum.join(" | ")}, got "${raw}"`,
          channelName,
        ),
      );
      continue;
    }

    // 范围检查
    if (typeof raw === "number") {
      if (ps.minimum !== undefined && raw < ps.minimum) {
        errors.push(
          createSearchError(
            "invalid_request",
            `Channel "${channelName}" channelParam "${name}" must be >= ${ps.minimum}`,
            channelName,
          ),
        );
        continue;
      }
      if (ps.maximum !== undefined && raw > ps.maximum) {
        errors.push(
          createSearchError(
            "invalid_request",
            `Channel "${channelName}" channelParam "${name}" must be <= ${ps.maximum}`,
            channelName,
          ),
        );
        continue;
      }
    }

    // pattern 检查(仅 string)
    if (ps.type === "string" && ps.pattern && typeof raw === "string") {
      try {
        if (!new RegExp(ps.pattern).test(raw)) {
          errors.push(
            createSearchError(
              "invalid_request",
              `Channel "${channelName}" channelParam "${name}" must match ${ps.pattern}`,
              channelName,
            ),
          );
          continue;
        }
      } catch {
        /* 无效正则,跳过 */
      }
    }

    valid[name] = raw;
  }

  // 未知参数 → warning(带支持列表,agent 可一次自纠)
  for (const k of inputKeys) {
    const supported = Object.keys(schema).join(", ");
    warnings.push(
      createSearchWarning(
        "unsupported_param",
        `Channel "${channelName}" does not declare channelParam "${k}" — ignored. Supported channelParams: ${supported}`,
        channelName,
        k,
      ),
    );
  }

  return { valid, warnings, errors };
}

/**
 * 从 spec 渲染渠道使用文档(公共参数 + 专有参数 + 示例)。
 * CLI `agent-search <channel> --help` / channel_debug help 都用它。
 */
export function renderChannelHelp(spec: ChannelSpec): string {
  const lines: string[] = [];
  lines.push(`Channel: ${spec.name} — ${spec.description ?? ""}`);
  lines.push(
    `Category: ${spec.category} | intents: ${spec.intents.join(", ")} | contentTypes: ${spec.contentTypes.join(", ")}`,
  );
  lines.push("");
  lines.push("Usage: agent-search " + spec.name + " <query> [args]");
  lines.push("");
  lines.push("公共参数(所有渠道统一):");
  lines.push("  query          关键词(必填)");
  lines.push(`  limit          最大结果数(默认 ${spec.defaults?.limit ?? 5})`);
  if (spec.supports.sort !== false)
    lines.push(
      `  sort           ${(spec.supports.sort ?? ["relevance"]).join(" | ")}`,
    );
  if (spec.supports.timeRange !== false)
    lines.push(
      `  timeRange      ${(spec.supports.timeRange ?? ["all"]).join(" | ")}`,
    );
  if (spec.supports.language === true) lines.push("  language        语言过滤");
  lines.push("");

  const cp = Object.entries(spec.channelParams ?? {});
  if (cp.length > 0) {
    lines.push("渠道专有参数(channelParams):");
    for (const [name, ps] of cp) {
      const enumStr = ps.enum ? `(${ps.enum.join(" | ")})` : ps.type;
      const def = ps.default !== undefined ? `, 默认 ${ps.default}` : "";
      const req = ps.required ? ", 必填" : "";
      lines.push(
        `  ${name}          ${enumStr}${def}${req}${ps.description ? " — " + ps.description : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("示例:");
  const exampleParams = cp
    .filter(([, ps]) => ps.default !== undefined)
    .map(([n]) => n);
  lines.push(`  agent-search ${spec.name} "关键词"`);
  if (exampleParams.length > 0) {
    lines.push(
      `  agent-search ${spec.name} "关键词" --${exampleParams[0]} ${cp.find(([n]) => n === exampleParams[0])?.[1].default ?? ""}`,
    );
  }

  // content 能力描述
  if (spec.contentDescription) {
    lines.push("");
    lines.push("内容获取 (agent_content):");
    lines.push(`  ${spec.contentDescription}`);
  }

  return lines.join("\n");
}
