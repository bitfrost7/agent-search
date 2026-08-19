/**
 * agent-search — core type definitions.
 *
 * Three-layer architecture:
 * - Channel:  declares channel-specific info (URL, cookie, JS, params, fallback)
 * - Adapter:  generic strategy orchestration (try main → fallback)
 * - Runner:   pure execution engine (daemon HTTP / execSync / fetch)
 */

// ── Result ────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url?: string;
  /** 渠道内部 ID(如 BV号/topic id/owner-repo)——content 定位用 */
  ref?: string;
  snippet: string;
  /** P1:结构化来源(不再拼字符串再 split)——channel + backend */
  source: { channel: string; backend?: string };
  meta?: Record<string, unknown>;
}

// ── ChannelOutcome — 渠道执行的硬结果协议(P1) ─────────────────────────────
// 取代旧的"伪 result + 字符串匹配"错误路径:错误不再塞进 title/snippet,
// 而是结构化 error 透出。适配层不做任何字符串猜测。

export interface ChannelError {
  code: "no_request" | "channel_failed" | "parse_failed" | "empty_results";
  message: string;
  channel?: string;
}

/** 渠道级警告(如 fallback 诊断)——由桥接层转 SearchWarning 透出给 agent */
export interface ChannelWarning {
  code: string;
  message: string;
  channel?: string;
}

export type ChannelOutcome =
  | { ok: true; results: SearchResult[]; warnings?: ChannelWarning[] }
  | { ok: false; error: ChannelError };

// ── AdapterExecution — 策略链执行结果(E7:fallback 诊断) ──────────────────────

export interface AdapterExecution {
  raw: unknown;
  /** 主策略失败后命中 fallback(诊断用)——转 fallback_used warning */
  fallbackUsed?: boolean;
  /** 各策略失败原因(按请求顺序,诊断用) */
  failures?: string[];
}

// ── Strategy ──────────────────────────────────────────────────────────────

export type Strategy = "cookie_fetch" | "browser_exec" | "cli" | "api";

// ── RunRequest — Channel 构造，交给 Adapter/Runner 执行 ───────────────────

export interface RunRequest {
  strategy: Strategy;

  // cookie_fetch: daemon 拿 cookie → 本进程 fetch API
  apiUrl?: string;
  cookieDomain?: string;
  cookieRoot?: string;
  headers?: Record<string, string>;

  // browser_exec: daemon navigate → evalInPage 执行 JS
  navigateUrl?: string;
  jsCode?: string;
  waitSelector?: string;

  // cli: execSync 外部 CLI
  cmd?: string;
  cmdArgs?: string[];

  // api: 本进程 fetch 公开 API
  url?: string;
  method?: "GET" | "POST";
  body?: string;

  // 通用
  timeout?: number;
  /** HTTP 非 2xx 时透传响应体给 formatResults 的状态码（如 401 未登录），默认抛错 */
  passThroughStatus?: number[];
}

// ── Adapter — 策略编排，不含渠道信息 ───────────────────────────────────────

export interface Adapter {
  name: string;
  execute(requests: RunRequest[]): Promise<AdapterExecution>;
}

// ── Health ────────────────────────────────────────────────────────────────

export type HealthState =
  "ok" | "warning" | "error" | "unavailable" | "unknown";

/** 健康探测方式: tcp=4层 / http=7层 / search=真实搜索 / ping|curl|check=旧标记 */
export type HealthProbeKind =
  | "tcp"
  | "http"
  | "search"
  | "ping"
  | "curl"
  | "check";

/**
 * 渠道自声明的健康探测配置。
 * 核心标准统一(BaseChannel.health 执行 4层→7层→可选真实搜索 链),
 * 渠道通过声明定制:健康 URL / 是否允许真实搜索(仅免费无配额渠道)。
 */
export interface HealthProbeConfig {
  /** 渠道自带 health 端点,7层探测优先于此 URL(而不是请求目标 URL) */
  healthUrl?: string;
  /**
   * 是否允许在 4/7 层均失败时用真实搜索确认(仅免费无配额 API,如 arxiv/openalex)。
   * 消耗配额/反爬渠道不得开启。
   */
  allowProbeSearch?: boolean;
}

export interface BackendHealth {
  name: string;
  status: HealthState;
  detail?: string;
  probe?: HealthProbeKind;
  latencyMs?: number;
}

export interface HealthStatus {
  status: HealthState;
  reason: string;
  name?: string;
  backends?: BackendHealth[];
  probe?: HealthProbeKind;
  latencyMs?: number;
}
