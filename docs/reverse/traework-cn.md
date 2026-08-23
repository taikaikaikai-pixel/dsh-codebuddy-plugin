# TraeWork CN / TRAE SOLO CN OAuth 与模型目录逆向档案

> 结论时间：2026-08-23  
> 目标：Windows 安装版 `TRAE SOLO CN`，产品名 `TraeWork CN`。  
> 方法：只做本地静态分析、日志/缓存结构分析和公开配置请求；不读取、输出或外传任何 token / key。  

## 目标版本与身份

安装路径：

```text
C:\Users\<user>\AppData\Local\Programs\TRAE SOLO CN
```

关键元数据：

| 项 | 值 |
|---|---|
| 产品名 | `TRAE SOLO CN` |
| Windows 显示名 | `TraeWork CN` / `TRAE Work` |
| App 版本 | `0.1.52` |
| VS Code fork 版本 | `1.107.1` |
| Build | `2.3.73734` |
| packageType | `stable_cn` |
| quality | `stable` |
| URL protocol | `solo-cn://` |
| 配置域 | `api.trae.com.cn` |
| 当前账号 API host | `https://api.trae.cn` |

证据文件：

```text
resources/app/product.json
resources/app/package.json
manifest.json
logs/<run>/main.log
logs/<run>/dynamicConfig.log
```

---

## OAuth / 登录流程

### 1. 本地回调服务

登录时应用会在本机随机端口启动 HTTP 服务，只绑定回环地址：

```text
http://127.0.0.1:<random_port>
```

相关路径：

| 路径 | 用途 |
|---|---|
| `/authorize` | 接收授权结果 / auth code |
| `/login-confirm` | 部分旧式本地登录确认流 |
| `/login-success` | 登录成功提示页 |

源码模块名：

```text
out-build/vs/code/electron-main/oauth/oauthLocalServer.js
out-build/vs/code/electron-main/oauth/userLogin/loginService.js
out-build/vs/code/electron-main/oauth/userLogin/loginUrlBuilder.js
out-build/vs/code/electron-main/oauth/marscode/request.js
out-build/vs/code/electron-main/oauth/marscode/oauthService.js
```

### 2. PKCE

客户端生成：

```text
code_verifier   = 48 bytes -> base64url
code_challenge  = SHA256(code_verifier) -> base64url
method          = S256
```

`code_verifier` 只保存在本地登录会话中，等回调拿到 auth code 后用于换 token。

### 3. 授权页 URL

对 SOLO CN，`auth_from=solo`。常见授权 URL 形态如下：

```http
https://<login-host>/authorization
  ?login_version=1
  &auth_from=solo
  &login_channel=native_ide
  &plugin_version=2.3.73734
  &auth_type=local
  &client_id=<client_id>
  &redirect=0
  &login_trace_id=<uuid>
  &auth_callback_url=http%3A%2F%2F127.0.0.1%3A<port>%2Fauthorize
  &machine_id=<machine_id>
  &device_id=<device_id>
  &x_device_id=<device_id>
  &x_machine_id=<machine_id>
  &x_device_brand=<device_brand_or_model>
  &x_device_type=<os_name>
  &x_os_version=<os_version>
  &x_app_version=0.1.52
  &x_app_type=stable
  &code_challenge=<code_challenge>
  &code_challenge_method=S256
  &hide_saas_login=true
```

SOLO Lite 分支默认 `client_id` 为：

```text
en1oxy7wnw8j9n
```

普通 TRAE 分支默认值为：

```text
ono9krqynydwx5
```

实际运行时可被远端动态配置覆盖。

### 4. 回调参数

浏览器完成登录后，远端会跳回：

```text
http://127.0.0.1:<port>/authorize?...
```

本地代码会解析 query。关键字段包括：

| 字段 | 说明 |
|---|---|
| `userInfo` | JSON 字符串，包含用户资料 |
| `authCodeInfo` | JSON 字符串，内部含 `AuthCode` |
| `codeVerifier` | 本地处理时会补充进去 |
| `consoleHost` | 可选，后续 API host |
| `error_code` / `error_msg` | 失败信息 |
| `originCredential` | 原始凭据引用，本地保留 |

### 5. Auth Code 换 Token

端点：

```http
POST https://<api-host>/trae/api/v3/oauth/ExchangeToken
Content-Type: application/json
```

Auth Code 模式请求体：

```json
{
  "ClientID": "<client_id>",
  "AuthCode": "<auth_code>",
  "CodeVerifier": "<pkce_code_verifier>",
  "DeviceInfo": {
    "DeviceID": "<device_id>",
    "MachineID": "<machine_id>",
    "PlatformCode": "SOLO_PC",
    "DeviceType": "PC",
    "DeviceName": "<device_display_name>",
    "DeviceModel": "<device_model>",
    "ClientVersion": "0.1.52",
    "DevicePublicKey": "<ec_p256_spki_public_key>",
    "DeviceBrand": "<manufacturer>",
    "DeviceCPU": "<cpu>",
    "OSInfo": "<os_name>",
    "OSVersion": "<os_version>"
  },
  "IDEVersion": "0.1.52"
}
```

响应核心字段在 `Result` 下：

```json
{
  "Result": {
    "Token": "<access_token>",
    "RefreshToken": "<refresh_token>",
    "TokenExpireAt": 1234567890,
    "TokenExpireDuration": 123456,
    "RefreshExpireAt": 1234567890
  }
}
```

随后用返回的 `Token` 调用户信息接口。

### 6. Refresh Token 刷新

同一 ExchangeToken 端点支持刷新模式：

```http
POST https://<api-host>/trae/api/v3/oauth/ExchangeToken
Content-Type: application/json
```

请求体：

```json
{
  "ClientID": "<client_id>",
  "ClientSecret": "",
  "RefreshToken": "<refresh_token>",
  "DeviceInfo": {
    "DeviceID": "<device_id>",
    "MachineID": "<machine_id>",
    "PlatformCode": "SOLO_PC",
    "DeviceType": "PC",
    "DeviceName": "...",
    "DeviceModel": "...",
    "ClientVersion": "0.1.52",
    "DevicePublicKey": "...",
    "DeviceBrand": "...",
    "DeviceCPU": "...",
    "OSInfo": "...",
    "OSVersion": "..."
  },
  "DeviceProof": {
    "Signature": "<base64_ecdsa_p256_signature>",
    "Timestamp": <unix_seconds>,
    "Nonce": "<32_hex_random>"
  },
  "IDEVersion": "0.1.52"
}
```

签名算法为 ECDSA P-256 / SHA-256。待签名字符串按换行拼接：

```text
POST
/trae/api/v3/oauth/ExchangeToken
<ClientID>
<RefreshToken>
<Timestamp>
<Nonce>
```

私钥为首次登录/设备注册时生成的 P-256 PKCS#8 私钥，按 DeviceID 缓存在本地安全存储中。

### 7. 账号与会话辅助端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `POST /cloudide/api/v3/trae/CheckLogin` | POST | 校验登录态；body 含 `IDEVersion`、`ReqSource`、`GetAIPayHost:true` |
| `POST /cloudide/api/v3/trae/GetUserInfo` | POST | 获取用户资料；header `x-cloudide-token` |
| `POST /cloudide/api/v3/trae/GenerateTempToken` | POST | 生成临时 token |
| `POST /cloudide/api/v3/trae/oauth/ClearRefreshToken` | POST | 注销 refresh token |

认证 header 形态：

```text
Authorization: Cloud-IDE-JWT <token>
x-cloudide-token: <token>
X-User-Region: CN
```

不同路径可能分别使用 `Authorization` 或 `x-cloudide-token`。

### 8. 动态配置

启动时拉取无鉴权动态配置：

```http
GET https://api.trae.com.cn/icube/api/v1/native/config/query
```

查询参数包括：

```text
mid
did
uid
userRegion=CN
packageType=stable_cn
productCode=SOLO_Lite
platform=Win
branch=release_solo_win32_cn
arch=x64
tenant=marscode
appVersion=0.1.52
buildVersion=2.3.73734
```

响应 `data` 为加密块，由客户端 SDK 解密后合并成运行时 boot config。

---

## 模型列表

### 1. 云端模型列表端点

从本地 Rust harness 二进制中提取到以下模型相关路由：

| 路径 | 说明 |
|---|---|
| `POST /api/ide/v1/get_model_list` | 按 function 批量获取模型列表 |
| `POST /api/ide/v1/model_list` | 模型列表相关路由 |
| `POST /api/ide/v1/batch_get_detail_param` | 批量详情参数 |
| `POST /api/ide/v1/providers` | 自定义 provider 列表 |
| `POST /api/ide/v1/add_custom_model` | 添加自定义模型 |
| `POST /api/ide/v1/update_custom_model` | 更新自定义模型 |
| `POST /api/agent/v3/custom_model_connectivity_check` | 自定义模型连通性检查 |

Rust 侧请求结构名：

```rust
GetModelListByFunctionRequest {
    functions: Vec<String>,
    force_refresh: bool,
}
```

因此云端请求形态大致为：

```http
POST https://<api-host>/api/ide/v1/get_model_list
Authorization: Cloud-IDE-JWT <token>
Content-Type: application/json

{
  "functions": [
    "solo_agent_lite",
    "solo_work_lite"
  ],
  "force_refresh": false
}
```

已确认的 function / category 名称包括：

```text
assistant
agent
builder
builder_v3
chat_v3
code_reviewer
code_review_summary
refactor
solo_agent
solo_agent_lite
solo_agent_remote
solo_coder
solo_work_lite
solo_work_remote
solo_design_lite
solo_design_remote
dsl_agent
voice_chat
voice_transcription
voice_summary
```

### 2. 本地缓存位置

VS Code 全局状态数据库：

```text
%APPDATA%\TRAE SOLO CN\User\globalStorage\state.vscdb
```

表：

```sql
ItemTable(key TEXT, value BLOB)
```

关键 key：

```text
<user_id>:AI.agent.model.model_list_map
<user_id>_AI.agent.model.model_list_map
<user_id>:AI.agent.model.session_selected_model
<user_id>:AI.agent.model.recent_user_selection_by_agent_label
<user_id>:AI.agent.model.max_mode_by_agent_model
```

其中 `model_list_map` 是 JSON，顶层按 function/category 分组。

示例结构：

```json
{
  "assistant": [ { "name": "...", "display_name": "...", "context_window_size": {} } ],
  "solo_agent_lite": [ { "name": "...", "config_name": "..." } ],
  "solo_work_lite": [ { "name": "...", "max_tokens": 32768 } ]
}
```

> 注意：自定义模型条目里存在 `ak` / `sk` 类字段，`state.vscdb` 应视为敏感文件，不要直接提交或分享。

### 3. ModelConfig 主要字段

本地缓存的每个模型条目包含大量字段，常用字段如下：

| 字段 | 含义 |
|---|---|
| `name` | 协议层模型名 / config 名 |
| `display_name` | UI 展示名 |
| `provider` | 第三方 provider，例如 `deepseek`、`volcengine-agent-plan` |
| `multimodal` | 是否支持多模态输入 |
| `model_type` | `reasoning_model` 或 `chat_model` |
| `prompt_max_tokens` | prompt 上限 |
| `context_window_size.default` | 默认上下文窗口 |
| `context_window_size.max` | 最大上下文窗口，可能是数组 |
| `max_tokens` | 输出上限 |
| `max_turn` / `max_turns` | agent 最大轮次 |
| `is_default` | 是否默认模型 |
| `is_preset` | 是否内置预设 |
| `selectable` | 是否可选 |
| `status` | 是否启用 |
| `fee_model_level` | 计费档位 |
| `commercial_info` | 商业化/用量展示信息 |
| `features` | reasoning、multimodal、context window、consumption rate 等 |

---

## 当前缓存中的模型清单

以下来自当前用户缓存 `AI.agent.model.model_list_map`，按 `config_name` 去重。数值单位为 token；“ctx max” 若为数组表示协议里允许多档上限。

| config_name | 展示名 | 多模态 | 类型 | prompt 上限 | ctx default | ctx max | 输出上限 | 最大 turns |
|---|---|---:|---|---:|---:|---:|---:|---:|
| `Doubao-Seed-Evolving` | Seed-Evolving | ✔ | reasoning | 936000 | 200000 | 1000000 | 64000 | 2000 |
| `Doubao-Seed-2.1-Pro` | Seed-2.1-Pro | ✔ | reasoning | 168000–200000 | 200000 | 200000 | 32000/32768 | 500 |
| `Doubao-Seed-2.1-Turbo` | Seed-2.1-Turbo | ✔ | reasoning | 168000–200000 | 200000 | 200000 | 32000/32768 | 500 |
| `Doubao-Seed-Code` | Seed-Code | ✔ | reasoning | 168000 | 184000 | 184000 | 16000 | 500 |
| `Doubao-Seed-2.0-Code` | Doubao-Seed-2.0-Code | ✔ | reasoning | 168000 | 184000 | 184000 | 16000 | 200 |
| `glm-5.3` | GLM-5.3 | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `glm-5.2` | GLM-5.2 | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `glm-5.1` | GLM-5.1 | ✘ | reasoning | 168000 | 200000 | 200000 | 32000 | 200 |
| `glm-5` | GLM-5 | ✘ | reasoning | 168000 | 200000 | 200000 | 32000 | 200 |
| `glm-5v-turbo` | GLM-5V-Turbo | ✔ | reasoning | 168000 | 200000 | 200000 | 32000 | 200 |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro 正式版 | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `DeepSeek-V4-Pro` | DeepSeek-V4-Pro | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash 正式版 | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `DeepSeek-V4-Flash` | DeepSeek-V4-Flash | ✘ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `kimi-k3` | Kimi-K3 | ✔ | chat | 936000 | 200000 | 1000000 | 64000 | 500 |
| `kimi-k2.7-code` | Kimi-K2.7-Code | ✔ | chat | 168000 | 200000 | - | 32000 | 500 |
| `kimi-k2.6` | Kimi-K2.6 | ✔ | chat | 168000 | 200000 | 200000 | 32000 | 500 |
| `kimi-k2.5` | Kimi-K2.5 | ✔ | chat | 168000 | 200000 | 200000 | 32000 | 200 |
| `minimax-m3` | MiniMax-M3 | ✔ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `minimax-m2.7` | MiniMax-M2.7 | ✘ | reasoning | 168000 | 200000 | 200000 | 32000 | 200 |
| `qwen3.8-max` | Qwen3.8-Max | ✔ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `qwen-3.7-plus` | Qwen3.7-Plus | ✔ | reasoning | 936000 | 200000 | 1000000 | 64000 | 500 |
| `qwen-3.6-plus` | Qwen3.6-Plus | ✔ | reasoning | 168000 | 200000 | - | 32000 | 200 |
| `qwen-3.5` | Qwen3.5-Plus | ✔ | reasoning | 168000 | 200000 | - | 32000 | 200 |

另有第三方/provider 型自定义或托管条目：

| config_name | provider | 说明 |
|---|---|---|
| `deepseek//deepseek-v4-pro` | `deepseek` | 用户侧 DeepSeek 直连/代理条目 |
| `deepseek//deepseek-v4-flash` | `deepseek` | 用户侧 DeepSeek 直连/代理条目 |
| `volcengine-agent-plan//deepseek-v4-flash` | `volcengine-agent-plan` | Volcengine Agent Plan 条目 |

旧 function 缓存中还出现过：

```text
DeepSeek-V3.1-Terminus
GLM-4.7
MiniMax-M2.7
Qwen3.5-Plus
Qwen3.6-Plus
```

这些主要出现在 `builder`、`chat_v3`、`code_reviewer`、`refactor` 等旧/专用 category 中。

---

## 关键判断

1. **OAuth 不是标准公共 OAuth2 授权码流的简单复用。**  
   它有 PKCE，但换 token 时还带私有 `DeviceInfo`、`DeviceProof`、ECDSA 设备签名和私有错误码体系。

2. **模型列表不是 OpenAI `GET /models`。**  
   它是私有 RPC：`POST /api/ide/v1/get_model_list`，请求按 IDE 内部 function/category 批量拉取。

3. **模型目录按功能分组，而不是全局单一列表。**  
   同一个模型在不同 function 下会有不同的上下文、输出、轮次和商业化限制。

4. **本地已有完整可解析缓存。**  
   如果只是想取模型清单，可以直接读 `state.vscdb` 的 `AI.agent.model.model_list_map`，不需要先破解网络协议。

5. **凭据不能直接明文导出。**  
   主凭据在 Electron 安全存储中被加密；refresh token 刷新还依赖本地设备 ECDSA key pair。仅拿 refresh token 不足以稳定复刻官方客户端行为。

---

## 后续可做的最小适配方案

如果目标是接入 dsh / OpenAI-compatible harness，不建议一开始就完整复刻 OAuth。更稳的路线是：

1. 先做一个**本地只读桥**：
   - 从 Trae 本地状态读模型缓存；
   - 不读取 token；
   - 只生成静态模型目录。

2. 再决定是否需要聊天能力：
   - 如需聊天，需要解决 `Cloud-IDE-JWT` / `x-cloudide-token`；
   - 还需要处理设备签名和 refresh 流程；
   - 建议通过本地桥收口凭据，而不是把 token 暴露给调用方。

3. 保持与 CodeBuddy 插件相同的核心经验：
   - 私有网关 → provider adapter；
   - stream-only / 私有 SSE → bridge；
   - 私有认证 → credential edge；
   - 私有模型目录 → catalog sync。

---

## 免责声明

本项目档案仅用于本机软件互操作研究、调试和安全评估。所有接口均属厂商未公开协议，可能随时变更；使用时应遵守目标服务条款，不得绕过鉴权、滥用配额或访问未授权数据。
