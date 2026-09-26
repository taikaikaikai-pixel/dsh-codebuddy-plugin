# 设置卡交互重设计：通道手风琴

> 状态：**已实施（0.10.0，2026-09-23）**——Task 1–9 全部落地，见 CHANGELOG 0.10.0 段与 `.superpowers/sdd/settings-card-ux-redesign-plan/`（计划 = 同名 `-plan.md`，逐任务报告 task-1..9-report.md）。
> 原设计状态：三节设计已与用户逐节评审通过（2026-09-23），并经一轮证据硬审查（行号/断言数/数据源逐条实测核对）。
> 驱动：用户"这个项目的前端页面的交互，有点麻烦。不够简单" → 痛点定位轮（多选）结论 = **找不到、太散**。
> 范围：`lib/client.js` 前端交互模型重写；后端路由契约零变化。目标版本 **0.10.0**（交互模型换代，非补丁）。

## 0. 实施结论（实测，2026-09-23）

- **落地面**：§3/§4 全部按设计实现（4 区块固定顺序默认全收 / 区块头状态行 = 单一真源 / 展开才挂载收起不卸载 / 通道内五分组 + `details.cbc-adv` / 三家模型组同构 / Trae·Qoder 启用开关只在区块头 / 通用区块头取样 + api-key 估算降级 / 保存提示落触发区块头）；§3 硬修复清单逐条迁移未丢（迁移时 11 条；跨分支终审补第 12 条「写后读必须带请求代次」）；§5 的 31 字段落点已在 `wiki/07-web-client.md` 重写时复核。§2 表里的行号（`TAB_DEFS:363`、`tabBadge:682` 等）随重写失效，作为"当时的问题证据"保留不改。
- **回归数字**：`card-accordion.js`（设置卡唯一套件，`card-regression.js` 同日退役）**129 通过 / 0 失败**（静态 `check(` 站点 126 + `[B2]` 循环多跑 2 次 + `[C2]` 循环多跑 1 次；迁移期 117 → 终审修复轮 118 → 残余修复轮补 `[F9]` 收起重采正向锁 119 → 复审修复轮补 `[B5]`（退避链启动点 + A2 代次门时序锁，10 条）⇒ **129**）；`qoder-slot-check.js` 13/13、`qoder-tab-phase2.js` 11/11、`qoder-prefs-check.js` 37 通过 / 0 失败 / 跳过 0（静态 39 站点）、`shots-baseline.js` 10 张**元素级**基线 0 失败、`debug-inputs.js` exit 0；离线七套件全绿（含 verify-qoder 154 / trae 89 / host-config 36 / `verify-models --list` 23 模型），全程 `~/.dsh/codebuddy-plugin.json` md5 恒等 = 零真实写入。
- **两条反复**（教训见踩坑 #46/#47/#48）：① 键盘激活补丁 `48329a7` 加了又撤回 `4dd9f52`——回归锁用 `dispatchEvent` 派发不可信 keydown 测出**伪缺陷**；② 浅色下未勾选原生控件呈深色实心块，**断言全绿、靠人工看图**才发现（`a421d35` 修）。
- **已知限制 / 仍开放**：a) 旧槽（≤0.1.5 `settings.plugin.item`）**无本机宿主可实测**，折叠态单芯片那一路只有代码审查覆盖；b) `qoder-e2e.js`（8 断言）与 `npm run verify`（18 次真实网关探测）**未跑**——两者都消耗用户额度，按裁定跳过，不得声称通过；c) ~~`lib/client.js` 的 `load()` 仍无请求代次标记~~ ⇒ **跨分支终审已修**（`loadGenRef` 代次 + 陈旧响应丢弃，含失败分支；另同轮修掉"通用区块头取样永不刷新"——收起边界重采一次）。修复前实况 = 脚本侧靠轮询到收敛绕过、产品侧未动；终审裁定"脚本侧绕过 ≠ 产品修好"，并要求把两条都写进 §3 硬修复清单。套件随之 117 → **118**（`[C2]` 补齐 Qoder 半边，见 CHANGELOG 0.10.0 段）→ **119**（终审残余修复轮：`[F9]` 给"收起边界重采"补上正向锁——此前套件只锁得住"收起后不再轮询"，把重采代码删掉照样全绿）→ **129**（复审修复轮：`[B5]` 十断言——补拉链的**启动点**当时仍读被代次门作废的回调参数，回退它套件照样全绿；新锁同时是该代次门的第一枚时序用例）；d) 区块展开驱动在 5 个脚本里各存一份副本（只有 `card-accordion.js` 有共享 `openBlock`），且除 `shots-baseline.js`（1440×3000）外各套件仍是 1440×900 视口——将来加高元素的截图会复刻"下半截空白"那个坑（#48）。这一分叉自终审起在 `card-accordion.js` 头注释里**明写为口径**（DOM 断言不受视口高度影响，改套件视口反而可能引入滚动行为差异），收尾取证图也改名成 `acc-task4-groups-viewport.png` 表明它是视口图；e) **每次打开插件管理器会多 1 次上游额度只读**——通用区块头的 `action:'usage'` 取样经服务端 `quotaSnapshot` 打控制台计费路径（`catalog.js:199-209` 有 60s memoize ⇒ 最坏 ≤1 次上游只读/进程/分钟），收起区块再 +1 次。别从"零真实写入"推出"零额外上游调用"：写入是零，**只读不是零**。

## 1. 目标与非目标

**目标（按痛点排序）**

1. 用"按通道归类"消灭"散"：每个通道的凭据、模型、工具、网关全部收进该通道区块；模型管理从三处归一，网关状态从五处归一。
2. 用"区块头常显状态行"消灭"找不到"：不展开也能读到三通道 + 通用的状态；warn/err 就地出现在所属区块头，替代独立的注意条。
3. 删掉为标签栏服务的三层状态补偿机制（折叠三芯片 / 注意条 / 标签徽标），状态展示收敛为单一真源。

**非目标（本轮不做）**

- 不改后端契约、不改槽位注册方式、不改 Plugin Manager summary 文案结构。
- 不做草稿/批量/撤销式的保存模型（用户未把"交互噪音"选为痛点，保持"失焦即保存"）。
- 不做跨通道的全局搜索框、主题定制、用量按通道拆分（YAGNI；额度账本保持跨通道单账）。
- 不动 `core/`、`providers/`（纯前端）。

## 2. 现状问题（证据）

| # | 问题 | 证据 |
|---|------|------|
| 1 | 分区轴混用：Trae/Qoder 各占整页，与 CodeBuddy 的模型页同构却分居三处 | `lib/client.js:1512`（TraeSection）、`:1692`（QoderSection）、`:1070`（ModelsSection） |
| 2 | 模型管理散在三处，各有一套同步按钮与列表 | 同上三处各自的 `fetchList`/`syncNow`/`fetchTlist`/`fetchQlist` |
| 3 | 同一状态最多出现 5 处 | 折叠三芯片 `buildChips`（`:619`）、注意条 `attn`/`strip`（`:534`/`:536`）、标签徽标 `tabBadge`（`:682`）、行内 `Dot`、灰字说明 |
| 4 | 工程项与日常项同层 | 3 个端口、`upstreamFirstByteTimeoutMs`、`sessionHeaderFormat`、`baseURL`、4 个域名、`qoderClientId` 全平铺 |
| 5 | 8 个标签扁平铺开，无分组 | `TAB_DEFS`（`:363`） |

补充实测：CodeBuddy 的桥（`:3901`）在"桥与高级"页，Trae/Qoder 的翻译网关（`:3902`/`:3903`）各在自己页——同一概念三处不同位置。后端口径核对：`meter` 由三通道网关共同记账（`core/usage-meter.js:120` 的 `record()` 被 `providers/trae/gateway.js:513`/`:683`、`providers/qoder/gateway.js:450` 调用）⇒ **用量是跨通道的**；账户剩余额度（`quotaSnapshot`）是 CodeBuddy 专有。

## 3. 顶层结构（已确认）

顶层 = 4 个可展开区块，顺序固定：**CodeBuddy → TraeWork CN → Qoder CN → 通用**。默认全部收起（首屏 = 4 条状态行，即总览）。

区块头 = 唯一常显状态，格式（示例）：

```
● CodeBuddy    已登录（00）· 28 模型 · 桥 :3901 ✓
■ TraeWork CN  未启用
⚠ Qoder CN     已登录 · 网关 :3903 未监听
○ 通用         额度 1879 credit · 服务商 3
```

状态点 tonal 沿用现有 `cbc-ok/warn/err/off` 四色；warn/err 只在所属区块头出现（原注意条的语义就地化）。

**状态行真源**：判定口径与文案直接沿用现有 `buildChips`（`lib/client.js:619`），只是从"三处重复展示"收敛为区块头一处；`tabBadge`（`:682`）随标签栏一并删除。CodeBuddy / Trae / Qoder 三家的状态行所需数据**全部在 GET 响应内**（已核 `settingsView`，`index.js:1179`：`oauth` / `bridge{running,port,lastError}` / `models.effectiveCount` / `trae.oauth`+`trae.bridge`+`trae.models{disabled,sync{at,count}}` / `qoder` 同构——通道模型数可由 `sync.count − disabled.length` 就地算出，无需额外请求）；唯一例外是通用区块头的「额度 / 服务商数」——二者不在 GET 里，改为卡片挂载时各做一次 `action:'usage'` 与 `provider-list` 取样（未取到前显示 `额度 — · 服务商 —`），通用区块展开后进入原轮询/原有交互。**取样口径分两句（0.10.0 终审措辞更正，此前"一次性，不轮询"被下游读成"永不更新"、据此拒掉了一个真缺陷）**：① **不做周期轮询**——头部四行常驻，定时打 `usage` 等于每次开卡都多付一份上游额度只读，这是成本考虑，不是"数值可以过期"；② **在区块收起时重采一次**——头部状态行是"首屏即总览 / 区块头 = 状态单一真源"的载体，而它正下方的展开区每 10s 轮询；只采挂载那一刻会让头部停在"打开页面那一瞬"的快照，用户加/删一个服务商或聊了一小时之后，头部与同屏正文自相矛盾 ⇒ 总览行会撒谎比没有总览行更伤。触发点 = `general` 由展开转收起的那一刻（`useEffect` deps `[!!openBlocks.general]` + `useRef` 记前值判"由开转关"），**不是**展开时（展开时正文自己会拉）。**本机凭据扫描 `credential-scan` 不上移**——仍在通用区块首次挂载时才做（它会扫本机文件，不该在每次开卡时触发）。**api-key 模式降级**：`quota.numericQuota` 为假（数值额度是 OAuth 专享，实测 401）时头部不编造数字，显示 `额度 估算`（口径同现有手填估算档）或退化为只显服务商数。

内容映射（归属原则 = 谁提供归谁，附代码证据）：

| 区块 | 内容 | 证据 |
|---|---|---|
| CodeBuddy | 凭据、模型、**工具**（搜索/抓取、生图）、网关（流式桥）、高级 | 搜索/抓取走 `/agenttool/v1/*`、生图走 `/v2/images/generations`（`providers/codebuddy/agenttool.js`、`images.js`） |
| TraeWork CN | 凭据、模型、网关（翻译网关 :3902、聊天传输、首字节超时）、高级（域名组） | `providers/trae/gateway.js` |
| Qoder CN | 凭据、模型（启停 + 档位/上下文变体）、网关（:3903）、高级（域名组） | `providers/qoder/gateway.js` |
| 通用 | 额度与用量（跨通道计量 + CodeBuddy 账户额度）、服务商（key 型上游 + 本机凭据导入） | `core/usage-meter.js` + `providers/qoder`/`trae` 记账调用点；`providers/openai-compat.js` |

**删除**：8 标签导航（`TAB_DEFS`/tabBar/各 ARIA）、折叠三芯片、注意条、标签徽标。
**必须原样迁移的硬修复清单**（全量重写最容易丢的就是这些；行号为现 `lib/client.js`，逐条已核）：

| 机制 | 位置 | 迁移要求 |
|---|---|---|
| 保存后网关退避补拉 `settleGateways` | `GATEWAY_SETTLE_DELAYS` 延迟表 / `settleGateways()` | **踩坑 #45**：POST 同步返回而 `running` 由 `listening` 事件异步翻转 ⇒ 假「未监听」会永久驻留。新结构下状态行仍在区块头，机制必须保留（1s/2s/4s 三次，用尽停手、warn 如实留下）；**启动点与续跑点两处判定同形**（读 `dataRef.current`，见下一行）。锁 = `[B4]`（续跑自愈）+ `[B5]`（启动点：本包被竞争包作废时链照旧要起来） |
| **写后读必须带请求代次**（0.10.0 终审补，#45 同族的另一半） | `load()`（`loadGenRef`/`dataRef` 两个 `useRef`）/ `save` 的 `.then` / `settleGateways` 的退避回调 | `load()` 的响应要能识别陈旧并丢弃：每次 `load()` 领一个自增代次（`useRef`），回包时不是最新代次就整包作废（**失败分支同样受门约束**——陈旧请求的报错不该盖住新态）。#45 上一轮只补了"异步 listen 会迟到"那一半，漏了"并发 GET 会倒序落地"这一半：`save` 的 `.then` 里必跟 `load()`，而本轮"四区块可同时展开 + 每分区各持一个 `saveIn(block)`"让 1 秒内并发保存成为**正常操作路径**，两次 POST 落在同一 GET 往返窗口（实测 ~1.0–1.3s）时先发后回的旧响应会覆掉新响应，且主视图无轮询自救。**配套纪律（复审补）**：一旦 `load()` 会返回 `null`，任何"拿返回值判接下来做什么"的站点都不能再用返回值——补拉链的**两个判定点（`save` 的 `.then` 启动点 + `settleGateways` 的续跑点）必须同形地读 `dataRef.current`**，只改一处等于把 #45 的自愈保护削掉一半（复审实测回退启动点 ⇒ 假「未监听」永久驻留）。通式：**写后的读不可当终态**，既要"补拉到收敛"，也要"陈旧响应不许落地"，还要"判定别看回调参数" |
| `fetchWithTimeout`（GET 20s / POST 30s） | `:98` | 全部 fetch 走它；AbortError 换成带时长的中文错误 |
| `PanelBoundary` 错误隔离 | `:296` | 粒度从"每标签"改为**每分区**（一个区块内的各分区各自隔离——模型组塌落不影响同区块的凭据组，比整区块隔离更细）；`componentDidCatch` 送堆栈进 console、fallback 只显示 message（踩坑 #7） |
| `startOAuthFlow` 同步开窗 | `:2042` | `window.open` 必须在点击处理器内同步发起，异步调用被弹窗拦截器吃掉 |
| `pickComponent` 图标候选表 | `:84` | **踩坑 #44③**：宿主 0.1.7 废掉带尺寸数字后缀的图标名；按候选序取第一个存在的，全缺退原生兜底 |
| 幽灵输入双路径 CSS | `:214`–`:218` | 宿主 `Input` 原语把 className 落在 wrapper span、焦点在内层 input ⇒ `:focus-within` 与 `.cbc-ghost input::-webkit-*-spin-button` 两条都要留 |
| 同值去重 + 失败销账（4 张表） | `:1124` / `:1577` / `:1773` / `:1789` | **踩坑 #27/#32**：`useRef` 同值去重（不用时间窗——勾选往返可快过任何时间窗）；失败分支必须删账，否则该模型同向操作被永久吞掉 |
| 字段编辑器模块级定义 | `TextField:1999` / `NumberField:2035` / `LimitInput:2060` | 组件身份随父重渲染变化会丢焦点 |
| 错误提示带原因 | 全文件 23 处 `e.message` 优先 | "（网络）"只是兜底；0.9.11 轮 3 收全的 13 处 catch 勿在重写中退回 |
| 脱敏纪律 | GET 的 `user` 字段 | Key 只回脱敏值、永不回传浏览器（踩坑 #26） |
| 失焦即保存 / `ResetButton` / `HelpNote` / 懒挂载 | — | 语义平移，不改行为 |

## 4. 区块内部结构与交互（已确认）

通道区块展开后 = 固定顺序分组（三家同构，CodeBuddy 多一个「工具」组）：

```
凭据 → 模型 → [工具] → 网关 → 高级(details 折叠)
```

- **凭据**：CodeBuddy = 登录方式 + 多 Key 管理 + 环境变量引用 + 失败冷却；Trae/Qoder = 登录/退出（二次确认）+ 令牌状态行。
- **模型**：操作条 `[同步目录]` + 状态文字（`上次同步 MM-DD HH:mm · 目录 N 个`）；筛选框三家统一提供；行 = 勾选框 + 模型名 + ctx/输出（CodeBuddy 可编辑=幽灵输入，另两家只读）+ 档位/变体 select + 徽标（插件/目录/CLI/图/思考）。CodeBuddy 现有两按钮（刷新列表 / 立即同步）合并为 `[同步目录]`：一次点按顺序触发 `model-sync` → `model-list`；失败路径保持两侧原因分别可见（目录同步失败 vs 列表获取失败，各自照旧文案）。
- **工具**（仅 CodeBuddy）：搜索与抓取开关 / 默认条数 / 正文上限；生图开关 / 生图模型。
- **网关**：状态行 + 端口 + 该通道特有项（CodeBuddy：流式桥开关、会话归因、会话头格式、并发上限；Trae：聊天传输、首字节超时）。
- **高级**（`<details>` 折叠，零 JS 状态）：域名族、`baseURL`、`qoderClientId` 等纯工程项。
- **通用区块**：`额度与用量`（hero + 统计卡 + 资源包 + 轮次表，原样；轮询条件从"标签可见"改为"区块展开"）+ `服务商`（列表 + 添加行 + 本机凭据行，原样）。

**交互细节**

1. **区块头结构**：`div.cbc-acc-head` = 左侧占满的展开 `button`（状态点 + 名称 + 状态行 + 箭头，`aria-expanded`/`aria-controls`）+ 右侧可选启用开关（Trae/Qoder 的 `traeEnabled`/`qoderEnabled` 唯一落点，不在展开区重复）。分开两个交互元素，避免嵌套交互。CodeBuddy 无通道级开关，头部右侧只有箭头。
2. **手风琴允许多开**，互不联动；展开才挂载分区内容，收起不卸载（`hidden` 保留 DOM——草稿、滚动位置、已拉目录跨展开与保存保留，语义平移自现有懒挂载纪律）。
3. **状态收敛**：warn/err 仅见于所属区块头；错误横幅保留卡片顶部；保存成功提示从标签栏右侧移到**触发该次保存的区块**头部右侧（1.8s 自愈）。
4. **键盘/ARIA**：区块头是普通 button（Enter/Space 展开/收起）；删除 tablist 的 roving tabIndex、`role="tab"`、方向键逻辑与相关断言。
5. **模型档位/上限控件**：`LimitInput`、`effortByModel` select、Qoder `modelPrefs` 两 select 全部原样迁移（同值去重 `useRef` 纪律不变，踩坑 #27/#32）。
6. **旧槽折叠态**（≤0.1.5 `settings.plugin.item`）：卡片头保留标题 + 一行简介；仅当存在 warn/err 时显示单枚"N 项需处理"芯片；展开卡片即进入四区块手风琴。`plugins.item` 的 summary 视图不变。

## 5. 字段落点对照（`SETTINGS_FIELDS` 全量，31 项）

| 字段 | 落点 |
|---|---|
| `authMode` `apiKeys` `activeApiKey` `apiKeyEnv` `keyCooldownMs` | CodeBuddy · 凭据 |
| `effortByModel`（+ 状态量 `modelSetEnabled`/`modelSetLimits`） | CodeBuddy · 模型 |
| `searchEnabled` `searchMaxResults` `fetchBodyCap` `imageGenEnabled` `imageGenModel` | CodeBuddy · 工具 |
| `bridgeEnabled` `bridgePort` `sessionHeadersEnabled` `sessionHeaderFormat` `maxConcurrentPerSession` | CodeBuddy · 网关 |
| `baseURL` | CodeBuddy · 高级 |
| `traeEnabled` | TraeWork CN · 区块头开关 |
| `traeChatTransport` `traeBridgePort` `upstreamFirstByteTimeoutMs` | TraeWork CN · 网关 |
| `traeAuthBaseURL` `traeChatBaseURL` `traeLoginHost` | TraeWork CN · 高级 |
| `qoderEnabled` | Qoder CN · 区块头开关 |
| `qoderBridgePort` | Qoder CN · 网关 |
| `qoderLoginHost` `qoderOpenapiBaseURL` `qoderInferBaseURL` `qoderClientId` | Qoder CN · 高级 |
| `quotaTotalManual` | 通用 · 额度与用量 |
| 其余状态量：`traeModelSetEnabled` / `qoderModelSetEnabled` / `qoderModelSetPrefs` / `provider-*` / `credential-*` | 各自通道的模型组 / 通用 · 服务商 |

## 6. 兼容、回归与影响面（已确认）

- **后端契约零变化**：GET/POST `/dsh-tap/settings` 的全部 action 与响应结构不动；槽位双注册（`plugins.item` / `settings.plugin.item`）不动。
- **浏览器回归**（仓库外 `dsh-ui-test/`，puppeteer + 系统 Chrome）：
  - 驱动方式从"点 `.cbc-tab` 文本 + 查 `.cbc-panel[data-tab=X]`"改为"点区块头 + 查新区块选择器"。
  - `card-regression.js`（现 28 断言）：随结构消失的断言（标签齐全/徽标/注意条/ARIA tablist/方向键）替换为——4 区块与固定顺序、默认全收、状态行口径（**独立预言机**双向对齐，沿用 0.9.11 手法）、展开才挂载、收起保留（草稿 + 滚动）、多开独立、头部开关 = 1 POST、无注意条（warn 只出现在状态行）、**挂载取样各一次且收起不轮询**（usage/provider-list 在卡片挂载时各一次，通用区块收起期间无周期请求）。⚠ 实测：现套件**没有**"未激活不轮询 / 切走即停"这条断言——原 `step25` 已随 0.9.11 回归套件重建丢失（`grep -n "切走\|不轮询" card-regression.js` 零命中），故本次是**新增**该断言，不是"承接"。
  - `qoder-slot-check.js`（现 10 断言）：Qoder CN 标签 → Qoder CN 区块；槽断言不变。
  - `qoder-e2e.js`（8 断言）/ `qoder-prefs-check.js`（32）/ `qoder-tab-phase2.js`（8）/ `shots-baseline.js`：选择器与驱动逐个适配（断言数为本次实测 `grep -c 'check("'`）。
  - 纪律保持：mock GET/POST、零真实写入（跑前跑后 `~/.dsh/codebuddy-plugin.json` 哈希对账）。
- **文档修正（实测漂移）**：`wiki/07-web-client.md` §改 UI 后的回归 说"测试驱动先用 `window.__cbc.tab('分区名')`"，但 `lib/client.js` 与 `dsh-ui-test/*.js` 中**均无此钩子**（脚本实际点击 `.cbc-tab`）。重设计后统一写清新区块驱动方式与选择器清单。
- **文档与版本**：重写 `wiki/07-web-client.md` 卡片结构章节；更新 `AGENTS.md` 架构表 `lib/client.js` 行；`CHANGELOG.md` 记 0.10.0。
- **已知限制**：旧槽（≤0.1.5）无本机宿主可实测，仅代码审查覆盖；回归脚本为仓库外资产且历史上丢失过（step 系列），本次重写后把"选择器清单 + 驱动方式"固化进 wiki。

## 7. 实施顺序（供 writing-plans 展开）

1. **骨架**：4 区块 + 状态行 + 手风琴 + 懒挂载；先打通 CodeBuddy 的「凭据/模型」两组（含同步按钮合并）。
2. **迁移**：其余内容迁入手风琴（工具/网关/高级/额度/服务商/通用），删除三套状态层与 tablist 逻辑。
3. **回归**：换驱动与选择器，重写断言集，`dsh-ui-test/` 全绿（含零写入 mock 组）。
4. **收尾**：截图基线重拍、wiki/AGENTS/CHANGELOG 更新。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 展开态页面变长 | 默认全收 + 多开可控；模型列表保持滚动盒 |
| 头部开关误触（收起态直接启用/停用通道） | 开关即普通 checkbox、可逆；若实感不佳，回退方案 = 开关移入展开区第一行（已与用户约定） |
| 回归脚本重写工作量（仓库外一次重建） | 预留独立一轮（实施顺序 ③），断言集先写"独立预言机"再补细节 |
| 旧槽路径无宿主可测 | 保留双槽注册；旧槽逻辑仅做代码审查 + 精简（折叠态只留 1 枚按需芯片） |

## 9. 验收标准

- `lib/client.js` 全量重写后：4 区块与状态行口径正确；默认全收；展开才挂载、收起保留；多开独立；无 tablist/注意条/徽标残留代码与样式。
- `dsh-ui-test/` 全部脚本适配后跑绿（card-regression 重写版 + qoder 系列），零真实写入纪律可复验。
- `npm run verify` 与全部离线回归（verify-bridge / core-generic / rotation / providers / trae / qoder / host-config）保持绿（纯前端改动，预期零影响，作为回归保险）。
- 浅色/深色截图基线重拍并人工核验；wiki/AGENTS/CHANGELOG 更新到位。
