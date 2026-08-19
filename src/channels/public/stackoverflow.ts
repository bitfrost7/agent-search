/**
 * Stack Overflow — 英文技术问答渠道。
 * API: GET https://api.stackexchange.com/2.3/search/advanced (免费, 300 次/天无 key)
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://api.stackexchange.com/2.3/search/advanced";

export const spec = defineChannelSpec<{ query: string; limit: number; sort?: string }>({
  name: "stackoverflow",
  category: "tech qa",
  description: "Stack Overflow——英文技术问答(免费 API, 300次/天)",
  intents: ["web", "docs"],
  contentTypes: ["post", "doc"],
  supports: {
    limit: true,
    page: false,
    sort: ["relevance", "latest"],
    timeRange: false,
    language: false,
    contentType: ["post", "doc"],
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

export default class StackoverflowChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const sort = params.sort === "latest" ? "creation" : "relevance";
    const limit = (params.limit as number) ?? 10;
    const url = `${API}?order=desc&sort=${sort}&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}`;
    return [{ strategy: "api", url }];
  }

  formatResults(raw: unknown, _params: Record<string, unknown>): SearchResult[] {
    const data = parseJsonObject(raw);
    const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];
    return items
      .filter((it) => String(it.title ?? "").trim())
      .map((it) => {
        const tags = Array.isArray(it.tags) ? (it.tags as unknown[]).map(String) : [];
        const score = Number(it.score ?? 0);
        const answers = Number(it.answer_count ?? 0);
        const views = Number(it.view_count ?? 0);
        const answered = it.is_answered === true;
        const created = Number(it.creation_date ?? 0);
        const createdStr = created
          ? new Date(created * 1000).toISOString().slice(0, 10)
          : "";
        const parts: string[] = [];
        if (answered) parts.push("✓answered");
        if (answers > 0) parts.push(`${answers} answers`);
        if (score !== 0) parts.push(`${score} score`);
        if (views > 0) parts.push(`${views} views`);
        if (tags.length > 0) parts.push(`[${tags.join(", ")}]`);
        if (createdStr) parts.push(createdStr);
        return {
          title: String(it.title ?? ""),
          snippet: parts.join(" | "),
          url: String(it.link ?? ""),
          source: { channel: this.name, backend: "api" },
          meta: { tags, score, answers, views, isAnswered: answered, created: createdStr },
        };
      });
  }
}

export const plugin = defineChannelPlugin(spec, StackoverflowChannel);
