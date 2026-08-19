/**
 * warnings.ts — 抑制已知噪音警告。
 *
 * 背景:agent-search 检测到本地代理时会挂载 EnvHttpProxyAgent(见 runner.ts initProxy),
 * Node 26 对 EnvHttpProxyAgent 每次运行都打印 experimental 警告 [UNDICI-EHPA],
 * 纯噪音且出现在所有命令输出顶部。
 *
 * 注意:Node 26 中注册 'warning' listener 不会阻止默认打印(stderr),
 * 必须拦截 process.emitWarning 本身。只吞 [UNDICI-EHPA],其他照常。
 *
 * A6 风险评估:pi 扩展在宿主进程内调用本函数——patch 的是进程级 process.emitWarning。
 * 缓解:
 *   1. 只吞 UNDICI-EHPA 单一警告码,其余警告原样放行(白名单而非黑名单)
 *   2. 幂等:重复调用只 patch 一次,已 patch 则跳过(宿主多次加载扩展不叠加)
 *   3. 调用方(CLI 主入口/pi 扩展)均为进程内唯一入口,无交叉影响面
 */

const PATCH_SYMBOL = Symbol.for("agent-search.warnings.patched");

export function suppressNoiseWarnings(): void {
  // 幂等:已 patch 过则跳过(宿主进程内多个扩展/多次加载不重复包装)
  if ((process as unknown as Record<symbol, boolean>)[PATCH_SYMBOL]) return;

  const origEmitWarning = process.emitWarning.bind(process) as (...a: unknown[]) => void;

  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const msg = typeof warning === "string" ? warning : (warning.message ?? "");
    // 只吞 EnvHttpProxyAgent experimental 警告(代码 UNDICI-EHPA)——白名单,其余放行
    if (
      msg.includes("EnvHttpProxyAgent is experimental") ||
      args.some((a) => typeof a === "string" && a.includes("UNDICI-EHPA")) ||
      (args[0] && typeof args[0] === "object" && (args[0] as { code?: string }).code === "UNDICI-EHPA")
    ) {
      return;
    }
    return origEmitWarning(warning, ...args);
  }) as typeof process.emitWarning;

  (process as unknown as Record<symbol, boolean>)[PATCH_SYMBOL] = true;
}
