/**
 * OpenAlex channel — academic paper & author search.
 *
 * Uses the public OpenAlex REST API (no key required, polite pool).
 * API docs: https://docs.openalex.org/
 *
 * 策略：api（fetch OpenAlex API，解析 JSON）。
 */

import { BaseChannel } from "../../channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../plugin.js";
import { validateRequestAgainstSupports } from "../../search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../types.js";

export const spec = defineChannelSpec<{
  query: string;
  limit: number;
  sort?: string;
  type?: string;
}>({
  name: "openalex",
  category: "academic",
  description: "OpenAlex——学术论文、作者和机构搜索(免费,无需 API key)",
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
      enum: ["relevance"],
      default: "relevance",
      description: "排序方式(默认 relevance)",
    },
    type: {
      type: "string",
      enum: ["works", "authors", "concepts", "institutions"],
      default: "works",
      description: "搜索类型(默认 works)",
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
        sort: req.channelParams?.sort as string | undefined,
        type: req.channelParams?.type as string | undefined,
      },
      warnings,
      errors,
    };
  },
});

/** Reconstruct abstract from OpenAlex inverted index */
function reconstructAbstract(ai: Record<string, number[]> | undefined): string {
  if (!ai) return "";
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(ai)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map((w) => w[1]).join(" ");
}

export default class OpenalexChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  helpMsg = `Usage: agent-search openalex <query> [args]

Search academic papers, authors, and more on OpenAlex (no API key required).

Args:
  -L, --limit <int>    Max results (default: 10)
      --sort <str>     Sort: relevance (default), cited_by_count, publication_date
      --type <str>     Filter: works (default), authors, venues, institutions
      --year <int>     Filter by publication year

Examples:
  agent-search openalex "LLM agent memory retrieval"
  agent-search openalex "Mendelian randomization" --limit 5 --year 2025`;

  // 免费无配额 API:允许真实搜索兜底(4/7层失败时用 sentinel query 真实探测)
  healthProbe = {
    healthUrl: "https://api.openalex.org/works?search=test&per_page=1",
    allowProbeSearch: true,
  };

  parseArgs(query: string, args: string[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      query: query && !query.startsWith("--") ? query : "",
      limit: 10,
      sort: "relevance",
      type: "works",
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
      } else if (a === "--type") {
        const v = next();
        if (v) params.type = v;
      } else if (a === "--year") {
        const v = next();
        if (v) params.year = parseInt(v, 10);
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
    const type = (params.type as string) ?? "works";
    const year = params.year as number | undefined;

    // title_and_abstract.search 限定标题+摘要范围，避免全文匹配噪声
    // （search= 全文检索时被引量高的手册类文档会占据相关度前列）
    let url = `https://api.openalex.org/${type}?filter=title_and_abstract.search:${encodeURIComponent(query)}&per_page=${limit}`;

    // OpenAlex sort: relevance_score:desc, cited_by_count:desc, publication_date:desc
    if (sort && sort !== "relevance") {
      const sortMap: Record<string, string> = {
        cited_by_count: "cited_by_count:desc",
        publication_date: "publication_date:desc",
        latest: "publication_date:desc",
      };
      const mapped = sortMap[sort] ?? sort;
      url += `&sort=${mapped}`;
    }
    if (year) {
      url += `&filter=publication_year:${year}`;
    }

    // Polite pool: add mailto for better rate limits
    const headers: Record<string, string> = {
      "User-Agent": "mailto:agent-search@localhost",
    };

    return [{ strategy: "api", url, headers }];
  }

  formatResults(raw: unknown, params: Record<string, unknown>): SearchResult[] {
    // runApi auto-parses JSON if content-type is application/json
    const data = raw as Record<string, unknown>;
    const results = Array.isArray(data.results)
      ? (data.results as Record<string, unknown>[])
      : [];

    return results.map((r) => {
      const title = String(r.title ?? r.display_name ?? "");
      const doi = r.doi ? `DOI: ${r.doi}` : "";
      const year = r.publication_date
        ? String(r.publication_date).slice(0, 4)
        : "";
      const cited = r.cited_by_count ? `cited by ${r.cited_by_count}` : "";
      const venue = (r.primary_location as Record<string, unknown> | undefined)
        ?.source as Record<string, unknown> | undefined;
      const venueName = venue?.display_name ? `${venue.display_name}` : "";

      // Abstract reconstruction
      const abstract = reconstructAbstract(
        r.abstract_inverted_index as Record<string, number[]> | undefined,
      );

      const snippet = [year, venueName, cited, abstract.slice(0, 200)]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 500);

      const url = String(r.doi ?? r.id ?? "");

      return {
        title: `${title}${doi ? ` (${doi})` : ""}`,
        snippet,
        url,
        source: { channel: "openalex", backend: "api" },
        meta: {
          publicationDate: r.publication_date,
          citedByCount: r.cited_by_count,
          type: r.type,
          openAccess: r.open_access,
        },
      };
    });
  }
}

export const plugin = defineChannelPlugin(spec, OpenalexChannel);
