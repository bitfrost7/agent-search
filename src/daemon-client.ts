/**
 * OpenCLI daemon client — direct HTTP communication with the opencli daemon.
 *
 * Replaces execSync("opencli ...") subprocess calls with direct HTTP requests
 * to the local daemon (default :19825). The daemon forwards commands to the
 * Chrome extension via WebSocket, which executes them in the browser context.
 *
 * Lifecycle management mirrors opencli's own BrowserBridge:
 * 1. Check daemon health (is it running? is the extension connected?)
 * 2. If daemon not running → spawn it (detached, unref)
 * 3. If daemon running but extension not connected → poll until ready (10s)
 * 4. If stale daemon (version mismatch) → shutdown + respawn
 *
 * Supported actions: exec, cookies, navigate, tabs, screenshot, etc.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { which } from "./which.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DAEMON_PORT = 19825;
const DAEMON_PORT = parseInt(
  process.env.OPENCLI_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT),
  10,
);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const OPENCLI_HEADERS = { "X-OpenCLI": "1" };

const DAEMON_SPAWN_TIMEOUT_MS = 10_000; // 10s to wait for daemon + extension
const POLL_INTERVAL_MS = 200;
const HEALTH_CACHE_MS = 5_000; // cache health for 5s (shorter than opencli for faster feedback)

// ── Types ──────────────────────────────────────────────────────────────────

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  page?: string;
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  uptime: number;
  daemonVersion?: string;
  extensionConnected: boolean;
  extensionVersion?: string;
  contextId?: string;
  profileRequired?: boolean;
  profileDisconnected?: boolean;
  pending: number;
  memoryMB: number;
  port: number;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

type DaemonState = "ready" | "stopped" | "no-extension" | "profile-disconnected" | "profile-required";

// ── Internal state ─────────────────────────────────────────────────────────

let _idCounter = 0;
let _healthCache: { state: DaemonState; status: DaemonStatus | null; checkedAt: number } | null = null;
let _ensurePromise: Promise<boolean> | null = null;

// ── Core HTTP ──────────────────────────────────────────────────────────────

async function requestDaemon(
  pathname: string,
  init: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = 30_000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(`${DAEMON_URL}${pathname}`, {
      ...rest,
      headers: { ...OPENCLI_HEADERS, ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function generateId(): string {
  return `as_${process.pid}_${Date.now()}_${++_idCounter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Daemon status & health ─────────────────────────────────────────────────

/** Fetch raw daemon status from /status endpoint. Returns null if daemon not running. */
export async function fetchDaemonStatus(opts: { timeout?: number } = {}): Promise<DaemonStatus | null> {
  try {
    const res = await requestDaemon("/status", { timeout: opts.timeout ?? 2_000 });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

/** Classify daemon status into a state enum. */
function classifyHealth(status: DaemonStatus | null): { state: DaemonState; status: DaemonStatus | null } {
  if (!status) return { state: "stopped", status: null };
  if (status.profileRequired) return { state: "profile-required", status };
  if (status.profileDisconnected) return { state: "profile-disconnected", status };
  if (!status.extensionConnected) return { state: "no-extension", status };
  return { state: "ready", status };
}

/**
 * Check daemon health. Cached for HEALTH_CACHE_MS.
 * Returns { ok, reason } for simple health checks.
 */
export async function checkDaemonHealth(): Promise<{ ok: boolean; reason: string }> {
  const { state, status } = await getDaemonHealth();
  switch (state) {
    case "ready":
      return { ok: true, reason: "opencli daemon available" };
    case "stopped":
      return { ok: false, reason: "daemon not running" };
    case "no-extension":
      return { ok: false, reason: "browser extension not connected" };
    case "profile-disconnected":
      return { ok: false, reason: `browser profile "${status?.contextId ?? "unknown"}" disconnected` };
    case "profile-required":
      return { ok: false, reason: "multiple profiles connected, need --profile" };
    default:
      return { ok: false, reason: "unknown daemon state" };
  }
}

/**
 * Get daemon health with full status. Cached for HEALTH_CACHE_MS.
 * Mirrors opencli's getDaemonHealth().
 */
export async function getDaemonHealth(opts: { contextId?: string } = {}): Promise<{ state: DaemonState; status: DaemonStatus | null }> {
  // Return cached result if fresh
  if (_healthCache && Date.now() - _healthCache.checkedAt < HEALTH_CACHE_MS) {
    return { state: _healthCache.state, status: _healthCache.status };
  }

  const status = await fetchDaemonStatus({ timeout: 2_000 });
  const { state } = classifyHealth(status);

  _healthCache = { state, status, checkedAt: Date.now() };
  return { state, status };
}

// ── Daemon lifecycle: spawn, restart, ensure ──────────────────────────────

/**
 * Find the opencli daemon script path.
 *
 * A8:优先从 @jackwener/opencli 包的入口解析(不依赖内部路径猜测),
 * 降级到 .bin 符号链接 / which / 全局安装位置探测。
 */
function findDaemonScript(): string | null {
  // 1. 从包入口解析:require.resolve 返回 dist/src/main.js,daemon.js 是同目录兄弟
  try {
    const require = createRequire(import.meta.url);
    const mainJs = require.resolve("@jackwener/opencli");
    const daemonJs = join(dirname(mainJs), "daemon.js");
    if (existsSync(daemonJs)) return daemonJs;
  } catch {
    /* 包未安装,走 fallback */
  }

  // 2. Check bundled node_modules
  const localBin = new URL("../node_modules/.bin/opencli", import.meta.url).pathname;
  if (existsSync(localBin)) {
    // .bin/opencli is a symlink to dist/src/main.js; daemon.js is a sibling
    const mainJs = realpathSafe(localBin);
    if (mainJs) {
      const daemonJs = join(dirname(mainJs), "daemon.js");
      if (existsSync(daemonJs)) return daemonJs;
    }
  }

  // 3. Check system opencli
  const ocPath = which("opencli");
  if (ocPath) {
    const mainJs = realpathSafe(ocPath);
    if (mainJs) {
      const daemonJs = join(dirname(mainJs), "daemon.js");
      if (existsSync(daemonJs)) return daemonJs;
    }
  }

  // 4. Check common global install locations(含 pnpm)
  const globalRoots = [
    "/usr/local/lib/node_modules/@jackwener/opencli",
    `${process.env.HOME}/.local/lib/node_modules/@jackwener/opencli`,
    `${process.env.HOME}/.npm-global/lib/node_modules/@jackwener/opencli`,
    `${process.env.HOME}/Library/pnpm/global/5/node_modules/@jackwener/opencli`,
    `${process.env.HOME}/.pnpm-store/v3/files/@jackwener+opencli`,
  ];
  for (const root of globalRoots) {
    const daemonJs = join(root, "dist/src/daemon.js");
    if (existsSync(daemonJs)) return daemonJs;
  }

  return null;
}

function realpathSafe(p: string): string | null {
  try {
    // readlink to resolve symlink; if not a symlink, return as-is
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) {
      return realpathSync(p);
    }
    return p;
  } catch {
    return null;
  }
}

/** Spawn the daemon process (detached, unref). */
function spawnDaemon(): boolean {
  const script = findDaemonScript();
  if (!script) {
    return false;
  }
  try {
    const proc = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

/** Request daemon shutdown via HTTP /shutdown. */
async function requestDaemonShutdown(): Promise<boolean> {
  try {
    const res = await requestDaemon("/shutdown", { method: "POST", timeout: 5_000 });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for daemon to stop responding (poll /status until it returns null). */
async function waitForDaemonStop(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const status = await fetchDaemonStatus({ timeout: 500 });
    if (!status) return true;
  }
  return false;
}

/** Wait for daemon to start responding + extension to connect. */
async function pollUntilReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const { state } = await getDaemonHealth();
    // Invalidate cache so we re-check each iteration
    _healthCache = null;
    if (state === "ready") return true;
  }
  return false;
}

/**
 * Ensure the daemon is running and the browser extension is connected.
 * Mirrors opencli's BrowserBridge._ensureDaemon():
 *
 * 1. Check health → if ready, return immediately
 * 2. If daemon stopped → spawn → poll until ready
 * 3. If daemon running but no extension → poll until ready (10s)
 * 4. If profile disconnected → throw (user must open Chrome)
 *
 * This is the main entry point before any sendCommand() call.
 * Idempotent — concurrent calls share the same promise.
 */
export async function ensureDaemon(): Promise<boolean> {
  // Deduplicate concurrent calls
  if (_ensurePromise) return _ensurePromise;

  _ensurePromise = (async () => {
    const { state, status } = await getDaemonHealth();

    // Fast path: already ready
    if (state === "ready") return true;

    // Profile disconnected — can't fix programmatically
    if (state === "profile-disconnected") {
      _ensurePromise = null;
      throw new DaemonError(
        `Browser profile "${status?.contextId ?? "unknown"}" is not connected`,
        "profile_disconnected",
        "Open the matching Chrome profile and make sure the OpenCLI extension is enabled.",
      );
    }

    // Multiple profiles — need user to select
    if (state === "profile-required") {
      _ensurePromise = null;
      throw new DaemonError(
        "Multiple Browser Bridge profiles are connected; choose one with --profile",
        "profile_required",
        "Run: opencli profile list, then opencli profile use <name>",
      );
    }

    // Daemon stopped — spawn it
    if (state === "stopped") {
      const spawned = spawnDaemon();
      if (!spawned) {
        _ensurePromise = null;
        throw new DaemonError(
          "Cannot start daemon: opencli not found",
          "daemon_not_found",
          "Install opencli: npm install -g @jackwener/opencli",
        );
      }
      // Wait for daemon + extension
      const ready = await pollUntilReady(DAEMON_SPAWN_TIMEOUT_MS);
      _ensurePromise = null;
      if (!ready) {
        throw new DaemonError(
          "Daemon started but extension not connected within 10s",
          "extension_not_connected",
          "Make sure Chrome is open and the OpenCLI extension is enabled.",
        );
      }
      return true;
    }

    // Daemon running but no extension — wait for it
    if (state === "no-extension") {
      const ready = await pollUntilReady(DAEMON_SPAWN_TIMEOUT_MS);
      _ensurePromise = null;
      if (!ready) {
        throw new DaemonError(
          "Browser Bridge extension not connected",
          "extension_not_connected",
          "Make sure Chrome/Chromium is open and the extension is enabled.\n" +
            "If the extension is installed, try: opencli daemon stop && opencli doctor",
        );
      }
      return true;
    }

    _ensurePromise = null;
    return false;
  })();

  return _ensurePromise;
}

// ── Command sending ────────────────────────────────────────────────────────

/**
 * Send a command to the daemon and return the result data.
 * Automatically ensures daemon is ready before sending.
 * Throws DaemonError on failure.
 */
export async function sendCommand(
  action: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // Ensure daemon is ready (spawns if needed, waits for extension)
  await ensureDaemon();

  const id = generateId();
  const command = { id, action, surface: "browser", session: params.session ?? "agent-search", ...params };

  let res: Response;
  try {
    res = await requestDaemon("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      timeout: 60_000,
    });
  } catch (err) {
    throw new DaemonError(
      `daemon request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = (await res.json()) as DaemonResult;
  if (!result.ok) {
    throw new DaemonError(
      result.error ?? "daemon command failed",
      result.errorCode,
      result.errorHint,
    );
  }
  return result.data;
}

// ── High-level helpers ─────────────────────────────────────────────────────

/**
 * Execute JavaScript in the browser page context.
 * Returns the result of the expression.
 */
export async function evalInPage(
  code: string,
  opts: { session?: string; contextId?: string } = {},
): Promise<unknown> {
  return sendCommand("exec", {
    code,
    ...opts,
  });
}

/**
 * Get cookies from the browser for a domain or URL.
 * Returns an array of Cookie objects.
 */
export async function getCookies(
  opts: { domain?: string; url?: string; contextId?: string; session?: string } = {},
): Promise<Cookie[]> {
  const result = await sendCommand("cookies", opts);
  return Array.isArray(result) ? (result as Cookie[]) : [];
}

/**
 * Get a cookie header string for a domain/URL.
 *
 * Strategy: navigate to the URL first (creates a browser session),
 * then read document.cookie from the page context.
 */
export async function getCookieHeader(
  domain: string,
  rootDomain?: string,
  url?: string,
): Promise<string> {
  const targetUrl = url ?? `https://${domain}/`;
  // Navigate to the target URL to establish a browser session
  try {
    await navigate(targetUrl);
  } catch {
    // Navigation may fail if already on the page or session exists — continue
  }
  // Read document.cookie from the page context
  try {
    const cookie = await evalInPage("document.cookie");
    if (typeof cookie === "string" && cookie.length > 0) {
      return cookie;
    }
  } catch {
    // Fall through to cookies action
  }
  // Fallback: try cookies action with domain
  const seen = new Map<string, string>();
  const domains = [domain, rootDomain].filter(Boolean) as string[];
  for (const d of domains) {
    try {
      const cookies = await getCookies({ domain: d });
      for (const c of cookies) {
        if (!seen.has(c.name)) seen.set(c.name, c.value);
      }
    } catch {
      // try next
    }
  }
  return [...seen].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Navigate the browser to a URL (opens a tab if needed).
 * Returns the page identity (targetId).
 */
export async function navigate(
  url: string,
  opts: { session?: string; contextId?: string } = {},
): Promise<string | undefined> {
  const result = await sendCommand("navigate", {
    url,
    ...opts,
  });
  if (typeof result === "object" && result !== null && "page" in result) {
    return (result as { page?: string }).page;
  }
  return undefined;
}

// ── OpenCLI binary resolver ────────────────────────────────────────────────

/**
 * Find the opencli binary — check bundled node_modules and system PATH.
 * Used for finding the daemon script, not for subprocess calls.
 */
export function findOpencli(): string | null {
  const local = new URL("../node_modules/.bin/opencli", import.meta.url)
    .pathname;
  if (existsSync(local)) return local;
  return which("opencli");
}

// ── Error ──────────────────────────────────────────────────────────────────

export class DaemonError extends Error {
  code?: string;
  hint?: string;
  constructor(message: string, code?: string, hint?: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
    this.hint = hint;
  }
}
