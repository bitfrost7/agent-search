/**
 * Adapter tests — DefaultAdapter strategy chain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/runner.js", () => ({
  run: vi.fn(),
  checkStrategy: vi.fn(),
}));

import { DefaultAdapter } from "../src/adapter.js";
import { run } from "../src/runner.js";

describe("DefaultAdapter", () => {
  let adapter: DefaultAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DefaultAdapter();
  });

  it("should return first success", async () => {
    vi.mocked(run).mockResolvedValueOnce("first success");

    const result = await adapter.execute([
      { strategy: "cli", cmd: "echo" },
    ]);

    expect(result.raw).toBe("first success");
    expect(result.fallbackUsed).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should fallback to next strategy on failure (E7: 记录失败原因 + fallbackUsed)", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce("second success");

    const result = await adapter.execute([
      { strategy: "cli", cmd: "nonexistent" },
      { strategy: "api", url: "https://example.com" },
    ]);

    expect(result.raw).toBe("second success");
    expect(result.fallbackUsed).toBe(true);
    expect(result.failures).toEqual([expect.stringContaining("first failed")]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should throw if all strategies fail", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new Error("first failed"))
      .mockRejectedValueOnce(new Error("second failed"));

    await expect(
      adapter.execute([
        { strategy: "cli", cmd: "nonexistent" },
        { strategy: "api", url: "bad" },
      ]),
    ).rejects.toThrow("second failed");
  });

  it("should throw on empty requests", async () => {
    await expect(adapter.execute([])).rejects.toThrow("no requests");
  });

  it("should return last error when all fail", async () => {
    vi.mocked(run)
      .mockRejectedValueOnce(new Error("err1"))
      .mockRejectedValueOnce(new Error("err2"))
      .mockRejectedValueOnce(new Error("err3"));

    await expect(
      adapter.execute([
        { strategy: "cli", cmd: "a" },
        { strategy: "cli", cmd: "b" },
        { strategy: "cli", cmd: "c" },
      ]),
    ).rejects.toThrow("err3");
  });
});
