# Channel 开发规范

新增渠道的目标是：一个模块声明能力并实现执行逻辑，Registry 自动发现，统一搜索管道自动使用。

## 创建渠道

```bash
npm run new-channel -- --name hacker-news --category public
```

脚手架生成：

| 文件                                    | 用途                             |
| --------------------------------------- | -------------------------------- |
| `src/channels/public/hacker-news.ts`    | 同文件 `spec + Channel + plugin` |
| `tests/channels/hacker-news.test.ts`    | 身份、路由和解析测试             |
| `tests/fixtures/hacker-news.json`       | 正常响应 fixture                 |
| `tests/fixtures/hacker-news-error.json` | 异常响应 fixture                 |

不需要修改 Registry、搜索管道或集中测试文件。生产渠道集合只由插件目录决定。

## 模块契约

渠道模块必须导出：

```ts
export const spec = defineChannelSpec({
  name: "hacker-news",
  category: "public",
  description: "Hacker News 技术新闻和讨论",
  intents: ["web", "social"],
  contentTypes: ["article", "post"],
  supports: {
    limit: true,
    page: false,
    sort: ["latest", "popular"],
    timeRange: false,
    language: false,
  },
  defaults: { limit: 10 },
  mapRequest(req) {
    const { warnings, errors } = validateRequestAgainstSupports(
      req,
      this.supports,
      this.name,
    );
    return {
      ok: errors.length === 0,
      params: { query: req.query, limit: req.limit },
      warnings,
      errors,
    };
  },
});

export default class HackerNewsChannel extends BaseChannel {
  name = spec.name;
  category = spec.category;
  channelSpec = spec;

  buildRequests(params: Record<string, unknown>): RunRequest[] {
    // Build ordered primary/fallback requests.
    return [];
  }

  formatResults(raw: unknown): SearchResult[] {
    // Parse backend data into the stable result contract.
    return [];
  }
}

export const plugin = defineChannelPlugin(spec, HackerNewsChannel);
```

Registry 以 `spec` 为能力事实来源，并验证 `spec.name/category` 与实现一致。重复名称或加载失败会进入 `channels.loadErrors`，不会静默覆盖。

Registry 加载模块后，将 `plugin.spec` 与 Channel 实例一起注册。搜索管道所需的 resolver 由 CLI、MCP 或 pi 入口从该 Registry 显式注入，不存在静态 fallback 索引。

## 参数规则

- 公共参数：`query`、`limit`、`sort`、`timeRange`、`language`、`contentType`、`scope`。
- 专有参数必须声明在 `spec.channelParams`，由框架统一校验。
- 不要为普通参数覆盖 `parseArgs`；基类支持 `--key value` 和 `--key=value`。
- 凭证不是业务参数。API key 只从环境变量或凭证提供器读取，禁止放进 `channelParams`。
- `mapRequest` 不抛异常，无法执行时返回结构化 `errors`。
- 渠道类的 `name`、`category` 和 `channelSpec` 必须从同文件 `spec` 派生，不重复写字符串。

## 结果规则

每条结果必须满足：

```ts
{
  title: string;
  url?: string;
  ref?: string;
  snippet: string;
  source: { channel: string; backend?: string };
  meta?: Record<string, unknown>;
}
```

- `formatResults` 对合法空结果返回 `[]`。
- 不要用伪 result 表示错误；业务错误通过 `formatError` 返回。
- `meta.popularity` 是 `popular` 排序的统一数值信号。
- search-only 渠道保持 `supportsContent=false`，搜索摘要即交付物。
- search+content 渠道设置 `supportsContent=true`，搜索结果提供稳定 `ref`，并覆盖 `content(ref)`。

## 执行策略

`buildRequests` 返回按优先级排列的 `RunRequest[]`。Adapter 依次尝试，Runner 负责 API、CLI、cookie 和浏览器执行。所有策略受 `RunRequest.timeout` 约束；CLI 参数不得经过 shell 拼接。

## 验收

```bash
npm run typecheck
npm test
npm run build
```

`npm run build` 会编译公开渠道和本地 `src/channels/internal/` 渠道；
`npm run build:public` 只生成公开产物，`npm pack` 会自动使用该构建。

至少覆盖：正常解析、空结果、错误响应、参数映射、主后端失败后的 fallback，以及 `source/ref/meta` 契约。

## 迁移旧渠道

旧渠道迁移按以下顺序执行：

1. 将中央 `ChannelSpec` 原样搬入渠道模块并用 `defineChannelSpec` 包装。
2. 将类字段改为 `name = spec.name`、`category = spec.category`、`channelSpec = spec`。
3. 导出 `plugin = defineChannelPlugin(spec, ChannelClass)`。
4. 将测试改为直接导入共置 `spec`，并确认 Registry 加载无错误。
5. 删除旧中央定义；无需添加任何重导出或注册项。
