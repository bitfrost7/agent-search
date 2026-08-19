/**
 * Bocha (博查) — 国内 agent 专用搜索渠道。
 *
 * 纯国内服务（open.bochaai.com），中文搜索质量好、返回干净结构化 JSON、
 * 无需代理直连。API: POST https://api.bochaai.com/v1/web-search
 *
 * 正文抓取：博查无独立正文 API，content() 走本地 fetch + 粗提取
 * （与 web 渠道的 fallback 相同）。
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest, ChannelError } from "../../types.js";
const BOCHA_API = "https://api.bochaai.com/v1/web-search";

export const spec = defineChannelSpec<{
  query: string;
  limit: number;
  freshness?: string;
}>({
  name: "bocha",
  category: "web search",
  description: "博查搜索——中文网页,国内直连,返回干净 JSON(中文首选)",
  intents: ["web", "docs"],
  contentTypes: ["web_page", "article"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: ["day", "week", "month", "year"],
    language: false,
  },
  channelParams: {
    freshness: {
      type: "string",
      enum: ["oneDay", "oneWeek", "oneMonth", "oneYear"],
      description: "时间过滤(默认不限)",
    },
  },
  defaults: { limit: 5 },
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    const freshness =
      (req.channelParams?.freshness as string | undefined) ||
      (req.timeRange &&
        (
          {
            day: "oneDay",
            week: "oneWeek",
            month: "oneMonth",
            year: "oneYear",
          } as Record<string, string>
        )[req.timeRange]) ||
      "";
    return {
      ok: errors.length === 0,
      params: {
        query: req.query,
        limit: req.limit,
        ...(freshness ? { freshness } : {}),
      },
      warnings,
      errors,
    };
  },
});

interface BochaWebPage {
  name?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
  siteName?: string;
  siteIcon?: string;
  datePublished?: string;
  cachedPageUrl?: string | null;
}

function bochaKey(): string {
  const key = process.env.BOCHA_API_KEY ?? "";
  if (key) return key;
  throw new Error("bocha backend requires BOCHA_API_KEY environment variable");
}

export default class BochaChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  helpMsg = `Usage: agent-search bocha <query> [args]

Bocha (博查) web search — 国内 agent 专用，中文质量好，返回干净 JSON。

Args:
  -L, --limit <int>      Max results (default: 5)
      --freshness <str>  Time filter: oneDay | oneWeek | oneMonth | oneYear | noLimit

Examples:
  agent-search bocha "arch linux 安装"
  agent-search bocha "vllm 部署" --limit 10`;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const limit = params.limit as number;
    const freshness = String(params.freshness ?? "");
    const body: Record<string, unknown> = { query, count: limit };
    if (freshness) body.freshness = freshness;
    return [
      {
        strategy: "api",
        url: BOCHA_API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bochaKey()}`,
        },
        body: JSON.stringify(body),
      },
    ];
  }

  /** F4:bocha 业务错误(code !== 200)结构化透出,不静默返回 [] */
  protected formatError(raw: unknown): ChannelError | null {
    const data = parseJsonObject(raw);
    if (data && data.code !== undefined && data.code !== 200) {
      const msg = data.message ? `: ${String(data.message)}` : "";
      return {
        code: "channel_failed",
        message: `bocha API error code=${String(data.code)}${msg}`,
        channel: this.name,
      };
    }
    return null;
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    const data = parseJsonObject(raw);
    if (!data) return [];

    const pages = (data.data as Record<string, unknown> | undefined)
      ?.webPages as Record<string, unknown> | undefined;
    const value = Array.isArray(pages?.value)
      ? (pages.value as BochaWebPage[])
      : [];
    if (value.length === 0) return [];

    return value.map((p) => ({
      title: String(p.name ?? "result"),
      snippet: String(p.snippet ?? ""),
      url: String(p.url ?? p.displayUrl ?? ""),
      source: { channel: this.name, backend: "web" },
      meta: {
        siteName: p.siteName || undefined,
        datePublished: p.datePublished || undefined,
        cachedPageUrl: p.cachedPageUrl || undefined,
      },
    }));
  }
}

export const plugin = defineChannelPlugin(spec, BochaChannel);
