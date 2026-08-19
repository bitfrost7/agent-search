/**
 * Bridge executor — connects the unified search pipeline to existing BaseChannel.
 *
 * The unified search calls `executor(channelName, params, limit)`.
 * This bridge:
 * 1. Gets the BaseChannel from Registry
 * 2. Calls BaseChannel.searchWithParams(params) directly — mapped params
 *    flow straight into buildRequests, with no CLI-arg round trip
 * 3. Uses adaptSearchResults to convert to UnifiedSearchResult[]
 *
 * Adding a new channel no longer requires touching this file: as long as
 * the channel's ChannelSpec.mapRequest produces params that its
 * buildRequests/formatResults understand, the bridge just works.
 */

import type { BaseChannel } from "../channel.js";
import type { UnifiedSearchResult, SearchWarning, SearchError } from "./types.js";
import { adaptSearchResults } from "./result-adapter.js";

// ── Bridge executor ────────────────────────────────────────────────────────

/**
 * Create a ChannelExecutor that bridges to BaseChannel.searchWithParams.
 */
export function createBridgeExecutor(
  getChannel: (name: string) => BaseChannel | undefined,
): (channelName: string, params: Record<string, unknown>, limit: number) => Promise<{ results: UnifiedSearchResult[]; warnings: SearchWarning[]; errors: SearchError[] }> {

  return async (channelName, params, limit) => {
    const ch = getChannel(channelName);
    if (!ch) {
      return {
        results: [],
        warnings: [],
        errors: [{
          code: "unknown_channel",
          message: `Channel "${channelName}" not found in registry`,
          channel: channelName,
        }],
      };
    }

    // Override limit with the per-channel allocated limit from router.
    // This ensures the global limit is distributed across channels, not duplicated.
    // (Channels that declare supports.limit=false ignore it.)
    const paramsWithLimit = { ...params, limit };

    // Call BaseChannel.searchWithParams — bypasses CLI arg parsing entirely.
    // P1:searchWithParams 返回 ChannelOutcome——错误结构化透出,不再有伪 result。
    const outcome = await ch.searchWithParams(paramsWithLimit);

    if (!outcome.ok) {
      return {
        results: [],
        warnings: [],
        errors: [{
          code: outcome.error.code === "no_request" ? "empty_results" : outcome.error.code,
          message: outcome.error.message,
          channel: outcome.error.channel ?? channelName,
        }],
      };
    }

    // Adapt to unified format
    const adapted = adaptSearchResults(outcome.results);

    // E7:ChannelWarning(fallback_used 等)转 SearchWarning 透出
    const warnings: SearchWarning[] = [
      ...(outcome.warnings ?? []).map((w) => ({
        code: (w.code === "fallback_used" ? "fallback_used" : "partial_results") as SearchWarning["code"],
        message: w.message,
        channel: w.channel,
      })),
      ...adapted.warnings,
    ];

    return {
      results: adapted.results,
      warnings,
      errors: adapted.errors,
    };
  };
}
