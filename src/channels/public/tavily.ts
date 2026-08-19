/**
 * Tavily — agent 优化搜索引擎渠道。
 * API: POST https://api.tavily.com/search (Bearer TAVILY_API_KEY)
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin } from "../../plugin.js";
import { defineWebEngineSpec } from "../../search/spec-builders.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://api.tavily.com/search";

export const spec = defineWebEngineSpec(
  "tavily",
  "Tavily——英文网页,agent 优化(需 TAVILY_API_KEY)",
);

function apiKey(): string {
  const key = process.env.TAVILY_API_KEY ?? "";
  if (!key)
    throw new Error(
      "tavily channel requires TAVILY_API_KEY environment variable",
    );
  return key;
}

export default class TavilyChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    return [
      {
        strategy: "api",
        url: API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({ query, max_results: params.limit ?? 5 }),
      },
    ];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    const data = parseJsonObject(raw);
    const items = Array.isArray(data?.results)
      ? (data.results as Record<string, unknown>[])
      : [];
    return items
      .filter((r) => !String(r.url ?? "").includes("reddit.com")) // reddit 对查资料无意义且国内不可达
      .map((r) => ({
        title: String(r.title ?? ""),
        snippet: String(r.content ?? ""),
        url: String(r.url ?? ""),
        source: { channel: this.name, backend: "api" },
      }));
  }
}

export const plugin = defineChannelPlugin(spec, TavilyChannel);
