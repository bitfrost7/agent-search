/**
 * json-util.ts — 轻量 JSON 解析工具(E5)。
 *
 * 引擎渠道 formatResults / formatError 的解析开头逐字重复,统一抽此函数。
 * 语义:字符串尝试 JSON.parse;对象直接返回;其余/解析失败返回 null。
 */

export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/** 解析 JSON 数组(字符串或对象);失败返回 null。 */
export function parseJsonArray(raw: unknown): unknown[] | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(raw) ? raw : null;
}
