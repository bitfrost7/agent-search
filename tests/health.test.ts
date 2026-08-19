import { describe, expect, it } from "vitest";
import { BaseChannel } from "../src/channel.js";
import type { RunRequest, SearchResult } from "../src/types.js";

class QueryRequiredChannel extends BaseChannel {
  name = "query-required";
  category = "test";

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    return params.query ? [{ strategy: "cli", cmd: "echo" }] : [];
  }

  formatResults(): SearchResult[] {
    return [];
  }
}

describe("BaseChannel.health()", () => {
  it("builds query-required probes and reports structured latency", async () => {
    const health = await new QueryRequiredChannel().health();

    expect(health.status).toBe("ok");
    expect(health.backends).toHaveLength(1);
    expect(health.backends?.[0]).toMatchObject({
      name: "echo",
      status: "ok",
      probe: "check",
    });
    expect(health.backends?.[0].latencyMs).toBeTypeOf("number");
  });
});
