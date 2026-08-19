/**
 * Turndown-based HTML → Markdown 转换工具。
 * 渠道返回 HTML 内容时，用此工具转为 Markdown。
 */
import TurndownService from "turndown";

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

// 自定义表格规则（turndown-plugin-gfm 不兼容 turndown 7.x）
turndown.addRule("table", {
  filter: "table",
  replacement: function (content: string, node: any) {
    const table = node as any;
    const rows = table.rows;
    if (!rows || rows.length === 0) return content;

    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.cells;
      const cols: string[] = [];
      for (let j = 0; j < cells.length; j++) {
        let text = cells[j].textContent?.trim() ?? "";
        // Escape pipe chars
        text = text.replace(/\|/g, "\\|");
        cols.push(text);
      }
      lines.push("| " + cols.join(" | ") + " |");

      // Header separator after first row if it's a header
      if (i === 0) {
        const sep = cols.map(() => "---");
        lines.push("| " + sep.join(" | ") + " |");
      }
    }

    return "\n\n" + lines.join("\n") + "\n\n";
  },
});

/** 判断字符串是否为 HTML */
export function isHtml(s: string): boolean {
  return /^\s*<(!doctype|html|div|p|h[1-6]|pre|table|ul|ol|section|article)/i.test(s);
}

/** HTML → Markdown */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export default turndown;