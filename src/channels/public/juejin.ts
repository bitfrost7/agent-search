/**
 * 掘金 — 中文技术文章渠道。
 * API: GET https://api.juejin.cn/search_api/v1/search?query=X&id_type=0&cursor=0&limit=N
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://api.juejin.cn/search_api/v1/search";

export const spec = defineChannelSpec<{ query: string; limit: number }>({
  name: "juejin",
  category: "tech community",
  description: "掘金——中文技术社区文章(质量高于 CSDN)",
  intents: ["web", "docs"],
  contentTypes: ["article", "doc"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
    contentType: ["article", "doc"],
  },
  defaults: { limit: 10 },
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    return {
      ok: errors.length === 0,
      params: { query: req.query, limit: req.limit },
      warnings,
      errors,
    };
  },
});

export default class JuejinChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const limit = (params.limit as number) ?? 10;
    const url = `${API}?query=${encodeURIComponent(query)}&id_type=0&cursor=0&limit=${limit}`;
    return [{ strategy: "api", url }];
  }

  formatResults(raw: unknown, _params: Record<string, unknown>): SearchResult[] {
    const data = parseJsonObject(raw);
    const list = Array.isArray(data?.data) ? (data.data as Record<string, unknown>[]) : [];
    const results: SearchResult[] = [];
    for (const entry of list) {
      const model = (entry.result_model ?? entry) as Record<string, unknown>;
      const info = (model.article_info ?? {}) as Record<string, unknown>;
      const title = String(info.title ?? "").trim();
      if (!title) continue;
      const id = String(info.article_id ?? model.article_id ?? "");
      const author = String(
        (model.author_user_info as Record<string, unknown> | undefined)?.user_name ?? "",
      );
      const tags = Array.isArray(model.tags)
        ? (model.tags as Record<string, unknown>[]).map((t) => String(t.tag_name ?? "")).filter(Boolean)
        : [];
      const views = Number(info.view_count ?? 0);
      const diggs = Number(info.digg_count ?? 0);
      const comments = Number(info.comment_count ?? 0);
      const ctime = Number(info.ctime ?? 0);
      const dateStr = ctime ? new Date(ctime * 1000).toISOString().slice(0, 10) : "";
      const parts: string[] = [];
      if (author) parts.push(`by ${author}`);
      if (views > 0) parts.push(`${views} views`);
      if (diggs > 0) parts.push(`${diggs} 👍`);
      if (comments > 0) parts.push(`${comments} 💬`);
      if (tags.length > 0) parts.push(`[${tags.join(", ")}]`);
      results.push({
        title,
        snippet: [String(info.brief_content ?? "").trim(), parts.join(" | ")]
          .filter(Boolean)
          .join("\n"),
        url: id ? `https://juejin.cn/post/${id}` : "",
        source: { channel: this.name, backend: "api" },
        meta: { author, tags, views, diggs, comments, date: dateStr },
      });
    }
    return results;
  }
}

export const plugin = defineChannelPlugin(spec, JuejinChannel);
