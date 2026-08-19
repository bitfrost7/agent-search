/**
 * Runner — pure execution engine.
 *
 * Given a RunRequest, executes the appropriate I/O and returns raw data.
 * No business logic, no fallback, no channel-specific knowledge.
 *
 * Strategies:
 * - cookie_fetch:  daemon.getCookies() → fetch(apiUrl, { Cookie })
 * - browser_exec:  daemon.navigate() → daemon.evalInPage(jsCode)
 * - cli:           execSync(cmd, cmdArgs)
 * - api:           fetch(url)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import {
  setGlobalDispatcher,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from "undici";
import type { RunRequest, HealthStatus, HealthState } from "./types.js";
import {
  ensureDaemon,
  checkDaemonHealth,
  getCookieHeader,
  navigate,
  evalInPage,
  type DaemonError,
} from "./daemon-client.js";
import { which } from "./which.js";

// ── Proxy support ──────────────────────────────────────────────────────────
// 原生 fetch (undici) 默认不读 HTTP_PROXY/HTTPS_PROXY 环境变量，
// 导致需要代理的境外服务（jina.ai / duckduckgo 等）直连失败。
// 这里显式挂载全局代理：环境变量优先，否则探测本机常见代理端口
// （Clash 默认 7890 等）。本地地址始终走直连（NO_PROXY）。

const LOCAL_NO_PROXY = "localhost,127.0.0.1,::1,0.0.0.0";
const COMMON_PROXY_PORTS = [7890, 7897, 10809, 10808, 1080, 8888];

function pickEnvProxy(): string | null {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const v of candidates) {
    if (v && v.trim() !== "") return v.trim();
  }
  return null;
}

/** TCP 探测本机端口是否在监听（短超时） */
function isPortOpen(
  host: string,
  port: number,
  timeoutMs = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

async function detectLocalProxy(): Promise<string | null> {
  for (const port of COMMON_PROXY_PORTS) {
    if (await isPortOpen("127.0.0.1", port)) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return null;
}

let proxyInitialized = false;
let activeProxyUrl: string | null = null;

export async function initProxy(): Promise<void> {
  if (proxyInitialized) return;
  proxyInitialized = true;
  // 测试环境：保持直连（测试用 vi.stubGlobal mock 全局 fetch）
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  const proxyUrl = pickEnvProxy() ?? (await detectLocalProxy());
  if (!proxyUrl) return; // 无代理，保持直连（原行为）
  activeProxyUrl = proxyUrl;

  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, LOCAL_NO_PROXY]
    .filter((v): v is string => !!v && v.trim() !== "")
    .join(",");

  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
    }),
  );

  // Node 内置 globalThis.fetch 使用内置 undici 副本，不读我们的 dispatcher。
  // 替换为 undici 包自身的 fetch，让代理配置全局生效。
  globalThis.fetch = undiciFetch;
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function run(req: RunRequest): Promise<unknown> {
  await initProxy(); // 懒初始化：首次执行前挂载全局代理（幂等，无代理时零开销）
  const operation = (async () => {
    switch (req.strategy) {
      case "cookie_fetch":
        return runCookieFetch(req);
      case "browser_exec":
        return runBrowserExec(req);
      case "cli":
        return runCli(req);
      case "api":
        return runApi(req);
      default:
        throw new Error(
          `unknown strategy: ${(req as { strategy: string }).strategy}`,
        );
    }
  })();
  return withTimeout(operation, req.timeout ?? 30_000);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Strategy: cookie_fetch ─────────────────────────────────────────────────

async function runCookieFetch(req: RunRequest): Promise<unknown> {
  if (!req.apiUrl) throw new Error("cookie_fetch requires apiUrl");
  if (!req.cookieDomain) throw new Error("cookie_fetch requires cookieDomain");

  const cookie = await getCookieHeader(
    req.cookieDomain,
    req.cookieRoot ?? "",
    `https://${req.cookieDomain}`,
  );

  const resp = await fetch(req.apiUrl, {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
      Referer: `https://${req.cookieDomain}/`,
      ...req.headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(req.timeout ?? 30_000),
  });

  if (!resp.ok && !(req.passThroughStatus ?? []).includes(resp.status)) {
    throw new Error(`HTTP ${resp.status} from ${req.apiUrl}`);
  }

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Strategy: browser_exec ─────────────────────────────────────────────────

async function runBrowserExec(req: RunRequest): Promise<unknown> {
  // Step 1: navigate if needed
  if (req.navigateUrl) {
    await navigate(req.navigateUrl);
  }

  // Step 2: wait for selector if specified
  if (req.waitSelector) {
    const waitJs = `new Promise((resolve) => {
      const sel = ${JSON.stringify(req.waitSelector)};
      const check = () => {
        if (document.querySelector(sel)) { resolve('ok'); return; }
        setTimeout(check, 100);
      };
      check();
    })`;
    try {
      await evalInPage(waitJs);
    } catch {
      // timeout — continue anyway
    }
  }

  // Step 3: execute JS
  if (!req.jsCode) throw new Error("browser_exec requires jsCode");
  return evalInPage(req.jsCode);
}

// ── Strategy: cli ──────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

async function runCli(req: RunRequest): Promise<unknown> {
  if (!req.cmd) throw new Error("cli requires cmd");
  const args = req.cmdArgs ?? [];
  try {
    // A4:execFile + Promise(非阻塞事件循环)——MCP server 并发处理多个 tool_call 时不串行卡死
    // execFile 直接执行可执行文件,不经 shell,避免特殊字符解析问题(同 execFileSync)
    const { stdout } = await execFileAsync(req.cmd, args, {
      timeout: req.timeout ?? 30_000,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as {
      stderr?: string;
      stdout?: string;
      message?: string;
      code?: string;
    };
    // F3:命令不存在时给可读提示(yt-dlp 缺失等),不再裸抛 ENOENT
    if (e.code === "ENOENT") {
      throw new Error(
        `command not found: ${req.cmd} — 请安装该命令,或配置对应渠道的 API key`,
      );
    }
    throw new Error(e.stderr?.trim() || e.stdout?.trim() || String(e.message));
  }
}

// ── Strategy: api ──────────────────────────────────────────────────────────

async function runApi(req: RunRequest): Promise<unknown> {
  if (!req.url) throw new Error("api requires url");
  const resp = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(req.timeout ?? 30_000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${req.url}`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  const text = await resp.text();

  // Try JSON parse if content-type says JSON, or body looks like JSON
  if (
    contentType.includes("application/json") ||
    text.trimStart().startsWith("{") ||
    text.trimStart().startsWith("[")
  ) {
    try {
      return JSON.parse(text);
    } catch {
      // Not valid JSON despite looking like it — return text
    }
  }

  return text;
}

// ── Host probe (doctor ping) ───────────────────────────────────────────────

/**
 * Extract host:port from a URL string. Returns null for invalid URLs.
 * http→80, https→443, explicit ports win.
 */
export function hostFromUrl(
  url: string,
): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === "https:"
        ? 443
        : u.protocol === "http:"
          ? 80
          : 0;
    if (!port) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

/**
 * Ping a host:port via TCP connect with timeout (no TLS handshake —
 * connectivity only, fast and works for any host). Returns latency ms.
 * 若有可用代理，改走代理 CONNECT 隧道探测（反映真实可达性）。
 */
export async function probeHost(
  host: string,
  port: number,
  timeoutMs = 3_000,
): Promise<{ ok: boolean; ms: number }> {
  if (activeProxyUrl) {
    return await probeHostViaProxy(host, port, activeProxyUrl, timeoutMs);
  }
  return await new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const sock = connect({ host, port });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs);
    sock.setNoDelay(true);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/** 通过代理 CONNECT 隧道探测目标可达性 */
async function probeHostViaProxy(
  host: string,
  port: number,
  proxyUrl: string,
  timeoutMs: number,
): Promise<{ ok: boolean; ms: number }> {
  return await new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(proxyUrl);
    } catch {
      return resolve({ ok: false, ms: 0 });
    }
    const started = Date.now();
    let settled = false;
    const sock = connect({ host: u.hostname, port: Number(u.port) || 80 });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      sock.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`,
      );
    });
    let resp = "";
    sock.on("data", (d) => {
      resp += d.toString("latin1");
      if (resp.includes("\r\n")) {
        finish(
          resp.startsWith("HTTP/1.1 200") || resp.startsWith("HTTP/1.0 200"),
        );
      }
    });
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  /** 判定层级: tcp=4层确认, http=7层确认 */
  method: "tcp" | "http";
  statusCode?: number;
  detail?: string;
}

/**
 * 健康探测函数:对目标 URL(可带渠道自带 healthUrl)做可达性探测。
 * 可注入(测试用 mock);默认实现走 4层→7层 链。
 */
export type HealthProbe = (
  url: string,
  healthUrl?: string,
) => Promise<ProbeResult | null>;

/**
 * 默认探测链:先 4 层 TCP(确认即可达,即成功);
 * 4 层确认不了再升级 7 层 HTTP(healthUrl 优先),收到任意 HTTP 响应即可达。
 * 不消耗任何 API 配额(只做连接/HEAD,不触发搜索)。
 *
 * 注意:有代理时跳过 4 层——代理 CONNECT 隧道对几乎所有域名返回 200,
 * (Clash 先建隧道再转发),4 层失去区分度,必须用 7 层 HTTP 反映真实可达性。
 */
const defaultProbe: HealthProbe = async (url, healthUrl) => {
  const target = hostFromUrl(url);
  if (!target) return null;
  // 无代理:4 层 TCP 快检(真实直连,通即可达)
  if (!activeProxyUrl) {
    const tcp = await probeHost(target.host, target.port);
    if (tcp.ok) {
      return { ok: true, ms: tcp.ms, method: "tcp" };
    }
  }
  // 有代理(4层失真)或 4层失败 → 7 层 HTTP(渠道自带 healthUrl 优先)
  return probeHttp(healthUrl ?? url);
};

/** 7 层 HTTP 探测:HEAD 优先(部分站点 405/501 回退 GET),收到任意 HTTP 响应即可达 */
async function probeHttp(url: string): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    let resp: Response;
    try {
      resp = await undiciFetch(url, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      // HEAD 被拒(405/501 等)或异常 → 回退 GET
      resp = await undiciFetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
      });
    }
    // 任意 HTTP 响应(含 4xx/5xx)= 服务在线,只是拒绝请求 —— 算可达
    return {
      ok: true,
      ms: Date.now() - started,
      method: "http",
      statusCode: resp.status,
    };
  } catch {
    return {
      ok: false,
      ms: Date.now() - started,
      method: "http",
      detail: "http probe failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the target URL(链式); null if the URL has no host/port. */
async function probeUrl(
  url: string | undefined,
  healthUrl: string | undefined,
  probe: HealthProbe,
): Promise<
  | {
      host: string;
      ok: boolean;
      ms: number;
      method: "tcp" | "http";
      statusCode?: number;
    }
  | null
> {
  if (!url) return null;
  const target = hostFromUrl(url);
  if (!target) return null;
  const p = await probe(url, healthUrl);
  if (!p) return null;
  return {
    host: target.host,
    ok: p.ok,
    ms: p.ms,
    method: p.method ?? "tcp",
    statusCode: p.statusCode,
  };
}

async function timed<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await operation();
  return { value, ms: Date.now() - started };
}

function requestTargetUrl(req: RunRequest): string | undefined {
  return (
    req.url ??
    req.apiUrl ??
    req.navigateUrl ??
    req.cmdArgs?.find((arg) => /^https?:\/\//i.test(arg))
  );
}

function missingCredential(
  headers: Record<string, string> | undefined,
): boolean {
  const credentials = Object.entries(headers ?? {}).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized === "authorization" || normalized.includes("api-key");
  });
  return credentials.some(
    ([, value]) =>
      value.replace(/^(?:bearer|token)\s*/i, "").trim().length === 0,
  );
}

// ── Health check ───────────────────────────────────────────────────────────

/**
 * Health check per strategy. `probe` is injectable for tests;
 * by default it runs the 4-layer(TCP)→7-layer(HTTP) probe chain
 * against the request's target URL (channel healthUrl preferred at 7-layer).
 */
export async function checkStrategy(
  req: RunRequest,
  probe: HealthProbe = defaultProbe,
  healthUrl?: string,
): Promise<HealthStatus> {
  switch (req.strategy) {
    case "cookie_fetch": {
      // Daemon must be up (cookies come from the browser); also probe the target API host.
      const [daemon, hp] = await Promise.all([
        timed(() => checkDaemonHealth()),
        probeUrl(req.apiUrl, healthUrl, probe),
      ]);
      const dh = daemon.value;
      if (!dh.ok) {
        return {
          status: "unavailable",
          reason: `daemon ${daemon.ms}ms: ${dh.reason}`,
          probe: "tcp",
          latencyMs: daemon.ms,
        };
      }
      if (hp && !hp.ok) {
        return {
          status: "warning",
          reason: `daemon ok ${daemon.ms}ms, ${hp.host} ${hp.method} ${hp.ms}ms: unreachable`,
          probe: hp.method,
          latencyMs: hp.ms,
        };
      }
      return {
        status: "ok",
        reason: hp
          ? `daemon ok ${daemon.ms}ms, ${hp.host} ${hp.method} ${hp.ms}ms${hp.statusCode ? ` http ${hp.statusCode}` : ""}`
          : `daemon ok ${daemon.ms}ms`,
        probe: hp?.method ?? "tcp",
        latencyMs: hp?.ms ?? daemon.ms,
      };
    }
    case "browser_exec": {
      // Light health check — no spawn, no 10s poll (ensureDaemon is for actual searches)
      const [daemon, hp] = await Promise.all([
        timed(() => checkDaemonHealth()),
        probeUrl(req.navigateUrl, healthUrl, probe),
      ]);
      const h = daemon.value;
      const targetDetail = hp
        ? `, ${hp.host} ${hp.method} ${hp.ms}ms${hp.ok ? "" : ": unreachable"}`
        : "";
      return {
        status: !h.ok ? "unavailable" : hp && !hp.ok ? "warning" : "ok",
        reason: `daemon ${h.ok ? `ok ${daemon.ms}ms` : h.reason}${targetDetail}`,
        probe: hp?.method ?? "tcp",
        latencyMs: hp?.ms ?? daemon.ms,
      };
    }
    case "cli": {
      const started = Date.now();
      if (!req.cmd) {
        return {
          status: "unavailable",
          reason: "check 0ms: not in PATH",
          probe: "check",
          latencyMs: 0,
        };
      }
      const path = which(req.cmd);
      const checkMs = Date.now() - started;
      if (!path) {
        return {
          status: "unavailable",
          reason: `check ${checkMs}ms: not in PATH`,
          probe: "check",
          latencyMs: checkMs,
        };
      }
      const hp = await probeUrl(requestTargetUrl(req), healthUrl, probe);
      if (hp) {
        return {
          status: hp.ok ? "ok" : "warning",
          reason: `check ${checkMs}ms, ${hp.host} ${hp.method} ${hp.ms}ms${hp.ok ? "" : ": unreachable"}`,
          probe: hp.method,
          latencyMs: hp.ms,
        };
      }
      return {
        status: "ok",
        reason: `check ${checkMs}ms`,
        probe: "check",
        latencyMs: checkMs,
      };
    }
    case "api": {
      if (!req.url) return { status: "unavailable", reason: "no url" };
      const target = hostFromUrl(req.url);
      if (!target) return { status: "error", reason: "invalid URL" };

      // Probe the target URL (4-layer TCP → 7-layer HTTP chain)
      const p = await probe(req.url, healthUrl);
      const key =
        req.headers?.Authorization ?? req.headers?.["X-API-Key"] ?? "";
      if (!p) {
        return { status: "error", reason: "invalid URL" };
      }
      if (!p.ok) {
        return {
          status: "unavailable",
          reason: `${p.method ?? "tcp"} ${p.ms}ms: ${target.host} unreachable${p.detail ? ` (${p.detail})` : ""}`,
          probe: p.method ?? "tcp",
          latencyMs: p.ms,
        };
      }
      if (missingCredential(req.headers)) {
        return {
          status: "warning",
          reason: `${p.method ?? "tcp"} ${p.ms}ms, missing API key`,
          probe: p.method ?? "tcp",
          latencyMs: p.ms,
        };
      }
      return {
        status: "ok",
        reason: `${p.method ?? "tcp"} ${p.ms}ms${p.statusCode ? ` http ${p.statusCode}` : ""}${key ? ", authed" : ""}`,
        probe: p.method ?? "tcp",
        latencyMs: p.ms,
      };
    }
    default:
      return { status: "unknown", reason: "unknown strategy" };
  }
}
