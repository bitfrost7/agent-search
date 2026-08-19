/**
 * ArXiv channel — academic paper search.
 *
 * Uses the public arxiv API (no key required).
 * API docs: https://info.arxiv.org/help/api/
 *
 * 策略：api（fetch arxiv API，解析 Atom XML）。
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

export const spec = defineChannelSpec<{
  query: string;
  limit: number;
  sort?: string;
  order?: string;
}>({
  name: "arxiv",
  category: "academic",
  description: "arXiv——学术论文预印本搜索(免费,无需 API key)",
  intents: ["web", "docs"],
  contentTypes: ["article", "doc"],
  supports: {
    limit: true,
    page: false,
    sort: ["relevance", "latest"],
    timeRange: false,
    language: false,
    contentType: ["article", "doc"],
  },
  channelParams: {
    sort: {
      type: "string",
      enum: ["relevance", "latest"],
      default: "relevance",
      description: "排序方式(默认 relevance)",
    },
    order: {
      type: "string",
      enum: ["ascending", "descending"],
      default: "descending",
      description: "排序方向(默认 descending)",
    },
  },
  contentDescription: "通过 arXiv API 获取论文完整 abstract + 元数据(标题/作者/分类/DOI/PDF链接)",
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
        sort: req.channelParams?.sort as string | undefined,
        order: req.channelParams?.order as string | undefined,
      },
      warnings,
      errors,
    };
  },
});

/** Parse arxiv Atom XML response into SearchResult[] */
function parseArxivXml(raw: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(raw)) !== null) {
    if (results.length >= limit) break;
    const entry = entryMatch[1];

    const getTag = (tag: string): string => {
      const m = entry.match(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
      );
      return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
    };

    const title = getTag("title");
    const summary = getTag("summary");
    const id = getTag("id");
    // arxiv ID is the last part of the id URL, e.g. http://arxiv.org/abs/2501.12345
    const arxivId = id.split("/").pop() ?? "";
    const published = getTag("published");
    const authors =
      entry
        .match(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g)
        ?.map((a) => a.match(/<name>([^<]+)<\/name>/)?.[1] ?? "")
        .filter(Boolean)
        .slice(0, 5) ?? [];

    const url = id || `https://arxiv.org/abs/${arxivId}`;
    const snippet = summary.slice(0, 300) + (summary.length > 300 ? "..." : "");
    const titleLine =
      authors.length > 0 ? `${title} (${authors.join(", ")})` : title;

    results.push({
      title: titleLine,
      snippet,
      url,
      ref: arxivId,
      source: { channel: "arxiv", backend: "api" },
      meta: {
        arxivId,
        published,
        authors,
      },
    });
  }

  return results;
}

export default class ArxivChannel extends BaseChannel {
  supportsContent = true;
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  helpMsg = `Usage: agent-search arxiv <query> [args]

Search academic papers on arxiv.org (no API key required).

Args:
  -L, --limit <int>    Max results (default: 10)
      --sort <str>     Sort: relevance (default), lastUpdatedDate, submittedDate
      --order <str>    ascending or descending (default: descending)

Examples:
  agent-search arxiv "LLM agent memory retrieval"
  agent-search arxiv "Mendelian randomization" --limit 5 --sort lastUpdatedDate`;

  // 免费无配额 API:允许真实搜索兜底(4/7层失败时用 sentinel query 真实探测)
  healthProbe = {
    healthUrl:
      "http://export.arxiv.org/api/query?search_query=all:test&max_results=1",
    allowProbeSearch: true,
  };

  parseArgs(query: string, args: string[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      query: query && !query.startsWith("--") ? query : "",
      limit: 10,
      sort: "relevance",
      order: "descending",
    };
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      const next = (): string | undefined => {
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          const v = args[i + 1];
          i += 2;
          return v;
        }
        i += 1;
        return "";
      };
      if (a === "-L" || a === "--limit") {
        const v = next();
        if (v) params.limit = parseInt(v, 10) || 10;
      } else if (a === "--sort") {
        const v = next();
        if (v) params.sort = v;
      } else if (a === "--order") {
        const v = next();
        if (v) params.order = v;
      } else {
        i += 1;
      }
    }
    return params;
  }

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    const query = String(params.query ?? "").trim();
    if (!query) return [];

    const limit = params.limit as number;
    const sort = params.sort as string;
    const order = params.order as string;

    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=${sort}&sortOrder=${order}`;

    return [{ strategy: "api", url }];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const limit = params.limit as number;

    // Check for XML error response
    if (text.includes("<Error>") || text.trim().length === 0) {
      return [];
    }

    return parseArxivXml(text, limit);
  }

  /**
   * Fetch full abstract + metadata for a single arXiv paper.
   * Accepts URL (https://arxiv.org/abs/XXXX.XXXXX) or ref (arXiv ID string).
   */
  async content(url: string, _args: string[]): Promise<SearchResult[]> {
    // Extract arXiv ID from URL or use as-is (ref)
    const arxivId = url.match(/arxiv\.org\/abs\/([^\/\s?#]+)/)?.[1]?.replace(/v\d+$/, "") ?? url.replace(/v\d+$/, "");

    if (!arxivId) {
      return [{
        title: url,
        snippet: "not a valid arXiv URL or ref",
        source: { channel: this.name },
        url,
      }];
    }

    try {
      const { raw } = await this.adapter.execute([{
        strategy: "api",
        url: `http://export.arxiv.org/api/query?id_list=${arxivId}`,
        headers: { "User-Agent": "agent-search/1.0" },
      }]);

      const text = typeof raw === "string" ? raw : JSON.stringify(raw);

      // Parse the Atom XML response
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/;
      const entryMatch = text.match(entryRegex);
      if (!entryMatch) {
        return [{
          title: arxivId,
          snippet: "paper not found on arXiv",
          source: { channel: this.name },
          url: `https://arxiv.org/abs/${arxivId}`,
        }];
      }

      const entry = entryMatch[1];
      const getTag = (tag: string): string => {
        const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
      };

      const title = getTag("title");
      const summary = getTag("summary");
      const published = getTag("published");
      const updated = getTag("updated");

      // Extract authors
      const authors = entry.match(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g)
        ?.map((a: string) => a.match(/<name>([^<]+)<\/name>/)?.[1] ?? "")
        .filter(Boolean) ?? [];

      // Extract categories
      const categories = entry.match(/<category[^>]*term="([^"]+)"/g)
        ?.map((c: string) => c.match(/term="([^"]+)"/)?.[1] ?? "")
        .filter(Boolean) ?? [];

      // Extract DOI from link tags
      const doiMatch = entry.match(/<link[^>]*title="doi"[^>]*href="([^"]+)"/);
      const doiStr = doiMatch ? doiMatch[1] : "";

      const absUrl = `https://arxiv.org/abs/${arxivId}`;
      const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;

      const fullContent = [
        `Title: ${title}`,
        `Authors: ${authors.join(", ")}`,
        `Published: ${published}`,
        `Updated: ${updated}`,
        categories.length > 0 ? `Categories: ${categories.join(", ")}` : "",
        doiStr ? `DOI: ${doiStr}` : "",
        `URL: ${absUrl}`,
        `PDF: ${pdfUrl}`,
        "",
        "=== Abstract ===",
        summary,
      ].join("\n");

      return [{
        title: title,
        snippet: fullContent,
        url: absUrl,
        source: { channel: this.name, backend: "content/abstract" },
        meta: {
          arxivId,
          published,
          authors,
        },
      }];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{
        title: arxivId,
        snippet: `content fetch failed: ${msg}`,
        source: { channel: this.name },
        url: `https://arxiv.org/abs/${arxivId}`,
      }];
    }
  }
}

export const plugin = defineChannelPlugin(spec, ArxivChannel);
