/**
 * MCP tool handlers — extracted for testability.
 *
 * These functions implement the actual tool logic without the stdin/stdout
 * loop, so they can be unit-tested directly.
 */

import { unifiedSearch } from "./execute.js";
import type { UnifiedSearchRequest } from "./types.js";
import type { ChannelExecutor } from "./router.js";
import type { ChannelSpecResolver } from "./channel-spec.js";

// ── Tool schemas for tools/list ────────────────────────────────────────────

export const TOOL_SCHEMAS = {
  search: {
    name: "search",
    description: [
      "统一搜索:公共参数 + channelParams(渠道专有参数,键值对)。",
      "流程: 1) 先调 channels 看渠道清单(每渠道含完整参数说明 channelParams + 默认值 + 健康状态) 2) 选渠道,按该渠道支持的参数传 channelParams 3) 搜索后用 content 按需抓正文。",
      "公共参数: query(必填) / limit / sort / timeRange / language / contentType / channels(必填,单渠道) / channelParams(渠道专有,见 channels 返回的 channelParams 说明)。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词(必填)。以 http:// 开头直接读页面。",
        },
        channels: {
          type: "array",
          items: { type: "string" },
          description:
            "渠道名(必填,单次只搜一个渠道)。先看 channels 清单选择。需要多渠道时并行发起多个搜索。",
        },
        channelParams: {
          type: "object",
          description:
            "渠道专有参数(键值对,每个渠道支持的参数见 channels 返回的 channelParams 字段)。如 bilibili: {type: 'user'}",
        },
        limit: { type: "integer", default: 5, description: "最大结果数" },
        sort: {
          type: "string",
          enum: ["relevance", "latest", "popular"],
          description: "排序方式",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year", "all"],
          description: "时间范围",
        },
        language: { type: "string", description: "语言过滤，如 zh/en/ja（仅 serper/ddg/jina 支持）" },
        contentType: {
          type: "string",
          description:
            "内容类型: web_page/repo/code/issue/pr/video/user/post/product/doc/article",
        },
      },
      required: ["query", "channels"],
    },
  },
  content: {
    name: "content",
    description:
      "获取搜索结果的完整内容(第三层)。refs 传 search 结果里的 ref 字段(渠道内部 ID,数组一次抓多个);或兼容传 url(单条)。路由到该渠道自己的 content 实现。",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "渠道名" },
        refs: {
          type: "array",
          items: { type: "string" },
          description:
            "search 结果里的 ref 字段(渠道内部 ID),如 bilibili 的 BV号 / v2ex 的 topic id / youtube 的视频 id。一次可传多个。",
        },
        url: { type: "string", description: "(兼容)完整 url,单条" },
      },
      required: ["channel"],
    },
  },
  channels: {
    name: "channels",
    description:
      "列出所有渠道及完整能力(第一层):每渠道描述、supportsContent、完整参数说明(channelParams schema + 默认值)、health。直接据此选择渠道并传参,无需再查其他工具。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  channel_debug: {
    name: "channel_debug",
    description: "底层渠道排障：查看 help/health/spec。开发和调试用。",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "渠道名" },
        action: {
          type: "string",
          enum: ["help", "health", "spec"],
          description: "help=查看用法, health=健康检查, spec=查看能力声明",
        },
      },
      required: ["channel", "action"],
    },
  },
} as const;

// ── Handler functions ──────────────────────────────────────────────────────

/**
 * Handle search tool call.
 */
export async function handleSearch(
  args: UnifiedSearchRequest,
  executor: ChannelExecutor,
  resolveSpec: ChannelSpecResolver,
): Promise<string> {
  const resp = await unifiedSearch(args, executor, resolveSpec);
  return JSON.stringify(resp, null, 2);
}

/**
 * Handle content tool call.
 * Takes a function to fetch content from a channel.
 * getCapability 可选:调用方提供渠道能力表,supportsContent=false 的 search-only 渠道
 * 在入口处直接返回结构化错误(事前声明),不事后撞墙。
 *
 * A7:单条(url)与批量(refs)统一返回 { ok, channel, refs, items, errors }——
 * agent 只需一套解析,不再有单条/批量两套结构。
 */
export async function handleContent(
  args: { channel: string; url?: string; refs?: string[] },
  getContent: (
    channel: string,
    refOrUrl: string,
  ) => Promise<import("../types.js").SearchResult[]>,
  getCapability?: (
    channel: string,
  ) => { supportsContent?: boolean } | undefined,
): Promise<string> {
  const { channel } = args;
  if (typeof channel !== "string" || !channel.trim()) {
    return JSON.stringify({ ok: false, error: "channel is required" });
  }
  if (
    args.refs !== undefined &&
    (!Array.isArray(args.refs) ||
      args.refs.some((ref) => typeof ref !== "string"))
  ) {
    return JSON.stringify({
      ok: false,
      channel,
      error: "refs must be an array of strings",
    });
  }
  if (args.url !== undefined && typeof args.url !== "string") {
    return JSON.stringify({
      ok: false,
      channel,
      error: "url must be a string",
    });
  }

  // P2:search-only 渠道无 content 能力——入口处事前声明,不调用渠道
  const capability = getCapability?.(channel);
  if (capability && capability.supportsContent === false) {
    return JSON.stringify({
      ok: false,
      channel,
      error: {
        code: "unsupported_operation",
        message: `Channel "${channel}" is search-only — 搜索即交付物,结果摘要即为正文;不支持 content 抓取`,
      },
    });
  }

  // refs 数组优先(批量);url 兼容(单条)。两者都没有 → 报错提示
  const targets: string[] = args.refs?.length
    ? args.refs
    : args.url
      ? [args.url]
      : [];
  if (targets.length === 0) {
    return JSON.stringify({
      ok: false,
      channel,
      error: "refs(数组)或 url 至少提供一个;refs 取自 search 结果的 ref 字段",
    });
  }

  try {
    // 单条/批量统一:并发逐条取,个别失败不拖累整体
    const settled = await Promise.all(
      targets.map(async (ref) => {
        try {
          const results = await getContent(channel, ref);
          const first = results[0];
          return first
            ? {
                ref,
                title: first.title,
                content: first.snippet,
                format: detectContentFormat(first.snippet),
                url: first.url,
                meta: first.meta,
              }
            : {
                ref,
                title: "",
                content: "",
                format: "text",
                error: {
                  code: "empty_results",
                  message: `No content returned for ref "${ref}"`,
                },
              };
        } catch (err) {
          return {
            ref,
            error: {
              code: "ref_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );
    const items = settled.filter((s) => !s.error);
    const errors = settled.filter((s) => s.error);
    return JSON.stringify(
      {
        ok: errors.length < targets.length,
        channel,
        refs: targets,
        items,
        errors,
      },
      null,
      2,
    );
  } catch (err) {
    return JSON.stringify({
      ok: false,
      channel,
      error: {
        code: "channel_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/** 检测正文格式:JSON / Markdown / 纯文本(A7 统一单条与批量用)。 */
function detectContentFormat(content: string): "markdown" | "text" | "json" {
  if (!content) return "text";
  if (content.trim().startsWith("{") || content.trim().startsWith("["))
    return "json";
  if (
    content.includes("# ") ||
    content.includes("## ") ||
    content.includes("- [")
  )
    return "markdown";
  return "text";
}

/**
 * Handle channels tool call.
 * 第一层:渠道清单,每渠道含完整参数说明(channelParams schema + 默认值)。
 * agent 一次调用即可拿到选渠道 + 传参所需的全部信息。
 */
export async function handleChannels(
  getChannelList: () => {
    name: string;
    category: string;
    helpMsg?: string;
    supportsContent?: boolean;
  }[],
  getHealth: (name: string) => Promise<{ status: string; reason: string }>,
  resolveSpec: ChannelSpecResolver,
): Promise<string> {
  const selected = getChannelList()
    .map((ch) => {
      const spec = resolveSpec(ch.name);
      if (!spec) {
        throw new Error(`registered channel "${ch.name}" has no spec`);
      }
      return { ch, spec };
    });
  const channels = await Promise.all(
    selected.map(async ({ ch, spec }) => {
      let health: { status: string; reason: string };
      try {
        health = await getHealth(ch.name);
      } catch {
        health = { status: "error", reason: "health check failed" };
      }
      return {
        name: ch.name,
        category: ch.category,
        description: spec.description,
        supportsContent: ch.supportsContent ?? false,
        intents: spec.intents,
        contentTypes: spec.contentTypes,
        supports: spec.supports,
        // 完整专有参数说明(参数名/类型/枚举/默认值/描述)——直接可据此传 channelParams
        channelParams: spec.channelParams ?? {},
        defaults: spec.defaults,
        health,
      };
    }),
  );
  return JSON.stringify(
    { channels },
    null,
    2,
  );
}

export function createCachedHealthChecker<
  T extends { status: string; reason: string },
>(
  check: (name: string) => Promise<T>,
  ttlMs = 30_000,
): (name: string) => Promise<T> {
  const cache = new Map<string, { expiresAt: number; value: Promise<T> }>();
  return async (name) => {
    const now = Date.now();
    const cached = cache.get(name);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = check(name).catch((error) => {
      cache.delete(name);
      throw error;
    });
    cache.set(name, { expiresAt: now + ttlMs, value });
    return value;
  };
}

/**
 * Handle channel_debug tool call.
 */
export async function handleChannelDebug(
  args: { channel: string; action: string },
  getChannel: (name: string) => { help: () => string } | undefined,
  getHealth: (name: string) => Promise<unknown>,
  resolveSpec: ChannelSpecResolver,
): Promise<string> {
  const { channel, action } = args;
  const ch = getChannel(channel);
  if (!ch) return JSON.stringify({ error: `unknown channel: ${channel}` });

  switch (action) {
    case "help":
      return ch.help();
    case "health": {
      const h = await getHealth(channel);
      return JSON.stringify(h, null, 2);
    }
    case "spec": {
      const spec = resolveSpec(channel);
      if (!spec)
        return JSON.stringify({ error: `no spec for channel: ${channel}` });
      return JSON.stringify(spec, null, 2);
    }
    default:
      return JSON.stringify({ error: `unknown action: ${action}` });
  }
}
