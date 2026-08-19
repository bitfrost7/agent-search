/**
 * ArchWiki — Arch Linux 官方维基渠道。
 *
 * 搜索: MediaWiki API `list=search`(索引:title + snippet)
 * 正文: MediaWiki API `action=parse`(返回 wikitext,比 HTML 更利于 LLM 阅读)
 *
 * 无需 key,免费直连。ref 为页面 title(下划线形式),content 用它定位页面。
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://wiki.archlinux.org/api.php";
const UA = { "User-Agent": "agent-search/1.0 (+https://wiki.archlinux.org)" };

export const spec = defineChannelSpec<{
  query: string;
  limit: number;
  namespace?: number;
}>({
  name: "archwiki",
  category: "docs",
  description: "ArchWiki——Arch Linux 官方维基(安装/配置/排障/AUR 文档)",
  intents: ["docs", "web"],
  contentTypes: ["doc", "article"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
    contentType: ["doc", "article"],
  },
  channelParams: {
    namespace: {
      type: "integer",
      minimum: 0,
      default: 0,
      description: "MediaWiki 命名空间(默认 0=主命名空间;14=分类)",
    },
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
      params: {
        query: req.query,
        limit: req.limit,
        namespace: (req.channelParams?.namespace as number | undefined) ?? 0,
      },
      warnings,
      errors,
    };
  },
});

/** 解析 {{模板|参数1|参数2}} —— 平衡扫描,支持嵌套,返回模板名+参数数组 */
function parseTemplate(s: string): { name: string; args: string[] } | null {
  // s 以 "{{" 开头
  let depth = 0;
  let i = 2;
  let start = 2;
  const parts: string[] = [];
  while (i < s.length - 1) {
    if (s[i] === "{" && s[i + 1] === "{") {
      depth++;
      i += 2;
      continue;
    }
    if (s[i] === "}" && s[i + 1] === "}") {
      if (depth === 0) {
        parts.push(s.slice(start, i));
        const name = (parts[0] ?? "").trim();
        return { name: name.split(":")[0].trim(), args: parts.slice(1) };
      }
      depth--;
      i += 2;
      continue;
    }
    if (depth === 0 && s[i] === "|") {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    // 跳过 [[...]] 块(内部 | 是链接显示文本分隔,不切分模板参数)
    if (depth === 0 && s[i] === "[" && s[i + 1] === "[") {
      const close = s.indexOf("]]", i + 2);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return null;
}

/** 模板 → 可读文本(常用 ArchWiki 模板;未知模板取第一个参数) */
function renderTemplate(name: string, args: string[]): string {
  const n = name.toLowerCase();
  const first = args[0] ?? "";
  switch (n) {
    case "ic":
    case "bc":
      return "`" + first + "`";
    case "pkg":
    case "aur":
    case "grp":
    case "pkgver":
      return first;
    case "man":
      return args[args.length - 1] ?? first;
    case "app": {
      // {{App|名称|描述|url|包}} → "名称 — 描述(包)"
      const [title, desc, , pkg] = args;
      const parts = [title, desc].filter(Boolean);
      return parts.join(" — ") + (pkg ? `(${pkg})` : "");
    }
    case "related":
      return first; // 相关文章导航链接
    default:
      return first; // Note/Tip/Warning/维护模板等:保留第一个参数(主内容)
  }
}

/** 清理 wikitext 为可读文本(模板展开 + 去 wiki 链接/HTML 标签/引用标记) */
function cleanWikitext(raw: string, maxLen = 300): string {
  let t = raw;
  // 引用标记 <ref ...>...</ref>
  t = t.replace(/<ref[\s\S]*?<\/ref>/g, " ");
  t = t.replace(/<ref[^>]*\/>/g, " ");
  // 模板展开:{{...}} → 可读文本(循环从上次位置继续,防 O(n²) 退化为可控)
  let pos = 0;
  let guard = 0;
  while (guard++ < 5000) {
    const open = t.indexOf("{{", pos);
    if (open === -1) break;
    const parsed = parseTemplate(t.slice(open));
    if (!parsed) {
      pos = open + 2;
      continue;
    }
    const rendered = renderTemplate(parsed.name, parsed.args);
    // 找到模板结束位置:{{...}} 的长度
    let end = open + 2;
    let depth = 0;
    while (end < t.length - 1) {
      if (t[end] === "{" && t[end + 1] === "{") {
        depth++;
        end += 2;
        continue;
      }
      if (t[end] === "}" && t[end + 1] === "}") {
        if (depth === 0) {
          end += 2;
          break;
        }
        depth--;
        end += 2;
        continue;
      }
      end++;
    }
    t = t.slice(0, open) + rendered + t.slice(end);
    pos = Math.max(0, open - 2);
  }
  // 分类/文件链接与跨语言链接: [[Category:xxx]] [[de:xxx]]
  t = t.replace(/\[\[(?:Category|File|Image):[^\]]*\]\]/gi, " ");
  t = t.replace(/\[\[[a-z]{2,6}(?:-[a-z]{2,6})?:[^\]]*\]\]/gi, " ");
  // 带显示文本的链接: [[target|text]] → text
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1");
  // 纯链接: [[target]] → target
  t = t.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // 外链: [url text] → text;[url] → 空
  t = t.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1");
  t = t.replace(/\[https?:\/\/[^\]]*\]/g, " ");
  // HTML 标签(如 <span class="searchmatch">)
  t = t.replace(/<[^>]+>/g, "");
  // 压缩空白
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).trimEnd() + "…";
  return t;
}

/** 从 url 或 ref(title) 提取页面标题(统一为空格分隔,供 MediaWiki API 使用) */
function extractTitle(input: string): string | null {
  const urlMatch = input.match(/wiki\.archlinux\.org\/title\/([^?#]+)/);
  const raw = urlMatch ? decodeURIComponent(urlMatch[1]) : input;
  if (!raw || raw.length > 300 || /[<>{}|[\]]/.test(raw)) return null;
  return raw.replace(/_/g, " ");
}

export default class ArchwikiChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  supportsContent = true;

  helpMsg = `Usage: agent-search archwiki <query> [args]

Arch Linux 官方维基搜索(MediaWiki API,免费无 key)。

Args:
  -L, --limit <int>      Max results (default: 10)
      --namespace <int>  MediaWiki 命名空间(默认 0=主命名空间;14=分类)

Examples:
  agent-search archwiki "wayland"
  agent-search archwiki "intitle:firewall secure"
  agent-search archwiki "pacman tips" --limit 20`;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    // 健康检查探测:空 query 时用探测词,让 doctor/agent_channels 能测到真实可达性
    // (正常搜索路径由引擎层 requiresQuery 拦截空 query,不会走到这里)
    const query = (String(params.query ?? "").trim() || "arch linux").trim();
    if (!query) return [];
    const limit = Math.min((params.limit as number) ?? 10, 50);
    const ns = (params.namespace as number | undefined) ?? 0;
    const url =
      `${API}?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&srlimit=${limit}&srnamespace=${ns}&srprop=snippet&srfilterredir=nonredirects&format=json&formatversion=2`;
    return [{ strategy: "api", url, headers: UA }];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    let data: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return [];
      }
    } else if (raw && typeof raw === "object") {
      data = raw as Record<string, unknown>;
    }
    const q = data?.query as Record<string, unknown> | undefined;
    const hits =
      (q?.search as Array<Record<string, unknown>> | undefined) ?? [];
    const limit = (params.limit as number) ?? 10;

    const results: SearchResult[] = [];
    for (const h of hits.slice(0, limit)) {
      const title = String(h.title ?? "");
      if (!title) continue;
      results.push({
        title,
        url: `https://wiki.archlinux.org/title/${title.replace(/ /g, "_")}`,
        ref: title.replace(/ /g, "_"),
        snippet:
          cleanWikitext(String(h.snippet ?? ""), 300) || "(ArchWiki page)",
        source: { channel: this.name, backend: "api" },
        meta: {
          ...(typeof h.size === "number" ? { size: h.size } : {}),
          ...(typeof h.wordcount === "number"
            ? { wordcount: h.wordcount }
            : {}),
          ...(typeof h.timestamp === "string" ? { updated: h.timestamp } : {}),
        },
      });
    }
    return results;
  }

  /** 抓页面正文:接受完整 url 或 ref(title,下划线分隔) */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    const title = extractTitle(url);
    if (!title) {
      return [
        {
          title: url,
          snippet: "not an archwiki page url/ref",
          source: { channel: this.name },
          ref: url,
        },
      ];
    }
    try {
      const { raw } = await this.adapter.execute([
        {
          strategy: "api",
          url: `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2&redirects=1`,
          headers: UA,
        },
      ]);
      let data: Record<string, unknown> | null = null;
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw);
        } catch {
          /* fall through */
        }
      } else if (raw && typeof raw === "object") {
        data = raw as Record<string, unknown>;
      }
      const wikitext = (data?.parse as Record<string, unknown> | undefined)
        ?.wikitext;
      if (typeof wikitext !== "string") {
        const err = data?.error as Record<string, unknown> | undefined;
        const msg = err
          ? String(err.info ?? "page not found")
          : "page not found or parse failed";
        return [
          {
            title: title.replace(/ /g, "_"),
            snippet: msg,
            source: { channel: this.name },
            url,
          },
        ];
      }
      return [
        {
          title: title,
          snippet: cleanWikitext(wikitext, 50000),
          url: `https://wiki.archlinux.org/title/${title.replace(/ /g, "_")}`,
          source: { channel: this.name, backend: "content/wikitext" },
        },
      ];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [
        {
          title: title.replace(/ /g, "_"),
          snippet: `content fetch failed: ${msg}`,
          source: { channel: this.name },
          url,
        },
      ];
    }
  }
}

export const plugin = defineChannelPlugin(spec, ArchwikiChannel);
