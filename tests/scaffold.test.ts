import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("new-channel scaffold", () => {
  it("creates a co-located plugin, fixtures, and a real test", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-search-channel-"));
    execFileSync(
      process.execPath,
      [
        "scripts/new-channel.mjs",
        "--name",
        "hacker-news",
        "--category",
        "public",
        "--root",
        root,
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const channel = readFileSync(
      join(root, "src/channels/public/hacker-news.ts"),
      "utf8",
    );
    const test = readFileSync(
      join(root, "tests/channels/hacker-news.test.ts"),
      "utf8",
    );
    expect(channel).toContain('name: "hacker-news"');
    expect(channel).toContain("export const spec");
    expect(channel).toContain("export const plugin");
    expect(channel).toContain('source: { channel: this.name, backend: "api" }');
    expect(channel).not.toContain("__CATEGORY__");
    expect(test).toContain("HackerNewsChannel");
    expect(
      readFileSync(join(root, "tests/fixtures/hacker-news-error.json"), "utf8"),
    ).toContain("invalid response");
  });

  it("rejects a category that could escape the channels directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-search-channel-"));
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "scripts/new-channel.mjs",
          "--name",
          "bad",
          "--category",
          "../../outside",
          "--root",
          root,
        ],
        { cwd: process.cwd(), stdio: "pipe" },
      ),
    ).toThrow();
  });
});
