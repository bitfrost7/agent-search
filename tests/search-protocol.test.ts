/**
 * Unit tests for the unified search protocol layer.
 * Tests normalization, defaults, validation — no channels, no network.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSearchRequest as normalizeRequest,
  buildEmptyResponse,
  generateResultId,
  isPseudoErrorResult,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  DEFAULT_SORT,
  DEFAULT_INTENT,
  DEFAULT_TIME_RANGE,
} from "../src/search/schema.js";
import {
  createSearchError,
  unknownChannelError,
  channelFailedError,
  unsupportedParamWarning,
} from "../src/search/errors.js";
import { validateRequestAgainstSupports } from "../src/search/channel-spec.js";
import type { UnifiedSearchRequest } from "../src/search/types.js";
import { resolveMockSpec } from "./helpers/mock-channel.js";

const normalizeSearchRequest = (req: UnifiedSearchRequest) =>
  normalizeRequest(req, resolveMockSpec);

// ── normalizeSearchRequest ──────────────────────────────────────────────────

describe("normalizeSearchRequest", () => {
  it("applies defaults for minimal request with channels", () => {
    const { normalized, warnings, errors } = normalizeSearchRequest({
      query: "hello",
      channels: ["mock"],
    });
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(normalized).not.toBeNull();
    expect(normalized!.query).toBe("hello");
    expect(normalized!.intent).toBe(DEFAULT_INTENT);
    expect(normalized!.limit).toBe(DEFAULT_LIMIT);
    expect(normalized!.page).toBe(DEFAULT_PAGE);
    expect(normalized!.sort).toBe(DEFAULT_SORT);
    expect(normalized!.timeRange).toBe(DEFAULT_TIME_RANGE);
    expect(normalized!.channels).toEqual(["mock"]);
    // 默认值填充不标记为显式传入(validate 不因此报 unsupported_param)
    expect(normalized!.sortSpecified).toBe(false);
    expect(normalized!.timeRangeSpecified).toBe(false);
  });

  it("errors when channels missing (no auto-routing)", () => {
    const { normalized, errors } = normalizeSearchRequest({ query: "hello" });
    expect(normalized).toBeNull();
    expect(
      errors.some(
        (e) =>
          e.code === "invalid_request" &&
          e.message.includes("channels is required"),
      ),
    ).toBe(true);
  });

  it("preserves explicitly provided values", () => {
    const { normalized } = normalizeSearchRequest({
      query: "react hooks",
      channels: ["mock"],
      limit: 20,
      page: 2,
      sort: "latest",
      timeRange: "week",
      language: "typescript",
      contentType: "repo",
      scope: { repo: "facebook/react" },
    });
        expect(normalized!.channels).toEqual(["mock"]);
    expect(normalized!.limit).toBe(20);
    expect(normalized!.page).toBe(2);
    expect(normalized!.sort).toBe("latest");
    expect(normalized!.timeRange).toBe("week");
    expect(normalized!.language).toBe("typescript");
    expect(normalized!.contentType).toBe("repo");
    expect(normalized!.scope).toEqual({ repo: "facebook/react" });
    // 显式传入的 sort/timeRange 标记为 specified
    expect(normalized!.sortSpecified).toBe(true);
    expect(normalized!.timeRangeSpecified).toBe(true);
  });

  it("trims query whitespace", () => {
    const { normalized } = normalizeSearchRequest({
      query: "  spaced  ",
      channels: ["mock"],
    });
    expect(normalized!.query).toBe("spaced");
  });

  it("errors on empty query", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "",
      channels: ["mock"],
    });
    expect(normalized).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("invalid_request");
  });

  it("errors on whitespace-only query", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "   ",
      channels: ["mock"],
    });
    expect(normalized).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("invalid_request");
  });

  it("warns on invalid sort and falls back to default", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      sort: "alphabetical" as never,
    });
    expect(normalized!.sort).toBe(DEFAULT_SORT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("sort");
  });

  it("warns on invalid timeRange", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      timeRange: "decade" as never,
    });
    expect(normalized!.timeRange).toBe(DEFAULT_TIME_RANGE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("timeRange");
  });

  it("warns on invalid contentType and ignores it", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      contentType: "music" as never,
    });
    expect(normalized!.contentType).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("contentType");
  });

  it("caps limit at 50 with warning", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      limit: 100,
    });
    expect(normalized!.limit).toBe(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("limit");
  });

  it("warns on zero/negative limit", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      limit: 0,
    });
    expect(normalized!.limit).toBe(DEFAULT_LIMIT);
    expect(warnings).toHaveLength(1);
  });

  it("warns on non-positive page", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      page: 0,
    });
    expect(normalized!.page).toBe(DEFAULT_PAGE);
    expect(warnings).toHaveLength(1);
  });

  it("filters invalid channels from array and keeps single channel", () => {
    const { normalized, warnings } = normalizeSearchRequest({
      query: "test",
      channels: ["mock", "", "  "],
    });
    expect(normalized!.channels).toEqual(["mock"]);
    expect(warnings).toHaveLength(0);
  });

  it("A5:errors when multiple channels provided(强制单渠道,不静默取第一个)", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "test",
      channels: ["mock", "other"],
    });
    expect(normalized).toBeNull();
    expect(
      errors.some(
        (e) => e.code === "invalid_request" && e.message.includes("单渠道"),
      ),
    ).toBe(true);
    expect(errors[0].message).toContain("单渠道");
  });

  it("errors when channels array has no valid entries", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "test",
      channels: ["", "  "],
    });
    expect(normalized).toBeNull();
    expect(errors.some((e) => e.message.includes("channels is required"))).toBe(
      true,
    );
  });

  it("rejects non-object scope", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      scope: "not-an-object" as never,
    });
    expect(normalized).toBeNull();
    expect(errors[0].message).toContain("scope must be an object");
  });

  it("rejects array scope", () => {
    const { normalized, errors } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      scope: ["array"] as never,
    });
    expect(normalized).toBeNull();
    expect(errors[0].message).toContain("scope must be an object");
  });

  it("rejects malformed external request types without throwing", () => {
    expect(
      normalizeSearchRequest({ query: 123, channels: ["mock"] } as never)
        .errors[0].message,
    ).toContain("query must be a string");
    expect(
      normalizeSearchRequest({ query: "test", channels: "mock" } as never)
        .errors[0].message,
    ).toContain("channels must be an array");
    expect(
      normalizeSearchRequest({
        query: "test",
        channels: ["mock"],
        channelParams: [],
      } as never).errors[0].message,
    ).toContain("channelParams must be an object");
  });

  it("ignores empty language string", () => {
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["mock"],
      language: "  ",
    });
    expect(normalized!.language).toBeUndefined();
  });
});

// ── buildEmptyResponse ──────────────────────────────────────────────────────

describe("buildEmptyResponse", () => {
  it("builds ok response with no errors", () => {
    const resp = buildEmptyResponse("test", [], []);
    expect(resp.ok).toBe(true);
    expect(resp.count).toBe(0);
    expect(resp.results).toEqual([]);
  });

  it("builds not-ok response with errors", () => {
    const resp = buildEmptyResponse(
      "test",
      [],
      [createSearchError("invalid_request", "bad")],
    );
    expect(resp.ok).toBe(false);
    expect(resp.errors).toHaveLength(1);
  });
});

// ── generateResultId ────────────────────────────────────────────────────────

describe("generateResultId", () => {
  it("generates id with channel prefix", () => {
    const id = generateResultId("mock", "https://mock.example/repo");
    expect(id).toMatch(/^mock_/);
  });

  it("generates different ids for different URLs", () => {
    const id1 = generateResultId("mock", "https://mock.example/repo1");
    const id2 = generateResultId("mock", "https://mock.example/repo2");
    expect(id1).not.toBe(id2);
  });

  it("generates id without url", () => {
    const id = generateResultId("web");
    expect(id).toMatch(/^web_/);
  });

  it("deterministic: 同 URL 每次结果 ID 一致(D4)", () => {
    expect(generateResultId("mock", "https://mock.example/a")).toBe(
      generateResultId("mock", "https://mock.example/a"),
    );
    expect(generateResultId("mock", "https://mock.example/a", "title")).toBe(
      generateResultId("mock", "https://mock.example/a"),
    );
  });

  it("deterministic: 无 url 用 title 兜底,同 title 同 ID", () => {
    expect(generateResultId("mock", undefined, "React")).toBe(
      generateResultId("mock", undefined, "React"),
    );
    expect(generateResultId("mock", undefined, "React")).not.toBe(
      generateResultId("mock", undefined, "Vue"),
    );
  });
});

// ── isPseudoErrorResult ─────────────────────────────────────────────────────

describe("isPseudoErrorResult", () => {
  it("detects 'search failed' pseudo results", () => {
    expect(isPseudoErrorResult("v2ex search failed")).toBe(true);
    expect(isPseudoErrorResult("bilibili search failed")).toBe(true);
  });

  it("detects '(no results)' pseudo results", () => {
    expect(isPseudoErrorResult("bilibili (no results)")).toBe(true);
  });

  it("does not flag normal titles", () => {
    expect(isPseudoErrorResult("How to use React hooks")).toBe(false);
    expect(isPseudoErrorResult("GitHub - facebook/react")).toBe(false);
  });
});

// ── Error/Warning factories ─────────────────────────────────────────────────

describe("error factories", () => {
  it("creates unknownChannelError with channel", () => {
    const err = unknownChannelError("hackernews");
    expect(err.code).toBe("unknown_channel");
    expect(err.channel).toBe("hackernews");
    expect(err.message).toContain("hackernews");
  });

  it("creates channelFailedError with detail", () => {
    const err = channelFailedError("web", "timeout");
    expect(err.code).toBe("channel_failed");
    expect(err.message).toContain("timeout");
  });

  it("creates unsupportedParamWarning with field", () => {
    const w = unsupportedParamWarning("bilibili", "language", "not supported");
    expect(w.code).toBe("unsupported_param");
    expect(w.channel).toBe("bilibili");
    expect(w.field).toBe("language");
  });
});

// ── validateRequestAgainstSupports 噪音回归 ─────────────────────────────────
// A3:默认值填充不算用户参数——不带 sort/timeRange 的请求不得对 sort:false/
// timeRange:false 渠道报 unsupported_param 假 warning。

describe("validateRequestAgainstSupports (A3 噪音回归)", () => {
  const noSortSupport = {
    limit: true,
    page: false,
    sort: false as const,
    timeRange: false as const,
    language: false,
  };

  // normalize 后的默认请求(sortSpecified/timeRangeSpecified 为 false)
  const defaultReq = {
    query: "test",
    intent: "web" as const,
    channels: ["mock"],
    limit: 5,
    page: 1,
    sort: "relevance" as const,
    timeRange: "all" as const,
  };

  it("默认请求(sort/timeRange 由引擎填充)不报 unsupported_param", () => {
    const { warnings } = validateRequestAgainstSupports(
      defaultReq,
      noSortSupport,
      "tavily",
    );
    expect(warnings.filter((w) => w.code === "unsupported_param")).toHaveLength(
      0,
    );
  });

  it("显式传不支持的 sort 仍报 warning", () => {
    const { warnings } = validateRequestAgainstSupports(
      { ...defaultReq, sort: "popular", sortSpecified: true },
      noSortSupport,
      "tavily",
    );
    expect(warnings.filter((w) => w.field === "sort")).toHaveLength(1);
  });

  it("显式传不支持的时间范围仍报 warning", () => {
    const { warnings } = validateRequestAgainstSupports(
      { ...defaultReq, timeRange: "week", timeRangeSpecified: true },
      noSortSupport,
      "tavily",
    );
    expect(warnings.filter((w) => w.field === "timeRange")).toHaveLength(1);
  });

  it("显式传默认值(relevance/all)不报 warning(默认语义任何渠道都适用)", () => {
    const { warnings } = validateRequestAgainstSupports(
      { ...defaultReq, sortSpecified: true, timeRangeSpecified: true },
      noSortSupport,
      "tavily",
    );
    expect(warnings.filter((w) => w.code === "unsupported_param")).toHaveLength(
      0,
    );
  });

  it("渠道支持列表内的时间范围不报 warning", () => {
    const { warnings } = validateRequestAgainstSupports(
      { ...defaultReq, timeRange: "week", timeRangeSpecified: true },
      {
        limit: true,
        page: false,
        sort: false,
        timeRange: ["day", "week"],
        language: false,
      },
      "bocha",
    );
    expect(warnings.filter((w) => w.field === "timeRange")).toHaveLength(0);
  });
});
