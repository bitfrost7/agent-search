/**
 * env.ts — lightweight .env loader (zero-dependency).
 *
 * 加载顺序（不覆盖已存在的进程环境变量）：
 *   1. 项目根 .env
 *   2. ~/.config/agent-search/.env
 *
 * 用途：API key 等敏感配置集中放用户级文件，不依赖 shell 环境
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

function parseEnvContent(content: string): void {
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // 兼容 export 前缀行（dotenv 常见风格）
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // 去引号（"..." / '...'）
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // 不覆盖已存在的环境变量（环境变量优先，.env 兜底）
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** 加载 .env 文件（项目根 + 用户级），幂等。 */
export function loadEnvFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/env.ts → 项目根；dist/env.js → 项目根
  const projectRoot = resolve(here, "..");
  const candidates = [
    resolve(projectRoot, ".env"),
    resolve(homedir(), ".config", "agent-search", ".env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) parseEnvFile(file);
  }
}

function parseEnvFile(file: string): void {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return;
  }
  parseEnvContent(content);
}

/** 测试用：直接解析 .env 内容（环境变量优先，缺失才写入） */
export function applyEnvContent(content: string): void {
  parseEnvContent(content);
}
