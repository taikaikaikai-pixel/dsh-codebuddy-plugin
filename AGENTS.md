# AGENTS.md — dsh-tap 开发指南

面向在本仓库工作的 AI 编码 agent（以及未来的你自己）。本文只放"每次都要的"：项目定位、架构、速查、命令、文档地图。**网关事实全表在 docs/rules/gateway-facts.md，踩坑全本（#1–#27）在 docs/pitfalls.md，版本史在 CHANGELOG.md**——所有"为什么"都在那里，别凭记忆改，按文末文档地图去读。

## 项目是什么

把腾讯 CodeBuddy 网关（`copilot.tencent.com`）接入 DeepSeek Harness（dsh）的插件：18 个模型（可运行时增删）+ dsh 原生 `web_search`/`web_fetch` 的 CodeBuddy 后端 + `image_generate` 生图工具 + 本地流式桥 + Web UI 设置卡；v0.8.x 起增加第二上游 **TraeWork CN 通道**（OAuth 订阅额度 + OpenAI↔Trae 翻译网关 :3902 + 本机 state.vscdb 目录）。纯 ESM，Node ≥ 22。

## 三层架构（改动时先想清楚落在哪层）

| 层 | 文件 | 职责 | 改动生效方式 |
|----|------|------|--------------|
| 静态配置 | `cordis.patch.yml` | 覆盖 dsh-base 的 `llm-pi-ai`（provider 路由**指向本地桥**+模型清单）、`agent-default-model`、`web`（provider 钉选）、`insert` 入口 | 重启 dsh |
| 组合根 | `index.js` | Config/schema、模型管理（patch 解析 + settings.yaml 镜像）、凭据编排（core 轮转 + provider OAuth 分支）、设置路由、apply 生命周期；对外导出契约 | 重启 dsh |
| 凭据边缘层 | `core/` | **provider 无关**：json-store（文件层/env 解析）、rotation（KeyRotator 轮询/冷却/failover，实例状态）、usage-meter（计量存储）、bridge（流式桥：会话归因/并发闸/SSE 聚合/取证；上游特化全走 provider 钩子）。**禁止出现任何 CodeBuddy 特化**——verify-core-generic 静态扫描锁 | 重启 dsh |
| 上游适配器 | `providers/codebuddy/` | 全部 CodeBuddy 网关事实：headers（逐字段规则/迷信判定，ua-validation.md §3）、errors（错误码表）、oauth（设备流）、catalog（/v3/config+额度方言）、agenttool（search/webfetch）、images（生图）。裁判依据 docs/rules/ | 重启 dsh |
| 上游适配器（v0.8.x） | `providers/trae/` | 全部 TraeWork CN 事实：oauth（**自持 ECDSA P-256 设备密钥**的设备流+DeviceProof 刷新，令牌存 `~/.dsh/trae-plugin-auth.json`）、catalog（本机 state.vscdb 目录→dsh profiles，复用 scripts/trae-model-catalog.mjs 纯函数——CLI 入口有 import.meta 守卫可安全当库导入）、gateway（OpenAI↔Trae 翻译网关 :3902：**不是 core 桥**——协议要改写不能透传，但复用 SessionLimiter/usage-meter 原语）、errors（mchost `{code}`/火山 ResponseMetadata/裸非 JSON 三态信封）。裁判依据 docs/reverse/traework-cn.md + trae-cloud-api.md | 网关端口/域名热生效；patch 路由改动重启 dsh |
| 多服务商（G6/G7） | `providers/openai-compat.js` + `providers/ark`、`providers/bailian`、`providers/iflow`、`providers/qwen` | key 型 OpenAI 兼容上游注册表：共享骨架（GET /models 验目录 + provider 块组装；**/models 404 时 probeChatKey 探针验 key + fallbackModels 兜底清单**，裁判 docs/rules/extra-providers.md）+ 每上游 preset（baseURL/认证方言）。登记册在插件文件层 `managedProviders`，块写 settings.yaml、key 写 .credentials.yaml（踩坑 #21） | 免重启（热加载） |
| 浏览器半 | `lib/client.js` | Settings → 插件配置 的 CodeBuddy 设置卡（`settings.plugin.item` slot；复用宿主 `dsh-client-ui-primitives` 组件 + `--dsw-alias-*` tokens + 注入式 cbc- 样式，见踩坑 #15） | 刷新页面（注意浏览器缓存，测试加 `--disable-http-cache`） |

设置数据流：设置卡 → `POST /dsh-tap/settings`（自有路由）→ `~/.dsh/codebuddy-plugin.json`（文件层）→ `Config({entry, file})` 活解析。OAuth 令牌单独存 `~/.dsh/codebuddy-plugin-auth.json`，**永不回传浏览器**（key 也只回脱敏 `ck_a…5678`）。

各层细节叙述见 wiki/01-architecture.md ~ 09-run-and-test.md。表中"踩坑 #N"指 docs/pitfalls.md。

## 关键网关事实速查（全表：docs/rules/gateway-facts.md）

CodeBuddy 通道：

- `/v2/chat/completions` **仅流式**（非流式报 11101）；网关无 `GET /models`（404，dsh 内置"获取可用模型"对本网关永远失效）→ docs/rules/routing.md
- `/agenttool/v1/*` 与 `/v3/config` 要求 **CLI 形态 UA**（如 `CLI/unknown CodeBuddy/2.136.0`；`CodeBuddyCode/1.0` 被拒 12403）→ docs/rules/ua-validation.md
- pi-ai 会把推理模型的 system prompt 序列化成 `role:"developer"`，触发网关审核 `content_filter`——桥出站一律重写 developer→system → docs/rules/dev-role-boundary.md
- 提示缓存**按内容寻址、自动生效**，亲和头/`prompt_cache_key` 对命中零影响；**分模型策略**：v4-pro/v4-flash/kimi-k2.7/hy3 有缓存，glm-5.x 条目秒-分钟级失效（"命中率只有 40%"多源于此），deepseek-v3 恒 0；40k+ 真实增长内容条目保留不稳 → docs/rules/prompt-cache.md + docs/diagnosis-cache-quota.md
- 数字剩余额度主源 = 控制台计费路径族 `/billing/meter/get-user-resource` 等，**仅接受 OAuth Bearer**（`ck_` key 401）；企业用量需 `X-Enterprise-Id` 头 → docs/rules/quota-signals.md §R-Q7
- 生图走 `/v2/images/generations`（`hunyuan-image-v3.0-art` 实测出图）；视频/3D 路由存在但无可用模型（14407），不接入 → docs/rules/routing.md
- OAuth 设备流：`/v2/plugin/auth/state` → 轮询 `auth/token`（11217=未完成）→ 刷新 `auth/token/refresh`；WorkBuddy 与 CodeBuddy 同账户体系 → docs/rules/oauth-handshake.md

TraeWork CN 通道：

- 聊天网关在 `trae-api-cn.mchost.guru`（`/api/agent/v3/llm_utils_chat`）；OAuth 在 `api.trae.cn`（ExchangeToken 双模式 + DeviceProof 自签刷新）；认证双头 `Cloud-IDE-JWT` + `x-cloudide-token` → docs/rules/trae-surface.md
- **inline_chat 不做模型路由**（恒走账户默认模型）；唯一真实的模型选择 = **remote 会话协议**（chat_sessions + manual 策略，耗 work 额度池、不支持 OpenAI tools）→ docs/reverse/trae-cloud-api.md §5.1
- 额度双池：raw 耗 IDE 池、remote 耗 work 池；读数走 `ide_user_ent_usage` 按 `available_endpoint` 分池 → docs/reverse/trae-cloud-api.md

## 踩坑速查（全本含代价与修复：docs/pitfalls.md；改代码前按编号查相关条）

1. bundle 入口必须 `insert`，否则 dsh 只应用 patch、不执行 `apply()`
2. 双 settings 服务实例互不相通——设置卡走自有 webServer 路由
3. 客户端模块走 `__ModuleLoader__.load`，factory 内 `require('react')`，无构建步骤
4. React hooks：`useSyncExternalStore` 传绑定包装；hook 不在条件分支后
5. 合成事件：脚本派发的 blur 不触发 React onBlur，用真实 `input.blur()`；受控 checkbox 写操作加去抖
6. 模型同步纯净态：动态目录存活期镜像恒铺；归零时按 pristine 判定删覆盖层
7. 错误提示要带原因（catch 只写"（网络）"曾误导排查方向）
8. dsh web 增删插件后必须重启进程才刷新启动清单
9. 本插件不能 import `@deepseek-ai/*`；运行时依赖仅 `schemastery`/`yaml`
10. 验证队列/代理行为必须断言"响应完成"（首字节对 ≠ 连接收尾）
11. launch-environment 是启动时不可变快照——无 `apiKeyEnv` 时用静态哨兵 Authorization 头，桥逐请求替换
12. schemastery 不物化无默认值字段——写入白名单查显式清单 `SETTINGS_FIELDS`，别查解析产物键
13. `ctx.tools` 注册的 schema 必须是最终 JSON Schema
14. provider 工厂之间传的是 settings 函数，不是解析结果
15. UI 原生化：`dsh-client-ui-primitives` + `--dsw-alias-*` tokens + 注入式 `cbc-` 样式
16. puppeteer 三坑：evaluate 不序列化 DOM 元素；setInput 与 blur 分任务；"重置"断言先 `normalizeField`
17. `server.listen` 必须挂 error 监听（EADDRINUSE 曾崩掉整个 dsh 进程）
18. dsh rc.7 起 `settings.plugin.item` 槽位 keyed 化（注册带 `key`，兼容写法带 id/order/label）
19. "逐字节等价"靠手写重建 = 自欺欺人——用 dump 抓真实字节再逐字段 bisect
20. core/ 与 providers/ 的运行状态必须是实例状态（工厂/类），不是模块全局
21. settings.yaml 用户层一个坏 provider 块毒化全层——落盘前本地校验 + 实测后再写
22. GitHub 逆向项目是"历史参照"不是"协议真相"：定方向 → strings 提取 → 无凭据探测 → 带凭据联调
23. Trae 没有可读的存量 token——自持设备密钥走完整设备流是正路
24. 官方本地 harness 是懒启动黑盒；strings 里本地 RPC 与云端路由要按命名空间分辨
25. 非目录路由空 models 清单 apply 即 throw——Trae 通道用"路由存在性管理"（patch 不带 trae 基线，镜像整块铺/删）
26. 设置接口按响应整体审脱敏——`user` 字段曾漏脱敏、明文 Key 下发浏览器（已修）
27. 组件函数体局部变量不跨渲染——checkbox 去抖表每渲染重建，跨渲染状态用 `useRef`

## 常用命令

```sh
dsh web                                        # 起测试服务（默认 3080）
node scripts/verify-models.mjs --list           # 离线自检模型解析
node scripts/verify-models.mjs                  # 在线探测模型可用性（读 CODEBUDDY_API_KEY）
node scripts/verify-models.mjs --sync           # 对比 /v3/config 目录漂移
node scripts/verify-models.mjs --efforts [id…]  # 探测 reasoning_effort 档位
node scripts/verify-bridge.mjs                  # 离线桥回归（mock 网关，断言响应完成）
node scripts/verify-rotation.mjs                # 离线多 Key 轮询回归（mock 网关按 Key 行为表）
node scripts/verify-core-generic.mjs            # core/ 通用性证伪（静态纯净扫描 + 第二上游全链路）
node scripts/verify-providers.mjs               # 多服务商骨架离线回归（/models 404 兜底 + 认证方言）
node scripts/verify-trae-provider.mjs           # Trae 通道离线回归（mock OAuth 全流程/目录映射/翻译网关）
node scripts/probe-trae-live.mjs --login        # Trae 真实登录（浏览器授权 + DeviceProof 刷新自证；一次性）
node scripts/probe-trae-live.mjs --chat "文本"  # Trae 真实对话联调（原始证据落 docs/probes/ 校准信封）
node scripts/measure-latency.mjs --mock|--real  # 识图/搜索端到端延迟分布（JSONL 落盘）
node scripts/probe-media.mjs                    # 生图/视频/3D 端点探测（证据落盘 docs/probes/）
npm run verify                                  # 同在线探测
CODEBUDDY_BRIDGE_LOG=/tmp/bridge.jsonl dsh web  # 开桥取证日志（请求哈希/头特征/usage）
CODEBUDDY_BRIDGE_DUMP=/tmp/dump dsh web          # 叠加请求体明文落盘（仅本地诊断，慎开）
node scripts/capture-traffic.mjs                # 受控主聊天流量（多轮/重发/子代理，经 3080 RPC）
node scripts/capture-cache.mjs                  # 两会话同 prompt 缓存复刻（选 v4-pro，配合桥日志/dump）
node scripts/probe-cache.mjs                    # 网关缓存对照探测（--model/--arms/--repeat/--calls/--base/--effort）
node scripts/probe-quota.mjs                    # 额度信号探测（accounts/dosage-notify/chat 响应头，证据落盘 docs/probes/）
```

浏览器回归脚本（puppeteer-core + 系统 Chrome，位于仓库外本地目录 `dsh-ui-test/`，不进仓库；2026-08-18 从 `/tmp/dsh-ui-test/` 迁来——/tmp 被系统清空，step9/12/16b/17/18/23 随之丢失，现存为重建版）：`_helpers.js`（共享驱动：打开卡片、请求计数、Key 清理、模式切换、`normalizeField`）、step20（设置卡全套 20 断言）、step22（流畅度 22 断言：保存不卸载组件/严格 1 POST+1 GET/思考档位/Key 排序）、step24（生图分区 8 断言）、step25（额度与用量分区 12 断言：存在/顺序/文案/桥状态/经桥注入真实请求后轮询自动刷新/21s 静默窗轮询 ≥2）、shot-card/shot-dark（明暗主题截图）。跑前 `dsh web`，跑后杀 3080。选择器一律按 `.cbc-*` 类与行内单元格精确匹配（踩坑 #16 与 step20 误删 Key 的教训），改 UI 文案/结构后先 grep 旧脚本的选择器；脚本基线一律从 GET /settings 实况读取并收尾复原（含文件层擦除），不硬编码起始模式。

## 文档地图（改哪类代码，先读哪份）

- 改 CodeBuddy 出站行为（headers/UA/错误码/目录/额度/缓存/审核）→ docs/rules/ 对应专题：routing、ua-validation、quota-signals、prompt-cache、content-moderation、dev-role-boundary、oauth-handshake；错误码表在 providers/codebuddy/errors.js
- 接入新的 key 型 OpenAI 兼容上游 → docs/rules/extra-providers.md
- 改 Trae 通道 → docs/reverse/traework-cn.md + trae-cloud-api.md（目录提取另见 trae-model-catalog.md）；错误码表在 providers/trae/errors.js
- 排查"缓存命中率低/重复提问" → docs/diagnosis-cache-quota.md；排查 "trae 3003 all models failed" → docs/diagnosis-trae-3003.md
- 要原始实测证据 → docs/probes/（历次探测 JSON/JSONL 落盘）
- 要架构与模块叙述 → wiki/01-architecture.md ~ 09-run-and-test.md
- 要某版本改了什么 → CHANGELOG.md；要课题交接状态 → docs/rules/STATE.md

## 维护纪律

- 新实测事实追加到 docs/rules/gateway-facts.md（或对应专题文件），新坑追加到 docs/pitfalls.md（取新编号），本文只在两个速查节各加一行——本文保持薄索引，不再铺长段落/章节。
- 版本历史只写 CHANGELOG.md，不在本文铺章节。
