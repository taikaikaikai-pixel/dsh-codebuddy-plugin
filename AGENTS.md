# AGENTS.md — dsh-tap 开发指南

面向在本仓库工作的 AI 编码 agent（以及未来的你自己）。本文只放"每次都要的"：项目定位、架构、速查、命令、文档地图。**网关事实全表在 docs/rules/gateway-facts.md，踩坑全本（#1–#39）在 docs/pitfalls.md，版本史在 CHANGELOG.md**——所有"为什么"都在那里，别凭记忆改，按文末文档地图去读。

## 项目是什么

把腾讯 CodeBuddy 网关（`copilot.tencent.com`）接入 DeepSeek Harness（dsh）的插件：18 个模型（可运行时增删）+ dsh 原生 `web_search`/`web_fetch` 的 CodeBuddy 后端 + `image_generate` 生图工具 + 本地流式桥 + Web UI 设置卡；v0.8.x 起增加第二上游 **TraeWork CN 通道**（OAuth 订阅额度 + OpenAI↔Trae 翻译网关 :3902 + 本机 state.vscdb 目录）；v0.9.7/0.9.8 起第三上游 **Qoder CN 通道**（设备流 OAuth + COSY WASM 签名 + OpenAI↔加密信封翻译网关 :3903 + 网关目录镜像，设计文档 docs/goals/qoder-cn-provider-design.md）。纯 ESM，Node ≥ 22。

## 三层架构（改动时先想清楚落在哪层）

| 层             | 文件                                                                                                    | 职责                                                                                                                                                                                                                                                                                                                                                                                                                           | 改动生效方式                                   |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 静态配置          | `cordis.patch.yml`                                                                                    | 覆盖 dsh-base 的 `llm-pi-ai`（provider 路由**指向本地桥**+模型清单）、`agent-default-model`、`web`（provider 钉选）、`insert` 入口                                                                                                                                                                                                                                                                                                                    | 重启 dsh                                   |
| 组合根           | `index.js`                                                                                            | Config/schema、模型管理（patch 解析 + settings.yaml 镜像）、凭据编排（core 轮转 + provider OAuth 分支）、设置路由、apply 生命周期；对外导出契约                                                                                                                                                                                                                                                                                                                     | 重启 dsh                                   |
| 凭据边缘层         | `core/`                                                                                               | **provider 无关**：json-store（文件层/env 解析）、rotation（KeyRotator 轮询/冷却/failover，实例状态）、usage-meter（计量存储）、bridge（流式桥：会话归因/并发闸/SSE 聚合/取证；上游特化全走 provider 钩子）。**禁止出现任何 CodeBuddy 特化**——verify-core-generic 静态扫描锁                                                                                                                                                                                                                       | 重启 dsh                                   |
| 上游适配器         | `providers/codebuddy/`                                                                                | 全部 CodeBuddy 网关事实：headers（逐字段规则/迷信判定，ua-validation.md §3）、errors（错误码表）、oauth（设备流）、catalog（/v3/config+额度方言）、agenttool（search/webfetch）、images（生图）。裁判依据 docs/rules/                                                                                                                                                                                                                                                            | 重启 dsh                                   |
| 上游适配器（v0.8.x） | `providers/trae/`                                                                                     | 全部 TraeWork CN 事实：oauth（**自持 ECDSA P-256 设备密钥**的设备流+DeviceProof 刷新，令牌存 `~/.dsh/trae-plugin-auth.json`）、catalog（本机 state.vscdb 目录→dsh profiles，复用 scripts/trae-model-catalog.mjs 纯函数——CLI 入口有 import.meta 守卫可安全当库导入）、gateway（OpenAI↔Trae 翻译网关 :3902：**不是 core 桥**——协议要改写不能透传，但复用 SessionLimiter/usage-meter 原语）、errors（mchost `{code}`/火山 ResponseMetadata/裸非 JSON 三态信封）。裁判依据 docs/reverse/traework-cn.md + trae-cloud-api.md | 网关端口/域名热生效；patch 路由改动重启 dsh              |
| 上游适配器（v0.9.7+） | `providers/qoder/` | Qoder CN 事实：oauth（PKCE S256 设备流：授权页 qoder.cn/device/selectAccounts + openapi 面 poll（**404=未完成**）/refresh（`drt-` 前缀强制），令牌存 `~/.dsh/qoder-plugin-auth.json`）、cosy（COSY 签名运行时：`qoder_auth.wasm` 官方原字节 + 手写 wbindgen 胶水；**聊天签名走 `prepareInferRequest`，prepareRequest 的 /algo 重写是目录面专用**）、catalog（签名 GET /algo/api/v2/model/list，明文/密文两态）、gateway（OpenAI↔COSY 加密信封翻译 :3903，usage.credits 计量）。裁判依据 docs/goals/qoder-cn-provider-design.md（§5e = 聊天面打通实录） | 网关端口/域名热生效；patch 路由改动重启 dsh |
| 多服务商（G6/G7）   | `providers/openai-compat.js` + `providers/ark`、`bailian`、`deepseek`、`bigmodel`、`moonshot`、`openrouter`、`qwen` | key 型 OpenAI 兼容上游注册表：共享骨架（GET /models 验目录 + provider 块组装；**/models 404 时 probeChatKey 探针验 key + fallbackModels 兜底清单**；公开目录型如 OpenRouter 走 `staticCatalog` 探针验 key + 内置精选表，裁判 docs/rules/extra-providers.md）+ 每上游 preset（baseURL/认证方言）。登记册在插件文件层 `managedProviders`，块写 settings.yaml、key 写 .credentials.yaml（踩坑 #21）                                                                                                                                                              | 免重启（热加载）                                 |
| 浏览器半          | `lib/client.js`                                                                                       | dsh-tap 设置卡（dsh ≥ 0.1.6 = Plugin Manager `plugins.item` 槽，owner props `{view}` 分 summary 一行简介 / page 完整表单 embedded 常开；旧宿主回退 `settings.plugin.item`，踩坑 #34；折叠态状态芯片 + 8 标签页懒挂载隐藏不卸载；复用宿主 `dsh-client-ui-primitives` 组件 + `--dsw-alias-*` tokens + 注入式 cbc- 样式，见踩坑 #15）                                                                                                                                                                                                                                                         | 刷新页面（注意浏览器缓存，测试加 `--disable-http-cache`） |

设置数据流：设置卡 → `POST /dsh-tap/settings`（自有路由）→ `~/.dsh/codebuddy-plugin.json`（文件层）→ `Config({entry, file})` 活解析。OAuth 令牌单独存 `~/.dsh/codebuddy-plugin-auth.json`，**永不回传浏览器**（key 也只回脱敏 `ck_a…5678`）。

各层细节叙述见 wiki/01-architecture.md \~ 10-provider-qoder.md。表中"踩坑 #N"指 docs/pitfalls.md。

## 关键网关事实速查（全表：docs/rules/gateway-facts.md）

CodeBuddy 通道：

- `/v2/chat/completions` **仅流式**（非流式报 11101）；网关无 `GET /models`（404，dsh 内置"获取可用模型"对本网关永远失效）→ docs/rules/routing.md

- `/agenttool/v1/*` 与 `/v3/config` 要求 **CLI 形态 UA**（如 `CLI/unknown CodeBuddy/2.136.0`；`CodeBuddyCode/1.0` 被拒 12403）→ docs/rules/ua-validation.md

- pi-ai 会把推理模型的 system prompt 序列化成 `role:"developer"`，触发网关审核 `content_filter`——桥出站一律重写 developer→system → docs/rules/dev-role-boundary.md

- 提示缓存**按内容寻址、自动生效**，亲和头/`prompt_cache_key` 对命中零影响；**分模型策略**：v4-pro/v4-flash/kimi-k2.7/hy3 有缓存，glm-5.x 条目秒-分钟级失效（"命中率只有 40%"多源于此），deepseek-v3 恒 0 → docs/rules/prompt-cache.md + docs/diagnosis-cache-quota.md

- **v4-flash 网关缓存本身稳定**（直连 24 发全 99.3%、TTL ≥600s）；存量"经桥命中率下降快/40k+ 不稳/命中波动"根因是**桥 `rawBody += c` 逐分片解码损坏出站前缀**（跨分片中文→U+FFFD 且位置逐请求随机），**0.9.2 已修复**（Buffer.concat 一次解码，verify-bridge [10] 回归锁定案）→ docs/diagnosis-cache-decline.md（踩坑 #28）

- 数字剩余额度主源 = 控制台计费路径族 `/billing/meter/get-user-resource` 等，**仅接受 OAuth Bearer**（`ck_` key 401）；企业用量需 `X-Enterprise-Id` 头 → docs/rules/quota-signals.md §R-Q7

- 生图走 `/v2/images/generations`（`hunyuan-image-v3.0-art` 实测出图）；视频/3D 路由存在但无可用模型（14407），不接入 → docs/rules/routing.md

- OAuth 设备流：`/v2/plugin/auth/state` → 轮询 `auth/token`（11217=未完成）→ 刷新 `auth/token/refresh`；WorkBuddy 与 CodeBuddy 同账户体系 → docs/rules/oauth-handshake.md

TraeWork CN 通道：

- 聊天网关在 `trae-api-cn.mchost.guru`（`/api/agent/v3/llm_utils_chat`）；OAuth 在 `api.trae.cn`（ExchangeToken 双模式 + DeviceProof 自签刷新）；认证双头 `Cloud-IDE-JWT` + `x-cloudide-token` → docs/rules/trae-surface.md

- **inline\_chat 不做模型路由**（恒走账户默认模型）；唯一真实的模型选择 = **remote 会话协议**（chat\_sessions + manual 策略，耗 work 额度池、不支持 OpenAI tools）→ docs/reverse/trae-cloud-api.md §5.1

- 额度双池：raw 耗 IDE 池、remote 耗 work 池；读数走 `ide_user_ent_usage` 按 `available_endpoint` 分池 → docs/reverse/trae-cloud-api.md

Qoder CN 通道：

- 设备流：授权页 `qoder.cn/device/selectAccounts`（PKCE S256，客户端生成 challenge/nonce/machine_id）→ 轮询 `openapi.qoder.com.cn/api/v1/deviceToken/poll`（**404=未完成**，1s×5min）→ 刷新 `deviceToken/refresh`（refresh_token 强制 `drt-` 前缀）；access `dt-` 30 天 / refresh 约 1 年，两令牌齐轮换 → docs/goals/qoder-cn-provider-design.md §2.2/§5b

- **聊天签名入口是 `QoderContext.prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)`**——URL 恒映射到 infer 节点（region 发现：CN = `gateway.qoder.com.cn`）的 `/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，body 加密、SSE 信封回标准 OpenAI chunk；**`prepareRequest`（/algo 重写）只用于目录等管理面**；api2-v2 OpenAI 面裸 Bearer 恒 401（废弃勿用）→ 设计文档 §5e

- **裸 OpenAI body 不落入官方用量统计**（"能聊天"≠"被记账"）：归因 = 聊天 body 归因信封字段 + business 块 + 收尾双上报（business/finish mode auth、/api/v1/tracking mode sign，均 prepareRequest 直通 `cosy.prepareSigned`），插件网关已对齐官方客户端（verify-qoder [19] 锁定案）→ docs/rules/gateway-facts.md Qoder 节

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
27. 组件函数体局部变量不跨渲染——checkbox 去抖表每渲染重建；终版 = `useRef` **同值去重**（时间窗会吞掉快过它的勾选往返）
28. HTTP 请求体禁止 `string += buffer` 逐分片拼接——跨 TCP 分片的多字节字符变 3×U+FFFD 且位置逐请求随机，曾把"桥自己弄脏前缀"误判成"网关缓存不稳"8 个版本（mock 单块写测不出；正解 `Buffer.concat` 一次解码；0.9.2 已修复，含同型的 trae 网关与设置路由）
29. 原生 socket 测试客户端不挂 `data` 监听 = paused 流——服务端 FIN 后 `close` 永不派发，测试永久挂起且无报错；socket 客户端必须消费响应（哪怕空监听器），"套件挂死"先开取证日志区分被测物与测试自身
30. dsh 0.1.5：web 入口 token 闸（回归传 `DSH_WEB_TOKEN`）；`settings.plugin.item` 槽位运行时声明——卡片必须 `slots.inject` 等声明再注册，直接 register 静默不出现；RPC `llm.providers` → `llm/listProviders`（payload `{args:{}}`，返回仅 active）
31. 状态文件落盘必须 tmp+rename 原子写——截断的 settings.yaml 往往仍是合法 YAML，静默丢配置比炸更糟（writeTextAtomic，0.9.5）
32. 同值去重表（踩坑 #27）失败必须销账——POST 前记账、失败不回滚则该模型同向操作被永久吞掉
33. fire-and-forget promise 必须 .catch 落地（unhandledRejection 崩宿主）；生命周期"已在目标态"早退条件必须计入 lastError 失败态，否则 listen 失败后永久 wedge
34. dsh 0.1.6 拆除 `settings.plugin.item` 槽（迁入 Plugin Manager `plugins.item`，`{view:'summary'|'page'}` 契约）——旧槽上 `slots.inject` 静默等待，升级后卡片"消失且零报错"（dshmarket 同受害）；修复 = 双槽注册 + 卡片 embedded 分形；升级 dsh 后先 grep 新产物的槽名清单对账
35. Windows Git Bash 的 `curl -d` 中文按 ANSI(GBK) 发字节——含非 ASCII 的 HTTP 测试用 Node fetch，"中文乱码"先怀疑测试工具链
36. wasm-bindgen 的 RequestResult.headers 是 JS Map——`{...map}` 展开得空头组（服务器断连无报错），必须 Object.fromEntries；手写胶水位运算永远加括号（`ptr >>> 0 + len` ≡ `ptr >>> len`）
37. 未知模型 key 被上游**静默改派 auto**——响应 model 字段 + billable:false 是哨兵，探测必须用真实目录 key
38. 测试 fixture 禁写绝对日期（"未来时间"到期即必红）；"昨天绿今天红"先查 fixture 时钟
39. pi-ai 丢弃 `stopReason=error/aborted` 的 assistant **但保留其 toolResult** → 出站孤儿 `role:"tool"` → 严格上游 400（Qoder `provider_error` 根因）；翻译网关出站前必须做消息配对体检（`sanitizeToolPairing`，verify-qoder [18] 锁定案）
40. 客户端 transcript 里的 usage 是 enrich 后的记录不是线缆帧；计费归因判别靠梯度臂 + 高精度计数器差分（totalCredits 11 位小数），裸推理请求可能完全不被记账

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
node scripts/verify-qoder-provider.mjs          # Qoder CN 离线回归（mock 设备流全流程 + 翻译网关信封 + 目录投影）
node scripts/probe-qoder-live.mjs --login       # Qoder CN 真实设备流登录（浏览器授权；令牌存 ~/.dsh/qoder-plugin-auth.json）
node scripts/probe-qoder-live.mjs --chat "文本" # Qoder CN 真实对话（cosy 签名路径，证据落 docs/probes/）
node scripts/probe-qoder-matrix.mjs --suite flash|tools|reject|repair  # Qoder 差分矩阵（逐变量隔离上游报错，证据 docs/probes/qoder-matrix-*.json）
node scripts/probe-qoder-flash-confirm.mjs      # Qwen3.8-Flash 上游节点状态确认（3×Flash + 2×对照，恢复即翻绿）
node scripts/probe-qoder-quota.mjs              # 用量计数器差分（quota/heatmap/summary 前后对比，--read-only 只读）
node scripts/probe-qoder-attribution.mjs [--arm N]  # 用量归因梯度实验（裸体/信封/business块/finish/tracking 逐臂判定）
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

浏览器回归脚本（puppeteer-core + 系统 Chrome，位于仓库外本地目录 `dsh-ui-test/`，不进仓库；2026-08-18 从 `/tmp/dsh-ui-test/` 迁来——/tmp 被系统清空，step9/12/16b/17/18/23 随之丢失，现存为重建版；2026-09-03 随设置卡标签页重设计全套重建并换 `/dsh-tap/settings` 新路由；2026-09-19 Windows 侧按 dsh 0.1.6 Plugin Manager 重建 `qoder-slot-check.js`——槽迁移 + Qoder CN 标签 10 断言，点击入口必须选卡片 `cardTitle` 按钮而非侧栏会话树同名行）：`_helpers.js`（共享驱动：打开卡片并激活「模型」标签、`tab()` 标签激活、请求计数、Key 清理、模式切换、`normalizeField`）、step20（设置卡全套 22 断言：7 标签顺序/折叠态头部芯片/状态条/OAuth+Key 双视图/增删 Key/搜索开关与重置/模型分组移动）、step22（流畅度 25 断言：DOM 标记证明保存不卸载组件/严格 1 POST+1 GET/草稿跨标签保留/思考强度 select 设档与持久化/Key 排序）、step24（生图 7 断言）、step25（额度与用量 13 断言：未激活不轮询/文案/桥状态/经桥注入真实请求后轮询自动刷新/可见 21s 轮询 ≥2/切走即停）、step26（数值额度 8 断言：OAuth hero+资源包聚合展开 / api-key 估算档）、step27（目录同步 4）、step28（行内上限 9）、step29（服务商注册表 13，mock 上游端到端 + 行内反馈/删除二次确认）、step31-trae（Trae 通道 19：开启/目录同步/逐模型启停往返/连接域名折叠组/关闭删块）、shot9-redesign（明暗主题+逐标签截图）。跑前 `dsh web`，跑后杀 3080。选择器一律按 `.cbc-*` 类与行内单元格精确匹配（踩坑 #16 与 step20 误删 Key 的教训），改 UI 文案/结构后先 grep 旧脚本的选择器；脚本基线一律从 GET /settings 实况读取并收尾复原（含文件层擦除），不硬编码起始模式。

## 文档地图（改哪类代码，先读哪份）

- 改 CodeBuddy 出站行为（headers/UA/错误码/目录/额度/缓存/审核）→ docs/rules/ 对应专题：routing、ua-validation、quota-signals、prompt-cache、content-moderation、dev-role-boundary、oauth-handshake；错误码表在 providers/codebuddy/errors.js

- 接入新的 key 型 OpenAI 兼容上游 → docs/rules/extra-providers.md

- 改 Trae 通道 → docs/reverse/traework-cn.md + trae-cloud-api.md（目录提取另见 trae-model-catalog.md）；错误码表在 providers/trae/errors.js

- 排查"缓存命中率低/重复提问" → docs/diagnosis-cache-quota.md；排查 "trae 3003 all models failed" → docs/diagnosis-trae-3003.md；排查 Qoder "upstream error / provider_error / Flash 不可用" → docs/diagnosis-qoder-flash.md

- 要原始实测证据 → docs/probes/（历次探测 JSON/JSONL 落盘）

- 要架构与模块叙述 → wiki/01-architecture.md \~ 10-provider-qoder.md

- 要某版本改了什么 → CHANGELOG.md；要课题交接状态 → docs/rules/STATE.md

## 维护纪律

- 新实测事实追加到 docs/rules/gateway-facts.md（或对应专题文件），新坑追加到 docs/pitfalls.md（取新编号），本文只在两个速查节各加一行——本文保持薄索引，不再铺长段落/章节。

- 版本历史只写 CHANGELOG.md，不在本文铺章节。

