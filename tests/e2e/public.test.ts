/**
 * E2E tests — public channels (real search, no mocks).
 *
 * These tests make real network requests. They require:
 *   - gh CLI for github(已删渠道,见 git log)
 *   - yt-dlp for youtube
 *   - bili CLI for bilibili (or browser fallback)
 *   - Network access for web/v2ex
 *
 * Run: npm run test:e2e
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TIMEOUT = 60_000;

/** 环境依赖探测:缺依赖的 e2e 测试条件 skip(不在无环境机器上全红) */
function hasCommand(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}
const hasYtDlp = hasCommand("yt-dlp") || !!process.env.YOUTUBE_API_KEY;
const hasOpenCli = hasCommand("opencli");

function runSearch(args: string[]): { stdout: string; exitCode: number } {
  const result = spawnSync(
    process.execPath,
    [resolve("bin/agent-search.js"), ...args],
    {
      encoding: "utf-8",
      timeout: TIMEOUT,
    },
  );
  return { stdout: result.stdout ?? "", exitCode: result.status ?? 1 };
}

// ── YouTube ─────────────────────────────────────────────────────────────────

describe("youtube (e2e)", () => {
  it.skipIf(!hasYtDlp)(
    "should search videos and return titles",
    () => {
      const { stdout, exitCode } = runSearch([
        "youtube",
        "python tutorial",
        "--limit",
        "3",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("youtube");
      expect(stdout.length).toBeGreaterThan(50);
    },
    TIMEOUT,
  );
});

// ── V2EX ────────────────────────────────────────────────────────────────────

describe("v2ex (e2e)", () => {
  it(
    "should fetch hot topics",
    () => {
      const { stdout, exitCode } = runSearch(["v2ex", "--limit", "3"]);
      // V2EX API may be unreachable in some regions
      if (exitCode !== 0) {
        console.log("v2ex API unreachable, skipping");
        return;
      }
      expect(stdout.length).toBeGreaterThan(20);
    },
    TIMEOUT,
  );
});

// ── Bilibili ────────────────────────────────────────────────────────────────

describe("bilibili (e2e)", () => {
  it.skipIf(!hasOpenCli)(
    "should search videos and return results",
    () => {
      const { stdout, exitCode } = runSearch([
        "bilibili",
        "编程",
        "--limit",
        "3",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("bilibili");
    },
    TIMEOUT,
  );
});

// ── Doctor ──────────────────────────────────────────────────────────────────

describe("doctor (e2e)", () => {
  it(
    "should list all channels with status",
    () => {
      const { stdout, exitCode } = runSearch(["doctor"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("channel");
      expect(stdout).toContain("v2ex");
      expect(stdout).toContain("youtube");
      expect(stdout).toContain("bocha");
    },
    TIMEOUT,
  );
});

// ── CLI ─────────────────────────────────────────────────────────────────────

describe("cli (e2e)", () => {
  it(
    "should list channels",
    () => {
      const { stdout, exitCode } = runSearch(["channel", "list"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("v2ex");
      expect(stdout).toContain("youtube");
    },
    TIMEOUT,
  );

  it(
    "should show channel help",
    () => {
      const { stdout, exitCode } = runSearch(["channel", "show", "v2ex"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage");
      expect(stdout).toContain("v2ex");
    },
    TIMEOUT,
  );

  it(
    "should show usage when no args",
    () => {
      const { stdout, exitCode } = runSearch([]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("agent-search");
      expect(stdout).toContain("Channels");
    },
    TIMEOUT,
  );
});
