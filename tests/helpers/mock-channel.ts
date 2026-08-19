/**
 * Mock channel + spec — generic pipeline test fixture.
 *
 * 通用管道测试(router / protocol / mcp-handlers)只依赖这个 mock,
 * 不引用任何真实渠道 —— 增删渠道不会波及这些测试。
 * 真实渠道的契约由 tests/contract 统一兜底。
 */

import { BaseChannel } from "../../src/channel.js";
import { defineChannelPlugin, defineChannelSpec } from "../../src/plugin.js";
import { validateRequestAgainstSupports } from "../../src/search/channel-spec.js";
import type { SearchResult, RunRequest } from "../../src/types.js";

export const mockSpec = defineChannelSpec<{
  query: string;
  limit: number;
  type?: string;
}>({
  name: "mock",
  category: "test",
  description: "Mock channel for generic pipeline tests",
  intents: ["web"],
  contentTypes: ["web_page"],
  supports: {
    limit: true,
    page: false,
    sort: ["relevance"],
    timeRange: false,
    language: true,
    contentType: ["web_page"],
  },
  channelParams: {
    type: {
      type: "string",
      enum: ["a", "b"],
      default: "a",
      description: "枚举参数(测试用)",
    },
  },
  defaults: { limit: 5, sort: "relevance" },
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    return {
      ok: errors.length === 0,
      params: {
        query: req.query,
        limit: req.limit,
        type: (req.channelParams?.type as string | undefined) ?? "a",
      },
      warnings,
      errors,
    };
  },
});

export class MockChannel extends BaseChannel {
  name = mockSpec.name;
  category = mockSpec.category;
  channelSpec = mockSpec;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    return [
      {
        strategy: "api",
        url: `https://mock.example/search?q=${encodeURIComponent(
          String(params.query ?? ""),
        )}`,
      },
    ];
  }

  formatResults(
    _raw: unknown,
    _params: Record<string, unknown>,
  ): SearchResult[] {
    return [];
  }
}

export const mockPlugin = defineChannelPlugin(mockSpec, MockChannel);

/** 只认 "mock"/"mock2" 的 spec 解析器(替代真实 registry) */
export const resolveMockSpec = (name: string) =>
  name === "mock" || name === "mock2" ? mockSpec : undefined;

/** 返回 MockChannel 实例的 getChannel(替代真实 registry.get) */
export const getMockChannel = (name: string) =>
  name === "mock" || name === "mock2" ? new MockChannel() : undefined;
