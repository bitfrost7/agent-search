/**
 * env.ts tests — .env 解析语义：环境变量优先，缺失才从 .env 读。
 */
import { describe, it, expect, afterEach } from "vitest";
import { applyEnvContent } from "../src/env.js";

const SAVED: Record<string, string | undefined> = {};

afterEach(() => {
  // 清理测试写入的环境变量
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function save(keys: string[]) {
  for (const k of keys) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
}

describe("applyEnvContent", () => {
  it("解析 KEY=value 基础行", () => {
    save(["TEST_A"]);
    applyEnvContent("TEST_A=hello\n");
    expect(process.env.TEST_A).toBe("hello");
  });

  it("解析 export 前缀行", () => {
    save(["TEST_B"]);
    applyEnvContent("export TEST_B=world\n");
    expect(process.env.TEST_B).toBe("world");
  });

  it("去除引号", () => {
    save(["TEST_C", "TEST_D"]);
    applyEnvContent('TEST_C="double"\nTEST_D=\'single\'\n');
    expect(process.env.TEST_C).toBe("double");
    expect(process.env.TEST_D).toBe("single");
  });

  it("已存在的环境变量优先，.env 不覆盖", () => {
    save(["TEST_E"]);
    process.env.TEST_E = "from-env";
    applyEnvContent("TEST_E=from-file\n");
    expect(process.env.TEST_E).toBe("from-env");
  });

  it("跳过注释和空行", () => {
    save(["TEST_F", "TEST_G"]);
    applyEnvContent("# comment\n\nTEST_F=1\n   \nTEST_G=2\n");
    expect(process.env.TEST_F).toBe("1");
    expect(process.env.TEST_G).toBe("2");
  });

  it("忽略无效行（无 = / 非法 key）", () => {
    save(["TEST_H"]);
    applyEnvContent("NOT_A_VALID LINE\n=novalue\nTEST_H=ok\n");
    expect(process.env.TEST_H).toBe("ok");
    expect(process.env["=novalue"]).toBeUndefined();
  });

  it("幂等：多次调用结果一致", () => {
    save(["TEST_I"]);
    applyEnvContent("TEST_I=v1\n");
    applyEnvContent("TEST_I=v2\n");
    expect(process.env.TEST_I).toBe("v1");
  });
});
