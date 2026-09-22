# 课题状态表（交接用，新会话 30 秒接上）

> 更新纪律：每次会话结束必须更新本表。状态取值：未开始 / 探测中 / 规则成立 / 未解。
> 长期目标与完成标准见会话目标；课题按序进行，架构重构（core/ + providers/）在课题 1 完成后才允许开始。

## 分支拓扑（2026-09-17 梳理，改动分支/tag 前先读这节）

三条分支**不是同一条线的三个版本**：`main` 与 `v0.8.3` / `open-source` 之间 `git merge-base` 为空——历史线互不相干（两个独立根提交）。`git branch -vv` 里 `main` 与 `open-source` 的 ahead/behind 数字跨线比较，无意义。

| 分支 | HEAD | 提交数 | 性质 |
|---|---|---|---|
| `main` | 93b24c8 2026-08-19 | 17 | **私有线，已遗弃**。根提交 8bc7e3b「Initial import: CodeBuddy provider bundle migrated from Windows copy」，0.2.0→0.7.4，含 `code-review-report.md`、`docs/probes/*.jsonl` 等私有材料，从未推送 origin |
| `open-source` | da8254c 2026-08-20 | 6 | 开流线的一段。根提交 8cfa542「v0.7.4 initial open-source release」= origin/main 历史起点（仓库首提交 f3385d3 的 amend）；本地多做 0.8.1/0.8.2 两提交未推。**upstream 误设为 origin/main**（远端无此分支） |
| `v0.8.3` | b2b5c8e 2026-09-11 | 37 | **实际开发线，当前 HEAD**。名字只是历史遗留——内容一路做到 0.9.6 |

开流动作 = 从私有线 0.7.4 快照重建干净历史（8cfa542 vs 8bc7e3b 实测删 30 文件 / -6152 行，去掉探测证据与 code-review-report 等私有材料）。**开流之后只有一条连续线**：

```
8cfa542(0.7.4 公开基线) → fc52657(0.8.0) → 50e19a1/e70f5bc(0.8.1) → da8254c(0.8.2)   [open-source]
  → 4639e44/521e74b/6fee4a9(Trae 通道 0.8.3 起) → … → 60d3e71(0.9.0 改名 dsh-tap)
  → b5ea3eb(0.9.1) … 680cd59(0.9.4) → 98b203d(0.9.4 收尾 = origin/v0.8.3 最新)
  → 9cc5d80(0.9.5) … 0c4ed27(0.9.6) → fffc4d7/47a5544/e022ada/0dc1509/b2b5c8e(5 个未发版提交)
```

远端与本地差额：`origin/main` 停在 27e4736（3 提交：8cfa542 + 文档 + `Create node.js.yml` CI）；`origin/v0.8.3` 停在 98b203d；本地 v0.8.3 领先远端 10 个提交，其中 HEAD 前 5 个未进 CHANGELOG（`git log 0c4ed27..HEAD`）。

其它遗留：本地 tag/分支 `v0.8.0` = fc52657（open-source 链起点，陈旧）；`stash@{0}` 为 "On main: mode-only drift 755->644"（换分支时文件权限漂移，无内容）。

工作区：Windows 侧 `C:\Users\21613\dev\dsh-tap` 是 WSL 工作树在 b2b5c8e 的**逐字节拷贝（无 .git）**——两边文件内容 md5 一致，改哪边都要手工同步另一边。

## v0.8 Goal 进展（docs/goals/v0.8-额度可见-模型动态化-多服务商.md）

| G 项 | 状态 | 进展记录 |
|---|---|---|
| G1 真实 OAuth 登录 | **完成**（2026-08-19） | 用户已完成真实浏览器登录：`~/.dsh/codebuddy-plugin-auth.json` 存在，`authMode:"oauth"`，personal 账号（nickname "00"），access token 有效期至 2026-10-16；`oauthStatus()` 经插件代码路径离线验证 signedIn:true + 账户信息。基线：verify:bridge / verify:core / verify-rotation 全绿。 |
| G2 token×端点矩阵 | **完成**（2026-08-19） | `probe-oauth.mjs` 新增 matrix/quota/quota2/values/quota3–7/refresh 八组真实 token 探测（证据 `docs/probes/oauth-token-2026-08-19.jsonl`）。三大结论：①token 权限边界=ck_ key 严格超集（五端点同可达，`/billing/meter/*` OAuth-only、ck_ 401）；②**数值剩余额度 API 找到**——控制台 SPA bundle 逆向出 `/billing/meter/get-user-resource`（资源包 CapacityRemainPrecise/TotalDosage，本账号 2379）、`check-gift-claimed`（赠品 1500）、`get-enterprise-user-usage`（limitNum 2000）等，两域名同构、Bearer 直达，"cookie 体系进不去"被推翻（quota-signals.md R-Q7）；③refresh 轮换不作废旧令牌（R-O6，expiresIn 60 天；附带发现插件 refreshOAuth 读错字段名 refreshExpiresAt→实为 refreshExpiresIn，良性）。state 真实 TTL 留待下次交互登录顺带验证。 |
| G3 额度卡片 | **完成**（2026-08-19） | "额度与用量"分区升级：OAuth 模式显示**真实剩余额度**（`/billing/meter/get-user-resource`，`fetchQuotaSnapshot` 扩展：numericQuota + resource{totalRemain/cycleRemain/packs[11]}，60s 缓存不阻塞主链路）；api-key 模式为手填总额度（新字段 `quotaTotalManual`）− 计量累计的**估算**档并标注；轮次行加 token 拆解（usage-meter groupTurns 增 completion 聚合）。验证：usage 端点实读与探测值一致（1879.73/2379/11 包）；verify:bridge/core/rotation 全绿、`npm run verify` 18/18；浏览器回归 step20/22/24/25 全绿 + 新增 step26（数值额度区块 6 断言，模式感知）。截图 dsh-ui-test/shot-quota.png。 |
| G4 模型动态化 | **完成**（2026-08-19） | 模型清单默认跟 `/v3/config` 走：index.js 新增模块级 `dynamicCatalog` + `computeBaseModels()`（目录∪静态并集，目录刷新同名静态条目尺寸、静态 reasoningEfforts 靠展开保留；纯静态 id 保留——目录≠可路由，deepseek-v3 不在目录但是默认模型）+ `syncModelsFromGateway()` 单飞（启动自动 + 设置卡"目录同步"行手动，成功换新铺镜像、失败保留旧目录或回落静态，**选择器绝不变空**）。纯净态纪律修订：有动态目录时镜像恒铺（每次启动刷新，不属踩坑 #6"陈旧遮蔽"）。勾选语义唯一权威 = 服务端 `effectiveIds`（settingsView.models 与 model-list 响应均带）；`setModelEnabled` 基清单内只动 disabled 不写 extra。验证：启动同步 24 目录 → effective 30（+静态独有 6），settings.yaml 镜像 30；离线回落实测（baseURL 打挂重启）：sync:null、effective 19、默认模型在、镜像=静态+extra，恢复后 24/30 回弹；toggle 往返（glm-5.0 off→29→on→30）；四项离线回归全绿；浏览器 step20/22/24/25/26 全绿 + 新增 step27（同步行/按钮/effectiveIds 语义/at 前进，6 断言）。 |
| G5 上下文长度组件 | **完成**（2026-08-19） | 每模型 ctx/输出上限行内可调：`modelState.overrides{id→{contextWindow?,maxTokens?}}`（readModelState 迁移默认 {}，纯净态判定纳入 overrides），`setModelLimits`（null=清除回基值；正整数 + 不得超基清单/extra 实际上限，服务端权威校验）→ `computeEffectiveModels` 应用覆盖 → 镜像即时重铺。model-list 响应加 `profiles`（有效值，覆盖全已知 id 含禁用行）+ `ceilings`（基值上限）。client.js：模块级 `LimitInput`（组件身份稳定防失焦；Enter/blur 提交，清空=回基值，超限本地快检+横幅报错回退），onModelsSaved 本地合并 overrides+重算 profiles；删除闲置 fmtCtx，CSS 加 cbc-w90。验证：API 级 set/超限拒/非整数拒/清空全过（镜像 1000000→500000→回弹）；新增 step28（12 断言：值显示/1 POST 纪律/镜像落盘/超限 0 POST/双字段往返）；浏览器全量 step20–28 绿（86 断言）+ verify:bridge/core/rotation 绿。 |
| G6 多服务商注册表 | **完成**（2026-08-19） | 设置卡新增"服务商"分区：预设（火山 ark / 阿里百炼）或自定义（id+baseURL）+ key → 实测 GET /models 验 key → 写 settings.yaml `llm-pi-ai.providers.<id>` 块（apiKeyEnv 引用）+ `~/.dsh/.credentials.yaml` `<ID>_API_KEY`（0600 硬要求）→ **免重启热加载进选择器**（chokidar watch + 原地换路由，实测 active）；删除连块带凭据一起清；登记册 `managedProviders` 存插件文件层（无 secret，key 只回脱敏）。机制与官方 CustomProviderCard 相同（调研报告：schema/合并/凭据缝/选择器枚举六问，证据到文件:行号）。`providers/openai-compat.js` 共享骨架 + `providers/ark`/`providers/bailian` preset，core/ 零改动（verify-core-generic 绿）。**毒化实测**：settings.yaml 用户层有一个坏 provider 块 → 启动时整个用户层被丢弃（base/patch 层 codebuddy 幸存，用户手写 qianwenai/kimiclaw/kimi-coding 全灭）→ 写块前本地校验 + 实测目录是硬纪律。验证：API 级 add/refresh/remove/错误路径全过；step29 10 断言（含热加载轮询与坏 key 无残留）；全量回归 step20–29（96 断言）+ 三项离线回归绿。真实 ark/百炼 key 的添加留给用户交互。 |
| G7 本机登录态检测 | **扫描完成，导入链路已修通，待用户确认导入**（2026-08-19） | 只读扫描器 `local-scan.js`（探测器数据驱动，findings 只带路径/类型/过期元数据、**绝无 secret 值**）+ 路由 `credential-scan`/`credential-import` + 设置卡"服务商"分区顶部"本机凭据"行（自动扫描一次，可导入项带"一键导入"，不可导入项带原因，已导入去重标记）。本机实测命中：**iFlow**（~/.iflow/settings.json 现成 apiKey）、**Qwen Code**（~/.qwen/oauth_creds.json）；不可导入带原因：Codex/CodeBuddy CLI/Kimi Code/ZCode；TRAE/豆包/Qoder/千问办公未安装。**兜底修复（同日傍晚）**：探测发现 iFlow/portal.qwen.ai **均无 GET /models**（404）——原导入链必炸；openai-compat 骨架新增 `probeChatKey`（chat 探针验 key + `fallbackModels` 兜底清单，规则 E-P1/P2 见 docs/rules/extra-providers.md），iflow/qwen 升为正式 preset（同 id 同 baseURL 时 credential-import 走 preset 通道），preset 条目刷新模型自动带兜底。**另查实：Qwen OAuth 免费额度 2026-04-15 已官方停服**，本机 qwen token 大概率失效（探针会如实拒绝）。验证：verify-providers.mjs 13 断言（含 iflow 434 方言）；live 假 key 穿透两 preset——iflow 如实报 434、qwen 如实报 401、零文件残留；step29/30 全绿；四项离线回归绿。**导入动作等用户逐个确认**；/v2/accounts 网关侧 500→524 持续故障，step25 降级分支维持。 |

## 六课题状态（2026-08-19 全部关闭）

| # | 课题 | 状态 | 规则文档 | 证据 | 下一步 |
|---|---|---|---|---|---|
| 1 | UA 校验 | **规则成立**（宽松路径 flapping 子项未解） | [ua-validation.md](ua-validation.md) | `docs/probes/ua-2026-08-19.jsonl`（74 条）· `scripts/probe-ua.mjs` | 重构时按文档 §3 裁判 CLIENT_HEADERS |
| 2 | 提示缓存 | **规则成立**（glm 概率保留成因、部分模型 TTL/阈值单元格未测，已标注） | [prompt-cache.md](prompt-cache.md) | `docs/probes/cache-boundary-2026-08-19.jsonl`（49 条）· `scripts/probe-cache-ttl.mjs` | 课题 3 路由探测时把 auto 模型的缓存行为一并记录 |
| 3 | 路由配置（14407） | **规则成立**（账号/套餐维度单账号不可证伪，已标未解；auto 分解未测） | [routing.md](routing.md) | `docs/probes/routing-2026-08-19.jsonl`（19 条）· `scripts/probe-routing.mjs` | 重构时把 14401/14407/11102/11103 错误映射表放进 providers/codebuddy/ |
| 4 | 额度信号 | **规则成立**（耗尽错误码违反只读红线不可诱发，标未解） | [quota-signals.md](quota-signals.md) | `docs/probes/quota-map-2026-08-19.jsonl`（9 条）· `scripts/probe-quota2.mjs` | 重构时删 webfetch 死 usage 路径（注释引 R-Q2 证据） |
| 5 | OAuth 握手 | **规则成立**（state 真实 TTL 仍未解，下次交互登录顺带验证） | [oauth-handshake.md](oauth-handshake.md) | `docs/probes/oauth-2026-08-19.jsonl`（15 条）+ `oauth-token-2026-08-19.jsonl`（G2 八组）· `scripts/probe-oauth.mjs` | G2 已解锁 token 权限边界（R-O5 超集）与 refresh 轮换（R-O6 不作废） |
| 6 | 内容审核 | **规则成立**（case 变体按红线刻意不测） | [content-moderation.md](content-moderation.md) | `docs/probes/moderation-2026-08-19.jsonl`（6 条）· `scripts/probe-moderation.mjs` | 重构时 developer→system 重写归入 providers/codebuddy/，11128 入错误映射表 |

## 架构重构（2026-08-19 完成，完成标准 2、3 已满足）

- 结构：`index.js`（约 1863 行单文件）→ `core/`（json-store / rotation / usage-meter / bridge，provider 无关）+ `providers/codebuddy/`（headers / errors / oauth / catalog / agenttool / images 薄适配器）+ `index.js` 降为组合根。对外导出契约不变。
- 规则文档裁判落位：CLIENT_HEADERS 逐字段判定见 `providers/codebuddy/headers.js` 文件头（仅 UA 的 codebuddy/含点段是规则，余皆迷信保留）；错误码表进 `providers/codebuddy/errors.js`；developer→system 重写归适配器 `transformChatPayload`；webfetch/search 死 usage 路径按 R-Q2 删除（images 的未证伪，保留）。
- 证伪测试（完成标准 2）：`scripts/verify-core-generic.mjs` 全绿——core/ 静态零特化 token、零 providers/ 引用；内联 mock-openai 适配器经 core/ 驱动第二上游（聚合/透传/会话头/轮询 failover/无 credit 计量/developer 透传）。
- 回归（完成标准 3）：`npm run verify` 18/18 在线、`verify:bridge` 44 断言、`verify-rotation`、`verify:core` 全绿（2026-08-19，WSL node v22）。
- 关键纪律（docs/pitfalls.md #20）：core/ 与 providers/ 的运行状态一律实例状态（工厂/类），在 index.js 模块作用域创建——verify-rotation 的 `?case=` 双导入隔离依赖这一点，状态沉进 core 模块全局即破。
- 已知有意偏差：createBridge 的 SessionLimiter 改为 per-apply（原为模块全局；测试中性、生产单实例）；凭据不可用识别从消息字符串比较改为 `err.credentialUnavailable` 旗标（文案不变）。

## 关键运行环境事实（免得重查）

- 凭据：`~/.dsh/.credentials.yaml` 的 `CODEBUDDY_API_KEY`（api-key 模式）；探测脚本与插件同逻辑解析。
- 网关：`https://copilot.tencent.com`；UA 门只认 `/codebuddy\/[^a-z\s]*\./i`（含点即可，版本数值不查）。
- `/v2/chat/completions` 必须 `stream:true`（否则 11101），无 UA 门；`/agenttool/*` 当前无 UA 门。
- 探测纪律：1.5s+ 间隔、单账号、只读优先；证据落 `docs/probes/<课题>-<日期>.jsonl`，预测须预注册（脚本内 expect 字段）。
- 工作区注意：**2026-09-21 起正本在 Windows** `C:\Users\21613\dev\dsh-tap`（git 历史已通过本地 fetch 从 WSL 并入，v0.8.3 分支连续）；WSL 侧 `/root/dev/dsh-tap` 已退役留作备份，别再往那边改（见上「分支拓扑」节与下「上次会话 2026-09-21」）。

## 本次会话（2026-09-22 续三，CodeBuddy 通道「模型思考强度」更新）

1. **目录声明扩容被吃进来（本次功能核心）**：`GET /v3/config` 的 `reasoning` 出现新形态 `{supportedEfforts, canDisableThinking, defaultEffort}`（旧形态只有默认档 `effort`）。实测带清单的仅 4 个：`glm-5.3-flash` / `kimi-k2.8-preview` = `["low","high","max"]`（canDisableThinking **true**）、`hy4-preview` / `hy4-preview-x` = `["high"]`（false）。落点：`providers/codebuddy/catalog.js` 全量解析声明 → `index.js catalogReasoningEfforts()` 生成档位表（键=档位名、值=出站线值）→ `catalogToProfile` 挂到 profile → `computeBaseModels` 合并（**目录声明优先、patch 静态表兜底**）→ settings.yaml 镜像随之带 `reasoningEfforts`（**宿主 Model/Effort 选择器对目录模型从此出档**，此前一律无档）。
2. **档位语义三定论（162+24 臂实测，新探针 `scripts/probe-codebuddy-efforts.mjs`）**：①误拼有专用码 **11150** `invalid_reasoning_effort`（v4-pro 显式 `off`/`disabled`/`auto` 全 11150，而同拼写在 glm-5.3-flash 被静默接受 ⇒ 拼写接受面逐模型不一致，档位表只列实测/声明过的拼写）；②**"关思考"无可靠拼写** —— canDisableThinking=true 的两模型**省略参数照常思考**（reason≈1.2k），`off`/`disabled`/`auto` 被接受但推理量不变，`minimal`/`none` 两模型表现不一致（GLM≈0 / Kimi≈140 对基线≈1k）⇒ 插件**不出 off 档**、不臆造线值；③`off` 档语义 = 省略参数，**只在该模型"省略即不思考"时才是真开关** —— `hy3`/`hy3-preview` 六臂每臂都出 ~510–625 字推理，off 已撤（08-16 结论过期）。
3. **静态清单按实测刷新**（证据 docs/probes/codebuddy-efforts-matrix-2026-09-22.json，决策表 = `--summarize`）：撤 hy3/hy3-preview 的 off；**补 deepseek-v3.2 的表**（旧清单漏列，实测档位有效）；新增可路由且有实效的目录模型 `deepseek-v4.1-flash` / `deepseek-v3-2-volc` / `glm-5.3` / `glm-5.0-turbo` / `hy3-x`（glm-5.3/hy3-x 无 off）；尺寸对齐目录（v4-pro maxTokens 50000→128000、glm-5.2 48000→64000、minimax-m3 128000→64000）；**目录有 ≠ /v2 可路由**——`glm-4.6v`/`kimi-k2-thinking`/`minimax-m2.5`/`hy4-preview-x` 六臂全 11102 ⇒ 不进静态清单（routing.md R-R3 再证）。静态清单 18 → 23 个模型。
4. **UI 与守卫**：设置卡「模型」页档位 select 改由服务端 `efforts`（静态表 ∪ 目录声明）驱动（目录模型也出档）；`off` 仅在**线值非空**（真开关）时出现，`off` 线值为 null 者（= 省略参数 = 默认态）不进选项；桥出站注入改查合并表，未声明档位/无表模型一律不注入（脏档位永不线上）。
5. **验证**：verify-bridge 新增 **[17] 14 断言**（目录声明→档位表→settings.yaml 镜像→桥出站注入全链 + 负例：未声明档位/无表模型/off 不注入；mock `/v3/config` 带闸门，前 16 节不受影响）——全套绿、exit 0；**真实上游全链路联调** `scripts/probe-codebuddy-tier-wiring.mjs`（临时 DSH_HOME + 本地捕获代理 → 真实网关）**12 断言全绿**：真实目录 31 模型、档位表与声明一致（`glm-5.3-flash/kimi-k2.8-preview=["low","high","max"]`、`hy4-preview=["high"]`）、镜像带 `reasoningEfforts`、真实 chat 出站体带注入的 `reasoning_effort:"max"` 且上游 200、负例（`medium`/`auto`）不注入；verify-core-generic / verify-rotation / verify-providers / verify-trae(89) / verify-qoder(154) 全绿；`verify-models.mjs --list/--sync` 解析 23 模型正常。证据：docs/probes/codebuddy-efforts-{matrix,focus,disable,offconfirm}-2026-09-22.json + codebuddy-tier-wiring-2026-09-22.json。
6. **待办**：①**必须重启 dsh** 才生效（patch + index.js 都是启动期加载；重启后宿主 Effort 选择器即对 glm-5.3-flash/kimi-k2.8-preview/hy4-preview 出档）；②`canDisableThinking` 的真关思考机制未定（怀疑不在 `reasoning_effort` 维度，可能在 `thinking` 字段或思考预算参数）——如用户需要"彻底不思考"，值得单开一轮探 `thinking`/`enable_thinking`/预算类参数；③上游目录随时会再变，复跑 `node scripts/probe-codebuddy-efforts.mjs [--catalog] [--summarize <证据>]` 即可重出决策表。

## 上次会话（2026-09-22 续二，Qoder `provider_error` 复发调查 → 真根因定案）

1. **复发调查结论：#39 的定案是错的（当日推翻），真主因是 `content:null` 不可见**（踩坑 #41）。定位手法 = **单变量差分**：同一条结构合法的工具环，只切 assistant 的 `content` ∈ {`null`, 缺键, `""`, `"我查一下"`}，打真实上游——`null`/缺键在 **dmodel/kmodel/mmodel 一律 400**（文案各家一套），`""`/文本全绿；`role:"tool"` 自身 `content:null` 另报 `insufficient tool messages`。宿主 pi-ai `convertMessages`（openai-completions.js:961）在 `compat.requiresAssistantAfterToolResult=false` 下**对每个纯工具轮都发 `content:null`** ⇒ dsh 在严格家族上第一次调工具就必炸，与中断无关。首版修复的桩也是 `content:null` ⇒ **修复自身即新坏体**（`B_orphan_stub_null` ❌ / `B_orphan_stub_empty` ✅；经生产网关 B1–B5 全红）。首版验证还跑在容错家族 `qmodel` 上（对一切坏体静默容忍）⇒ 等于没验。
2. **"为什么 Qoder CN 不报错"已用本机取证回答**（不是推测）：官方 `~/.qoder-cn/projects/**/*.jsonl` 105 份 transcript 里 `tool_use`↔`tool_result` **孤儿 result 恒 0**（计数不等时缺的永远是「结果」）；按 `message.id` 归并的 **879 个工具回合 93.3% 带非空 thinking、52.8% 带非空 text，裸 tool_use 仅 2.73%**；252 份 `qodercli.log` 显示官方**同样客户端重放全量历史**（`request_message_count` 涨到 457）却**零条**配对 400。差异全在客户端历史构造纪律。
3. **附带定案：`role:"developer"` 在上游反序列化阶段整请求拒绝**（`Failed to deserialize the JSON body...`，换 `system` 即绿）。现网未触发（qoder 模型条目无 `reasoning` ⇒ pi-ai 发 system），属潜在雷；网关已折叠 developer→system（同 codebuddy 桥策略）。
4. **修复与验证**：`sanitizeToolPairing` 增可见性归一（assistant/tool 的 null/缺键 content → `''`、桩用 `''`、`repaired.invisible` 入取证）+ qoder 网关 developer→system。**端到端实测**（用当前代码起临时网关打真实 dmodel）：`A_call_content_null`/`B_orphan_plain`/`B_orphan_stub_null`/`C_tool_content_null` 四形态全部 **400 → 200 出正文**；直连同体仍 400（前后对照成立）。verify-qoder-provider **154 断言**全绿（[18] 扩到含 invisible/桩空串/developer 重写/网关明文断言）；verify-trae-provider 89、verify-bridge、verify-core-generic 全绿。新探针 `probe-qoder-pairing.mjs`（宿主真实序列化器离线复现 + live）、`probe-qoder-null-content.mjs`（单变量差分矩阵 + `--gw-local`）；证据 docs/probes/qoder-null-content-\*.json、qoder-pairing-\*.json。
5. **待办**：①**必须重启 dsh** 才生效（运行中实例 pid 3844 仍加载 05:12 的旧网关模块；重启后建议用 dmodel 跑一次真实工具轮验收）；②宿主 pi-ai 两处缺陷（删 assistant 留 toolResult、工具轮 content:null）值得向 dsh 上游报；③Trae 网关共用 `sanitizeToolPairing` 已同步受益，但其上游（火山/mchost）是否同规则未实测；④CodeBuddy 透传桥未接入该体检（网关宽容，暂无症状）——若日后换严格上游需同样接入。
6. **观测（非回归）**：`verify-bridge.mjs` 在 Windows 上偶发崩在 [15] 取消传播用例**之后**——断言全绿、退出码 1、`Error: read ECONNRESET at TCP.onStreamRead`（被测连接 abort 后的异步 socket 错误落在收尾期）。连跑 3 次全绿 ⇒ 测试自身时序抖动（踩坑 #29 同族），**别误判成回归**；复跑即绿。

## 上次会话（2026-09-22 续，Windows 侧 dsh-tap）

1. **第二类上游报错根因闭合（插件侧真 bug，已修）**：`provider_error … "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"` = 宿主 pi-ai 的 `transform-messages.js` 把 `stopReason=error/aborted` 的 assistant **整条删掉、却保留其 toolResult** → 出站孤儿 `role:"tool"`（离线复现 `[system,user,tool,user]`），严格上游 400。修复 = 网关出站口 `sanitizeToolPairing()`（孤儿补 assistant 桩 / 缺结果补"不可用"结果 / 合法历史逐字节不变），**修复后真实上游端到端实测**：孤儿复现体 400 → 200 正常出文本，两条对照行为不变。入踩坑 #39，verify-qoder [18] 9 断言锁定案；wiki 10-provider-qoder 新增"出站 tool 配对修复"节。**（本条定案已被「本次会话」第 1 项推翻：孤儿只是次因，主因是 `content:null` 不可见，且该修复的桩自己就是 `content:null` ⇒ 修完仍报同一条错；见踩坑 #41）**
2. **Qwen3.8-Flash（qfmodel）根因定案 = 上游节点故障（"Qoder 里能用"前提被推翻）**：完整诊断 docs/diagnosis-qoder-flash.md。客户端侧成因穷举排除（模型 key 由客户端日志自证；body/9 组 clientMetadata/`cosyVersion` 1.1.40→999.999.999/`context_window` 各值/tools 全扫，官方 `QoderContext` 原实现签也照样失败）；`oa_qwen-plus-main` 只被 qfmodel 指名，同坏体在 qmodel/qmodel_38max/q37fmodel 正常；**时间线**：客户端 transcript 里 09-18/09-19 有 754 条 qfmodel 消息（真实可用），最后成功 **04:21:38**，13 秒后同一客户端 `output_tokens=0`，04:31 起 dsh 复现并持续 → 节点在 04:21:38–04:21:51 之间坏了。**插件侧无解**（已如实上抛 `qoder_upstream_error`）；复测 `node scripts/probe-qoder-flash-confirm.mjs`。另：**上游容错面按模型家族分裂**——孤儿 tool 在 dmodel/kmodel/mmodel 上 400、在 auto/qmodel_38max/qmodel/gmodel 上被静默容忍，"换模型能跑"不能证伪协议问题
3. **附带修复：`Cosy-ClientType` 头保真度**：官方 wasm 恒出 `5`（`client_type` 传 `'qoder'`/`5`/缺省都一样），我方旧值 `'qoder'` 让所有请求带第三方指纹，已修为 5（与模型可用性无关）
4. **用量统计归因修复（Qoder CN"用了不统计"报障闭合，插件侧）**：臂9 大额实验**推翻早先结论**——额度扣减（quota/usage 的 addOnQuota.used）对裸 OpenAI body 也实时入账（45s 内 197→199→202），早先"裸 body 不记账"是整数取整读数吞掉 0.002 级小额探测的假象；统计视图（heatmap/summary/明细）是延迟批处理（官方自己的聊天 20 分钟也不动），插件已对齐官方归因链（信封+business 块+business/finish+tracking）以进入该层。判别脚本：probe-qoder-quota.mjs（计数器差分）、probe-qoder-attribution.mjs（臂 1-7 梯度）、probe-qoder-attribution-arm8/arm9.mjs（定价元数据/大额双臂）。**待确认**：统计视图层的延迟窗口与插件归因记录是否落明细——07:10/07:39 数据点：官方 GUI 聊天 42/71 分钟后 heatmap/summary 仍为 0；**12:45 终验**：addOnQuota.used=820（配额实时入账持续正常），heatmap/summary 仍 0 → 该层系**按日批处理**（对官方流量亦然，非插件独有问题）；隔日验证 = 09-23 09:43 cron（昨日值应落 ~13-14：官方 5.04 + 插件归因臂 3.29 + 臂9 ~5.1；落空则按档简报）
5. **待办**：qfmodel 上游修复后复测（确认探针 + `--suite flash`）；宿主 pi-ai 的"删 assistant 留 toolResult"缺陷值得向 dsh 上游报（插件侧已兜住）；本轮改动需**重启 dsh**（运行中实例仍加载旧网关模块）

## 上次会话（2026-09-22，Windows 侧 dsh-tap）干了什么

1. **Qwen3.8-Flash「用不了」根因定界 = 上游侧**：真实目录 key 是 `qfmodel`（非命名规律猜的 `qmodel_38flash`——臆造 key 被上游**静默改派 auto**，响应 model 字段 + billable:false 是哨兵，踩坑 #37）；qfmodel 请求在 HTTP 200 信封装带内业务错误 `{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}`，连续 3 次复测一致——上游给 Flash 配的 qwen-plus 主节点执行失败。证据 docs/probes/qoder-chat-live-1790007\*.json。**待上游修复后复测**（`probe-qoder-live --chat --model qfmodel`）。
2. **插件侧真 bug 修复（3370adc）**：翻译网关把带内失败帧（无 choices/usage、有 code/message）当普通帧吞掉 → 流式空响应/非流式挂死。现识别上抛：流式错误 chunk+[DONE]、非流式 502 `qoder_upstream_error` 带详情。错误形态三分类已入 gateway-facts Qoder 节。
3. **Qoder 目录模型逐模型调节落地（dc3c3b8 后端 + 955f45c UI）**：思考强度（off/low/medium/high/max，off=不注入）+ 上下文长度（目录 context_config 变体仿官方客户端；镜像写 contextWindow + 出站补默认 max_completion_tokens，客户端带值不覆盖）。文件层 `qoderModelPrefs` 完整替换语义；契约 GET `qoder.models.modelPrefs/variants` + patch `qoderModelSetPrefs`。verify-qoder 122 断言、dsh-ui-test/qoder-prefs-check.js 30 断言全绿。
4. **测试基建两修**：verify-qoder 真机 fixture expires_at 时间炸弹（踩坑 #38）；verify-core-generic 0600 位断言 win32 平台分支。
5. **注意**：dsh 用户实例（3090/3903，PID 28096）已用 09-22 工作区代码重启；上游目录端点 09-22 间歇 503（实例启动时 sync 正常，下午探测时挂、傍晚恢复）。

## 上次会话（2026-09-21，Windows 侧 dsh-tap）干了什么

1. **版本控制合并**：Windows 副本（v0.9.8，Qoder 通道）此前无 .git；WSL 仓库（37+1 提交，分支 v0.8.3，领先 origin 10）为正。做法 = WSL 提交未落盘的「分支拓扑」节 → Windows `git fetch` WSL 本地远端（UNC，免代理）→ `git reset wsl/v0.8.3`（mixed，工作区不动）→ 恢复 Windows 缺失的 tracked 文件（`git ls-files -d`：wiki/×11 + .agents/ponytail）→ Windows 侧 v0.9.7/v0.9.8 工作作为新提交落到真实历史上。Windows STATE.md 经校验为 WSL 版严格超集（零 `<` 行）。
2. **.gitattributes 新引入**：`* text=auto eol=lf` + `*.png/*.bin binary`——docs/probes 的抓包 .bin 按二进制保字节（踩坑 #19 教训）；.gitignore 采用 WSL 版全集（含 `.env*`/`*.key`/`*plugin-auth.json`/`.credentials*` 等凭据守卫）+ Thumbs.db。
3. **待办**：origin（GitHub taikaikaikaikai-pixel/dsh-codebuddy-plugin）推送需代理 127.0.0.1:7890 在线（当前 refused）；推送目标分支 v0.8.3，main/open-source 线收敛与否见「分支拓扑」节再定。

## 上次会话（2026-09-20，Windows 侧 dsh-tap）干了什么

1. **Qoder CN 聊天面打通**（v0.9.8，设计文档 §5e）：昨天"聊天面被 COSY 签名卡住"的结论推翻——签名入口是 WASM 的 `prepareInferRequest`（URL 恒映射 infer 节点 `gateway.qoder.com.cn` 的 `agent_chat_generation`，body 加密，SSE 信封回标准 OpenAI chunk）；`prepareRequest` 的 /algo 重写只是目录面；api2-v2 OpenAI 面裸 Bearer 恒 401 废弃。wasm 抽成 `providers/qoder/qoder_auth.wasm`（官方原字节）+ 手写胶水 `cosy.js`（版权边界干净）。
2. **通道全量落地**：`catalog.js`（签名目录 14 模型）+ `gateway.js`（翻译网关 :3903，usage.credits 计量）+ index.js 接线（qoderEnabled/qoderBridgePort/qoderInferBaseURL + 路由存在性管理镜像）+ 设置卡 Qoder CN 区完整化（登录/启用/目录/启停）。
3. **验证**：verify-qoder-provider 83 断言全绿（新增 [14] 网关翻译/[15] 目录投影）；存量三套件绿；dsh 0.1.6 UI 端到端——选择器出 Qoder CN 组、选 Qwen3.8-Max、哨兵词回显（网关计量日志坐实）；probe-qoder-live --chat 改走 cosy 路径实测 "收到"。
4. **注意**：headless profile 在本机是坏的（与 qoder 无关——旧 dsh-codebuddy-plugin 路由 + 死 key，裸跑也 400-no-body，别再拿它当对照）；两个 Windows 测试坑入档（pitfalls #35 curl -d 中文乱码假象、#36 Map headers 展开为空）。改动未同步 WSL 侧。

## 上次会话（2026-09-19，Windows 侧 dsh-tap）干了什么

1. **Qoder CN 通道 Phase 1 接线**（v0.9.7）：providers/qoder/oauth.js 接入组合根——Config 三字段（qoderLoginHost/qoderOpenapiBaseURL/qoderClientId）+ SETTINGS_FIELDS + `createQoderOAuth` 绑 `~/.dsh/qoder-plugin-auth.json` + 路由 `qoder-oauth-start/-status/-logout` + GET 视图 `qoder.oauth`；设置卡新增第 8 标签「Qoder CN」（登录/登出/状态/高级连接折叠组）。仅登录；聊天面与目录待 COSY WASM 签名（docs/goals/qoder-cn-provider-design.md §5b，Phase 2a 是唯一前置）。
2. **dsh 0.1.6 设置卡迁移**（踩坑 #34）：0.1.5-rc.2 → 0.1.6-alpha.2 拆除了 `settings.plugin.item` 槽，卡片"消失且零报错"（dshmarket 同受害）。修复 = 双槽注册（Plugin Manager `plugins.item` + 旧槽回退）+ 卡片按 `{view}` 分形（summary 一行简介 / page embedded 常开）+ package.json 删掉已不存在的 `@deepseek-ai/dsh-client-runtime`。
3. **验证**：四个离线套件全绿（verify-qoder-provider 65 / verify-providers / verify-rotation / verify-bridge）；dsh 0.1.6-alpha.2 真实实例（:3099）API 端到端（GET 含 qoder.oauth 脱敏、oauth-start 出合法 S256 授权 URL、pending 超时自愈令牌不动）；Windows 侧重建浏览器 harness（`C:\Users\21613\dev\dsh-ui-test\qoder-slot-check.js`）10/10。改动未同步 WSL 侧（两边手工同步纪律照旧）。
4. 注意：`scripts/probe-qoder-live.mjs --login` 时代的真实令牌仍在 `~/.dsh/qoder-plugin-auth.json`，别在测试里调 `qoder-oauth-logout`（会清令牌；pending 超时无害可随便起）。

## 上次会话（2026-08-19）干了什么

课题 1 从零到规则成立：12 轮假设-预测-实测（R1→R13），推翻 6 版规则，最终 R-A 以 11+ 条预注册预测命中收束；发现并记录宽松路径 flapping（未解）；裁判了 CLIENT_HEADERS 每个字段的规则/迷信属性。产出 `scripts/probe-ua.mjs`（可复跑全部轮次）、`docs/rules/ua-validation.md`、本表。

课题 2（同日晚）规则成立：新建 `scripts/probe-cache-ttl.mjs`（ttl/sweep/thresh/predict 四模式），49 条新证据补齐失效边界三维度——策略表 per-model 而非 per-vendor（v3✗/v3.2✓/r1✗、hy3✓/hy3-preview✗ 两条聚类假设被实测推翻后修正规程）；v4-pro 阈值 ≤173 tok、命中=floor(p/128)×128 精确（9/9 档）；v4-pro TTL≥240s、v3.2≥60s；glm-5.2 无 TTL 边界、概率性保留（5s 可丢/120s 可中，2s 连发 miss/hit 交替）。预注册预测 P1–P4 + 各轮 sweep 假设，命中与推翻均记录在 `docs/rules/prompt-cache.md`。

课题 3（同日晚）规则成立：新建 `scripts/probe-routing.mjs`（matrix/r2/r3/r4 四集合），19 条证据挖出三层路由结构——路径层 404 → 家族×模型注册表层（image 14401 / video·3d 14407 / chat 11102，消息逐字回显模型名）→ 后端派发层（11103 与 video 14407 兜底，信封按家族分裂）。预注册命中：P6、C1–C5、D2、D3、E1；推翻记录：P1–P5 原假设、C6、C7、D1。chat 注册表与 /v3/config、cli 清单三方互斥——客户端无权威可路由清单。账号/套餐维度单账号不可证伪，标未解。产出 `docs/rules/routing.md`。

课题 4（同日晚）规则成立：新建 `scripts/probe-quota2.mjs`，9 条证据画全额度信号地图——**所有端点所有响应形态（含错误信封）的响应头零额度信号**（P-Q1×3、P-Q4 预注册命中）；agenttool search/webfetch 响应体无计量字段（P-Q2a 命中；P-Q2b 被推翻——插件 webfetch 的 `data?.usage` 是死路径，重构可删）；dosage-notify 忽略参数（P-Q3 命中）；**新发现 /v3/config `models[].credits` 展示倍率字段**（"x0.51 credits" 字符串），非线性费率表，唯一硬映射 x0.00⟺零计费——P-Q5 预注册命中（hy3 实测 credit===0）。耗尽错误码不可安全诱发，标未解。产出 `docs/rules/quota-signals.md`。

课题 5（同日晚）部分成立：新建 `scripts/probe-oauth.mjs`，15 条无认证只读证据——state 创建无认证、X-No-* 三头是迷信（P-O3 HIT）、platform 必填任意值（省略报 10001）；**核心否定发现：token 轮询对 pending/bogus/过期一律 11217，三态不可区分**（P-O1 MISS 转规则），state TTL 因此不可观测；多 state 并存不作废（P-O2 HIT）；account 端点 pending 时裸 401 nginx 页（P-O6 HIT）；refresh bogus token 响亮失败 401+12153（P-O7 HIT）。token 权限边界/refresh 轮换/state 真实 TTL 标未解，解锁条件=一次交互式 OAuth 登录（详见 oauth-handshake.md §5）。产出 `docs/rules/oauth-handshake.md`。

课题 6（同日晚）规则成立：新建 `scripts/probe-moderation.mjs`，6 条证据定位 developer 拒绝在**网关入口通道校验层**（模型无关 P-M1✓、位置无关 P-M3✓、计费前无 usage、system 控制臂放行 P-M4✓）；**拒绝面已变迁**：200/content_filter（08-18）→ 500/11128 "unapproved channel"（现在）；P-M5 推翻"角色白名单"（hacker 角色放行）锁定为**字面量 developer 单列拒绝**。case 变体按红线刻意不测。产出 `docs/rules/content-moderation.md`。

六课题全部关闭；架构重构（完成标准 2、3）同日晚完成：core/ + providers/codebuddy/ 切分落地、证伪测试 verify-core-generic 全绿、四项回归全绿。长期目标三条完成标准至此全部满足。剩余未解子项（UA 宽松路径 flapping、oauth token 权限边界/refresh 轮换、耗尽错误码、账号维度路由）均为探测红线或单账号限制的诚实标注，解锁条件见各规则文档。
