/**
 * result-schema.ts — ChannelResult 结构校验(P1)。
 *
 * 渠道 formatResults 的输出在此做运行时校验(对应 Go struct tag + validate):
 * contract test 对每个渠道的输出校验,防字段漂移/结构破损。
 *
 * 说明:typebox 1.x 未导出 Check/Value 校验 API(0.3x 的 API 已移除),
 * 这里用轻量纯函数校验同等的结构约束。typebox 仍用于 MCP 工具参数 schema。
 */

import type { SearchResult } from "../types.js";

export interface ChannelResultViolation {
  field: string;
  message: string;
}

/** 校验单个 ChannelResult;返回违规列表(空 = 合法)。 */
export function validateChannelResult(r: unknown): ChannelResultViolation[] {
  const violations: ChannelResultViolation[] = [];
  if (typeof r !== "object" || r === null) {
    return [{ field: "$", message: "result 不是对象" }];
  }
  const o = r as Record<string, unknown>;
  if (typeof o.title !== "string") {
    violations.push({ field: "title", message: "title 必须是 string" });
  }
  if (o.url !== undefined && typeof o.url !== "string") {
    violations.push({ field: "url", message: "url 必须是 string" });
  }
  if (o.ref !== undefined && typeof o.ref !== "string") {
    violations.push({ field: "ref", message: "ref 必须是 string" });
  }
  if (typeof o.snippet !== "string") {
    violations.push({ field: "snippet", message: "snippet 必须是 string" });
  }
  if (
    typeof o.source !== "object" ||
    o.source === null ||
    Array.isArray(o.source)
  ) {
    violations.push({ field: "source", message: "source 必须是 object" });
  } else {
    const source = o.source as Record<string, unknown>;
    if (typeof source.channel !== "string" || source.channel.length === 0) {
      violations.push({
        field: "source.channel",
        message: "source.channel 必须是非空 string",
      });
    }
    if (source.backend !== undefined && typeof source.backend !== "string") {
      violations.push({
        field: "source.backend",
        message: "source.backend 必须是 string",
      });
    }
  }
  if (
    o.meta !== undefined &&
    (typeof o.meta !== "object" || o.meta === null || Array.isArray(o.meta))
  ) {
    violations.push({ field: "meta", message: "meta 必须是 object" });
  }
  return violations;
}

/** 校验 ChannelResult[];返回每个结果的违规列表(空 = 全部合法)。 */
export function validateChannelResultList(
  results: unknown,
): ChannelResultViolation[][] {
  if (!Array.isArray(results)) {
    return [[{ field: "$", message: "formatResults 输出必须是数组" }]];
  }
  return results.map((r) => validateChannelResult(r));
}
