/**
 * YouTube search channel.
 *
 * 策略链：CLI (yt-dlp) → API fallback (YouTube Data API v3, 仅当 YOUTUBE_API_KEY 存在)。
 *
 * yt-dlp 主策略使用 `ytsearchN:query --flat-playlist --print` 输出
 * 每行 `title|url|duration` 的精简格式；API 回退解析 items[].snippet。
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

export const spec = defineChannelSpec<{ query: string; limit: number }>({
  name: "youtube",
  category: "video",
  description: "YouTube——视频搜索(需 yt-dlp 或 YOUTUBE_API_KEY)",
  intents: ["video"],
  contentTypes: ["video"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
    contentType: ["video"],
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

export default class YoutubeChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  supportsContent = true;

  helpMsg = `Usage: agent-search youtube <query> [args]

Search YouTube videos using yt-dlp (with YouTube Data API fallback).

Args:
  -L, --limit <int>      Max results (default: 10)

Environment:
  YOUTUBE_API_KEY        If set, enables YouTube Data API v3 fallback.

Examples:
  agent-search youtube "python tutorial"
  agent-search youtube "大模型推理" --limit 5`;

  /**
   * Fetch video details (title/author/duration/description) via yt-dlp.
   */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    try {
      const { raw } = await this.adapter.execute([
        {
          strategy: "cli",
          cmd: "yt-dlp",
          cmdArgs: [
            url,
            "--skip-download",
            "--no-warnings",
            "--print",
            "%(title)s\n%(uploader)s\n%(duration_string)s\n%(view_count)s\n%(description)s",
          ],
        },
      ]);
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      const lines = text.split("\n");
      const [title, uploader, duration, views, ...descLines] = lines;
      const description = descLines.join("\n").trim();
      return [
        {
          title: title || url,
          snippet: description || "(no description)",
          url,
          source: { channel: this.name, backend: "content" },
          meta: {
            uploader: uploader || undefined,
            duration: duration || undefined,
            views: views || undefined,
            popularity: views
              ? parseInt(String(views).replace(/[^0-9]/g, ""), 10) || undefined
              : undefined,
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
    const query = String(params.query ?? "");
    const limit = params.limit as number;

    const requests: RunRequest[] = [
      // 主策略：yt-dlp CLI(F6:--print-json,标题含 | 不再解析错位)
      {
        strategy: "cli",
        cmd: "yt-dlp",
        cmdArgs: [
          `ytsearch${limit}:${query}`,
          "--flat-playlist",
          "--print-json",
        ],
      },
    ];

    // API 回退：仅当 YOUTUBE_API_KEY 存在时才加入
    if (process.env.YOUTUBE_API_KEY) {
      requests.push({
        strategy: "api",
        url: `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&maxResults=${limit}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`,
      });
    }

    return requests;
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    // ── API 输出：YouTube Data API JSON ───────────────────────────────────
    // runApi() 返回 resp.text()；可能是 JSON 字符串。先尝试 JSON.parse，
    // 若成功且含 items[] 则走 API 路径；否则按 yt-dlp 文本处理。
    let data: unknown = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null; // 非 JSON → 走下面的 yt-dlp 文本分支
      }
    }

    const obj = data as Record<string, unknown> | null;
    if (obj && Array.isArray(obj.items)) {
      const items = obj.items as Record<string, unknown>[];
      if (items.length === 0) {
        return []; // Return empty, not "(no results)" pseudo-error
      }
      return items.map((item) => {
        const snippet =
          (item.snippet as Record<string, unknown> | undefined) ?? {};
        const title = String(snippet.title ?? "YouTube video");
        const desc = String(snippet.description ?? "");
        const id = (item.id as Record<string, unknown> | undefined) ?? {};
        const videoId = String(id.videoId ?? "");
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
        return {
          title,
          url: url || undefined,
          snippet: desc.slice(0, 200),
          source: { channel: this.name, backend: "api" },
          meta: {
            channelId: snippet.channelId,
            channelTitle: snippet.channelTitle,
            publishedAt: snippet.publishedAt,
          },
        };
      });
    }

    // ── CLI 输出：yt-dlp --flat-playlist --print-json,每行一个 JSON 对象 ─────
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) {
        return []; // Return empty, not "(no results)" pseudo-error
      }

      const lines = text.split("\n").filter(Boolean);
      const results: SearchResult[] = [];
      for (const line of lines) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // 非 JSON 行(旧格式/警告)跳过
        }
        if (!obj || typeof obj.title !== "string") continue;
        const t = String(obj.title ?? "").trim();
        const u = String(obj.url ?? obj.webpage_url ?? "").trim();
        const d = obj.duration != null ? String(obj.duration) : "";
        if (!t && !u) continue;
        const snippetParts: string[] = [];
        if (u) snippetParts.push(u);
        if (d && d !== "NA") {
          const secs = parseInt(d, 10);
          if (!isNaN(secs)) {
            const mins = Math.floor(secs / 60);
            const rem = secs % 60;
            snippetParts.push(
              `Duration: ${mins}:${rem.toString().padStart(2, "0")}`,
            );
          } else {
            snippetParts.push(`Duration: ${d}`);
          }
        }
        results.push({
          title: t || "YouTube video",
          url: u || undefined,
          snippet: snippetParts.join(" | "),
          source: { channel: this.name, backend: "yt-dlp" },
          meta: d ? { duration: d } : undefined,
        });
      }
      if (results.length > 0) return results;

      return [];
    }

    return [];
  }
}

export const plugin = defineChannelPlugin(spec, YoutubeChannel);
