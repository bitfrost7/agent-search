/**
 * Bilibili search channel.
 *
 * 策略链：
 *   search:  COOKIE_FETCH（B站搜索 API）→ CLI (opencli) → BROWSER_EXEC（DOM 抓取）
 *   content: CLI（bili --yaml --subtitle --ai）→ CLI（bili --json）→ opencli
 *
 * B站搜索 API /x/web-interface/search/all/v2 不走 wbi 签名，cookie_fetch 直接用 daemon cookie 即可。
 * content() 以 bili CLI 为主策略（~1s 响应），支持 --subtitle/--ai 等丰富参数。
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest, ChannelError } from "../../types.js";
import { run } from "../../runner.js";
import yaml from "js-yaml";

const BILIBILI_API_HOST = "api.bilibili.com";

/** 提取 BV 号：传入 BV 号或完整 URL，返回 BV 号 */
function extractBvid(input: string): string {
  const match = input.match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : input;
}

export const spec = defineChannelSpec<{
  query: string;
  limit: number;
  type: string;
}>({
  name: "bilibili",
  category: "social/video",
  description: "B站——视频和 UP 主搜索",
  intents: ["video", "social"],
  contentTypes: ["video", "user"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
    contentType: ["video", "user"],
  },
  channelParams: {
    type: {
      type: "string",
      enum: ["video", "user"],
      default: "video",
      description: "搜索类型(默认 video)",
    },
  },
  defaults: { limit: 10 },
  contentDescription:
    "通过 BV 号获取视频详情，自动包含基本信息、统计数据、AI 总结（如有）、字幕全文及时间轴（如有）。",
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    return {
      ok: errors.length === 0,
      params: {
        query: req.query,
        limit: req.limit,
        type:
          (req.channelParams?.type as string | undefined) ??
          (req.contentType === "user" ? "user" : "video"),
      },
      warnings,
      errors,
    };
  },
});

export default class BilibiliChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  supportsContent = true;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "");
    const limit = params.limit as number;
    const encoded = encodeURIComponent(query);
    return [
      // Strategy 1: COOKIE_FETCH — B站搜索 API（无需 wbi 签名）
      {
        strategy: "cookie_fetch",
        apiUrl: `https://${BILIBILI_API_HOST}/x/web-interface/search/all/v2?keyword=${encoded}&page=1&page_size=${limit}`,
        cookieDomain: BILIBILI_API_HOST,
        cookieRoot: ".bilibili.com",
      },
      // Strategy 2: CLI fallback — opencli bilibili search
      {
        strategy: "cli",
        cmd: "opencli",
        cmdArgs: [
          "bilibili",
          "search",
          query,
          "--limit",
          String(limit),
          "--type",
          String(params.type ?? "video"),
          "--format",
          "json",
        ],
      },
      // Strategy 3: BROWSER_EXEC fallback — DOM 抓取
      {
        strategy: "browser_exec",
        navigateUrl: `https://search.bilibili.com/all?keyword=${encoded}`,
        waitSelector: ".bili-video-card, .video-list, .search-content",
        jsCode: `
          const items = [...document.querySelectorAll('.bili-video-card')].slice(0, ${limit}).map(el => ({
            title: el.querySelector('.bili-video-card__info--tit, [class*=\"title\"] a, h3 a')?.textContent?.trim() || el.querySelector('a[title]')?.title || "",
            url: el.querySelector('a[href*=\"video\"]')?.href || el.querySelector('a')?.href || "",
            author: el.querySelector('[class*=\"up-name\"], [class*=\"author\"]')?.textContent?.trim() || "",
            play: el.querySelector('[class*=\"play\"], [class*=\"view\"], [class*=\"count\"]')?.textContent?.trim() || "",
          })).filter(it => it.title || it.url);
          JSON.stringify(items);
        `,
      },
    ];
  }

  protected formatError(raw: unknown): ChannelError | null {
    const data = parseJsonObject(raw);
    if (data && typeof data.code === "number" && data.code !== 0) {
      const msg = data.message ? `: ${String(data.message)}` : "";
      return {
        code: "channel_failed",
        message: `bilibili API error code=${data.code}${msg}`,
        channel: this.name,
      };
    }
    return null;
  }

  private _extractFromApiResponse(
    obj: Record<string, unknown>,
  ): Record<string, unknown>[] {
    if (obj.code === 0 && obj.data) {
      const data = obj.data as Record<string, unknown>;
      const results = data.result as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(results)) {
        const videoBlock = results.find((r) => r.result_type === "video");
        if (videoBlock && Array.isArray(videoBlock.data)) {
          return videoBlock.data as Record<string, unknown>[];
        }
      }
    }
    for (const key of ["data", "results", "items"]) {
      if (Array.isArray(obj[key])) {
        return obj[key] as Record<string, unknown>[];
      }
    }
    return [];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    let items: Record<string, unknown>[] = [];
    let sourceStrategy = "cookie_fetch";

    if (typeof raw === "string") {
      if (raw.includes("反馈成功") || raw.includes("success")) {
        return [];
      }
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          items = parsed;
          sourceStrategy = "browser_exec";
        } else if (parsed && typeof parsed === "object") {
          items = this._extractFromApiResponse(
            parsed as Record<string, unknown>,
          );
          sourceStrategy = items.length > 0 ? "cookie_fetch" : "cli";
        }
      } catch {
        const jsonStart = raw.indexOf("[");
        const jsonEnd = raw.lastIndexOf("]");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          try {
            const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
            if (Array.isArray(parsed)) {
              items = parsed;
              sourceStrategy = "browser_exec";
            }
          } catch {
            // not JSON
          }
        }
        if (items.length === 0) {
          sourceStrategy = "cli";
          return [];
        }
      }
    } else if (Array.isArray(raw)) {
      items = raw as Record<string, unknown>[];
      sourceStrategy = "browser_exec";
    } else if (raw && typeof raw === "object") {
      items = this._extractFromApiResponse(raw as Record<string, unknown>);
    }

    if (items.length === 0) {
      return [];
    }

    return items.map((item) => {
      const bvid = item.bvid as string | undefined;
      const rawUrl = String(item.url ?? item.link ?? item.arcurl ?? "");
      const url =
        rawUrl && rawUrl !== "" && rawUrl !== "null"
          ? rawUrl
          : bvid
            ? `https://www.bilibili.com/video/${bvid}/`
            : "";
      return {
        title: String(item.title ?? item.name ?? "Bilibili result").replace(
          /<[^>]+>/g,
          "",
        ),
        snippet: String(item.description ?? item.snippet ?? item.desc ?? ""),
        url,
        ref: bvid ?? rawUrl ?? undefined,
        source: { channel: this.name, backend: String(sourceStrategy) },
        meta: {
          author: item.author ?? item.owner,
          play: item.play,
          duration: item.duration,
          popularity: item.play,
        },
      };
    });
  }

  /** 通过 CLI 获取视频详情（含字幕、AI 总结等丰富数据） */
  private async _fetchVideoDetail(
    bvid: string,
  ): Promise<{
    video: Record<string, unknown>;
    subtitle: { available: boolean; text: string; items: unknown[] };
    aiSummary: string;
  } | null> {
    // 策略 1: bili CLI —yaml —subtitle —ai（最丰富）
    try {
      const raw = await run({
        strategy: "cli",
        cmd: "bili",
        cmdArgs: ["video", bvid, "--yaml", "--subtitle", "--ai"],
      });
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const yamlStart = text.search(/\n?ok:/);
      const yamlText = yamlStart >= 0 ? text.slice(yamlStart) : text;
      const parsed = yaml.load(yamlText) as Record<string, unknown> | undefined;
      const data = parsed?.data as Record<string, unknown> | undefined;
      const video = data?.video as Record<string, unknown> | undefined;
      if (video) {
        const subtitleRaw = data?.subtitle as Record<string, unknown> | undefined;
        return {
          video,
          subtitle: {
            available: (subtitleRaw?.available as boolean) ?? false,
            text: (subtitleRaw?.text as string) ?? "",
            items: (subtitleRaw?.items as unknown[]) ?? [],
          },
          aiSummary: (data?.ai_summary as string) ?? "",
        };
      }
    } catch {
      // fall through
    }

    // 策略 2: bili CLI —json（基本信息）
    try {
      const raw = await run({
        strategy: "cli",
        cmd: "bili",
        cmdArgs: ["video", bvid, "--json"],
      });
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      const jsonStr = jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const video = (parsed?.data as Record<string, unknown> | undefined)?.video as Record<string, unknown> | undefined;
      if (video) {
        return { video, subtitle: { available: false, text: "", items: [] }, aiSummary: "" };
      }
    } catch {
      // fall through
    }

    // 策略 3: opencli bilibili video —format yaml（最后兜底）
    try {
      const raw = await run({
        strategy: "cli",
        cmd: "opencli",
        cmdArgs: ["bilibili", "video", bvid, "--format", "yaml"],
      });
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const parsed = yaml.load(text) as Record<string, unknown> | undefined;
      const items = parsed?.data as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(items)) {
        const video: Record<string, unknown> = {};
        for (const item of items) {
          video[String(item.field)] = item.value;
        }
        if (video.bvid || video.title) {
          return { video, subtitle: { available: false, text: "", items: [] }, aiSummary: "" };
        }
      }
    } catch {
      // nothing
    }

    return null;
  }

  /** Fetch full video metadata by BV ID or URL */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    const bvid = extractBvid(url);
    const result = await this._fetchVideoDetail(bvid);

    if (!result) {
      return [
        {
          title: bvid,
          snippet: "无法获取视频信息",
          url,
          source: { channel: this.name, backend: "cli" },
        },
      ];
    }

    const { video, subtitle, aiSummary } = result;
    const snippet = this._formatVideoDetail(video, subtitle, aiSummary);
    const stats = video.stats as Record<string, unknown> | undefined;
    const owner = video.owner as Record<string, unknown> | undefined;

    return [
      {
        title: String(video.title ?? video.bvid ?? ""),
        snippet,
        url,
        ref: bvid,
        source: { channel: this.name, backend: "cli" },
        meta: {
          author: owner?.name,
          views: stats?.view,
          likes: stats?.like,
          favorites: stats?.favorite,
          duration: video.duration_seconds ?? video.duration,
          has_subtitle: subtitle.available,
          has_ai_summary: aiSummary ? aiSummary.length > 0 : false,
          popularity: stats?.view,
        },
      },
    ];
  }

  /** 将视频详情格式化为结构化的摘要文本 */
  private _formatVideoDetail(
    video: Record<string, unknown>,
    subtitle: { available: boolean; text: string; items: unknown[] },
    aiSummary: string,
  ): string {
    const lines: string[] = [];

    const duration = video.duration_seconds ?? video.duration;
    if (duration) {
      const dur = Number(duration);
      if (!isNaN(dur)) {
        const minutes = Math.floor(dur / 60);
        const seconds = dur % 60;
        lines.push(`时长: ${minutes}:${String(seconds).padStart(2, "0")}`);
      }
    }

    const stats = video.stats as Record<string, unknown> | undefined;
    if (stats) {
      const parts: string[] = [];
      if (stats.view !== undefined) parts.push(`播放: ${stats.view}`);
      if (stats.like !== undefined) parts.push(`点赞: ${stats.like}`);
      if (stats.favorite !== undefined) parts.push(`收藏: ${stats.favorite}`);
      if (stats.coin !== undefined) parts.push(`投币: ${stats.coin}`);
      if (stats.share !== undefined) parts.push(`分享: ${stats.share}`);
      if (stats.danmaku !== undefined) parts.push(`弹幕: ${stats.danmaku}`);
      if (stats.reply !== undefined) parts.push(`评论: ${stats.reply}`);
      if (parts.length > 0) lines.push(parts.join(" | "));
    }

    const owner = video.owner as Record<string, unknown> | undefined;
    if (owner?.name) {
      lines.push(`UP主: ${owner.name}`);
    }

    const flags: string[] = [];
    if (subtitle.available) flags.push("📝 有字幕");
    if (aiSummary) flags.push("🤖 有AI总结");
    if (flags.length > 0) lines.push(flags.join(" | "));

    const desc = (video.description as string) ?? "";
    if (desc) {
      lines.push("");
      lines.push("--- 视频简介 ---");
      lines.push(desc);
    }

    if (aiSummary) {
      lines.push("");
      lines.push("--- AI 总结 ---");
      lines.push(aiSummary);
    }

    if (subtitle.available && subtitle.items.length > 0) {
      lines.push("");
      lines.push(`--- 字幕预览（共 ${subtitle.items.length} 条） ---`);
      const preview = subtitle.items.slice(0, 20) as Array<Record<string, unknown>>;
      for (const item of preview) {
        const from = item.from as number | undefined;
        const content = item.content as string | undefined;
        if (from !== undefined && content) {
          const min = Math.floor(from / 60);
          const sec = Math.floor(from % 60);
          lines.push(`[${min}:${String(sec).padStart(2, "0")}] ${content}`);
        }
      }
      if (subtitle.items.length > 20) {
        lines.push(`... 还有 ${subtitle.items.length - 20} 条`);
      }
    }

    return lines.join("\n");
  }
}

export const plugin = defineChannelPlugin(spec, BilibiliChannel);