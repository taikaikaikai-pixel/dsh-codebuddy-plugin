# Trae 云端 API 实测档案（v0.8.x 接入依据）

> 日期：2026-08-23
> 方法：GitHub 社区逆向（linqiu919/trae2api，2025-06 停更）提供历史参照 → 本机
> 二进制 strings 提取当前协议面 → **无凭据在线探测**校准错误信封与端点存活。
> 全程未使用任何真实凭据；带凭据联调由 `scripts/probe-trae-live.mjs` 承担
> （需要用户完成一次浏览器登录）。

## 0. 一句话结论

TraeWork CN 的聊天面是**任务制私有 RPC**（`/api/agent/v3/*`，SSE），网关在
`trae-api-cn.mchost.guru`；OAuth 换/刷令牌在 `api.trae.cn`
（`/trae/api/v3/oauth/ExchangeToken`，火山系 ResponseMetadata 信封）。
插件侧用**自持 ECDSA P-256 设备密钥**走完整设备流，refresh 的 DeviceProof
由自己签名——不依赖、不提取官方 IDE 的任何凭据。

## 1. 无凭据在线探测（2026-08-23，curl 直打）

| 端点 | 结果 | 结论 |
|---|---|---|
| `POST api.trae.cn/trae/api/v3/oauth/ExchangeToken`（假 ClientID） | 400 `ResponseMetadata.Error{Code:"10101", Message:"Invalid client.", StandardCode:"040004"}` | 端点存活；client 校验层 |
| 同上（真实 ClientID `en1oxy7wnw8j9n` + 假 AuthCode） | 400 `Code:"10101"`, `Message:"无效参数：{__Message.field}."` | client 过了校验层；线上模板变量未渲染（可当指纹） |
| `POST api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`（旧路径） | 400 同上 | **旧路径仍存活**（trae2api 时代的刷新路径没死，但当前客户端走新路径） |
| `POST api.trae.cn/cloudide/api/v3/trae/GetUserInfo`（无 token） | 401 `Code:"20310"`, `Message:"The user is not logged in,"` | cloudide 面信封确认 |
| `POST trae-api-cn.mchost.guru/api/agent/v3/create_agent_task`（无 token） | **401** `{"code":1001,"message":"We're sorry, but we are not able to authenticate you…"}` | **聊天网关在 mchost**；1001 = 统一未认证码 |
| `POST trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（无 token） | 401 同上 | 工具型一次性聊天端点存活 |
| `POST api.trae.cn/api/agent/v3/*`、`api.trae.com.cn/api/agent/v3/*` | 404（TLB nginx） | agent 面不在 api.trae.cn |

两种错误信封并存：mchost 面 `{code, message}`；api.trae.cn 面火山系
`ResponseMetadata.Error`。`providers/trae/errors.js` 的 normalizeTraeError
两者都吃 + 裸非 JSON 容忍。

## 2. 二进制协议面提取（harness.dll / ai_agent.dll strings）

- 云端路由族（harness.dll，`TTNetConfig` 邻域）：
  `/api/agent/v3/`：`create_agent_task`、`commit_toolcall_result`、`interrupt`、
  `resume_agent_task`、`get_resume_agent_task_status`、`query_history_state`、
  `sync_history_state`、`compact`、`llm_utils_chat`、`workflow/start`、
  `workflow/commit_toolcall`、`use_fast_request`、`generate_summary`、
  `dsl/logs/subscribe`、`dsl/templates`、`dsl/render/resources`。
  → 官方 SOLO 的 agent 环 = create_task → SSE 事件 → commit_toolcall 循环；
  **`llm_utils_chat` 是工具型一次性聊天**（title.rs / video.rs / telemetry 用它），
  是 dsh provider 场景（纯 LLM 调用）的正确目标。
- llm_utils_chat 请求信封字段（serde 结构提取，置信度中）：
  `role/content/type/usage/function/messages` + `session_id/conversation_id` +
  `scene_params/metadata/queue_id/request_seq` + `is_custom_model` +
  `model_name`。**未经带凭据联调**——`buildChatRequest`（providers/trae/gateway.js）
  是唯一组装点，live probe 发现偏差只改它。
- 认证头两套并存（harness.dll）：`authorization` + `x-ide-token`（ide_token 语义）
  与 `x-cloudide-token`；设备头组：`x-app-id`、`x-ide-version-code`、
  `x-app-version-code`、`x-user-region`、`x-tt-env`、`x-use-ppe`、`x-env-lane`、
  `request-traffic-type`、`x-device-id`、`x-machine-id`、`x-os-version`、
  `x-device-cpu`、`x-device-brand`、`x-web-id`。插件侧先发双头 + 已知设备头，
  联调后按 401 形态收敛。
- 自定义 provider 直连：二进制里有 `deepseek/anthropic/openrouter/gemini/aws/xai`
  前缀 + `/v1/chat/completions` 组合 + `ak/sk` 字段——BYOK 条目由 harness 直连
  第三方（与 state.vscdb 目录里 `deepseek//…` 条目带 ak/sk 互证），
  这就是目录映射时排除 BYOK 条目的原因。

## 3. 本地 harness（备选架构，存档未采用）

- 官方 Rust harness 是**本地服务器**：`resources/app/modules/ai-agent`，
  meta.json 固定 `socket.port: 40005`；axum 路由 `/api/v1/chat/{initialize,
  start_chat,subscribe_events,append_msg,…}`（harness\server\src\modules 证据），
  Electron 侧驱动。
- **懒启动**：IDE 常驻不等于 harness 常驻（2026-08-23 实测 IDE 13 进程、
  40005 无监听）；启动器是 `x64/run_helper.exe`（目录里没有 start.bat 引用的
  ai-agent.exe），裸拉无参即退——参数/握手未知。
- harness 数据库 `ModularData/ai-agent/database.db` **加密**（harness\storage-db
  \src\connection\encryption.rs，node:sqlite 报 "file is not a database"），
  令牌不落 state.vscdb（只有 `mcpOAuth` 一个无关键），Windows 凭据管理器无
  Trae 条目 → 令牌只在内存/加密存储。
- 结论：harness 驱动路线需要本地 RPC schema + 认证注入方式两个未知数，
  且无法自主触发懒启动；**直连云端路线（已采用）只需要一次用户登录**。

## 4. 历史参照（GitHub：linqiu919/trae2api，2025-06 停更）

- 旧协议：`POST {base}/api/ide/v1/chat` + TraeRequest 信封（user_input/
  intent_name="general_qa_intent"/variables/context_resolvers/chat_history/
  session_id/conversation_id/current_turn/valid_turns/multi_media/model_name/
  last_llm_response_info/is_preset/provider）+ `x-ide-token` 头。
- 旧刷新：`POST /cloudide/api/v3/trae/oauth/ExchangeToken`
  `{ClientID, RefreshToken, ClientSecret:"-", UserID}`（**无 DeviceProof**）。
  2026-08 客户端已演进为 DeviceProof 签名（traework-cn.md §6）；旧路径虽
  存活（§1），请求体已不满足当前客户端形态。
- 旧域名 `a0ai-api-sg.byteintlapi.com` 是国际版；CN 走 mchost/api.trae.cn。
- 旧 TraeRequest 信封字段与当前 llm_utils_chat 信封部分重合（messages/
  session_id/conversation_id/model_name），是 buildChatRequest 的交叉证据。

## 5. 插件实现 ↔ 证据对照

| 实现点 | 证据来源 | 置信度 |
|---|---|---|
| OAuth 设备流全流程 | traework-cn.md §3–§6（静态逆向原文） | 高 |
| PKCE/设备密钥自持 | 同上（"私钥为首次登录/设备注册时生成"→ 自注册同理） | 高 |
| ExchangeToken 端点/信封 | §1 无凭据实测（10101 两层） | 高 |
| 聊天网关域名+端点 | §1 401/1001 实测 + 二进制路由族 | 高 |
| llm_utils_chat 请求信封 | 二进制 serde 字段 + trae2api 旧信封交叉 | **中（待联调）** |
| SSE 事件语法 | 未知 → parseTraeEvent 容错字段发现 | **低（待联调）** |
| 双认证头形态 | traework-cn.md §7 + 二进制双头组 | 中 |

联调路径（用户一次性动作）：
```sh
node scripts/probe-trae-live.mjs --login      # 浏览器登录 + DeviceProof 刷新自证
node scripts/probe-trae-live.mjs --chat "你好" # 真实对话，原始证据落 docs/probes/
```
若 401：先试 `--sig raw`（DER→IEEE-P1363）；信封偏差：修 buildChatRequest；
事件语法偏差：修 parseTraeEvent（均在 providers/trae/gateway.js，单点）。

## 6. 免责声明

同 traework-cn.md：仅用于本机软件互操作研究与调试；接口属厂商未公开协议，
可能随时变更；不得绕过鉴权、滥用配额或访问未授权数据。
