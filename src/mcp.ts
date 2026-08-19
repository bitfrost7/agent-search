/**
 * agent-search MCP entry (src/mcp.ts) — unified search protocol over stdio JSON-RPC.
 *
 * Tools:
 *   search        — unified search entry, returns JSON envelope
 *   content       — fetch full content by channel + url
 *   channels      — list channels with capabilities (JSON)
 *   channel_debug — low-level channel help/health (for development)
 *
 * This is the MCP entry point — agents use the unified API
 * (no channel-specific extra_args needed). bin/mcp-server.js is a compat shim.
 */

import { Registry } from "./registry.js";
import { loadEnvFiles } from "./env.js";
import { suppressNoiseWarnings } from "./warnings.js";
import { createBridgeExecutor } from "./search/bridge-executor.js";
import {
  TOOL_SCHEMAS,
  handleSearch,
  handleContent,
  handleChannels,
  handleChannelDebug,
  createCachedHealthChecker,
} from "./search/mcp-handlers.js";

suppressNoiseWarnings();
loadEnvFiles();
import { createInterface } from "node:readline";

// ── Registry init ──────────────────────────────────────────────────────────

const registry = new Registry();
await registry.init();

const bridgeExecutor = createBridgeExecutor((name) => registry.get(name));
const getHealth = createCachedHealthChecker(async (name: string) => {
  const ch = registry.get(name);
  if (!ch) return { status: "error", reason: "not found" };
  const health = await ch.health();
  return { status: health.status, reason: health.reason };
});

// ── MCP message handlers ───────────────────────────────────────────────────

function handleInitialize(id: number | string | null) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-search", version: "0.1.0" },
    },
  };
}

function handleToolsList(id: number | string | null) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: Object.values(TOOL_SCHEMAS),
    },
  };
}

async function handleToolCall(
  id: number | string | null,
  name: string,
  args: Record<string, unknown>,
) {
  let resultText: string;

  try {
    switch (name) {
      case "search":
        resultText = await handleSearch(
          args as never,
          bridgeExecutor,
          (channel) => registry.getSpec(channel),
        );
        break;
      case "content":
        resultText = await handleContent(
          args as { channel: string; url?: string; refs?: string[] },
          async (channel, refOrUrl) => {
            const ch = registry.get(channel);
            if (!ch) throw new Error(`unknown channel: ${channel}`);
            return ch.content(refOrUrl, []);
          },
          (channel) => {
            const ch = registry.get(channel);
            return ch ? { supportsContent: ch.supportsContent } : undefined;
          },
        );
        break;
      case "channels":
        resultText = await handleChannels(
          () =>
            registry.list().map((ch) => ({
              name: ch.name,
              category: ch.category,
              helpMsg: ch.helpMsg,
              supportsContent: ch.supportsContent,
            })),
          getHealth,
          (channel) => registry.getSpec(channel),
        );
        break;
      case "channel_debug":
        resultText = await handleChannelDebug(
          args as { channel: string; action: string },
          (name) => registry.get(name),
          getHealth,
          (channel) => registry.getSpec(channel),
        );
        break;
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
    }
  } catch (err) {
    resultText = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: resultText }] },
  };
}

// ── Main loop (JSON-RPC over stdin/stdout) ─────────────────────────────────

type RpcId = number | string | null;

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function processLine(line: string): Promise<unknown | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return rpcError(null, -32600, "Invalid Request");
  }

  const msg = value as {
    jsonrpc?: unknown;
    method?: unknown;
    id?: unknown;
    params?: unknown;
  };
  const id: RpcId =
    typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  }

  try {
    switch (msg.method) {
      case "initialize":
        return isNotification ? null : handleInitialize(id!);
      case "notifications/initialized":
        return null;
      case "tools/list":
        return isNotification ? null : handleToolsList(id!);
      case "tools/call": {
        if (
          !msg.params ||
          typeof msg.params !== "object" ||
          Array.isArray(msg.params)
        ) {
          return isNotification ? null : rpcError(id, -32602, "Invalid params");
        }
        const params = msg.params as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") {
          return isNotification
            ? null
            : rpcError(id, -32602, "tools/call requires a tool name");
        }
        const args =
          params.arguments === undefined
            ? {}
            : params.arguments &&
                typeof params.arguments === "object" &&
                !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : null;
        if (!args)
          return isNotification
            ? null
            : rpcError(id, -32602, "tool arguments must be an object");
        if (isNotification) {
          await handleToolCall(0, params.name, args);
          return null;
        }
        return handleToolCall(id!, params.name, args);
      }
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      default:
        return isNotification
          ? null
          : rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return isNotification
      ? null
      : rpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

const rl = createInterface({ input: process.stdin });
const pending = new Set<Promise<void>>();
for await (const line of rl) {
  const task = processLine(line).then((response) => {
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  pending.add(task);
  void task.finally(() => pending.delete(task));
}
await Promise.allSettled([...pending]);
