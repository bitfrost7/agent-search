/**
 * V2EX search channel.
 *
 * Fetches topics from V2EX. The V2EX API doesn't support search,
 * so we fetch topic lists by tab (default: hot).
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

export const spec = defineChannelSpec<{ query: string; tab: string }>({
  name: "v2ex",
  category: "social",
  description: "V2EX——社区热门/最新主题(中文技术社区,经验向)",
  intents: ["social"],
  contentTypes: ["post"],
  supports: {
    limit: false,
    page: false,
    sort: ["latest", "popular"],
    timeRange: false,
    language: false,
    contentType: ["post"],
  },
  channelParams: {
    tab: {
      type: "string",
      enum: ["hot", "latest"],
      default: "hot",
      description: "主题页(默认 hot)",
    },
  },
  defaults: { limit: 20, sort: "popular" },
  requiresQuery: false,
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    const tab =
      (req.channelParams?.tab as string | undefined) ??
      (req.sort === "latest" ? "latest" : "hot");
    return {
      ok: errors.length === 0,
      params: { query: req.query, tab },
      warnings,
      errors,
    };
  },
});

interface V2exTopic {
  id: number;
  title: string;
  url: string;
  content: string;
  content_rendered: string;
  replies: number;
  member: {
    username: string;
  };
  node: {
    name: string;
    title: string;
  };
  created: number;
  last_modified: number;
  last_touched: number;
}

export default class V2exChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  supportsContent = true;

  helpMsg = `Usage: agent-search v2ex [query] [args]

Fetches topics from V2EX by tab. Query is optional and currently ignored
since the V2EX API only provides topic lists by tab (no search).

Args:
  --tab <str>   Topic tab: hot (default), latest, hot
                V2EX API endpoint: /api/topics/<tab>.json

Examples:
  agent-search v2ex
  agent-search v2ex --tab hot
  agent-search v2ex --tab latest`;

  /**
   * Fetch full topic content by url (https://www.v2ex.com/t/{id}) or ref (纯 topic id)。
   * V2EX API: /api/topics/show.json?id={id}
   */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    const idMatch = url.match(/v2ex\.com\/t\/(\d+)/) || url.match(/^(\d{3,})$/); // url 或纯 id ref
    if (!idMatch) {
      return [
        {
          title: url,
          snippet: "not a v2ex topic url/ref",
          source: { channel: this.name },
          ref: url,
        },
      ];
    }
    try {
      const { raw } = await this.adapter.execute([
        {
          strategy: "api",
          url: `https://www.v2ex.com/api/topics/show.json?id=${idMatch[1]}`,
        },
      ]);
      let data: unknown = raw;
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw);
        } catch {
          /* fall through */
        }
      }
      const list = Array.isArray(data) ? (data as V2exTopic[]) : [];
      if (list.length === 0) {
        return [
          {
            title: url,
            snippet: "topic not found",
            source: { channel: this.name },
            url,
          },
        ];
      }
      const t = list[0];
      const body = (t.content_rendered || t.content || "")
        .replace(/<[^>]+>/g, "") // strip HTML
        .replace(/\s+/g, " ")
        .trim();
      return [
        {
          title: t.title,
          snippet: body || "(no content)",
          url: t.url,
          source: { channel: this.name, backend: "content" },
          meta: {
            id: t.id,
            author: t.member?.username,
            node: t.node?.title,
            replies: t.replies,
            created: t.created,
            popularity: t.replies,
          },
        },
      ];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [
        {
          title: url,
          snippet: `fetch failed: ${msg}`,
          source: { channel: this.name },
          url,
        },
      ];
    }
  }

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const tab = String(params.tab ?? "hot");
    return [
      {
        strategy: "api",
        url: `https://www.v2ex.com/api/topics/${tab}.json`,
      },
    ];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    // Runner 返回的是字符串，需要先解析
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    if (!Array.isArray(data)) {
      return [];
    }

    const topics = data as V2exTopic[];
    return topics.map((t) => ({
      title: t.title,
      url: t.url,
      ref: String(t.id), // topic id:content 定位用
      snippet: this._formatSnippet(t),
      source: { channel: this.name, backend: String(_params.tab ?? "hot") },
      meta: {
        id: t.id,
        replies: t.replies,
        author: t.member?.username,
        node: t.node?.name,
        created: t.created,
        popularity: t.replies,
      },
    }));
  }

  private _formatSnippet(topic: V2exTopic): string {
    const content = (topic.content_rendered || topic.content || "")
      .replace(/<[^>]+>/g, "") // strip HTML tags
      .replace(/\s+/g, " ")
      .trim();
    const snippet =
      content.length > 200 ? content.slice(0, 200) + "..." : content;
    const parts = [
      `💬 ${topic.replies} replies`,
      `👤 ${topic.member?.username ?? ""}`,
      `📁 ${topic.node?.title ?? ""}`,
    ];
    if (snippet) {
      parts.unshift(snippet);
    }
    return parts.join(" | ");
  }
}

export const plugin = defineChannelPlugin(spec, V2exChannel);
