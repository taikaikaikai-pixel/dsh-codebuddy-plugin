# 课题状态表（交接用，新会话 30 秒接上）

> 更新纪律：每次会话结束必须更新本表。状态取值：未开始 / 探测中 / 规则成立 / 未解。
> 长期目标与完成标准见会话目标；课题按序进行，架构重构（core/ + providers/）在课题 1 完成后才允许开始。

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
- 工作区注意：仓库在 `\\wsl.localhost\Ubuntu-22.04\root\dev\dsh-tap\`（`code/` 子目录为空，工件都在仓库根）。

## 上次会话（2026-08-19）干了什么

课题 1 从零到规则成立：12 轮假设-预测-实测（R1→R13），推翻 6 版规则，最终 R-A 以 11+ 条预注册预测命中收束；发现并记录宽松路径 flapping（未解）；裁判了 CLIENT_HEADERS 每个字段的规则/迷信属性。产出 `scripts/probe-ua.mjs`（可复跑全部轮次）、`docs/rules/ua-validation.md`、本表。

课题 2（同日晚）规则成立：新建 `scripts/probe-cache-ttl.mjs`（ttl/sweep/thresh/predict 四模式），49 条新证据补齐失效边界三维度——策略表 per-model 而非 per-vendor（v3✗/v3.2✓/r1✗、hy3✓/hy3-preview✗ 两条聚类假设被实测推翻后修正规程）；v4-pro 阈值 ≤173 tok、命中=floor(p/128)×128 精确（9/9 档）；v4-pro TTL≥240s、v3.2≥60s；glm-5.2 无 TTL 边界、概率性保留（5s 可丢/120s 可中，2s 连发 miss/hit 交替）。预注册预测 P1–P4 + 各轮 sweep 假设，命中与推翻均记录在 `docs/rules/prompt-cache.md`。

课题 3（同日晚）规则成立：新建 `scripts/probe-routing.mjs`（matrix/r2/r3/r4 四集合），19 条证据挖出三层路由结构——路径层 404 → 家族×模型注册表层（image 14401 / video·3d 14407 / chat 11102，消息逐字回显模型名）→ 后端派发层（11103 与 video 14407 兜底，信封按家族分裂）。预注册命中：P6、C1–C5、D2、D3、E1；推翻记录：P1–P5 原假设、C6、C7、D1。chat 注册表与 /v3/config、cli 清单三方互斥——客户端无权威可路由清单。账号/套餐维度单账号不可证伪，标未解。产出 `docs/rules/routing.md`。

课题 4（同日晚）规则成立：新建 `scripts/probe-quota2.mjs`，9 条证据画全额度信号地图——**所有端点所有响应形态（含错误信封）的响应头零额度信号**（P-Q1×3、P-Q4 预注册命中）；agenttool search/webfetch 响应体无计量字段（P-Q2a 命中；P-Q2b 被推翻——插件 webfetch 的 `data?.usage` 是死路径，重构可删）；dosage-notify 忽略参数（P-Q3 命中）；**新发现 /v3/config `models[].credits` 展示倍率字段**（"x0.51 credits" 字符串），非线性费率表，唯一硬映射 x0.00⟺零计费——P-Q5 预注册命中（hy3 实测 credit===0）。耗尽错误码不可安全诱发，标未解。产出 `docs/rules/quota-signals.md`。

课题 5（同日晚）部分成立：新建 `scripts/probe-oauth.mjs`，15 条无认证只读证据——state 创建无认证、X-No-* 三头是迷信（P-O3 HIT）、platform 必填任意值（省略报 10001）；**核心否定发现：token 轮询对 pending/bogus/过期一律 11217，三态不可区分**（P-O1 MISS 转规则），state TTL 因此不可观测；多 state 并存不作废（P-O2 HIT）；account 端点 pending 时裸 401 nginx 页（P-O6 HIT）；refresh bogus token 响亮失败 401+12153（P-O7 HIT）。token 权限边界/refresh 轮换/state 真实 TTL 标未解，解锁条件=一次交互式 OAuth 登录（详见 oauth-handshake.md §5）。产出 `docs/rules/oauth-handshake.md`。

课题 6（同日晚）规则成立：新建 `scripts/probe-moderation.mjs`，6 条证据定位 developer 拒绝在**网关入口通道校验层**（模型无关 P-M1✓、位置无关 P-M3✓、计费前无 usage、system 控制臂放行 P-M4✓）；**拒绝面已变迁**：200/content_filter（08-18）→ 500/11128 "unapproved channel"（现在）；P-M5 推翻"角色白名单"（hacker 角色放行）锁定为**字面量 developer 单列拒绝**。case 变体按红线刻意不测。产出 `docs/rules/content-moderation.md`。

六课题全部关闭；架构重构（完成标准 2、3）同日晚完成：core/ + providers/codebuddy/ 切分落地、证伪测试 verify-core-generic 全绿、四项回归全绿。长期目标三条完成标准至此全部满足。剩余未解子项（UA 宽松路径 flapping、oauth token 权限边界/refresh 轮换、耗尽错误码、账号维度路由）均为探测红线或单账号限制的诚实标注，解锁条件见各规则文档。
