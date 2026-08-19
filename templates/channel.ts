/**
 * Channel template — copy this file to create a new channel.
 *
 * Usage:
 *   cp templates/channel.ts src/channels/public/<name>.ts
 *   Then replace all "TEMPLATE" / "template" with your channel name.
 */

import { BaseChannel } from "../../channel.js";
import type { SearchResult, RunRequest } from "../../types.js";
import { defineChannelSpec, defineChannelPlugin } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";

export const spec = defineChannelSpec({
  name: "template",
  category: "__CATEGORY__",
  description: "TODO: describe what this channel searches and when to use it",
  intents: ["web"],
  contentTypes: ["web_page"],
  supports: {
    limit: true,
    page: false,
    sort: false,
    timeRange: false,
    language: false,
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

export default class TemplateChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  // 不要覆写 parseArgs——基类默认实现已支持公共参数(--limit/--sort/--time-range/--language)
  // 及专有参数透传(--key value / --key=value,由 spec.channelParams 声明后框架统一校验)。
  // 见 docs/channel-development.md 规则 0c。

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "");
    const limit = params.limit as number;
    return [
      // Strategy 1: API (preferred)
      {
        strategy: "api",
        url: `https://api.example.com/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      },
      // Strategy 2: CLI fallback
      // {
      //   strategy: "cli",
      //   cmd: "example-cli",
      //   cmdArgs: ["search", query, "--limit", String(limit)],
      // },
    ];
  }

  formatResults(
    raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    // ── API JSON response ──────────────────────────────────────────────
    if (raw && typeof raw === "object") {
      const data = raw as Record<string, unknown>;
      const items = Array.isArray(data.items)
        ? (data.items as Record<string, unknown>[])
        : [];
      return items.map((item) => ({
        title: String(item.title ?? ""),
        snippet: String(item.description ?? item.snippet ?? ""),
        url: String(item.url ?? item.link ?? ""),
        source: { channel: this.name, backend: "api" },
        meta: { author: item.author },
      }));
    }

    // ── CLI text output ────────────────────────────────────────────────
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map((item: Record<string, unknown>) => ({
            title: String(item.title ?? ""),
            snippet: String(item.snippet ?? ""),
            url: String(item.url ?? ""),
            source: { channel: this.name, backend: "cli" },
          }));
        }
      } catch {
        // Not JSON — return empty, NOT a pseudo-error
      }
    }

    // ── Empty result — return [], NOT [{title: "no results"}] ──────────
    return [];
  }
}

export const plugin = defineChannelPlugin(spec, TemplateChannel);
