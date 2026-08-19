/**
 * GitHub — 仓库/代码/Issue/PR 搜索渠道。
 * 策略: cli — gh search(已认证, keyring)。
 */

import { BaseChannel } from "../../channel.js";
import { parseJsonArray, parseJsonObject } from "../../json-util.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

const TYPE_FIELDS: Record<string, string> = {
  repos: "fullName,description,stargazersCount,url,updatedAt,language,owner",
  code: "path,repository,url",
  issues: "title,url,state,createdAt,author,commentsCount,repository",
  prs: "title,url,state,createdAt,author,commentsCount,repository,isDraft",
};

export const spec = defineChannelSpec<{ query: string; limit: number; sort?: string; type?: string }>({
  name: "github",
  category: "dev",
  description: "GitHub——仓库/代码/Issue/PR 搜索(gh CLI,已认证)",
  intents: ["code", "docs"],
  contentTypes: ["repo", "code", "issue", "pr"],
  supports: {
    limit: true,
    page: false,
    sort: ["relevance", "latest"],
    timeRange: false,
    language: false,
    contentType: ["repo", "code", "issue", "pr"],
  },
  channelParams: {
    type: {
      type: "string",
      enum: ["repos", "code", "issues", "prs"],
      default: "repos",
      description: "搜索类型(默认 repos)",
    },
  },
  defaults: { limit: 10, sort: "relevance" },
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
        sort: req.sort,
        type: (req.channelParams?.type as string | undefined) ?? "repos",
      },
      warnings,
      errors,
    };
  },
});

export default class GithubChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;
  supportsContent = false;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];
    const type = String(params.type ?? "repos");
    const limit = (params.limit as number) ?? 10;
    const fields = TYPE_FIELDS[type] ?? TYPE_FIELDS.repos;
    const args = ["search", type, query, "--limit", String(limit), "--json", fields];
    if (params.sort === "latest" && type !== "code") {
      args.push("--sort", "updated", "--order", "desc");
    }
    return [{ strategy: "cli", cmd: "gh", cmdArgs: args, timeout: 30_000 }];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    const type = String(params.type ?? "repos");
    const list = parseJsonArray(raw) ?? [];
    const results: SearchResult[] = [];
    for (const item of list) {
      const it = (typeof item === "string" ? parseJsonObject(item) : item) as Record<string, unknown> | null;
      if (!it) continue;
      const r = type === "code" ? this._formatCode(it) : this._formatMeta(it, type);
      if (r) results.push(r);
    }
    return results;
  }

  private _formatCode(it: Record<string, unknown>): SearchResult | null {
    const path = String(it.path ?? "").trim();
    const repo = String((it.repository as Record<string, unknown> | undefined)?.nameWithOwner ?? "");
    if (!path) return null;
    return {
      title: path,
      snippet: repo,
      url: String(it.url ?? ""),
      source: { channel: this.name, backend: "cli" },
      meta: { type: "code", repo },
    };
  }

  private _formatMeta(it: Record<string, unknown>, type: string): SearchResult | null {
    const title = String(it.title ?? it.fullName ?? "").trim();
    if (!title) return null;
    const author = String(
      (it.author as Record<string, unknown> | undefined)?.login ?? "",
    );
    const repo = String(
      (it.repository as Record<string, unknown> | undefined)?.nameWithOwner ?? "",
    );
    const stars = Number(it.stargazersCount ?? 0);
    const comments = Number(it.commentsCount ?? 0);
    const created = String(it.createdAt ?? "");
    const updated = String(it.updatedAt ?? "");
    const language = String(it.language ?? "");
    const state = String(it.state ?? "");
    const parts: string[] = [];
    if (type === "repos") {
      if (language) parts.push(language);
      if (stars > 0) parts.push(`${stars}★`);
      if (author) parts.push(`by ${author}`);
      if (updated) parts.push(updated.slice(0, 10));
    } else {
      if (state) parts.push(state);
      if (repo) parts.push(repo);
      if (author) parts.push(`by ${author}`);
      if (comments > 0) parts.push(`${comments} 💬`);
      if (created) parts.push(created.slice(0, 10));
    }
    return {
      title,
      snippet: [String(it.description ?? "").trim(), parts.join(" | ")]
        .filter(Boolean)
        .join("\n"),
      url: String(it.url ?? ""),
      source: { channel: this.name, backend: "cli" },
      meta: { type, stars, language, author, repo, state, comments, created, updated },
    };
  }
}

export const plugin = defineChannelPlugin(spec, GithubChannel);
