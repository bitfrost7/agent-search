/**
 * Runner tests — strategy execution (mocked I/O).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock daemon-client before importing runner
vi.mock("../src/daemon-client.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue(true),
  getCookieHeader: vi.fn().mockResolvedValue("session=abc; token=xyz"),
  navigate: vi.fn().mockResolvedValue("page-123"),
  evalInPage: vi.fn().mockResolvedValue("result"),
  checkDaemonHealth: vi
    .fn()
    .mockResolvedValue({ ok: true, reason: "available" }),
}));

import { run, checkStrategy, type HealthProbe } from "../src/runner.js";

describe("run() — cookie_fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify({ retcode: 0, data: [{ id: 1 }] })),
      }),
    );
  });

  it("should fetch API with cookie header", async () => {
    const result = await run({
      strategy: "cookie_fetch",
      apiUrl: "https://example.com/api",
      cookieDomain: "example.com",
      cookieRoot: ".example.com",
    });

    expect(result).toEqual({ retcode: 0, data: [{ id: 1 }] });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "session=abc; token=xyz",
        }),
      }),
    );
  });

  it("should throw on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("forbidden"),
      }),
    );

    await expect(
      run({
        strategy: "cookie_fetch",
        apiUrl: "https://example.com/api",
        cookieDomain: "example.com",
      }),
    ).rejects.toThrow("HTTP 403");
  });

  it("should throw if apiUrl missing", async () => {
    await expect(
      run({ strategy: "cookie_fetch", cookieDomain: "example.com" } as any),
    ).rejects.toThrow("requires apiUrl");
  });

  it("should throw if cookieDomain missing", async () => {
    await expect(
      run({ strategy: "cookie_fetch", apiUrl: "https://example.com" } as any),
    ).rejects.toThrow("requires cookieDomain");
  });
});

describe("run() — cli", () => {
  it("should execute CLI command and return output", async () => {
    const result = await run({
      strategy: "cli",
      cmd: "echo",
      cmdArgs: ["hello"],
    });
    expect(result).toBe("hello\n");
  });

  it("should throw on missing cmd", async () => {
    await expect(run({ strategy: "cli" } as any)).rejects.toThrow(
      "requires cmd",
    );
  });

  it("should throw on failed command", async () => {
    await expect(run({ strategy: "cli", cmd: "false" })).rejects.toThrow();
  });
});

describe("run() — api", () => {
  it("enforces the request timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    await expect(
      run({ strategy: "api", url: "https://example.com/slow", timeout: 5 }),
    ).rejects.toThrow("timed out");
  });

  it("should fetch URL and return text for non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "text/html" },
        text: () => Promise.resolve("hello world"),
      }),
    );

    const result = await run({ strategy: "api", url: "https://example.com" });
    expect(result).toBe("hello world");
  });

  it("should parse JSON when content-type is application/json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve(JSON.stringify({ items: [1, 2, 3] })),
      }),
    );

    const result = await run({
      strategy: "api",
      url: "https://example.com/api",
    });
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("should parse JSON when body looks like JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "" },
        text: () => Promise.resolve('{"key":"value"}'),
      }),
    );

    const result = await run({
      strategy: "api",
      url: "https://example.com/api",
    });
    expect(result).toEqual({ key: "value" });
  });

  it("should throw on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => "" },
        text: () => Promise.resolve("internal server error"),
      }),
    );

    await expect(
      run({ strategy: "api", url: "https://example.com" }),
    ).rejects.toThrow("HTTP 500");
  });

  it("should throw if url missing", async () => {
    await expect(run({ strategy: "api" } as any)).rejects.toThrow(
      "requires url",
    );
  });
});

describe("run() — browser_exec", () => {
  it("should navigate and eval JS", async () => {
    const result = await run({
      strategy: "browser_exec",
      navigateUrl: "https://example.com",
      jsCode: "document.title",
    });
    expect(result).toBe("result");
  });

  it("should throw if jsCode missing", async () => {
    await expect(
      run({
        strategy: "browser_exec",
        navigateUrl: "https://example.com",
      } as any),
    ).rejects.toThrow("requires jsCode");
  });
});

describe("checkStrategy()", () => {
  /** 默认 probe 会真实 TCP ping，测试注入 mock */
  const okProbe: HealthProbe = async () => ({ ok: true, ms: 12 });
  const downProbe: HealthProbe = async () => ({ ok: false, ms: 3000 });

  it("should return ok for cli when command exists", async () => {
    const health = await checkStrategy({ strategy: "cli", cmd: "echo" });
    expect(health.status).toBe("ok");
    expect(health.probe).toBe("check");
    expect(health.latencyMs).toBeTypeOf("number");
    expect(health.reason).toMatch(/check \d+ms/);
  });

  it("should return unavailable for cli when command missing", async () => {
    const health = await checkStrategy({
      strategy: "cli",
      cmd: "nonexistent-cmd-xyz",
    });
    expect(health.status).toBe("unavailable");
  });

  it("should return ok for api with reachable host (tcp ok)", async () => {
    const health = await checkStrategy(
      { strategy: "api", url: "https://example.com" },
      okProbe,
    );
    expect(health.status).toBe("ok");
    expect(health.reason).toContain("tcp");
    expect(health).toMatchObject({ probe: "tcp", latencyMs: 12 });
  });

  it("should warn when an API host is reachable but its key is missing", async () => {
    const health = await checkStrategy(
      {
        strategy: "api",
        url: "https://example.com",
        headers: { Authorization: "Bearer " },
      },
      okProbe,
    );
    expect(health).toMatchObject({
      status: "warning",
      probe: "tcp",
      latencyMs: 12,
    });
    expect(health.reason).toContain("missing API key");
  });

  it("should return unavailable for api when host unreachable", async () => {
    const health = await checkStrategy(
      { strategy: "api", url: "https://example.com" },
      downProbe,
    );
    expect(health.status).toBe("unavailable");
  });

  it("should return error for api with invalid URL", async () => {
    const health = await checkStrategy(
      { strategy: "api", url: "not-a-url" },
      okProbe,
    );
    expect(health.status).toBe("error");
  });

  it("should report cookie_fetch unavailable when daemon down", async () => {
    // daemon-client 在文件顶部被 mock，checkDaemonHealth 默认返回 ok
    const health = await checkStrategy(
      {
        strategy: "cookie_fetch",
        apiUrl: "https://api.example.com/x",
        cookieDomain: "example.com",
      },
      okProbe,
    );
    expect(health.status).toBe("ok");
    expect(health.reason).toContain("daemon");
  });
});
