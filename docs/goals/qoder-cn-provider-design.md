# Qoder CN 通道：逆向档案与接入设计（待评审）

> 状态：**通道已全线打通并进选择器**（2026-09-20，插件 v0.9.8）。
> Phase 0 登录 ✅（2026-09-19，dt-/drt- 令牌在 `~/.dsh/qoder-plugin-auth.json`）；
> Phase 2a ✅——WASM 抽成 `providers/qoder/qoder_auth.wasm`（298KB 原始字节）+
> **手写 wasm-bindgen 胶水** `providers/qoder/cosy.js`（不复制 bundle 文本）；
> Phase 2b/3 ✅——`catalog.js`（签名目录）+ `gateway.js`（OpenAI↔COSY SSE 翻译
> 网关 :3903）+ index.js 接线（`qoderEnabled`/`qoderBridgePort`/`qoderInferBaseURL` +
> 路由存在性管理镜像）；Phase 4 ✅ 设置卡 Qoder CN 区（登录/启用/目录/启停）。
> **关键修正见 §5d**：聊天面不是 §2.5 记的 OpenAI 面。
> 验证：verify-qoder-provider 83 断言全绿（含 mock 上游网关翻译）；dsh web UI
> 选 Qwen3.8-Max 真实作答（网关计量日志坐实 usage/credits）。
> 侦察证据：CLI bundle 反混淆（13009 条字符串，`_$d1` = base64+XOR 重复密钥 `Qzj2x6l8xfuh`）
> + 无凭据只读探测 12 次 + 带 SDK-payload 探测 3 次（无凭据可用，见 §2.3b）。
> 原始落盘见 §7 复现路径（`C:\tmp\qoder-re\`，不进仓库）。

## 1. 目标

把 **Qoder CN**（qoder.cn，阿里 Qoder 中国区）作为第三个聊天上游接入 dsh-tap：
dsh 选择器直接选 Qoder CN 模型 → 流式对话 + 工具环可用，凭据走浏览器设备流 OAuth
（订阅额度跟账号走，与 Trae 通道同形态）。对齐 CodeBuddy/Trae 既有通道纪律：
providers/ 收敛全部上游事实、core/ 保持 provider 无关、设置卡可登录/登出/看状态。

## 2. 逆向事实（全部有证据，标注来源）

### 2.1 域名族（bundle 反混淆，`_o==="cn"` CN 构建分支）

| 用途 | CN | 国际 |
|---|---|---|
| infer（模型清单） | `gateway.qoder.com.cn` | `api2.qoder.sh` |
| openapi（设备流/用户） | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| 授权站（base） | `qoder.cn` / `qoder.com.cn`（实测双域同构） | `qoder.sh` |
| 模型推理 | `api2-v2.qoder.sh`（**CN 无同构域名**：`api2-v2.qoder.com.cn` DNS 不解析，实测 ENOTFOUND） | 同 |

另：daily/test 环境 `daily-gateway.qoder.com.cn` / `test-gateway.qoder.com.cn`（实测 test 域连接超时，不接入）。

### 2.2 设备流 OAuth（bundle `startDeviceFlow` 函数 + 实测）

```
① PKCE：verifier = 43–128 随机（charset A-Za-z0-9-._~），challenge = S256(verifier)
   nonce = UUID（客户端生成，透传回轮询）；machine_id = 本机生成
② 授权页：GET <base>/device/selectAccounts?challenge=&challenge_method=S256&nonce=
   &machine_id=&client_id=<uuid>[&machine_token=]
   实测无 cookie → 302 qoder.cn/users/sign-in?oauth_callback=…；Set-Cookie acw_tc+qoder_csrf_token
③ 轮询：GET <openapi>/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
   - 1s 间隔，5 分钟超时（bundle 常量）
   - 未完成 = HTTP 404 {"errorCode":"NotFound"}（**Bao 风格信封**；实测未登录/未注册同 404）
   - 缺参 = 400 精确业务码（DeviceTokenNonceRequired / DeviceTokenVerifierRequired，实测）
   - 完成 = 200 含 token（形态待 Phase 0 实证）
④ 刷新：POST <openapi>/api/v1/deviceToken/refresh {refresh_token, machine_id…}
   - refresh_token 前缀强制 **drt-**（实测 bogus → DeviceRefreshTokenPrefixInvalid）
   - 响应 {device_token, refresh_token, expires_at, refresh_token_expires_at}
⑤ 用户信息：GET <openapi>/api/v1/userinfo（Bearer）→ {uid/name/email/avatar_url…}
```

client_id（bundle 常量）：prod `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`；dev `e93fe488-5778-4c35-a6fc-0f54ed7b3139`。

### 2.3 出站认证（实测纠正：两面不同）

**聊天面（本通道用）无自研签名**：`/model/v1/chat/completions` 只认
`Authorization: Bearer <token>`——无 token 实测回 `401 {"error":"unauthorized"}`（简洁信封，
非 Bao 风格）；bundle 取值 `security_oauth_token ?? access_token`，401/403 → refresh 一次 → 重试一次。

**`/algo`（COSY）面要签名**（2026-09-19 实测纠正）：`gateway.qoder.com.cn/algo/api/v2/model/list`
→ `403 {"code":"101","message":"Signature invalid"}`。签名器是内嵌 WASM
`qoder_auth_wasm_bg.wasm`（bundle 内 base64 398KB @idx 25462），导出面：

```
QoderContext / RequestResult / ProfileEncryptor
generate_runtime_auth_fields   ← 出站签名
decrypt_server_response        ← 服务端响应解密（Encode=1 的解法在此）
credential_storage_{encrypt,decrypt} / model_cache_{encrypt,decrypt}
get_httpdns_{account_id,secret_key,config} / build_httpdns_url
```

构造：`new QoderContext(machineId, COSY_VERSION, JSON.stringify({uid,encrypt_user_info,key}), JSON.stringify(clientMetadata))`
→ `prepareRequest(base, path, method, authMode, …)`；`authMode` 有 `"sign"`（匿名，uid 空串）
与 `"auth"`（带凭据）两种。出站头组：`Authorization: Bearer` + `Cosy-MachineId` +
`Cosy-MachineToken` + `Cosy-MachineType` + `x-gw-user-id`。

**结论**：模型目录若走 `/algo` 就必须接 WASM 签名器；这也正是 CSDN《9router 代理 Qoder》
所述"RSA 加密 AES 密钥 + MD5 签名"的落点（此前我在 JS 里 grep 不到，故一度误判为否定）。

### 2.3b 本机既有登录态的可复用性（实测结论）

- 宿主注入的 `QODER_SDK_AUTH_PAYLOAD_FILE` **不是凭据**：内容
  `{type:"jobToken", jobTokenProvider:"host"}`——令牌由宿主进程内供给，不落盘、不可导出。
- 桌面应用自身的凭据在 `QODERCN_CONFIG_DIR`（本机 `~/.qoder-cn`）的 `.auth/` 下，
  形态 `qoder-cli-cn-credentials.json` = **AES-256-GCM**，密钥
  `scrypt("qoder-cli-cn-credentials", .keychain-salt, 32)`，密文格式 `ivHex:tagHex:cipherHex`。
  该目录受会话沙箱的凭据访问红线保护，**不在未获明确授权时读取**。
- 因此本通道的凭据来源确定为**设备流自登录**（与 CodeBuddy/Trae 同形），不做本机凭据
  搬运——官方 CLI 自身的登录恢复也只取机器标识（`recoverMachineIdForLogin`），令牌一律自持。


### 2.4 模型清单

`GET <infer>/algo/api/v2/model/list?Encode=1`（Bearer + COSY 签名头）。注意 **`/algo` 前缀**
由 bundle 的 `$ie()` 统一注入——不带前缀直连 `<infer>/api/v2/model/list` 实测 503（HTML），
带前缀则 403 `Signature invalid`，说明路径存在、缺的是签名（早先"503=路径不通"的判断已作废）。
`Encode=1` 的解码在 WASM 的 `decrypt_server_response` / `model_cache_decrypt` 里。
模型条目字段（bundle `listModelsFromCache` 投影）：`key/display_name/format/is_vl/
is_reasoning/url/max_input_tokens/context_window/max_output_tokens/enable/efforts/
default_effort/is_default/price_factor/tags` 等。

### 2.5 聊天面

`POST api2-v2.qoder.sh/model/v1/chat/completions`（**OpenAI 兼容体**，Bearer；
`QODER_MODEL_SERVER_HOST` env 可覆盖 host）。实测无凭据：405（GET 不允许，POST 路径存在）、
`/model/v1/models` 404（无目录端点）。另一面 `/algo/api/v2/service/pro/sse/agent_chat_generation`
是 CLI 内部 agent 面（scene_params/工具环自持），**不接入**——dsh 只要 OpenAI 面。

## 3. 集成设计（三层落位）

```
┌ dsh ─────────────────────────────────────────────────────────┐
│ llm-pi-ai.providers.qoder  ← settings.yaml 镜像（路由存在性管理）│
│   baseURL: http://127.0.0.1:3903/v1   headers: 哨兵 Bearer      │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌ core/openai-bridge.js —— OpenAI 透传桥（新原语，provider 无关）─┐
│ 回环 Host 门 / Buffer.concat 一次解码(踩坑#28) / SessionLimiter  │
│ withCredentials 逐请求注入真实 Bearer / usage-meter / /v1/models │
│ 上游是 OpenAI 方言 → 无协议翻译；错误信封透传 + 归一化钩子       │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌ providers/qoder/ —— 上游适配器 ────────────────────────────────┐
│ oauth.js    设备流（§2.2）：startOAuth/poll/refresh/status       │
│ catalog.js  /api/v2/model/list 拉取 + Encode 解码 + 投影到 profiles│
│ errors.js   信封归一（Bao 风格 errorCode/errorMessage；HTTP 语义） │
│ index.js    工厂：oauth+catalog+bridge 组装（trae/index.js 同构）  │
└───────────────────────────────────────────────────────────────┘
```

要点与理由：

1. **透传桥而非翻译网关**：Qoder 聊天面本就是 OpenAI 方言（§2.5），与 Trae 的私有
   `llm_utils_chat` 不同——无需 remote.js 式协议改写。core 桥抽成通用原语后，
   CodeBuddy 桥（现有 `core/bridge.js`）**本次不动**，避免回归面扩大；Qoder 直接复用
   其设计（Host 门、并发闸、计量、单块解码纪律逐条对齐）。
2. **路由存在性管理**（踩坑 #25 同款）：patch 不带 qoder 基线，settings.yaml 镜像
   整块铺/删——开启且有目录时写 `providers.qoder` 块（baseURL 跟随 `qoderBridgePort`，
   改端口重铺热生效），关闭/无目录时删块。
3. **凭据**：`~/.dsh/qoder-plugin-auth.json`（`{machine, auth:{accessToken,refreshToken,
   expiresAt,refreshExpiresAt}, account:{uid,name}}`），0600 + tmp+rename 原子写；
   令牌永不回浏览器（`oauthStatus()` 只出视图）。
4. **设置卡**：Trae 登录区同构（登录/登出/账户/过期时间/网关状态），标签页挂在现有
   "Trae 通道"分区旁（或改名"更多通道"——UI 细节实现时定）。
5. **多账号/多凭据**：不做（与 Trae 一致，单账号 OAuth）。

## 4. 交付物清单

- `core/openai-bridge.js`（新，~250 行）
- `providers/qoder/{index,oauth,catalog,errors}.js`
- `index.js`：Config 字段（`qoderEnabled/qoderBridgePort/qoderApiBaseURL/qoderModelServerURL/
  qoderLoginHost`）、SETTINGS_FIELDS、qoder 镜像函数、路由 action（`qoder-oauth-*`、
  `qoder-model-sync`、模型启停）、凭据编排分支、settingsView 扩展
- `lib/client.js`：Qoder 登录/目录/模型启停 UI
- `scripts/probe-qoder-live.mjs`（--login/--chat/--catalog，证据落 docs/probes/）
- `scripts/verify-qoder-provider.mjs`（离线回归：mock 设备流全流程 + 桥透传 + 错误映射）
- 文档：`docs/reverse/qoder-cn.md`（本文件 §2 的正式版，回填实测）、`docs/rules/qoder-surface.md`
  （接入面规则）、`docs/pitfalls.md` 新坑（如有）、`CHANGELOG.md` 0.9.7

## 5. 未知与风险（Phase 0 联调解决，逐项有替代方案）

### 5b. 2026-09-19 真实登录后的实测收敛（Phase 0 部分完成）

设备流**已全线打通**（用户浏览器已登录 → `selectAccounts` 直接放行）：

- poll 200 真实键集：`id, token, user_id, code_challenge, code_challenge_method, nonce,
  expires_at, refresh_token_id, created_at, updated_at, refresh_token, expires_in,
  refresh_token_expires_in, refresh_token_expires_at` → **未知 E 已解**
- 令牌形态：access `dt-`（27 字符）、refresh `drt-`（28 字符），与 bundle 前缀一致
- `expires_at`/`refresh_token_expires_at` 是 **ISO 字符串**（不是数字！）——按数字解会退化成
  epoch 0，真实联调才暴露（已修 + `[2]`/`[13]` 双处回归锁）
- **refresh 线上自证 200**：`{device_token, refresh_token, token_type:"Bearer",
  expires_at, refresh_token_expires_at}`；access 有效期 **30 天**、refresh **约 1 年**，
  两令牌齐轮换 → **未知 D 已解**
- openapi 面认这个 Bearer：`/api/v1/userinfo` 200、`/api/v3/user/status` 200
  （返回 `userType/personal_standard`、`plan/PLAN_TIER_FREE`、`quota:0`、`userTag/Free`、
  `whitelistStatus/PASS`、`featureSwitches.allow_byok:2`、`nextResetAt`）

仍未解（**已定位为单一依赖 = COSY WASM 签名器**）：

| # | 项 | 实测证据 | 排除项 |
|---|---|---|---|
| B | 聊天面鉴权 | `POST api2-v2.qoder.sh/model/v1/chat/completions` + `Bearer dt-`(+Cosy 三头) → **401 {"error":"unauthorized"}** | 主机猜错已排除：gateway/openapi 503、`/algo` 前缀 404、`qoder.cn` 要 CSRF |
| A | 目录 | `GET gateway/algo/api/v2/model/list?Encode=1` → **403 {"code":"101","Signature invalid"}** | 路径存在性已证（缺签名而非缺路由）；不带 `/algo` 是 503 |

结论：两面都必须跑 `qoder_auth_wasm_bg.wasm` 的 `QoderContext.prepareRequest`
（签名 + `Cosy-Key`），目录还要 `decrypt_server_response`。这是 Phase 2a 的前置，
纯本地逆向，不需要用户交互。

**新风险（诚实标注）**：本账号 `plan=PLAN_TIER_FREE`、`quota=0`——即使签名打通，
免费额度是否允许 API 式聊天仍未证；若被额度挡住，本通道只能停在"能登录、不能对话"。

### 5e. 2026-09-20 聊天面打通（推翻 §2.5 与 §5b 未知 B、§5d「agent 面缺信封」）

**§2.5 的 OpenAI 面定论作废**：`api2-v2.qoder.sh/model/v1/chat/completions` 裸
Bearer 恒 401（完整 Kxn 形态 body + UA + X-Request-ID 也 401；COSY 签名头打到
不重写路径也 401——该表面对本通道不可用，疑似付费/BYOK 面）。

真实聊天面（矩阵实测：单轮/多轮/模型切换/tools 全通，FREE 账号可用）：

- **签名入口是 `QoderContext.prepareInferRequest(endpoint, bodyJson, modelKey,
  modelSource)`**（不是 prepareRequest——后者把路径重写进 /algo 面，签名绑定
  改写后 URL）。URL 恒映射为 `{endpoint}/algo/api/v2/service/pro/sse/
  agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，
  body 由 WASM 加密，头组 = `Bearer COSY.*` + Cosy-* 全家 + `X-Model-Key`/`X-Model-Source`。
- **infer 节点由 region 发现服务给出**：`GET gateway.qoder.com.cn/api/v3/service/
  region/endpoints`（sign 匿名模式可取，响应 Encode=1 密文，decrypt 后
  `inferNodes:["https://gateway.qoder.com.cn"]`）——CN 推理走 gateway，不走 api2-v2。
- 响应 = SSE 信封：`data:{headers,body,statusCodeValue}`，`body` 为字符串，
  内容是**标准 OpenAI chat.completion.chunk JSON**（增量/tool_calls/finish_reason
  全标准）或 `"[DONE]"`；usage 帧 `choices:[]` + `usage{credits,billable,…}`；
  尾帧 `{firstTokenDuration,totalDuration,serverDuration}` 无 body；服务端异常为
  `event:error` + `data:{stackTrace…}`（如 body 非法 JSON）。
- 目录 `GET /algo/api/v2/model/list?Encode=1`（prepareRequest auth 模式）实测回
  **明文** JSON（该端点不加密；decrypt 留作兜底），`.chat[]` 14 条全 enable。
- 手写胶水两个实测坑：JS 运算符优先级（`ptr >>> 0 + len` ≡ `ptr >>> len`——
  视图长度全错，签名照样产出但内容错乱）；`RequestResult.headers` 是 **JS Map**，
  `{...map}` 展开得空头组、服务器直接断连无错误响应（必须 Object.fromEntries）。
- **§5d 的"agent 面缺信封"被推翻**：`prepareInferRequest` 就是信封构造器——
  所谓"worker 里另一层 WASM"就是这个 qoder_auth wasm 自己；请求体 =
  WASM 加密的 OpenAI chat JSON，不需要 scene_params。

## 5c. 原始未知表（保留备查·已被 §5b/§5e 取代）

| # | 未知 | 验证方式 | 若不符合的替代 |
|---|---|---|---|
| A | `model/list?Encode=1` 编码格式与 scope（个人账号可见模型） | 真实 token GET | `Encode=0` 尝试 → 仍不行则静态精选清单（openai-compat `staticCatalog` 同款，evidence 注释来源） |
| B | `/model/v1/chat/completions` 流式形态（标准 OpenAI SSE？） | 真实 POST curl | 非标准则加响应改写层（trae gateway 模式回退） |
| C | tools/function_call 支持度 | 带 tools 真实 POST | 不支持则文档诚实标注"纯文本通道"（dsh 工具环断，与 trae remote 现状同类） |
| D | token 有效期/刷新轮换语义 | 登录后解码 JWT/expires_at | 按 401 触发刷新（bundle 同款重试一次） |
| E | 设备流完成时 200 响应精确键名（token/refresh_token/expires_at…） | 真实登录 | 按 bundle `buildUserInfoFromDeviceToken` 投影宽容匹配 |
| F | CN 网络可达性（api2-v2.qoder.sh 从国内直连） | 实测 | 已有实测 405 可达，无风险 |

### 5d. 2026-09-19 续：COSY 签名器跑通后的三面结论

签名器落地方式（**未重写胶水，直接复用官方实现**）：复制 `qoderclicn.js` → 剥掉末尾
自执行入口 `kAr(async()=>…)` → 追加内部导出（`initWasm`/`createContext`/
`prepareWasmAuthenticatedRequest`/`decrypt_server_response`/`generate_runtime_auth_fields`），
在 Node 侧 `import()` 即可用。产物 `C:\tmp\qoder-re\cli-lib.mjs`（31.9MB，工具不入仓库）。

```js
ensureInit(); await initWasm()
const {encrypt_user_info, key} = JSON.parse(generate_runtime_auth_fields(
  JSON.stringify({uid, security_oauth_token, organization_id, organization_tags, data_policy_agreed})))
createContext(machineId, '1.1.57', JSON.stringify({...userInfo, encrypt_user_info, key}))
const {url, headers, body} = prepareWasmAuthenticatedRequest({endpoint, path, method, body, headers})
```

实测三面结论：

| 面 | 结果 | 说明 |
|---|---|---|
| **目录** | **✅ 200 / 69KB 解密成功** | `gateway/algo/api/v2/model/list?Encode=1`；11 个 scene（chat/developer/assistant/inline/quest/qwork/experts/qwake/app/byok_teams/byok_enterprise），chat 14 模型（Qwen3.8-Max/Flash **is_free**、Qwen3.7 系、DeepSeek-V4-Pro/Flash、GLM-5.3/5.3-Flash/5.2、Kimi-K3、auto），字段含 `context_config`/`thinking_config`/`price_factor`/`minimal_version`。证据 `docs/probes/qoder-model-list.json` |
| **model-server 聊天** | ❌ 401 unauthorized（即便带全套 COSY 头 + `Bearer COSY.<jwt>`） | 该面吃 **job token**；`/api/v1/jobToken/exchange` 的入参是 **personal_token（PAT）**，PAT 在网页控制台 `https://qoder.cn/account/integrations`（该 URL 即 bundle 常量 `nir`）创建。签名器会强制加 `/algo` + `?Encode=1`，而 model-server 要裸路径——两侧鉴权体系不同 |
| **gateway agent 聊天** | ✅ **2026-09-20 已通**（§5e） | `/algo/api/v2/service/pro/sse/agent_chat_generation`，设备令牌 + `prepareInferRequest` 签名/加密可达；FREE 账号实测出文本+tools，usage 带 credits |

**因此打通 dsh 聊天的两条路（择一）**：
1. **PAT → job token → model-server OpenAI 兼容面**（最省力，且目录已解完）：需用户在网页建一个 PAT；
2. **逆 agent_chat_generation 信封**（纯本地，但多一层 WASM 协议）。

注意仍待证：本账号 `PLAN_TIER_FREE` + `quota:0`，即使凭据打通，能否真的产生成仍未知
（目录里确有 `is_free:true` 的 Qwen3.8-Max/Flash，是正面信号）。

## 6. 实施阶段

- **Phase 0**（需你一次浏览器授权）：真实登录联调 → 回填 §5 → 修本文档
  （无人值守替代路径已实测穷尽：SSO 页无扫码入口、SDK payload 非凭据、本机 `.auth/` 受红线保护）
- **Phase 1 ✅ 已完成**（2026-09-19）：`providers/qoder/oauth.js`（设备流/刷新/代际守卫/
  脱敏视图/站点族门禁）+ `scripts/verify-qoder-provider.mjs` 55 断言全绿。
  期间抓到并修复两处真缺陷：refresh 响应缺 `refresh_token` 时旧值被丢弃（断掉续期）；
  门禁沿用 codebuddy 的"与 base 同域即放行"在 host 来自用户设置时形同虚设
  （收紧为官方站点族 + 回环，含后缀伪装域用例）
- **Phase 2a** ✅（2026-09-20）：wasm 抽成 `providers/qoder/qoder_auth.wasm`（bundle
  内嵌 base64 @25462 原字节）；胶水**手写**（`providers/qoder/cosy.js`，wbindgen ABI
  干净实现）——不复制官方 bundle 文本，版权边界干净
- **Phase 2b** ✅（2026-09-20）：`catalog.js`（签名目录，明文/密文两态）+
  `gateway.js`（翻译网关而非透传桥——线缆形态是加密信封，设计时的
  `core/openai-bridge.js` 透传设想作废，core/ 零改动复用 SessionLimiter/meter 原语）
- **Phase 3** ✅（2026-09-20）：index.js 接线（Config/镜像/路由/凭据分支，
  路由存在性管理同 trae）
- **Phase 4** ✅（2026-09-20）：设置卡 Qoder CN 区（登录/启用/目录/启停）；
  浏览器探针 dsh-ui-test/qoder-e2e.js + qoder-tab-phase2.js 全绿
- **Phase 5** ✅（2026-09-20）：verify-qoder-provider 扩到 83 断言（新增 [14]
  网关翻译 13 断言 + [15] 目录投影 5 断言）；真实对话验收过（UI 选
  Qwen3.8-Max 回显哨兵词，网关计量 credits 落盘）

## 7. 复现路径（侦察工具，本地留存不进仓库）

```
C:\tmp\qoder-re\
  decode-all.mjs     _$d1 批量解码（key=Qzj2x6l8xfuh）
  deobf.js           全量反混淆产物（32MB）
  probe-qoder-oauth*.jsonl  12 条无凭据探测证据
  flow.txt           设备流实现抽取（含 client_id 常量与轮询常量）
```
CLI bundle 源：`npm pack @qodercn-ai/qoderclicn@1.1.57` → `package/bundle/qoderclicn.js`。

## 8. 纪律与边界

- 只读探测已做（12 次无凭据）；Phase 0 起带凭据操作全部经本机用户授权的真实登录。
- 不触碰：Bao 风格审核路径、账号体系写操作（登出仅在本地清令牌）。
  `/algo/api/v2/service/pro/sse/agent_chat_generation` 自 2026-09-20 起是本通道的
  正式对话面（§5e）——只读对话用途，不调用 agent 面的其他能力。
- 令牌/机器码只进 `~/.dsh/qoder-plugin-auth.json`，设置卡接口按响应整体审脱敏（踩坑 #26）。
