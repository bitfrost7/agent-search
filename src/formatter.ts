/**
 * Formatter — 输出层渲染。
 *
 * 只做渲染,不做业务判断:数据由引擎层(unified pipeline)保证统一结构
 * (title/url/ref/summary 恒存在,ref 由引擎层归一 = 渠道 ref ?? url)。
 * 输出层不关心字段语义,有就显示。
 */

import type { UnifiedSearchResult } from "./search/types.js";

export function formatResults(
  results: UnifiedSearchResult[],
  format: "json" | "text" | "md" | "markdown",
): string {
  if (format === "json") {
    return JSON.stringify(results, null, 2);
  }

  if (format === "md" || format === "markdown") {
    return formatMarkdown(results);
  }

  // Text format — 无脑渲染全部字段
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[${r.source.channel}${r.source.backend ? "/" + r.source.backend : ""}] ${r.title}`);
    if (r.url) lines.push(`  url: ${r.url}`);
    if (r.ref) lines.push(`  ref: ${r.ref}`);
    if (r.summary) lines.push(`  ${r.summary}`);
  }
  return lines.join("\n");
}

function formatMarkdown(results: UnifiedSearchResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    const title = r.title || "Untitled";
    if (r.url) {
      lines.push(`- [${title}](${r.url})`);
    } else {
      lines.push(`- **${title}**`);
    }
    lines.push(`  _source: ${r.source.channel}_`);
    if (r.ref) {
      lines.push(`  _ref: ${r.ref}_`);
    }
    if (r.summary) {
      lines.push(`  > ${r.summary.replace(/\n/g, "\n  ")}`);
    }
    if (r.meta && Object.keys(r.meta).length > 0) {
      const metaStr = Object.entries(r.meta)
        .filter(([_, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ");
      if (metaStr) lines.push(`  _${metaStr}_`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
