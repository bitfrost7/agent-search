/**
 * Hacker News — 英文科技新闻/讨论渠道。
 * API: GET https://hn.algolia.com/api/v1/search (相关度) / /search_by_date (最新)
 * 免费无 key，无反爬。
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://hn.algolia.com/api/v1";

export const spec = defineChannelSpec<{ query: string; limit: number; sort?: string }>({
  name: "hn",
  category: "tech news",
  description: "Hacker News——英文科技新闻与讨论(免费 API,相关度/最新排序)",
  intents: ["web", "docs"],
  contentTypes: ["post"],
  supports: {
    limit: true,
    page: false,
    sort: ["relevance", "latest"],
    timeRange: false,
    language: false,
    contentType: ["post"],
  },
  defaults: { limit: 10, sort: "relevance" },
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    return {
      ok: errors.length === 0,
      params: { query: req.query, limit: req.limit, sort: req.sort },
      warnings,
      errors,
    };
  },
});

export default class HnChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const sort = params.sort === "latest" ? "search_by_date" : "search";
    const limit = (params.limit as number) ?? 10;
    const url = `${API}/${sort}?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
    return [{ strategy: "api", url }];
  }

  formatResults(raw: unknown, _params: Record<string, unknown>): SearchResult[] {
    const data = parseJsonObject(raw);
    const hits = Array.isArray(data?.hits) ? (data.hits as Record<string, unknown>[]) : [];
    return hits
      .filter((h) => String(h.title ?? "").trim())
      .map((h) => {
        const id = String(h.objectID ?? "");
        const storyUrl = String(h.story_url ?? h.url ?? "");
        const url = storyUrl || (id ? `https://news.ycombinator.com/item?id=${id}` : "");
        const points = Number(h.points ?? h.num_points ?? 0);
        const comments = Number(h.num_comments ?? 0);
        const author = String(h.author ?? "");
        const createdAt = String(h.created_at ?? "");
        const parts: string[] = [];
        if (points > 0) parts.push(`${points} pts`);
        if (comments > 0) parts.push(`${comments} comments`);
        if (author) parts.push(`by ${author}`);
        return {
          title: String(h.title ?? ""),
          snippet: parts.join(" | "),
          url,
          source: { channel: this.name, backend: "api" },
          meta: { points, comments, author, hnId: id, createdAt },
        };
      });
  }
}

export const plugin = defineChannelPlugin(spec, HnChannel);
