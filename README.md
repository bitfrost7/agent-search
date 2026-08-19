# Agent-Search

统一多渠道搜索 CLI + MCP server。一个命令搜 GitHub、B站、知乎、掘金、YouTube、Twitter、Hacker News、arXiv、网页等平台。

## 特性

- **每搜索引擎一渠道**：每个后端都是独立插件，不再维护 web 聚合渠道或中央渠道清单
- **参数分层**：公共参数(关键词/limit/sort/timeRange/language)统一;渠道专有参数(channelParams, JSON Schema 声明, 如 github 的 stars)
- **工具分层**：`agent_channels`(渠道清单+完整参数) → `agent_search`(单渠道执行) → `agent_content`(按需抓正文)
- **无自动路由**：渠道由 agent 自行选择,单次单渠道;多渠道 = agent 并行 tool_call
- **分层交付**：所有渠道实现 `search`;能稳定定位正文的渠道再声明并实现 `content`
- **做减法**：搜索只当索引,正文按需抓取;reddit 死链已过滤
- **统一协议**：MCP `search` 工具返回统一结构化结果
- **可扩展**：脚手架生成单文件 `spec + Channel + plugin`、fixtures 和契约测试,无需修改中央注册表
- **能力共置**：渠道参数、路由映射和实现位于同一模块；Registry 动态发现模块导出的 `plugin`
- **浏览器桥接**：通过 opencli daemon 复用桌面 Chrome 登录态,爬需要登录的网站

## 安装

```bash
./install.sh
```

脚本会安装依赖、构建，并把 `agent-search` 链接到 `~/.local/bin`，检测本机常见 agent 后打印接入提示，最后运行一次 `agent-search doctor`。它不会自动修改 agent 配置。可通过 `AGENT_SEARCH_BIN_DIR` 指定其他命令目录。

## 接入你的 agent

### MCP 配置（pi / Claude / Cursor 等）

```jsonc
// ~/.pi/agent/mcp.json 或 MCP 配置
{
  "mcpServers": {
    "agent-search": {
      "command": "node",
      "args": ["/path/to/agent-search/bin/mcp-server.js"]
    }
  }
}
```

MCP server 暴露 `search` / `content` / `channels` / `channel_debug` 四个工具。

常见 agent 可以直接注册：

```bash
# Codex
codex mcp add agent-search -- node /path/to/agent-search/bin/mcp-server.js

# Claude Code（用户级配置）
claude mcp add --scope user agent-search -- node /path/to/agent-search/bin/mcp-server.js

# Gemini CLI（用户级配置）
gemini mcp add --scope user agent-search node /path/to/agent-search/bin/mcp-server.js
```

Cursor 和其他 JSON 配置客户端使用上方的 `mcpServers` 配置。OpenCode 可运行 `opencode mcp add agent-search`，选择 local stdio 后填入 `node` 和 MCP server 路径。

### 可选依赖（部分渠道需要）

| 渠道                                         | 依赖                                                                   | 说明                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| github                                       | `gh` CLI                                                               | 无则 fallback 到 GitHub API                               |
| youtube                                      | `yt-dlp`                                                               | 无则 fallback 到 YouTube Data API（需 `YOUTUBE_API_KEY`） |
| bilibili / twitter | opencli + Chrome 扩展 | daemon 自动拉起；无则渠道不可用 |
| 搜索引擎渠道                                 | `BOCHA_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` / `JINA_API_KEY` | 各渠道检查自己的 key;ddg 免费无 key                       |

## 用法

```bash
# 两阶段协议:search(索引+ref) → content(按需抓正文)
# 动词与工具层对齐:agent_search / agent_content;search 可省略(兼容旧写法)

# 搜索 GitHub 仓库（默认）/ 代码 / issues / PRs
agent-search search github "python cli"
agent-search github "rate limiting" --type code --language python
agent-search github "rate limiting" --repo "fastapi/fastapi"
agent-search github --view --repo "garrytan/gbrain"

# 按需抓正文(ref 取自 search 结果的 ref 字段;search-only 渠道如 bocha 不支持)
agent-search content github "pydantic/pydantic"
agent-search content bilibili "BV1xx411c7mD"

# 搜索社交媒体 / 视频 / 商品
agent-search bilibili "大模型" --limit 5
agent-search juejin "RAG"
agent-search zhihu "大模型推理"
agent-search twitter "AI agents"
agent-search youtube "python tutorial"
agent-search bocha "大模型推理"

# 健康检查 & 渠道管理
agent-search doctor
agent-search channel list
agent-search channel show github
```

## 两个入口

| 入口    | 文件          | 用途                                                                                                                           |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CLI     | `src/cli.ts`  | 命令行：`agent-search <channel> <query>`；`agent-search doctor`（并发健康检查,4层→7层探测）                                     |
| MCP     | `src/mcp.ts`  | MCP server（stdio JSON-RPC），对任意支持 MCP 的 agent 暴露 `search/content/channels/channel_debug`                             |

## MCP 使用（agent 对接）

MCP server 通过 stdio 暴露 4 个工具（`node bin/mcp-server.js` 或 `npm run dev:mcp`）：

| 工具            | 用途                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `search`        | 统一搜索。`query` 与单个 `channels` 显式指定；`channelParams` 传渠道专有参数         |
| `content`       | 按 `channel + url` 获取单条完整内容                                                  |
| `channels`      | 列出所有渠道及完整能力（JSON，含 intents/supports/**channelParams 完整参数**/defaults/health） |
| `channel_debug` | 排障：查看渠道 help / health / spec                                                  |

`search` 返回统一 envelope：`{ ok, query, channels, count, results[], warnings[], errors[], diagnostics }`。
`results[].source = { channel, backend }` 标明来源；`diagnostics.perChannel` 给出每渠道耗时与结果数。

## 渠道路由（意图 → 推荐渠道）

| 意图               | 推荐渠道                                            |
| ------------------ | --------------------------------------------------- |
| 代码 / 仓库 / issue / PR | `github`                                     |
| 中文网页           | `bocha`（国内直连）                                 |
| 英文网页 / 通用    | `tavily` / `serper`                                 |
| 学术论文           | `arxiv` / `openalex`（均免费无 key）                |
| YouTube 视频       | `youtube`                                           |
| B站 / X / V2EX / 知乎 / 掘金 | `bilibili` / `twitter` / `v2ex` / `zhihu` / `juejin` |
| 技术社区 / 英文讨论 | `stackoverflow` / `hn` |
| UCloud 内部数据    | `ones-wiki` / `utoken` / `uxiao-log` / `cmdb` / `unoc` |

每个渠道的具体能力与参数以 `agent_channels` / `agent-search channel list` 返回为准（Registry 动态发现,不在此维护静态副本）。

## 健康检查（4层→7层探测链）

`agent-search doctor` / `channels` 的 health 字段反映渠道可达性,不消耗 API 配额：

- **4层 TCP**：无代理时 connect 目标 host 端口,通即可达（GitHub 这类"可达即成功"的渠道到此结束）
- **7层 HTTP**：有代理时直接走 7 层（代理 CONNECT 隧道对几乎所有域名返回 200,4 层失去区分度）；无代理时 4 层失败后升级。对渠道自带 `healthUrl`（或请求 URL）发 HEAD（fallback GET）,收到任意 HTTP 响应即可达（4xx/5xx 也算服务在线）
- **真实搜索兜底**：仅免费无配额渠道（arxiv / openalex）在 4/7 层均失败时,用 sentinel query 真实搜索一次确认（`allowProbeSearch` 声明,消耗配额渠道不得开启）
- 每个渠道通过 `healthProbe` 声明定制（`healthUrl` / `allowProbeSearch`）,核心标准由 `BaseChannel.health()` 统一执行

## 已知陷阱

- **daemon 自动管理**：首次调用 daemon 渠道（bilibili/twitter/内部渠道）时自动 spawn opencli daemon 并等待 Chrome 扩展连接（最多 10s）
- **Chrome 扩展必须启用**：扩展断连时报 `extension_not_connected`,需打开 Chrome 确认 OpenCLI Browser Bridge 扩展已启用
- **国内不可达渠道**：`ddg` / `jina` / `v2ex` 可能被墙,不影响其他渠道；内部渠道（`*.ucloudadmin.com`）需在可达网络环境
- **API key 渠道**：bocha / tavily / serper / jina 从环境变量读 key,缺 key 时 health 报 warning（服务可达但未鉴权）,实际搜索会失败
- **health 是探测不是搜索**：可达性 ≠ 搜索必成功,真实失败以 search 返回的 `errors[]` 为准
- **uxiao 日志保存 5-7 天**：外部 API 5 天,内部 API 7 天；默认查 24 小时内记录

## 渠道一览

渠道由 Registry 从插件目录动态发现，不在 README 维护静态副本。查看当前安装实际可用的渠道：

```bash
agent-search channel list
agent-search channel show github
agent-search doctor
```

## 架构

```
三层执行模型                   统一搜索管道
Channel（声明/解析/格式化）      UnifiedSearchRequest
  ↓ parseArgs / mapRequest        → normalize（默认值/校验）
Adapter（策略编排/fallback）      → route（intent/channels → 每渠道 plan）
  ↓ execute                       → execute（并行执行各渠道）
Runner（纯执行：cli/api/daemon）  → aggregate（去重/排序/截断）
                                 → UnifiedSearchResponse（含 diagnostics）
```

- CLI 入口：`src/cli.ts` — `<channel> <query>` 直接调 channel；`doctor` 对每个渠道后端**并发**健康检查并 TCP ping 目标 host
- MCP 入口：`src/mcp.ts` — 统一协议，agent 用（stdio JSON-RPC）
- 桥接层：`src/search/bridge-executor.ts` — 统一管道 → `searchWithParams`（params 直通 buildRequests，无 CLI 往返）
- 插件发现：`src/registry.ts` — 渠道和 spec 的唯一注册来源；新渠道在模块中导出 `spec`/`plugin`
- Resolver 注入：统一搜索纯函数不读取全局渠道表，由 CLI/MCP/pi 入口显式注入当前 Registry 的 spec resolver
- 发布边界：`src/channels/internal/` 使用同一插件契约，但保持 gitignore 且不进入公开构建

## 扩展

运行 `npm run new-channel -- --name <name> --category public`，详细规范见 [`docs/channel-development.md`](docs/channel-development.md)。

生成后只编辑渠道模块和独立测试/fixture。Registry 会自动发现 `plugin`；不存在需要同步修改的中央渠道注册表。

## 开发

```bash
npm install
npm run dev          # tsx 直接跑 src
npm run build        # 本地完整构建（public + internal）→ dist/
npm run build:public # 公开构建（排除 internal）→ dist/
npm run typecheck    # public + internal 类型检查
npm test             # vitest（排除 e2e）
npm run test:all     # 含 e2e
```

### 项目结构

```
src/
├── cli.ts                  # CLI 入口
├── mcp.ts                  # MCP server 入口（stdio, JSON-RPC）
├── channel.ts              # BaseChannel（含 searchWithParams）
├── plugin.ts               # ChannelSpec/Channel 插件导出辅助函数
├── registry.ts             # 渠道注册（顺序扫描 channels/，兼容 jiti）
├── adapter.ts              # DefaultAdapter（策略 fallback）
├── runner.ts               # 纯执行引擎（cli/api/cookie_fetch/browser_exec）+ host ping（probeHost）
├── daemon-client.ts        # opencli daemon HTTP 客户端
├── formatter.ts            # CLI 输出格式化
├── search/                 # 统一搜索管道
│   ├── types.ts            # 统一协议类型
│   ├── schema.ts           # 归一化/默认值/校验
│   ├── router.ts           # 渠道解析/limit 分配
│   ├── execute.ts          # 编排/聚合/诊断
│   ├── specs.ts            # 内置 public spec 的兼容索引（定义位于渠道模块）
│   ├── spec-builders.ts    # 可复用的 spec 形状
│   ├── bridge-executor.ts  # 统一管道 → BaseChannel 桥接
│   └── ...
└── channels/
    ├── public/             # 17 个公开渠道（每个模块含 spec + Channel + plugin）
    └── internal/           # 本地内部渠道（同一契约，gitignore，不进入公开包）
```

## 许可证

MIT
