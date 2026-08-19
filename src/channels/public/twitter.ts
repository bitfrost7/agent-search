/**
 * Twitter/X search channel.
 *
 * 策略链：CLI (opencli twitter search) → BROWSER_EXEC fallback。
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";
import { run } from "../../runner.js";

export const spec = defineChannelSpec<{ query: string; limit: number }>({
  name: "twitter",
  category: "social",
  description: "X/Twitter——推文搜索",
  intents: ["social"],
  contentTypes: ["post"],
  supports: {
    limit: true,
    page: false,
    sort: ["latest", "popular"],
    timeRange: false,
    language: false,
    contentType: ["post"],
  },
  defaults: { limit: 15 },
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

export default class TwitterChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  supportsContent = true;

  helpMsg = `Usage: agent-search twitter <query> [args]

Search Twitter/X for tweets.

Args:
  -L, --limit <int>      Max results (default: 15)

Examples:
  agent-search twitter "AI agents"
  agent-search twitter "AI agents" --limit 3`;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "");
    const limit = params.limit as number;
    return [
      // Strategy 1: opencli twitter search（原生适配器）
      {
        strategy: "cli",
        cmd: "opencli",
        cmdArgs: [
          "twitter",
          "search",
          query,
          "--limit",
          String(limit),
          "--format",
          "json",
        ],
      },
      // Strategy 2: BROWSER_EXEC fallback
      {
        strategy: "browser_exec",
        navigateUrl: `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`,
        waitSelector: '[data-testid="tweetText"], article',
        jsCode: `
          const items = [...document.querySelectorAll('article')].slice(0, ${limit}).map(el => ({
            text: el.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "",
            author: el.querySelector('[data-testid="User-Name"] a')?.textContent?.trim() || "",
            url: el.querySelector('a[href*="/status/"]')?.href || "",
            likes: el.querySelector('[data-testid="like"] [aria-label]')?.getAttribute('aria-label') || "",
          })).filter(it => it.text);
          JSON.stringify(items);
        `,
      },
    ];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    let items: Record<string, unknown>[] = [];

    if (typeof raw === "string") {
      if (raw.includes("反馈成功") || raw.includes("success")) {
        return [];
      }
      try {
        // opencli 输出可能包含尾部提示文本，提取 JSON 部分
        const jsonStart = raw.indexOf("[");
        const jsonEnd = raw.lastIndexOf("]");
        const jsonStr =
          jsonStart >= 0 && jsonEnd > jsonStart
            ? raw.slice(jsonStart, jsonEnd + 1)
            : raw;
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        // JSON parse failed — return empty (don't stuff raw text into result)
        return [];
      }
    } else if (Array.isArray(raw)) {
      items = raw as Record<string, unknown>[];
    }

    if (items.length === 0) {
      return []; // Return empty, not "(no results)" pseudo-error
    }

    return items.map((item) => {
      const text = String(item.text ?? item.full_text ?? "Tweet");
      const author = String(
        item.author ?? item.username ?? item.screen_name ?? "",
      );
      const meta: string[] = [];
      if (author) meta.push(`@${author}`);
      if (item.likes) meta.push(`♥ ${item.likes}`);
      if (item.retweets) meta.push(`🔁 ${item.retweets}`);
      return {
        title: text.slice(0, 200),
        url: String(item.url ?? item.permalink ?? "") || undefined,
        snippet: meta.length > 0 ? `${text}\n${meta.join(" · ")}` : text,
        source: { channel: this.name, backend: "browser" },
        meta: {
          author,
          text,
          likes: item.likes,
          retweets: item.retweets,
          replies: item.replies,
          popularity: item.likes,
        },
      };
    });
  }

  /** Fetch full tweet thread by URL */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    // Try opencli thread reader first, fallback to web page reader
    const raw = await run({
      strategy: "cli",
      cmd: "opencli",
      cmdArgs: ["twitter", "thread", url, "--format", "json"],
    });
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    const jsonStr =
      jsonStart >= 0 && jsonEnd > jsonStart
        ? text.slice(jsonStart, jsonEnd + 1)
        : text;
    try {
      const tweets = JSON.parse(jsonStr);
      if (Array.isArray(tweets)) {
        return tweets.map((t: Record<string, unknown>) => ({
          title: String(t.text ?? "").slice(0, 200),
          snippet: String(t.text ?? ""),
          url: String(t.url ?? ""),
          source: { channel: this.name, backend: "content" },
          meta: {
            author:
              (t.author as Record<string, string> | undefined)?.name ??
              String(t.author ?? ""),
            likes: t.likes ?? t.favorite_count,
            retweets: t.retweets ?? t.retweet_count,
            popularity: t.likes ?? t.favorite_count,
          },
        }));
      }
    } catch {
      /* fall through */
    }
    return [
      {
        title: url,
        snippet: text,
        source: { channel: this.name, backend: "content" },
      },
    ];
  }
}

export const plugin = defineChannelPlugin(spec, TwitterChannel);
