/**
 * Serper — Google 结果包装渠道。
 * API: POST https://google.serper.dev/search (X-API-KEY)
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin } from "../../plugin.js";
import { defineWebEngineSpec } from "../../search/spec-builders.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://google.serper.dev/search";

export const spec = defineWebEngineSpec(
  "serper",
  "Serper——Google 搜索结果包装,英文为主(需 SERPER_API_KEY)",
  { language: true },
);

/** language → Google { hl, gl } 映射 */
const LANG_MAP: Record<string, { hl: string; gl: string }> = {
  zh: { hl: "zh-cn", gl: "cn" },
  en: { hl: "en", gl: "us" },
  ja: { hl: "ja", gl: "jp" },
  ko: { hl: "ko", gl: "kr" },
  de: { hl: "de", gl: "de" },
  fr: { hl: "fr", gl: "fr" },
  es: { hl: "es", gl: "es" },
  ru: { hl: "ru", gl: "ru" },
};

function apiKey(): string {
  const key = process.env.SERPER_API_KEY ?? "";
  if (!key)
    throw new Error(
      "serper channel requires SERPER_API_KEY environment variable",
    );
  return key;
}

export default class SerperChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const body: Record<string, unknown> = { q: query, num: params.limit ?? 5 };
    const lang = String(params.language ?? "").toLowerCase();
    if (lang) {
      const m = LANG_MAP[lang] ?? { hl: lang, gl: lang };
      body.hl = m.hl;
      body.gl = m.gl;
    }
    return [
      {
        strategy: "api",
        url: API,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey(),
        },
        body: JSON.stringify(body),
      },
    ];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    const data = parseJsonObject(raw);
    const items = Array.isArray(data?.organic)
      ? (data.organic as Record<string, unknown>[])
      : [];
    return items
      .filter((r) => !String(r.link ?? "").includes("reddit.com"))
      .map((r) => ({
        title: String(r.title ?? ""),
        snippet: String(r.snippet ?? ""),
        url: String(r.link ?? ""),
        source: { channel: this.name, backend: "api" },
      }));
  }
}

export const plugin = defineChannelPlugin(spec, SerperChannel);
