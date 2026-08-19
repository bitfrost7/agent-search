/**
 * BaseChannel — abstract base for all search channels.
 *
 * Channel contract (both required for every channel):
 *   1. search(query)  → SearchResult[] — index only: title + url + short snippet
 *   2. content(url)   → SearchResult[] — fetch full content for a result url
 *
 * The two-step flow is the agent pattern: search returns an index, content
 * is fetched lazily on demand. Channels MUST implement content(); if a channel
 * genuinely cannot (e.g. anti-scraping), set supportsContent = false so the
 * UI can route content fetches elsewhere.
 *
 * Execution is delegated to Adapter → Runner.
 */

import type {
  SearchResult,
  RunRequest,
  Adapter,
  HealthStatus,
  BackendHealth,
  HealthState,
  HealthProbeConfig,
  ChannelOutcome,
  ChannelError,
  ChannelWarning,
} from "./types.js";
import { defaultAdapter } from "./adapter.js";
import { checkStrategy } from "./runner.js";
import { renderChannelHelp, type ChannelSpec } from "./search/channel-spec.js";

export abstract class BaseChannel {
  abstract name: string;
  abstract category: string;
  helpMsg?: string;
  channelSpec?: ChannelSpec;

  /**
   * Whether this channel implements content(url).
   * Default false — channels that can fetch full content set this to true.
   * Tooling (channels tool) exposes this so callers know where they can
   * fetch content without guessing.
   */
  supportsContent = false;

  /**
   * 渠道自声明的健康探测配置(可选):healthUrl / allowProbeSearch。
   * 核心标准统一由 BaseChannel.health() 执行,渠道通过声明定制。
   */
  healthProbe?: HealthProbeConfig;


  /** Default adapter — channels can override with a custom one. */
  adapter: Adapter = defaultAdapter;

  help(): string {
    if (this.channelSpec) return renderChannelHelp(this.channelSpec);
    return this.helpMsg ?? `Usage: agent-search ${this.name} <query> [args]`;
  }

  /** Main entry: parse args → build requests → execute → format. */
  async search(query: string, args: string[]): Promise<SearchResult[]> {
    const params = this.parseArgs(query, args);
    const outcome = await this.searchWithParams(params);
    // 兼容入口:错误不再产伪 result,统一返回 [] (结构化错误由 ChannelOutcome 透出)
    return outcome.ok ? outcome.results : [];
  }

  /**
   * Execute a search with pre-built params (bypasses CLI arg parsing).
   *
   * 这是统一管道调用的入口:router 通过 ChannelSpec 把 NormalizedSearchRequest
   * 映射为渠道参数,直接流入 buildRequests——不走 CLI 参数往返。
   *
   * P1:返回 ChannelOutcome(可辨识联合)——成功带 results,失败带结构化 error。
   * 不再把错误塞进 title("xxx search failed" 伪 result),适配层不做字符串猜测。
   */
  async searchWithParams(
    params: Record<string, unknown>,
  ): Promise<ChannelOutcome> {
    const requests = this.buildRequests(params);

    if (requests.length === 0) {
      return {
        ok: false,
        error: {
          code: "no_request",
          message: `${this.name}: no request built`,
          channel: this.name,
        },
      };
    }

    try {
      const { raw, fallbackUsed, failures } =
        await this.adapter.execute(requests);
      // F4:响应级错误(如 API code !== 200)由渠道 formatError 声明——错误结构化透出,
      // 不再静默返回 [] 导致 ok=false 但 errors=[]
      const formatErr = this.formatError?.(raw, params);
      if (formatErr) return { ok: false, error: formatErr };
      // E7:主策略失败命中 fallback 时给出诊断(转 fallback_used warning)
      const warnings: ChannelWarning[] = [];
      if (fallbackUsed && failures && failures.length > 0) {
        warnings.push({
          code: "fallback_used",
          message: `${this.name}: 主策略失败,已用 fallback(失败原因: ${failures[0]})`,
          channel: this.name,
        });
      }
      // 搜=索引:snippet 清理统一由引擎层 aggregate.cleanSummary 负责(D1——
      // 渠道层不再重复做 HTML 剥离/截断,单一实现、单一阈值)
      const results = this.formatResults(raw, params);
      return { ok: true, results, warnings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "channel_failed",
          message: `${this.name}: ${msg}`,
          channel: this.name,
        },
      };
    }
  }

  /**
   * Fetch full content of a single item by URL or ref.
   *
   * Part of the channel contract — every channel should implement this.
   * 入参可为完整 url 或渠道内部 ref(如 BV号 / topic id / owner-repo)。
   * Default: informative stub (channel declared not-supported).
   */
  async content(url: string, args: string[]): Promise<SearchResult[]> {
    return [
      {
        title: `${this.name} content`,
        snippet: this.supportsContent
          ? `content() not implemented for channel "${this.name}" (supportsContent=true but no override)`
          : `content fetch not implemented for channel "${this.name}" — this channel only supports search`,
        source: { channel: this.name },
      },
    ];
  }

  /**
   * Health check: probe all strategies concurrently (4-layer TCP → 7-layer HTTP
   * chain, channel healthUrl preferred at 7-layer), return per-backend status.
   * 若渠道声明 allowProbeSearch 且 4/7 层均失败,用真实搜索兜底确认(仅免费无配额渠道)。
   */
  async health(): Promise<HealthStatus> {
    // buildRequests() is query-driven for most channels. Use a sentinel query
    // to build probes without executing a real search request.
    const params = this.parseArgs("agent-search-doctor", []);
    const requests = this.buildRequests(params);
    if (requests.length === 0) {
      return {
        status: "unknown",
        reason: "no requests",
        name: this.name,
        backends: [],
      };
    }
    const healthUrl = this.healthProbe?.healthUrl;
    // Concurrent health checks — one per backend request
    const checked = await Promise.all(
      requests.map(async (req) => ({
        req,
        health: await checkStrategy(req, undefined, healthUrl),
      })),
    );

    const backends: BackendHealth[] = [];
    let overallStatus: HealthState = "unavailable";
    const statuses: string[] = [];

    for (const { req, health } of checked) {
      const label = this._requestLabel(req);
      const be: BackendHealth = {
        name: label,
        status: health.status,
        detail: health.reason,
        probe: health.probe,
        latencyMs: health.latencyMs,
      };
      backends.push(be);
      const detail = health.reason ? ` (${health.reason})` : "";
      statuses.push(`${label}: ${health.status}${detail}`);

      // Overall: ok if any ok, warning if any warning but none ok
      if (health.status === "ok") overallStatus = "ok";
      else if (health.status === "warning" && overallStatus !== "ok")
        overallStatus = "warning";
    }

    // 4/7 层均失败 + 渠道允许真实搜索(免费无配额)→ 兜底真实搜索确认
    if (overallStatus !== "ok" && this.healthProbe?.allowProbeSearch) {
      const outcome = await this.searchWithParams(params);
      if (outcome.ok) {
        overallStatus = "ok";
        statuses.push(`real-search: ok (allowProbeSearch)`);
        backends.push({
          name: "real-search",
          status: "ok",
          detail: "4/7层失败,真实搜索确认可达",
          probe: "search",
        });
      } else {
        statuses.push(
          `real-search: failed (${outcome.error?.message ?? "unknown"})`,
        );
      }
    }

    return {
      status: overallStatus,
      reason: statuses.join(", "),
      name: this.name,
      backends,
    };
  }

  /** Label for a request in health output — override for custom labels. */
  protected _requestLabel(req: RunRequest): string {
    if (req.url) {
      try {
        const u = new URL(req.url);
        return u.hostname;
      } catch {
        /* not a URL */
      }
    }
    if (req.cmd) return req.cmd;
    if (req.strategy === "cookie_fetch") return "opencli/cookies";
    if (req.strategy === "browser_exec") return "opencli/browser";
    return req.strategy;
  }

  // ── Subclasses may override ─────────────────────────────────────────

  /**
   * 解析 CLI 参数为结构化 params。
   * 默认实现(框架统一):
   *   - query: 第一个非 -- 参数
   *   - 公共参数: -L/--limit、--sort、--time-range、--language
   *   - 其余 --key value 或 --key=value 作为专有参数透传(由 spec.channelParams 声明)
   * 渠道一般无需覆写。
   */
  parseArgs(query: string, args: string[]): Record<string, unknown> {
    // A2:默认 limit 从 spec.defaults 读(渠道不再覆写 parseArgs 只为改默认值)
    const defaultLimit = this.channelSpec?.defaults.limit ?? 5;
    const params: Record<string, unknown> = {
      query: query && !query.startsWith("--") ? query : "",
      limit: defaultLimit,
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
        return undefined;
      };
      if (a === "-L" || a === "--limit") {
        const v = next();
        if (v) params.limit = parseInt(v, 10) || 5;
      } else if (a === "--sort") {
        const v = next();
        if (v) params.sort = v;
      } else if (a === "--time-range" || a === "--timeRange") {
        const v = next();
        if (v) params.timeRange = v;
      } else if (a === "--language") {
        const v = next();
        if (v) params.language = v;
      } else if (a.startsWith("--") && a.includes("=")) {
        // --key=value 形式
        const eq = a.indexOf("=");
        const key = a.slice(2, eq);
        params[key] = a.slice(eq + 1);
        i += 1;
      } else if (a.startsWith("--")) {
        // --key value 形式(专有参数透传)
        const v = next();
        if (v !== undefined) {
          const key = a.slice(2);
          params[key] = v;
        } else {
          params[a.slice(2)] = true;
        }
      } else {
        i += 1;
      }
    }
    return params;
  }

  /** Build RunRequest(s) from params. Ordered: main → fallback. */
  abstract buildRequests(params: Record<string, unknown>): RunRequest[];

  /**
   * 响应级错误钩子(F4):adapter 执行成功但响应本身是业务错误(如 API code !== 200)时,
   * 返回结构化 ChannelError 替代静默空结果。默认无。
   */
  protected formatError?(
    raw: unknown,
    params: Record<string, unknown>,
  ): ChannelError | null;

  /** Format raw data from adapter into SearchResult[]. */
  abstract formatResults(
    raw: unknown,
    params: Record<string, unknown>,
  ): SearchResult[];
}
