/**
 * 知乎 — 中文技术问答/专栏渠道。
 * 策略: browser_exec — 在浏览器页面上下文 fetch search_v3(自动带登录态与
 * x-zse-96 签名),返回 search_result 的 object 数组。
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonArray, parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const API = "https://www.zhihu.com/api/v4/search_v3";

export const spec = defineChannelSpec<{ query: string; limit: number }>({
  name: "zhihu",
  category: "tech qa",
  description: "知乎——中文技术问答/专栏(复用浏览器登录态)",
  intents: ["web", "docs"],
  contentTypes: ["post", "article"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
    contentType: ["post", "article"],
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

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** 从 search_v3 的 object 节点提取统一结果 */
function extractObject(obj: Record<string, unknown>): SearchResult | null {
  const type = String(obj.type ?? "");
  const id = String(obj.id ?? "");
  const rawTitle = String(
    (obj as Record<string, unknown>).title ??
      ((obj.question as Record<string, unknown> | undefined)?.title ?? ""),
  );
  const title = stripTags(rawTitle).trim();
  if (!title) return null;
  const excerpt = stripTags(String(obj.excerpt ?? obj.description ?? "")).trim();
  const author = String(
    (obj.author as Record<string, unknown> | undefined)?.name ?? "",
  );
  const votes = Number(obj.voteup_count ?? 0);
  const answers = Number(obj.answer_count ?? obj.follower_count ?? 0);
  const comments = Number(obj.comment_count ?? 0);
  const created = Number(obj.created_time ?? obj.created ?? 0);
  const dateStr = created ? new Date(created * 1000).toISOString().slice(0, 10) : "";

  let url = "";
  if (type === "article") {
    url = `https://zhuanlan.zhihu.com/p/${id}`;
  } else if (type === "question") {
    url = `https://www.zhihu.com/question/${id}`;
  } else if (type === "answer") {
    const qid = String((obj.question as Record<string, unknown> | undefined)?.id ?? "");
    url = qid ? `https://www.zhihu.com/question/${qid}/answer/${id}` : "";
  } else if (type === "zvideo") {
    url = `https://www.zhihu.com/zvideo/${id}`;
  }

  const parts: string[] = [];
  if (type) parts.push(type);
  if (author) parts.push(`by ${author}`);
  if (votes > 0) parts.push(`${votes} 👍`);
  if (answers > 0) parts.push(`${answers} answers`);
  if (comments > 0) parts.push(`${comments} 💬`);
  if (dateStr) parts.push(dateStr);

  return {
    title,
    snippet: [excerpt, parts.join(" | ")].filter(Boolean).join("\n"),
    url,
    source: { channel: "zhihu", backend: "browser_exec" },
    meta: { type, author, votes, answers, comments, date: dateStr },
  };
}

/** 在页面上下文执行的 JS: fetch search_v3,过滤 search_result,返回 object 数组 */
function buildJs(query: string, limit: number): string {
  const q = JSON.stringify(query);
  return `(async () => {
  const url = 'https://www.zhihu.com/api/v4/search_v3?t=general&q=' + encodeURIComponent(${q}) + '&correction=1&offset=0&limit=${limit}';
  let lastErr = '';
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': navigator.userAgent, Accept: 'application/json' } });
      const j = await r.json();
      if (j && Array.isArray(j.data)) {
        const objs = j.data.filter(d => d && d.type === 'search_result' && d.object).map(d => d.object);
        return JSON.stringify(objs);
      }
      if (j && j.error) return JSON.stringify({ __err: String(j.error.code) });
      lastErr = 'no data';
    } catch (e) { lastErr = String(e && e.message || e); }
    await new Promise(res => setTimeout(res, 600));
  }
  return JSON.stringify({ __err: lastErr });
})()`;
}

export default class ZhihuChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const limit = (params.limit as number) ?? 10;
    return [{
      strategy: "browser_exec",
      navigateUrl: `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
      waitSelector: "body",
      jsCode: buildJs(query, limit),
      timeout: 30_000,
    }];
  }

  formatResults(raw: unknown, _params: Record<string, unknown>): SearchResult[] {
    const obj = parseJsonObject(raw);
    if (obj && "__err" in obj) {
      const code = String(obj.__err);
      if (code === "101") {
        return [{
          title: "zhihu 需要登录",
          snippet:
            "知乎搜索需要登录态：请在 Chrome（opencli 浏览器）中登录 https://www.zhihu.com 后重试。",
          source: { channel: this.name },
        }];
      }
      return [{
        title: "zhihu 搜索失败",
        snippet: `知乎搜索失败：${code}`,
        source: { channel: this.name },
      }];
    }
    const list = parseJsonArray(raw) ?? [];
    const results: SearchResult[] = [];
    for (const item of list) {
      const r = extractObject(item as Record<string, unknown>);
      if (r) results.push(r);
    }
    return results;
  }
}

export const plugin = defineChannelPlugin(spec, ZhihuChannel);
