/**
 * Structured search errors.
 *
 * These are used throughout the unified search pipeline to represent
 * channel failures, validation errors, and other issues in a structured
 * way — instead of stuffing error messages into fake SearchResult objects.
 */

import type { SearchError, SearchErrorCode, SearchWarning, SearchWarningCode } from "./types.js";

// ── Error factory ──────────────────────────────────────────────────────────

export function createSearchError(
  code: SearchErrorCode,
  message: string,
  channel?: string,
): SearchError {
  return { code, message, channel };
}

// ── Warning factory ────────────────────────────────────────────────────────

export function createSearchWarning(
  code: SearchWarningCode,
  message: string,
  channel?: string,
  field?: string,
): SearchWarning {
  return { code, message, channel, field };
}

// ── Common error constructors ──────────────────────────────────────────────

export function unknownChannelError(channel: string): SearchError {
  return createSearchError(
    "unknown_channel",
    `Channel "${channel}" is not registered`,
    channel,
  );
}

export function channelFailedError(channel: string, detail: string): SearchError {
  return createSearchError(
    "channel_failed",
    `Channel "${channel}" failed: ${detail}`,
    channel,
  );
}

export function parseFailedError(channel: string, detail: string): SearchError {
  return createSearchError(
    "parse_failed",
    `Channel "${channel}" returned unparseable data: ${detail}`,
    channel,
  );
}

export function backendUnavailableError(channel: string): SearchError {
  return createSearchError(
    "backend_unavailable",
    `No available backend for channel "${channel}"`,
    channel,
  );
}

export function emptyResultsError(channel: string): SearchError {
  return createSearchError(
    "empty_results",
    `Channel "${channel}" returned no results`,
    channel,
  );
}

// ── Common warning constructors ────────────────────────────────────────────

export function unsupportedParamWarning(
  channel: string,
  param: string,
  detail?: string,
): SearchWarning {
  return createSearchWarning(
    "unsupported_param",
    `Channel "${channel}" does not support "${param}"${detail ? `: ${detail}` : ""}`,
    channel,
    param,
  );
}

export function paramDegradedWarning(
  channel: string,
  param: string,
  detail: string,
): SearchWarning {
  return createSearchWarning(
    "param_degraded",
    `Channel "${channel}" degraded "${param}": ${detail}`,
    channel,
    param,
  );
}

export function fallbackUsedWarning(channel: string, backend: string): SearchWarning {
  return createSearchWarning(
    "fallback_used",
    `Channel "${channel}" used fallback backend "${backend}"`,
    channel,
  );
}

export function partialResultsWarning(channel: string, detail: string): SearchWarning {
  return createSearchWarning(
    "partial_results",
    `Channel "${channel}" returned partial results: ${detail}`,
    channel,
  );
}
