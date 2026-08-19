/**
 * agent-search CLI — unified multi-channel search.
 *
 * Usage:
 *   agent-search <channel> <query> [args]         搜索
 *   agent-search content <channel> <ref|url> [...] 按需抓正文
 *   agent-search doctor [--json]                   健康检查
 *   agent-search channel list|show <channel>       渠道管理
 *   agent-search <channel> -h                      渠道帮助
 */

import { Registry } from "./registry.js";
import { formatResults } from "./formatter.js";
import { initProxy } from "./runner.js";
import { loadEnvFiles } from "./env.js";
import { suppressNoiseWarnings } from "./warnings.js";
import { unifiedSearch } from "./search/execute.js";
import { createBridgeExecutor } from "./search/bridge-executor.js";
import { handleContent } from "./search/mcp-handlers.js";
import type { UnifiedSearchRequest } from "./search/types.js";

suppressNoiseWarnings();
loadEnvFiles();

const registry = new Registry();
const executor = createBridgeExecutor((name) => registry.get(name));

/** 公共参数名 */
const PUBLIC_PARAM_KEYS = ["query", "limit", "sort", "timeRange", "language"];

async function main() {
  await registry.init();
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printUsage();
    return;
  }

  switch (args[0]) {
    case "doctor":
      await cmdDoctor(args.includes("--json"));
      return;
    case "channel":
      await cmdChannel(args.slice(1));
      return;
    case "content":
      await cmdContent(args.slice(1));
      return;
    default:
      // <channel> <query> [args] — 无动词 = 搜索
      await cmdSearch(args);
      return;
  }
}

function printUsage() {
  console.log(`agent-search — unified multi-channel search CLI

Usage:
  agent-search <channel> <query> [args]         搜索
  agent-search content <channel> <ref|url> [...] 按需抓正文
  agent-search <channel> -h                      渠道帮助
  agent-search channel list|show <channel>       渠道管理
  agent-search doctor [--json]                   健康检查

Channels: ${registry.names().join(", ") || "none"}`);
}

async function cmdDoctor(json: boolean) {
  const channels = registry.list();
  await initProxy();
  const healthResults = await Promise.all(
    channels.map(async (ch) => {
      const health = await ch.health();
      return { name: ch.name, category: ch.category, ...health };
    }),
  );
  if (json) {
    console.log(JSON.stringify(healthResults, null, 2));
  } else {
    const header = `${"channel".padEnd(16)} ${"category".padEnd(14)} ${"status".padEnd(12)} backends`;
    console.log(header);
    console.log("-".repeat(80));
    for (const r of healthResults) {
      const backends = r.backends ?? [];
      if (backends.length === 0) {
        console.log(
          `${String(r.name).padEnd(16)} ${String(r.category).padEnd(14)} ${String(r.status).padEnd(12)} ${r.reason}`,
        );
      } else {
        const b0 = backends[0];
        const d0 = b0.detail ? ` (${b0.detail})` : "";
        console.log(
          `${String(r.name).padEnd(16)} ${String(r.category).padEnd(14)} ${String(r.status).padEnd(12)} ${b0.name}: ${b0.status}${d0}`,
        );
        for (let i = 1; i < backends.length; i++) {
          const b = backends[i];
          const d = b.detail ? ` (${b.detail})` : "";
          console.log(
            `${"".padEnd(16)} ${"".padEnd(14)} ${"".padEnd(12)} ${b.name}: ${b.status}${d}`,
          );
        }
      }
    }
  }
}

async function cmdChannel(args: string[]) {
  if (args.length === 0) {
    console.error("usage: agent-search channel <list|show>");
    process.exit(1);
  }
  switch (args[0]) {
    case "list":
      for (const ch of registry.list()) {
        console.log(`${ch.name.padEnd(18)} ${ch.category}`);
      }
      break;
    case "show":
      if (!args[1]) {
        console.error("usage: agent-search channel show <channel>");
        process.exit(1);
      }
      const ch = registry.get(args[1]);
      if (!ch) {
        console.error(`unknown channel: ${args[1]}`);
        process.exit(1);
      }
      console.log(ch.help());
      break;
    default:
      console.error(`unknown channel subcommand: ${args[0]}`);
      process.exit(1);
  }
}

async function cmdContent(args: string[]) {
  const channelName = args[0];
  const ch = registry.get(channelName);
  if (!ch) {
    console.error(`unknown channel: ${channelName}`);
    console.error(`available: ${registry.names().join(", ")}`);
    process.exit(1);
  }

  const targets = args.slice(1);
  if (targets.length === 0) {
    console.error(`usage: agent-search content ${channelName} <ref|url> [...]`);
    process.exit(1);
  }

  try {
    const out = await handleContent(
      { channel: channelName, refs: targets },
      fetchChannelContent,
      (cname) => {
        const c = registry.get(cname);
        return c ? { supportsContent: c.supportsContent } : undefined;
      },
    );
    console.log(out);
  } catch (err) {
    console.error(`content failed: ${err}`);
    process.exit(1);
  }
}

async function fetchChannelContent(cname: string, ref: string) {
  const c = registry.get(cname);
  if (!c) throw new Error(`unknown channel: ${cname}`);
  return c.content(ref, []);
}

async function cmdSearch(args: string[]) {
  const channelName = args[0];
  const ch = registry.get(channelName);
  if (!ch) {
    console.error(`unknown channel: ${channelName}`);
    console.error(`available: ${registry.names().join(", ")}`);
    process.exit(1);
  }

  if (args.includes("-h") || args.includes("--help")) {
    console.log(ch.help());
    return;
  }

  if (args.length < 2) {
    console.error(`usage: agent-search ${channelName} <query> [args]`);
    process.exit(1);
  }

  const query = args[1];
  const channelArgs = args.slice(2);

  try {
    const params = ch.parseArgs(query, channelArgs);
    const channelParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!PUBLIC_PARAM_KEYS.includes(k)) channelParams[k] = v;
    }
    const req: UnifiedSearchRequest = {
      query: String(params.query || query),
      channels: [channelName],
      limit: params.limit as number | undefined,
      sort: params.sort as UnifiedSearchRequest["sort"],
      timeRange: params.timeRange as UnifiedSearchRequest["timeRange"],
      language: params.language as string | undefined,
      channelParams: Object.keys(channelParams).length > 0 ? channelParams : undefined,
    };
    const resp = await unifiedSearch(req, executor, (name) => registry.getSpec(name));
    if (resp.errors.length > 0 && resp.results.length === 0) {
      console.error(`search failed: ${resp.errors.map((e) => e.message).join("; ")}`);
      process.exit(1);
    }
    console.log(formatResults(resp.results, "text"));
  } catch (err) {
    console.error(`search failed: ${err}`);
    process.exit(1);
  }
}

main();