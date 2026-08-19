/**
 * DefaultAdapter — generic strategy orchestration.
 *
 * Receives an ordered list of RunRequests from a Channel (main → fallback),
 * tries each in order, returns the first success.
 *
 * Contains zero channel-specific knowledge. All URLs, cookies, JS code,
 * and CLI commands come from the Channel via RunRequest.
 *
 * E7:返回 AdapterExecution{ raw, fallbackUsed, failures }——主策略失败原因
 * 与 fallback 命中情况可诊断,不再静默丢信息。
 */

import type { Adapter, RunRequest, AdapterExecution } from "./types.js";
import { run } from "./runner.js";

function requestLabel(req: RunRequest): string {
  const kind = req.strategy;
  if (req.cmd) return `${kind}:${req.cmd}`;
  if (req.url) {
    try {
      return `${kind}:${new URL(req.url).hostname}`;
    } catch {
      return kind;
    }
  }
  return kind;
}

export class DefaultAdapter implements Adapter {
  name = "default";

  async execute(requests: RunRequest[]): Promise<AdapterExecution> {
    if (requests.length === 0) {
      throw new Error("no requests to execute");
    }

    const failures: string[] = [];
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      try {
        return {
          raw: await run(req),
          fallbackUsed: i > 0,
          failures,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${requestLabel(req)}: ${msg}`);
      }
    }
    throw new Error(`all strategies failed: ${failures.join("; ")}`);
  }
}

/** Shared singleton — all channels use this by default. */
export const defaultAdapter = new DefaultAdapter();
