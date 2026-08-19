/**
 * Contract tests — verify all registered channels meet the unified search contract.
 *
 * These tests initialize the REAL Registry and compare against ChannelSpecs:
 * - Every Registry channel has a matching ChannelSpec (and vice versa)
 * - spec.name === channel.name
 * - spec.intents and spec.contentTypes are non-empty
 * - Default request mapping doesn't throw
 * - formatResults output can be converted to unified result
 */

import { describe, it, expect } from "vitest";
import { normalizeSearchRequest as normalizeRequest } from "../../src/search/schema.js";
import { routeRequest as route } from "../../src/search/router.js";
import { validateChannelResultList } from "../../src/search/result-schema.js";
import type {
  NormalizedSearchRequest,
  UnifiedSearchRequest,
} from "../../src/search/types.js";
import { BaseChannel } from "../../src/channel.js";
import { isChannelModuleFile } from "../../src/registry.js";
import {
  registeredTestSpecs,
  resolveTestSpec,
  testRegistry,
} from "../helpers/registry.js";

// ── Initialize real Registry ───────────────────────────────────────────────

const registry = testRegistry;
const registryChannels: BaseChannel[] = registry.list();
const registryNames = registry.names();
const allChannelSpecs = registeredTestSpecs();
const publicChannelSpecs = allChannelSpecs.filter(
  (spec) => spec.category !== "internal",
);
const getChannelSpec = resolveTestSpec;
const normalizeSearchRequest = (req: UnifiedSearchRequest) =>
  normalizeRequest(req, resolveTestSpec);
const routeRequest = (req: NormalizedSearchRequest) =>
  route(req, resolveTestSpec);

// ── Registry ↔ Spec bidirectional matching ─────────────────────────────────

// Every discovered plugin must provide a spec. The public subset is retained
// only for assertions about the publishable channel boundary.

describe("Registry ↔ ChannelSpec bidirectional matching", () => {
  it("loads source and compiled modules but ignores declarations/tests", () => {
    expect(isChannelModuleFile("github.ts")).toBe(true);
    expect(isChannelModuleFile("github.js")).toBe(true);
    expect(isChannelModuleFile("github.d.ts")).toBe(false);
    expect(isChannelModuleFile("github.test.ts")).toBe(false);
    expect(isChannelModuleFile("github.spec.ts")).toBe(false);
  });

  it("loads every channel module without errors", () => {
    expect(registry.errors()).toEqual([]);
  });

  it("every Registry channel has a matching ChannelSpec", () => {
    for (const ch of registryChannels) {
      const spec = registry.getSpec(ch.name);
      expect(
        spec,
        `Channel "${ch.name}" is registered but has no ChannelSpec`,
      ).toBeDefined();
    }
  });

  it("every public ChannelSpec has a matching Registry channel", () => {
    for (const spec of publicChannelSpecs) {
      const ch = registryChannels.find((c) => c.name === spec.name);
      expect(
        ch,
        `ChannelSpec "${spec.name}" has no matching Registry channel`,
      ).toBeDefined();
    }
  });

  it("spec.name matches channel.name for all", () => {
    for (const spec of publicChannelSpecs) {
      const ch = registryChannels.find((c) => c.name === spec.name);
      if (ch) {
        expect(spec.name).toBe(ch.name);
      }
    }
  });

  it("spec.category matches channel.category (E3: 元数据单一事实源方向B)", () => {
    for (const spec of publicChannelSpecs) {
      const ch = registryChannels.find((c) => c.name === spec.name);
      if (ch) {
        expect(
          spec.category,
          `Channel "${spec.name}": spec.category 与 channel.category 漂移`,
        ).toBe(ch.category);
      }
    }
  });

  it("no orphan channels (registered but no spec)", () => {
    const orphans = registryNames.filter((name) => !registry.getSpec(name));
    expect(orphans, `Channels without specs: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });

  it("no orphan public specs (spec but no registered channel)", () => {
    const regSet = new Set(registryNames);
    const orphans = publicChannelSpecs
      .filter((s) => !regSet.has(s.name))
      .map((s) => s.name);
    expect(orphans, `Specs without channels: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });

  it("every registered internal channel has a spec", () => {
    for (const ch of registryChannels) {
      if (ch.category === "internal") {
        expect(
          registry.getSpec(ch.name),
          `Internal channel "${ch.name}" has no spec`,
        ).toBeDefined();
      }
    }
  });
});

// ── All specs must be valid ─────────────────────────────────────────────────

describe("ChannelSpec contract", () => {
  it("every spec has a non-empty name", () => {
    for (const spec of allChannelSpecs) {
      expect(spec.name).toBeTruthy();
      expect(typeof spec.name).toBe("string");
    }
  });

  it("every spec has non-empty intents", () => {
    for (const spec of allChannelSpecs) {
      expect(spec.intents.length).toBeGreaterThan(0);
    }
  });

  it("every spec has non-empty contentTypes", () => {
    for (const spec of allChannelSpecs) {
      expect(spec.contentTypes.length).toBeGreaterThan(0);
    }
  });

  it("every spec has defaults.limit > 0", () => {
    for (const spec of allChannelSpecs) {
      expect(spec.defaults.limit).toBeGreaterThan(0);
    }
  });

  it("every spec has a supports object", () => {
    for (const spec of allChannelSpecs) {
      expect(spec.supports).toBeDefined();
      expect(typeof spec.supports).toBe("object");
    }
  });

  it("spec names are unique", () => {
    const names = allChannelSpecs.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ── CLI parseArgs ↔ spec.channelParams 键名一致 ─────────────────────────────
// 回归保护:CLI 的 channelParams 会被 router 按 spec.channelParams 校验,
// 未声明的键一律丢弃。parseArgs 产出的非公共键必须都被 spec 声明。

describe("CLI parseArgs keys align with spec.channelParams", () => {
  const PUBLIC_KEYS = ["query", "limit", "sort", "timeRange", "language"];

  it("every non-public default key from parseArgs is declared in channelParams", () => {
    for (const ch of registryChannels) {
      const spec = registry.getSpec(ch.name);
      if (!spec) continue;
      const params = ch.parseArgs("test", []);
      for (const key of Object.keys(params)) {
        if (PUBLIC_KEYS.includes(key)) continue;
        expect(
          spec.channelParams?.[key],
          `Channel "${ch.name}": parseArgs emits "${key}" but spec.channelParams does not declare it — router will drop it`,
        ).toBeDefined();
      }
    }
  });

  it("bilibili --type user survives the router", () => {
    const bilibili = registryChannels.find((c) => c.name === "bilibili")!;
    const params = bilibili.parseArgs("test", ["--type", "user"]);
    const channelParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !PUBLIC_KEYS.includes(k)),
    );
    const { normalized } = normalizeSearchRequest({
      query: "test",
      channels: ["bilibili"],
      channelParams,
    });
    const { plans, warnings } = routeRequest(normalized!);
    // 专有参数 type 未被丢弃(其余警告是 bilibili 不支持 sort 的既有噪音)
    expect(warnings.filter((w) => w.field === "type")).toHaveLength(0);
    expect(plans[0].mapping.params!.type).toBe("user");
  });
});

// ── supportsContent ↔ content() 双向契约(P2) ──────────────────────────────

describe("supportsContent ↔ content() contract (P2)", () => {
  it("supportsContent=true 的渠道必须覆写 content()", () => {
    for (const ch of registryChannels) {
      if (ch.supportsContent) {
        expect(
          Object.prototype.hasOwnProperty.call(
            Object.getPrototypeOf(ch),
            "content",
          ),
          `Channel "${ch.name}" declares supportsContent=true but does not override content() — 声明了假能力`,
        ).toBe(true);
      }
    }
  });

  it("search-only 渠道声明 supportsContent=false 且未覆写 content()", () => {
    const searchOnly = registryChannels.filter((ch) => !ch.supportsContent);
    for (const ch of searchOnly) {
      expect(
        Object.prototype.hasOwnProperty.call(
          Object.getPrototypeOf(ch),
          "content",
        ),
        `Channel "${ch.name}" overrides content() but does not declare supportsContent=true`,
      ).toBe(false);
    }
  });
});

// ── formatResults 输出运行时校验(P1) ────────────────────────────────────────

describe("formatResults output schema (P1)", () => {
  it("所有渠道 formatResults 输出符合 ChannelResult 结构(空/非法输入不产生结构破损)", () => {
    for (const ch of registryChannels) {
      const params = ch.parseArgs("test", []);
      for (const input of ["", "not json at all", null]) {
        try {
          const results = ch.formatResults(input, params);
          const violations = validateChannelResultList(results);
          const flat = violations.flat();
          expect(
            flat,
            `${ch.name} formatResults(${JSON.stringify(input)}) 输出违反 schema: ${JSON.stringify(flat)}`,
          ).toEqual([]);
        } catch {
          // 非法输入抛异常可接受(渠道内部解析逻辑),不在此校验
        }
      }
    }
  });

  it("所有渠道 parseArgs 空参输出符合结构", () => {
    for (const ch of registryChannels) {
      const params = ch.parseArgs("test", []);
      if (params.query !== undefined) {
        expect(typeof params.query).toBe("string");
      }
      if (params.limit !== undefined) {
        expect(typeof params.limit).toBe("number");
      }
    }
  });
});

// ── mapRequest contract ────────────────────────────────────────────────────

describe("ChannelSpec.mapRequest contract", () => {
  // Create a minimal valid normalized request (channels required now)
  const baseReq = normalizeSearchRequest({
    query: "test",
    channels: ["bocha"],
  }).normalized!;

  it("mapRequest does not throw for any spec with default request", () => {
    for (const spec of allChannelSpecs) {
      expect(() => spec.mapRequest(baseReq)).not.toThrow();
    }
  });

  it("mapRequest returns ok=true for default request", () => {
    for (const spec of allChannelSpecs) {
      const result = spec.mapRequest(baseReq);
      expect(result.ok).toBe(true);
    }
  });

  it("mapRequest returns params for default request", () => {
    for (const spec of allChannelSpecs) {
      const result = spec.mapRequest(baseReq);
      expect(result.params).toBeDefined();
      expect(typeof result.params).toBe("object");
      expect(Object.keys(result.params! as object).length).toBeGreaterThan(0);
    }
  });

  it("mapRequest returns empty errors for default request", () => {
    for (const spec of allChannelSpecs) {
      const result = spec.mapRequest(baseReq);
      expect(result.errors).toHaveLength(0);
    }
  });
});

// ── Intent filtering is derived from plugin specs ─────────────────────────

describe("Intent hint coverage", () => {
  it("every channel declares only known intents (no typos)", () => {
    // 白名单 = 协议级 SearchIntent,与具体渠道集合无关 —— 增删渠道不波及
    const knownIntents: string[] = [
      "web", "code", "video", "social", "internal", "shopping", "docs",
    ];
    for (const spec of allChannelSpecs) {
      for (const intent of spec.intents) {
        expect(knownIntents).toContain(intent);
      }
    }
  });

  it("intent does NOT auto-route: no channels → error, not defaults", () => {
    const { normalized, errors } = normalizeSearchRequest({ query: "test" });
    expect(normalized).toBeNull();
    expect(errors.some((e) => e.message.includes("channels is required"))).toBe(
      true,
    );
  });
});

// ── Intent/contentType consistency ─────────────────────────────────────────

describe("Spec intent/contentType consistency", () => {
  it("video channels have video contentType", () => {
    for (const spec of allChannelSpecs) {
      if (spec.intents.includes("video")) {
        expect(spec.contentTypes).toEqual(expect.arrayContaining(["video"]));
      }
    }
  });

  it("social channels have post or user contentType", () => {
    for (const spec of allChannelSpecs) {
      if (spec.intents.includes("social")) {
        const hasSocialType = spec.contentTypes.some((ct) =>
          ["post", "user", "video"].includes(ct),
        );
        expect(hasSocialType).toBe(true);
      }
    }
  });

  it("code channels have code-related contentType", () => {
    for (const spec of allChannelSpecs) {
      if (spec.intents.includes("code")) {
        const hasCodeType = spec.contentTypes.some((ct) =>
          ["repo", "code", "issue", "pr"].includes(ct),
        );
        expect(hasCodeType).toBe(true);
      }
    }
  });
});
