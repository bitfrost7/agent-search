/**
 * text-extract.ts — 轻量正文提取（零依赖，无 DOM）。
 *
 * 各渠道 content() 的本地 fallback 用：fetch 原始 HTML 后提取正文纯文本。
 * 质量不如 Jina Reader / readability，但无需 API key、国内可直连。
 */

const NOISE_BLOCK_RE =
  /<(?:script|style|noscript|nav|header|footer|aside|form|iframe|svg)[\s\S]*?<\/(?:script|style|noscript|nav|header|footer|aside|form|iframe|svg)>/gi;

/** 从 HTML 中粗提取正文纯文本。 */
export function extractPlainText(html: string, maxLen = 20000): string {
  let s = html;
  // 去掉脚本/样式/注释/噪音标签块
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(NOISE_BLOCK_RE, " ");
  // 优先取 article/main 主体
  const m =
    s.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    s.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (m) s = m[1];
  // 去掉剩余标签 + 解码实体
  s = s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, maxLen);
}
