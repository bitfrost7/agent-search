/**
 * Router — resolve channels by intent, validate against specs,
 * and produce per-channel execution plans.
 *
 * No I/O — pure function, fully unit-testable with mocks.
 */

import type {
  NormalizedSearchRequest,
  SearchWarning,
  SearchError,
  UnifiedSearchResult,
} from "./types.js";
import type {
  ChannelSpec,
  ChannelMappingResult,
  ChannelSpecResolver,
} from "./channel-spec.js";
import { validateChannelParams } from "./channel-spec.js";
import { unknownChannelError } from "./errors.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChannelExecutionPlan {
  channel: string;
  spec: ChannelSpec;
  mapping: ChannelMappingResult;
  /** Per-channel limit — allocated from the global limit */
  limit: number;
}

export interface RoutingResult {
  plans: ChannelExecutionPlan[];
  warnings: SearchWarning[];
  errors: SearchError[];
}

// ── Limit allocator ────────────────────────────────────────────────────────

/**
 * Allocate the global limit across N channels.
 * Each channel gets ceil(limit / N) so that the total is at least `limit`.
 */
export function allocateLimit(
  totalLimit: number,
  channelCount: number,
): number {
  if (channelCount <= 0) return 0;
  return Math.ceil(totalLimit / channelCount);
}

// ── Main router ────────────────────────────────────────────────────────────

/**
 * Route a normalized request to channel execution plans.
 *
 * Steps:
 * 1. Resolve channels (explicit or intent-based)
 * 2. Validate each channel has a spec
 * 3. Map request to channel-specific params via spec.mapRequest
 * 4. Allocate limit across channels
 */
export function routeRequest(
  req: NormalizedSearchRequest,
  resolveSpec: ChannelSpecResolver,
): RoutingResult {
  const warnings: SearchWarning[] = [];
  const errors: SearchError[] = [];
  const plans: ChannelExecutionPlan[] = [];

  // 1. Resolve channels (explicit — single channel enforced at normalize)
  const channelNames = req.channels;

  if (channelNames.length === 0) {
    errors.push({
      code: "invalid_request",
      message:
        "channels is required — 先调用 agent_channels 查看渠道清单,选择渠道后显式指定",
    });
    return { plans, warnings, errors };
  }

  // 2. Validate each channel has a spec
  const validSpecs: ChannelSpec[] = [];
  for (const name of channelNames) {
    const spec = resolveSpec(name);
    if (!spec) {
      errors.push(unknownChannelError(name));
    } else {
      validSpecs.push(spec);
    }
  }

  if (validSpecs.length === 0) {
    return { plans, warnings, errors };
  }

  // 3. Allocate limit (channels that don't support limit get their default)
  const baseLimit = allocateLimit(req.limit, validSpecs.length);

  // 4. 校验专有参数 + 映射请求
  for (const spec of validSpecs) {
    // Validate and clean channel-specific parameters before mapping.
    const {
      valid,
      warnings: cpWarnings,
      errors: cpErrors,
    } = validateChannelParams(req.channelParams, spec.channelParams, spec.name);
    warnings.push(...cpWarnings);
    errors.push(...cpErrors);
    if (cpErrors.length > 0) continue;

    const mapReq: NormalizedSearchRequest = {
      ...req,
      channelParams: valid,
    };
    const mapping = spec.mapRequest(mapReq);

    // Collect warnings/errors from mapping
    warnings.push(...mapping.warnings);
    errors.push(...mapping.errors);
    if (!mapping.ok || !mapping.params) continue;

    // Channels declaring supports.limit=false (e.g. v2ex)
    // ignore the allocated limit and use their own default.
    const limit =
      spec.supports.limit === false ? spec.defaults.limit : baseLimit;

    plans.push({
      channel: spec.name,
      spec,
      mapping,
      limit,
    });
  }

  return { plans, warnings, errors };
}

// ── Channel executor type ──────────────────────────────────────────────────

/**
 * A function that executes a channel search and returns raw results.
 * The router/executor layer calls this — in production it's wired to
 * BaseChannel.search, in tests it's mocked.
 */
export type ChannelExecutor = (
  channelName: string,
  params: Record<string, unknown>,
  limit: number,
) => Promise<{
  results: UnifiedSearchResult[];
  warnings: SearchWarning[];
  errors: SearchError[];
}>;
