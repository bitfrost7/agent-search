/**
 * Jina — Jina Search 渠道。
 * API: GET https://s.jina.ai/?q={query} (Bearer JINA_API_KEY / JINA_READER_API_KEY)
 * 返回格式: Markdown 结果块（[N] Title: / [N] URL Source: / [N] Description:）
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin } from "../../plugin.js";
import { defineWebEngineSpec } from "../../search/spec-builders.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://s.jina.ai/";

export const spec = defineWebEngineSpec(
  "jina",
  "Jina——语义搜索(需 JINA_API_KEY)",
  { language: true },
);

function apiKey(): string {
  return process.env.JINA_API_KEY ?? process.env.JINA_READER_API_KEY ?? "";
}

/** 解析 Jina Search 的 Markdown 结果块 */
function parseJinaMarkdown(text: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = text.split(/\r?\n/);
  let current: Partial<SearchResult> | null = null;
  const titleRe = /^\[\d+\]\s+Title:\s*(.*)$/;
  const urlRe = /^\[\d+\]\s+URL Source:\s*(.*)$/;
  const descRe = /^\[\d+\]\s+Description:\s*(.*)$/;

  for (const line of lines) {
    const tm = line.match(titleRe);
    const um = line.match(urlRe);
    const dm = line.match(descRe);
    if (tm) {
      if (current?.title) {
        results.push(current as SearchResult);
        if (results.length >= limit) break;
      }
      current = { title: tm[1].trim() };
    } else if (um && current) {
      current.url = um[1].trim();
    } else if (dm && current) {
      current.snippet = dm[1].trim();
    }
  }
  if (current?.title && results.length < limit) {
    results.push(current as SearchResult);
  }

  return results
    .filter((r) => !String(r.url ?? "").includes("reddit.com"))
    .map((r) => ({
      ...r,
      snippet: r.snippet ?? "",
      url: r.url ?? "",
      source: { channel: "jina", backend: "api" },
    }));
}

export default class JinaChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  // s.jina.ai 对 HEAD 请求挂起(不实现),probeHttp 的 HEAD→GET 回退会在 4s 预算内耗尽;
  // 用真实搜索兜底确认可达
  healthProbe = {
    allowProbeSearch: true,
  };

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const key = apiKey();
    let url = `${API}?q=${encodeURIComponent(query)}`;
    const lang = String(params.language ?? "").toLowerCase();
    if (lang) url += `&lang=${encodeURIComponent(lang)}`;
    return [
      {
        strategy: "api",
        url,
        ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
      },
    ];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return parseJinaMarkdown(text, (params.limit as number) ?? 5);
  }
}

export const plugin = defineChannelPlugin(spec, JinaChannel);
