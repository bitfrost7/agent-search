/**
 * Execute — orchestrate channel execution, aggregate results.
 *
 * This is the main unified search entry point.
 * It takes a normalized request, routes it, executes channels,
 * and aggregates results into a UnifiedSearchResponse.
 */

import type {
  NormalizedSearchRequest,
  UnifiedSearchResponse,
  UnifiedSearchResult,
  SearchWarning,
  SearchError,
  SearchDiagnostics,
  ChannelDiagnostics,
} from "./types.js";
import { routeRequest, type ChannelExecutor } from "./router.js";
import { normalizeSearchRequest } from "./schema.js";
import { aggregateResults } from "./aggregate.js";
import type { UnifiedSearchRequest } from "./types.js";
import type { ChannelSpecResolver } from "./channel-spec.js";

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Execute a unified search.
 *
 * @param req - The raw unified search request from the agent
 * @param executor - A function that executes a single channel search
 * @returns UnifiedSearchResponse with aggregated results
 */
export async function unifiedSearch(
  req: UnifiedSearchRequest,
  executor: ChannelExecutor,
  resolveSpec: ChannelSpecResolver,
): Promise<UnifiedSearchResponse> {
  const startTime = Date.now();

  // 1. Normalize
  const {
    normalized,
    warnings: normWarnings,
    errors: normErrors,
  } = normalizeSearchRequest(req, resolveSpec);

  if (!normalized) {
    return {
      ok: false,
      query: req.query ?? "",
      channels: [],
      count: 0,
      results: [],
      warnings: normWarnings,
      errors: normErrors,
    };
  }

  // 2. Route
  const {
    plans,
    warnings: routeWarnings,
    errors: routeErrors,
  } = routeRequest(normalized, resolveSpec);

  const allWarnings = [...normWarnings, ...routeWarnings];
  const allErrors = [...normErrors, ...routeErrors];

  if (plans.length === 0) {
    return {
      ok: allErrors.length === 0,
      query: normalized.query,
      channels: [],
      count: 0,
      results: [],
      warnings: allWarnings,
      errors: allErrors,
    };
  }

  // 3. Execute all channels in parallel
  const channelsRequested = plans.map((p) => p.channel);
  const results = await Promise.all(
    plans.map(async (plan) => {
      if (!plan.mapping.ok || !plan.mapping.params) {
        return {
          channel: plan.channel,
          results: [],
          warnings: plan.mapping.warnings,
          errors: plan.mapping.errors,
          durationMs: 0,
        };
      }
      const chStart = Date.now();
      try {
        const execResult = await executor(
          plan.channel,
          plan.mapping.params,
          plan.limit,
        );
        return {
          channel: plan.channel,
          results: execResult.results,
          warnings: execResult.warnings,
          errors: execResult.errors,
          durationMs: Date.now() - chStart,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          channel: plan.channel,
          results: [],
          warnings: [],
          errors: [
            {
              code: "channel_failed" as const,
              message: `Channel "${plan.channel}" threw: ${msg}`,
              channel: plan.channel,
            },
          ],
          durationMs: Date.now() - chStart,
        };
      }
    }),
  );

  // 4. Collect raw results
  const rawAggregated: UnifiedSearchResult[] = [];
  const channelsSucceeded: string[] = [];
  const channelsEmpty: string[] = [];
  const channelsFailed: string[] = [];
  const perChannel: Record<string, ChannelDiagnostics> = {};

  for (const r of results) {
    allWarnings.push(...r.warnings);
    allErrors.push(...r.errors);
    perChannel[r.channel] = {
      durationMs: r.durationMs,
      resultCount: r.results.length,
    };

    if (r.errors.length > 0) {
      channelsFailed.push(r.channel);
      perChannel[r.channel].error = r.errors[0].message;
    } else {
      channelsSucceeded.push(r.channel);
      if (r.results.length > 0) rawAggregated.push(...r.results);
      else channelsEmpty.push(r.channel);
    }
  }

  // 5. Aggregate: clean summaries → deduplicate → rank → truncate
  const finalResults = aggregateResults(
    rawAggregated,
    normalized.sort,
    normalized.limit,
  );

  // 6. Build diagnostics
  const diagnostics: SearchDiagnostics = {
    durationMs: Date.now() - startTime,
    channelsRequested,
    channelsSucceeded,
    channelsEmpty,
    channelsFailed,
    perChannel,
  };

  // 7. Determine ok status
  // A successful execution may legitimately return zero matches.
  const ok = channelsSucceeded.length > 0;

  return {
    ok,
    query: normalized.query,
    channels: channelsRequested,
    count: finalResults.length,
    results: finalResults,
    warnings: allWarnings,
    errors: allErrors,
    diagnostics,
  };
}
