# AGENTS.md — dsh-codebuddy-plugin 开发指南

面向在本仓库工作的 AI 编码 agent（以及未来的你自己）。改代码前先读完本文；所有"为什么"都写在踩坑一节，别凭直觉改。

## 项目是什么

把腾讯 CodeBuddy 网关（`copilot.tencent.com`）接入 DeepSeek Harness（dsh）的插件：18 个模型（可运行时增删）+ dsh 原生 `web_search`/`web_fetch` 的 CodeBuddy 后端 + `image_generate` 生图工具 + 本地流式桥 + Web UI 设置卡。纯 ESM，Node ≥ 22。

## 三层架构（改动时先想清楚落在哪层）

| 层 | 文件 | 职责 | 改动生效方式 |
|----|------|------|--------------|
| 静态配置 | `cordis.patch.yml` | 覆盖 dsh-base 的 `llm-pi-ai`（provider 路由**指向本地桥**+模型清单）、`agent-default-model`、`web`（provider 钉选）、`insert` 入口 | 重启 dsh |
| 宿主运行时 | `index.js` | 注册 ctx.web 搜索/抓取后端、ctx.tools 生图工具、流式桥（127.0.0.1:3901，**含主聊天在内全部请求的唯一凭据入口**；api-key 模式多 Key 轮询+failover+冷却；**恒开 usage 计量** → `~/.dsh/codebuddy-plugin-usage.json` 供设置卡"额度与用量"分区）、OAuth 设备流、设置路由 | 重启 dsh |
| 浏览器半 | `lib/client.js` | Settings → 插件配置 的 CodeBuddy 设置卡（`settings.plugin.item` slot；复用宿主 `dsh-client-ui-primitives` 组件 + `--dsw-alias-*` tokens + 注入式 cbc- 样式，见踩坑 #15） | 刷新页面（注意浏览器缓存，测试加 `--disable-http-cache`） |

设置数据流：设置卡 → `POST /dsh-codebuddy-plugin/settings`（自有路由）→ `~/.dsh/codebuddy-plugin.json`（文件层）→ `Config({entry, file})` 活解析。OAuth 令牌单独存 `~/.dsh/codebuddy-plugin-auth.json`，**永不回传浏览器**（key 也只回脱敏 `ck_a…5678`）。

## 已验证的网关事实（2026-08 实测，勿凭记忆改）

- `/v2/chat/completions`：**仅流式**（非流式报 `code 11101`）；`reasoning_effort` 接受 low/medium/high/max，各模型思考量自适应非严格单调
- `/agenttool/v1/search`、`/agenttool/v1/webfetch`：专用搜索/抓取端点，`ck_` Key 直调可用；**UA 必须是 CLI 形态**（如 `CLI/unknown CodeBuddy/2.136.0`，`CodeBuddyCode/1.0` 被拒 12403）
- `/v3/config`：网关自有模型目录（官方 CLI 用），`x-api-key` 头认证（OAuth 用 Authorization），同 UA 要求；响应 `{code, data:{models, agents}}`
- `/v2/images/generations`：OpenAI 形态生图端点，`hunyuan-image-v3.0-art` 实测出图（~22s/张，plain UA 即可，无需 CLI UA）；`/v2/videos/generations`、`/v2/3d/generations` 路由存在但当前账号一律 14407 `route config not found`（无可用模型，官方 CLI 包内也无对应客户端调用）→ 视频/3D 不接入。证据：docs/probes/media-2026-08-17.json（`probe-media.mjs`）
- OAuth 设备流：`POST /v2/plugin/auth/state?platform=CLI`（三个 `X-No-*` 头）→ 浏览器打开 authUrl → 轮询 `GET /v2/plugin/auth/token?state=`（`11217`=未完成）→ `GET /v2/plugin/login/account`；刷新 `POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token`）
- **额度信号盘点**（2026-08-18，`scripts/probe-quota.mjs`，证据 docs/probes/quota-2026-08-18.json）：`GET /v2/accounts`（ck_ Key 直调可用）返回账户元数据（type/enterprise/lastLogin，当前账户=lastLogin:true 条目）；`POST /v2/billing/meter/get-dosage-notify`（官方 CLI BillingService 的低额告警源，ck_ 可用）健康时返回空文案；**数字剩余额度无 CLI/api-key 可达 API**——chat 响应头无 quota 字段，CLI 包内端点全集（`/v2/accounts`、`/v2/billing/meter/get-dosage-notify`、`/v3/config`、`/v2/report` 等）无 quota 查询，用户中心网页 plan API（字段 credit/limitNum/exclusiveGift.remainCredits）走浏览器 cookie 体系进不去。计费只有每请求 `usage.credit` 自报
- **WorkBuddy 与 CodeBuddy 同账户体系**：`www.workbuddy.cn/v2/plugin/auth/state` 实测返回同形态 `{state, authUrl}`（同一设备流）；官方 CLI product.json 的 `internalDomain` 互含 workbuddy.cn，认证 id 同为 `Tencent-Cloud.coding-copilot` → 额度账户级共享，无需单独通道
- 会话头体系（CLI 使用，v0.5.5 目标）：`X-Conversation-ID / X-Session-ID / X-Conversation-Request-ID / X-Conversation-Message-ID / X-Agent-Type / X-Agent-Intent`
- dsh 内置"获取可用模型"对本网关**永远失效**（无 OpenAI `GET /models`，404）
- **提示缓存按内容寻址、自动生效，与头无关**（2026-08-17 对照实测）：usage 每 chunk 带 `prompt_cache_hit_tokens/prompt_cache_miss_tokens/credit`；会话亲和三头与 `prompt_cache_key` 对命中**零影响**（2.6k/15.8k 两档 anon==session）；命中粒度 128 token。**按模型分策略**：deepseek-v4-pro 缓存工作（阈值 ≤2684 tok），deepseek-v3 在 ≤16.3k tok 全部 0 命中——v3 无缓存折扣。credit 实测单价：v4-pro miss ≈0.26/1k tok、hit ≈1/24；v3 ≈0.03/1k。命中可用性在 15.8k 规模有网关内部波动（0→全命中非单调），亲和头不能消除。详见 docs/diagnosis-cache-quota.md
- **缓存按模型分策略实测表**（2026-08-18，docs/probes/cache-models-2026-08-18.jsonl）：v4-pro / v4-flash / kimi-k2.7 / hy3 有稳定跨请求前缀缓存（同 prompt 连发命中 95–100%，kimi 全量命中含尾部）；**glm-5.1/5.2 缓存条目秒-分钟级失效**，连发同 prompt 出现 0→83%→83%→0 非单调（4 次综合命中率 ≈41%——"命中率只有 40 多"类现象多源于此，与链路无关）；deepseek-v3 恒 0。**规模警告**：v4-flash 在 40k+ 真实增长内容下条目保留不稳定（coverage 21%→100% 乱跳，直连同尺寸合成内容却 100%——网关内部状态相关，诊断文档 §7）；v4-pro 99k 规模仍 agg 93%。**桥对缓存透明**：直连 vs 经桥同 payload 命中逐字节一致（2.6k 档均 95.4%）；dsh 每步注入的秒级时间戳只动尾部 ~19 tok（17.5k prompt 跨会话重发命中 99.9%，docs/probes/cache-dsh-path-2026-08-18.jsonl）
- **内容审核 developer 角色事件**（2026-08-18 16:24 UTC 起，0.7.4 已解）：网关内容审核开始对**含 `role:"developer"` 消息**的 chat payload 一律 `finish_reason: content_filter`，仅改回 `system` 即放行。触发源在 pi-ai：openai-completions 序列化器对推理模型把 system prompt 写成 developer 角色（`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`，桥 URL 不在非标准名单 → true）——所以 dsh 会话全挂而官方 CLI/手写回放（手写一直是 `system`）全过，deepseek-v3 不受影响（非推理模型不发 developer）。**修复在桥**：chat 出站前把 `developer` 重写为 `system`（verify-bridge 第 9 节锁回归）。0.7.3 猜的"x-stainless 头组/序列化顺序"已被 OpenAI SDK 6.26.0 全保真回放证伪；教训：等价对比必须用 dump/抓包的真实字节，手写重建会抹掉差异字段。

## 踩坑记录（每条都付过学费）

1. **bundle 入口必须 `insert`**：dsh 对声明 `dsh.bundle` 的包只应用 patch、不加载 JS；必须在 cordis.patch.yml 里 `- insert: [{id, name}]` 才会执行 `apply()`。
2. **双 settings 服务实例**：bundle 入口侧与 Web 客户端连接侧的 `settings` 服务互不相通，命名空间注册对设置页不可见——所以设置卡走自有 webServer 路由（dsh-html-visualizer 同模式）。别尝试改回官方 installSettingsSection。
3. **客户端模块格式**：`window.__ModuleLoader__.load({id, factory})`，factory 内 `require('react')`；包需声明 `exports["./client"]` 与 `dsh.client.manifest`。手写 `React.createElement`（无构建步骤）。
4. **React hooks 规则**：`useSyncExternalStore(scope.subscribe,…)` 必须传绑定包装（裸方法引用丢 `this`）；hook 不能在条件分支后调用。改 UI 后必跑浏览器回归。
5. **合成事件**：脚本派发的原生 blur 不触发 React onBlur，用真实 `input.blur()`；受控 checkbox 可能双 change，写操作加去抖。
6. **模型同步的纯净态**：`llm-pi-ai.providers.codebuddy.models` 写入 `~/.dsh/settings.yaml` 即时生效（选择器实时刷新）；但状态归零时必须**删除**该覆盖层，否则陈旧清单遮蔽插件更新的静态模型。禁用"目录新增"模型只删 extra、**不写 disabled**（否则永远非纯净）。
7. **错误提示要带原因**：catch 里只写"（网络）"曾把 `reload is not a function` 误导成网络问题排查了一圈。
8. **dsh web 增删插件后必须重启**进程才会刷新启动清单（运行中的清单是内存缓存）。
9. 本插件 JS 不能 import `@deepseek-ai/*`（除非装进自己的 node_modules——加载器按插件路径解析）；provider 接口用鸭子类型零依赖实现，仅 `schemastery`/`yaml` 两个运行时依赖（锁 dsh 0.1.0-rc.6 线）。
10. **验证队列/代理行为必须断言"响应完成"**：首字节/时间戳看起来都对、连接却永远不收尾——v0.5.5 的 `SessionLimiter.release()` 在计数归零且队列非空时直接 return，limit=1 下同会话第二个请求永久挂起（0.5.6 修复，回归锁在 verify-bridge.mjs）。同类教训：桥的出站头是**重建**的，"保留调用方已设头"若只跳过注入而不转发，等于静默丢弃（同为 0.5.6 修复，改逐头保留+补全）。
11. **launch-environment 是启动时不可变快照**：插件运行时写 `process.env.X` 对 dsh 凭据解析**无效**（`createLaunchEnvironmentSnapshot` 冻结于任何 config entry 挂载前）。要让 pi-ai 在无 `apiKeyEnv` 时也发请求，正解是 patch 里放**静态哨兵 Authorization 头**：pi-ai `getClientApiKey` 见 authorization 头即放行（返回 "unused"），OpenAI SDK 的 `defaultHeaders` 合并顺序在 `authHeaders` 之后，哨兵因此真正上线，桥再逐请求替换。另注意 dsh-llm-pi-ai 的 `requestHeaders` 会剥掉与 attribution 冲突的头——静态 `User-Agent` 永远到不了网关（被 dsh 自己的 UA 替换），`/v2` 不校验 UA 才无感。
12. **schemastery 不物化无默认值字段**：`Config({})` 的键集合不含 `activeApiKey` 这类无 default 的字段——曾用 `hasOwnProperty(Config({}), key)` 当写入白名单，切换活跃 Key 被静默丢弃。白名单一律查显式清单（`SETTINGS_FIELDS`），别查解析产物的键。
13. **ctx.tools 注册的 schema 必须是最终 JSON Schema**：defineTool 的"简写→JSON Schema"转换器在宿主包内，插件 import 不到（见 #9）；`parameters`/`output.schema` 直接手写完整 JSON Schema 即可正常注册。
14. **provider 工厂之间传的是 settings 函数，不是解析结果**：makeSearchProvider/makeFetchProvider 曾把 `settings()` 的对象传给期望函数的 `callAgentTool`，每次搜索/抓取抛 `TypeError: settings is not a function`——对外就是无网关 code 的"模糊报错"。这类跨层签名漂移启动日志看不出来，只能靠端到端真实调用暴露。
15. **UI 原生化的正确姿势**：宿主**没有全局可复用 class**（第一方与 dshmarket 全是 CSS Modules hash 类名）。复用 = require 平台 seed 模块 `@deepseek-ai/dsh-client-ui-primitives`（Button/Input/图标；try/catch 失败回落原生元素，卡片不白屏）+ 注入单个 `<style data-plugin="…" data-plugin-css="…">`（cbc- 前缀类，与第一方同协议，模块加载器可按插件归因/热清理）+ 全部颜色走 `--dsw-alias-*` tokens（深色主题靠 `body[data-ds-dark-theme]` 下的 alias 变量自动跟随，无需自己写媒体查询）。`--dsw-alias-accent` 和 `--dsw-alias-label-error` **不存在**——写了永远走 fallback，正确名是 `state-business-primary`/`state-error-primary`。组件外壳数值抄第一方 PluginCard：radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16。
16. **puppeteer 回归三坑**（0.7.1 重建脚本时各踩一次）：a) `page.evaluate` 无法序列化 DOM 元素——返回 Element 的表达式恒解析为 `undefined`，存在性断言的 `!!` 必须写在 evaluate **内部**（外层 `!!(await evaluate(el))` 永远 false，且毫无报错）；b) `setInput`（native setter + input 事件）与 `blur()` 必须分两个任务——同一任务内 blur 的 commit 闭包读到的还是旧草稿，静默不保存；c) 涉及"重置"按钮的断言先 `normalizeField` 把字段归一到 schema 默认值——中断的 run 会留下文件层覆盖，"重置"回的是默认值而不是 run 起始值，基线错了断言必挂。
17. **`server.listen` 不挂 error 监听 = 宿主进程炸弹**：桥绑 3901 遇 EADDRINUSE（第二个 dsh 实例——`dsh web --help` 都会加载插件抢绑）时 unhandled 'error' 事件直接崩掉整个 dsh。listen 前挂 `server.on('error')` 降级为告警 + 状态字段（`bridgeRuntime`），绝不抛出。同类教训：轮询型 UI 断言必须先等"正在读取"消失再读文本（step25 首跑 3 连挂就是首次 pull 未返回）；轮询断言的基线计数器要和文本显示的口径一致——step25 曾拿全量 `totalRequests` 对比卡片"今日"计数，跨本地午夜后必然分叉、断言永不成立（文本基线应取 `usage.today.requests`）。
18. **dsh rc.7 把 `settings.plugin.item` 槽位从 list 改成 keyed**（0.7.3 适配）：tab 改为从 api-proxy `settings.describe` 读 Host 命名空间清单，按 `renderSlot(…, {entryKey: ns})` 逐个派发——**卡片想出现，必须同时满足**：宿主半 `ctx.inject(['settings'])` + `settings.register('dsh-codebuddy-plugin', Config)` 注册命名空间（只作派发声明，读写仍走自有路由；注册是本 fiber 的 effect）＋ 浏览器半注册带 `key: "dsh-codebuddy-plugin"`。rc.6 的硬编码白名单 `WEB_SETTINGS_NAMESPACES` 与 `settings-not-exposed` 已删，第三方插件自曝配置面是官方落地的新路径。rc.6↔rc.7 兼容写法：注册项同时带 `key` 和 `id/order/label`——list 槽位只校验 `id`、keyed 只校验 `key`，多余字段都被忽略。踩坑 #2 因此**部分过时**：rc.7 起命名空间注册对设置页可见了（但官方 `installSettingsSection` 仍不是我们数据流的载体）。
19. **"逐字节等价"若靠手写重建 = 自欺欺人**（0.7.4 破解 content_filter 事件的代价）：pi-ai 会把推理模型的 system prompt 序列化成 `role:"developer"`，而此前所有"等价回放"都手写 `system`——差异字段被重建过程抹掉，导致把网关审核误判成"时变风控/按客户端形态"。正解是开 `CODEBUDDY_BRIDGE_DUMP` 抓真实请求体，再以 dump 为基准逐字段 bisect（一次翻转即定位 developer 角色）。网关对 developer/system 指令语义等价，桥直接重写即可。

## 常用命令

```sh
dsh web                                        # 起测试服务（默认 3080）
node scripts/verify-models.mjs --list           # 离线自检模型解析
node scripts/verify-models.mjs                  # 在线探测模型可用性（读 CODEBUDDY_API_KEY）
node scripts/verify-models.mjs --sync           # 对比 /v3/config 目录漂移
node scripts/verify-models.mjs --efforts [id…]  # 探测 reasoning_effort 档位
node scripts/verify-bridge.mjs                  # 离线桥回归（mock 网关，断言响应完成）
node scripts/verify-rotation.mjs                # 离线多 Key 轮询回归（mock 网关按 Key 行为表）
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

## 版本现状

0.1.0 初始 → 0.2 文档同步 → 0.3 对齐 /v3/config + verify 脚本 → 0.4 思考强度可调 → 0.5 ctx.web 后端 + 流式桥 + 识图 → 0.5.1 设置卡 → 0.5.2 OAuth + 多 Key → 0.5.3 功能分区 + 一键开关 → 0.5.4 模型逐个启停同步选择器 → 0.5.5 会话管理 A+B → 0.5.6 桥三 bug 修复 + 设置卡重构 → 0.6 主聊天走桥（OAuth 覆盖模型对话）→ 0.6.1 桥取证日志 + 缓存/额度诊断存档 → 0.7 设置卡流畅度 + 搜索修复与错误硬化 + 生图接入 + 多 Key 轮询 → 0.7.1 设置卡迁移 dsh 原生 UI 资源（primitives+tokens+注入样式）+ 回归目录重建 → 0.7.2 桥 EADDRINUSE 崩溃修复 + "额度与用量"设置卡分区（桥恒开 usage 计量 + 轮次聚类 + 账户额度信号；数字剩余额度无 API 已实证存档）→ 0.7.3 适配 dsh rc.7（settings.plugin.item 槽位 keyed 化：宿主半注册 settings 命名空间 + 浏览器半注册加 key，双版兼容写法见踩坑 #18；其余 rc.7 变化逐包 diff 实证无关）→ 0.7.4 主聊天 content_filter 修复（根因=pi-ai 把推理模型 system prompt 写成 developer 角色触发网关审核，桥出站重写 developer→system；dump+bisect 取证法见踩坑 #19）（详见 CHANGELOG.md）。

## v0.5.5：会话管理 A + B（已完成 2026-08-17）

落点：流式桥升级为智能代理（`index.js` 的 proxyUpstream/SessionLimiter）。**A 纯补丁不可行**（llm-pi-ai 的 compat 白名单剥除未知字段，pi-ai 内部的会话亲和开关经适配器被剥掉），故 A+B 都落在运行时。

- **A 会话归因**：入站带会话 id（`X-Conversation-ID`/`X-Session-ID`/`session_id` 头或请求体 `conversation_id`/`session_id`）时注入网关会话头（openai 三头 / openrouter 单头，可选），调用方已设置的逐头保留、缺失的补全。
- **B 并发管理**：`SessionLimiter` 按会话 id 限制并发（默认 4），同会话超额 FIFO 排队，无会话 id 不限流。实测 4 请求 max=2 分两波完成（3.6/3.9s 与 7.7/7.9s）。
- 桥现在透传任意路径（`/agenttool/*` 等），凭据仍由 `resolveCredential()` 统一解析；非流式入站聚合成 `chat.completion` JSON（v0.5.0 能力，v0.5.5 误删、0.5.6 恢复）。

**0.5.6 修三个回归/潜伏 bug**（详见 CHANGELOG 与踩坑 #10）：limit=1 排队死锁、非流式聚合丢失、会话头"保留"实为丢弃。回归一律跑 `node scripts/verify-bridge.mjs`（离线，30 项断言，含第 7 节取证日志断言）。

## v0.6：主聊天走桥（已完成 2026-08-17）

动机：OAuth 此前只覆盖搜索/抓取/桥，主聊天仍走 patch 的 `CODEBUDDY_API_KEY` 环境引用——"登录了 OAuth 却没用上"。落点全部在 patch：codebuddy 路由 `baseURL` → `http://127.0.0.1:3901/v2`，删 `apiKeyEnv`，加静态哨兵 `Authorization: Bearer dsh-codebuddy-bridge`（机制见踩坑 #11）。桥由此成为**唯一凭据入口**与主聊天关键路径：禁用桥/改端口与 patch 不一致都会断主聊天（设置卡已明示）。会话归因/并发管理暂仍只对自带会话 id 的调用方生效（dsh 出站经适配器剥掉了 pi-ai 的会话亲和开关）。

下一步：v0.7 指纹映射候选**已被诊断否决**（见下节）——缓存按内容寻址，会话亲和头对命中零影响，指纹映射恢复不了"本就不缺的"缓存。

## 诊断存档：重复提问与缓存/额度（2026-08-17，docs/diagnosis-cache-quota.md）

桥新增**取证日志**（`CODEBUDDY_BRIDGE_LOG=<jsonl>`，不落明文，verify-bridge 第 7 节锁回归），配合 `capture-traffic.mjs`（受控流量）与 `probe-cache.mjs`（网关对照）得出：

- **"后端多次相同提问"主因是架构不是 bug**：每工具 step 全量重发历史（实测 ≈6.1 请求/turn）；标题生成每会话 1 次且内嵌首问全文；子代理独立会话全量重发（首请求 0 命中全价）。dsh-llm-retry 机制存在（请求体逐字节相同、无线上标记）但 codebuddy 路径 83 历史会话 0 实例；注意 `EMPTY_RESPONSE` 在默认可重试码里，网关返回空内容会静默重发 ≤2 次。
- **缓存结论**：按内容寻址自动前缀缓存，亲和头/prompt_cache_key 零影响；**v4-pro 有缓存、v3（插件默认模型）无**；命中波动是网关内部行为。credit：v4-pro miss 0.26/1k、hit ~1/24；v3 0.03/1k 无折扣。一轮 15.8k tok 的 turn 全 miss 4.08 credit vs 全命中 0.17。
- **v0.7 决策**：指纹→会话映射对缓存收益 ≈0，不立项；杠杆是模型选择（v3 换有缓存的模型）。dsh rc.3↔rc.6 请求路径无行为差异（逐包 diff），排除"升级致命中率下降"。
- **"36% 事件"补遗（2026-08-18，诊断文档 §7）**：用户 v4-flash/high 插件会话 25 步 agg 34.7%（vs 其原生对照 91%）——根因是**网关在 40k+ 规模对真实增长内容的缓存条目保留不稳定**（cacheRead 吸附历史快照尺寸 7424/32768/34304，coverage 21%→100% 乱跳），**非插件/桥/会话管理回归**：直连增长探测 20k→108k coverage≈100%，受控 A/B 小上下文插件 92.3%≈原生 97.3%。命中率主导变量是后端×上下文规模：≤5k 稳定，codebuddy 40k+ 真实内容不可靠，v4-pro 99k/215 步实测 agg 93.1% 仍可用。证据：docs/probes/cache-session-f52c817f-2026-08-18.json、cache-flash-scale-2026-08-18.jsonl。

## v0.7：增强队列四项（已完成 2026-08-17）

- **设置卡流畅度**：保存严格 1 POST + 1 GET（Enter 双提交修复）、不重新拉目录、不卸载分区组件；模型行思考档位（静态按 patch `reasoningEfforts` 键名、目录按 `reasoning.effort`）；Key 列表使用中置顶 + 字典序。回归 step22/step20。
- **搜索/抓取修复与测量**：根因是 provider 工厂把对象传给期望函数的 callAgentTool（踩坑 #14）；错误硬化——网络错带 undici cause 链、HTTP 错嵌入网关 code/msg。识图慢结论：慢在上游生成（e2e p50 2.5s ≈ 上游 TTFB），插件侧无病理开销（mock 桥开销 ≈5ms）——measure-latency.mjs 可重复测量。
- **生图接入**：`image_generate` 工具走 dsh 既有 tools 缝（踩坑 #13），`/v2/images/generations` + `hunyuan-image-v3.0-art` E2E 真出图（step23）；视频/3D 端点 14407 按停止规则存档不接入（证据见网关事实节）。设置卡新增"图像生成"分区（开关 + 模型，step24 锁）。
- **多 Key 轮询**（仅 api-key 模式，OAuth 不动）：`withKeyRotation()` 统一三条出站路径（agenttool 搜索/抓取、流式桥、image_generate）；apiKeys≥2 逐请求轮询，401/403/429/5xx/网络错在**同一请求内** failover；失败 Key 冷却 `keyCooldownMs`（默认 60s，设置卡可配）后自动回轮换；冷却中其余全失败时冷却 Key 兜底；单 Key / env 回落行为不变。回归 verify-rotation.mjs（25 项断言）。
