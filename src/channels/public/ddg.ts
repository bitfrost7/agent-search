/**
 * DuckDuckGo — 无 key 兜底搜索引擎渠道。
 * API: GET https://lite.duckduckgo.com/lite/?q= (HTML,本渠道解析)
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin } from "../../plugin.js";
import { defineWebEngineSpec } from "../../search/spec-builders.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://lite.duckduckgo.com/lite/";

export const spec = defineWebEngineSpec(
  "ddg",
  "DuckDuckGo——免费无 key,结果有限,兜底用",
  { language: true },
);

/** language → DDG Lite kl (region) 映射 */
const KL_MAP: Record<string, string> = {
  zh: "cn-zh",
  en: "us-en",
  ja: "jp-jp",
  ko: "kr-kr",
  de: "de-de",
  fr: "fr-fr",
  es: "es-es",
};

/** 解码常见 HTML 实体（title/snippet 清洗） */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) =>
      String.fromCharCode(parseInt(d, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

/** 解析 DDG Lite HTML:提取真实 URL(解开 //duckduckgo.com/l/?uddg= 跳转) */
function parseDdgHtml(raw: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const source: { channel: string; backend?: string } = {
    channel: "ddg",
    backend: "api",
  };
  const linkRegex =
    /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
  const snippetRegex =
    /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const links: string[] = [];
  const titles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(raw)) !== null) {
    const href = m[1];
    const title = m[2].trim();
    if (href && title && !href.startsWith("#")) {
      try {
        const u = new URL(href, "https://duckduckgo.com");
        const realUrl = u.searchParams.get("uddg");
        links.push(realUrl ? decodeURIComponent(realUrl) : href);
      } catch {
        links.push(href);
      }
      titles.push(title);
    }
  }
  const snippets: string[] = [];
  while ((m = snippetRegex.exec(raw)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  for (let i = 0; i < Math.min(links.length, limit); i++) {
    if (links[i].includes("reddit.com")) continue; // reddit 对查资料无意义且国内不可达
    results.push({
      title: decodeHtmlEntities(titles[i] || `result ${i + 1}`),
      snippet: decodeHtmlEntities(snippets[i] || ""),
      url: links[i] || "",
      source,
    });
  }
  return results;
}

export default class DdgChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    let url = `${API}?q=${encodeURIComponent(query)}`;
    const lang = String(params.language ?? "").toLowerCase();
    if (lang) {
      const kl = KL_MAP[lang] ?? lang;
      url += `&kl=${encodeURIComponent(kl)}`;
    }
    return [{ strategy: "api", url }];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return parseDdgHtml(text, (params.limit as number) ?? 5);
  }
}

export const plugin = defineChannelPlugin(spec, DdgChannel);
