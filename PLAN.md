# PLAN.md · agent-search 渠道端到端测试

> 产品与工程现状真源。阶梯/部件图在笔记侧（`~/Documents/Notes/wiki/knowledge/dev/Build To Learn/agent-search/`），此处只放产品、架构、决策、构建级「怎么跑」。

## 产品是什么（一句话）
发布前对渠道做「场景级端到端测试」的一键工具——渠道作者填场景清单，检查员真跑，过/挂一眼看清，环境问题明说跑不了，绝不假过。

## 剧本（用户确认的场景清单）
1. 写完/改完渠道 → 一键测 → 该渠道真实搜索跑通，结果字段齐全（标题/链接/摘要/来源）
2. 换参数（数量/排序/时间/语言）→ 不报错、行为正确
3. 环境缺登录态/依赖/网络 → 明确说「这环境跑不了这个渠道」，不假过
4. 报告一眼看清：哪些过、哪些挂、挂在哪一步

## 做成判据
跑一条命令，能对一个渠道输出「过/挂在哪一步」；三类场景（正常/参数/环境）都有明确结论；环境问题绝不假过。

## 架构/形状
- 薄管道 + 厚插件：Registry 按目录动态发现渠道（单文件自包含 spec + Channel + plugin），无中央注册表
- 参数分层：公共参数（query/limit/sort/timeRange/language）+ 渠道专有 channelParams（JSON Schema 声明）
- 双策略执行：buildRequests 返回主+fallback（cli / api / cookie_fetch / browser_exec），adapter 自动降级
- 接入同源：pi 扩展（src/pi-extension.ts）与 MCP server（src/mcp.ts）共用 mcp-handlers.ts
- 测试基建（2026-08-12 重构）：通用管道测试（router/protocol/mcp-handlers）用 tests/helpers/mock-channel.ts，不引用真实渠道；契约测试动态校验；fixtures 自动发现。增删渠道只动渠道文件 + 专属测试

## 决策及依据（已拍 + 待拍）
- **已拍（2026-08-12）：砍掉 github 渠道**——gh CLI 已覆盖其全部能力（搜仓库/代码/issues/prs/读文件，且认证后限流 5000/hr），后续搜 GitHub 直接用 `gh search`/`gh api` 命令行。连带：github 渠道、fixtures、渠道专属测试全部移除；code 搜索 intent 不再有渠道声明，由 gh 命令行替代
- **已拍（2026-08-12）：撤销场景清单系统**（scenarios.ts + test 子命令）——曾为发布前渠道验证而建，后认为不如直接审代码/直接用工具，整体移除
- 待拍：无

## 怎么跑（构建/部署级）
- cd /Users/user/Documents/Code/tools/agent-search
- 依赖：npm install（node >= 20）
- 测试：npm test（单元+契约，不含 e2e）/ npm run test:e2e（真实搜索，需本机依赖）
- 渠道依赖：gh（github）、yt-dlp（youtube）、opencli daemon + 浏览器登录态（bilibili/twitter/内部渠道）
