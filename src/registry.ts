/**
 * Registry — discover and load channel modules.
 *
 * Channels live under src/channels/public/ and src/channels/internal/.
 * Each file exports a `default` class extending BaseChannel.
 *
 * Channels are loaded lazily on first access via init().
 */

import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseChannel } from "./channel.js";
import type { ChannelSpec } from "./search/channel-spec.js";
import type { ChannelConstructor } from "./plugin.js";

const __filename = fileURLToPath(import.meta.url);
const _scriptDir = dirname(__filename);
const _projectRoot = resolve(_scriptDir, "..");
// Detect: running from dist/ (compiled) or src/ (tsx dev)
const _isDist = _scriptDir.endsWith("/dist") || _scriptDir.endsWith("\\dist");
const _srcOrDist = _isDist ? "dist" : "src";
const CHANNELS_PUBLIC = join(_projectRoot, _srcOrDist, "channels", "public");
const CHANNELS_INTERNAL = join(
  _projectRoot,
  _srcOrDist,
  "channels",
  "internal",
);
export interface ChannelLoadError {
  path: string;
  message: string;
}

export function isChannelModuleFile(file: string): boolean {
  return (
    (file.endsWith(".js") ||
      (file.endsWith(".ts") && !file.endsWith(".d.ts"))) &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".spec.ts")
  );
}

export class Registry {
  channels: Map<string, BaseChannel> = new Map();
  private specs: Map<string, ChannelSpec> = new Map();
  private sources: Map<string, string> = new Map();
  private loadErrors: ChannelLoadError[] = [];
  private _loaded = false;

  async init(): Promise<void> {
    if (this._loaded) return;
    await this._loadDir(CHANNELS_PUBLIC);
    await this._loadDir(CHANNELS_INTERNAL);
    this._loaded = true;
  }

  private async _loadDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(isChannelModuleFile);
    // Sequential loading: jiti (pi extension loader) has a race condition on
    // concurrent dynamic imports that share a common dependency (channel.ts) —
    // the losing loads get a partially-initialized module ("Class extends value
    // undefined"). Sequential is ~ms for a handful of files and safe everywhere.
    for (const f of files) {
      await this._loadFile(join(dir, f));
    }
  }

  private async _loadFile(path: string): Promise<void> {
    try {
      const mod = await import(path);
      const Cls: ChannelConstructor | undefined =
        mod.plugin?.Channel ?? mod.default ?? mod.Channel;
      if (!Cls) return;
      const instance = new Cls();
      if (!instance.name) throw new Error("channel name is empty");
      const spec = (mod.plugin?.spec ?? mod.spec) as ChannelSpec | undefined;
      if (!spec)
        throw new Error(`channel "${instance.name}" does not export a spec`);
      if (spec.name !== instance.name) {
        throw new Error(
          `spec.name "${spec.name}" does not match channel.name "${instance.name}"`,
        );
      }
      if (spec.category !== instance.category) {
        throw new Error(
          `spec.category "${spec.category}" does not match channel.category "${instance.category}"`,
        );
      }
      const previous = this.sources.get(instance.name);
      if (previous)
        throw new Error(
          `duplicate channel "${instance.name}" already loaded from ${previous}`,
        );
      instance.channelSpec = spec;
      this.channels.set(instance.name, instance);
      this.specs.set(instance.name, spec);
      this.sources.set(instance.name, path);
    } catch (err) {
      this.loadErrors.push({
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(name: string): BaseChannel | undefined {
    return this.channels.get(name);
  }

  getSpec(name: string): ChannelSpec | undefined {
    return this.specs.get(name);
  }

  errors(): readonly ChannelLoadError[] {
    return this.loadErrors;
  }

  list(): BaseChannel[] {
    return [...this.channels.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  names(): string[] {
    return [...this.channels.keys()].sort();
  }
}
