# 诊断报告：`trae 3003 all models failed`（PI_AI_ERROR）

**日期**：2026-08-24 ｜ **现象报告**：用户经 dsh-codebuddy-plugin 使用 TraeWork CN
模型，报 `trae 3003 all models failed`，宿主以 `PI_AI_ERROR` 包装。
**结论先行**：**Trae 服务端 inline_chat 面的模型解析层故障**（该面对一切 model 名
返回业务错误 `3003 "all models failed"`），不是插件缺陷，与用户凭据/额度无关。

## 1. 错误传播链（每一环都有实证）

```
dsh(pi-ai) ──OpenAI方言──▶ 插件 Trae 网关(127.0.0.1:3902, providers/trae/gateway.js)
   settings: traeEnabled=true, traeChatTransport="inline"(默认), traeChatBaseURL=mchost
   ──POST /api/agent/v3/llm_utils_chat (function=inline_chat)──▶ trae-api-cn.mchost.guru
Trae 云端：HTTP 200 SSE，事件流 = error{"code":3003,"message":"all models failed"} + done
网关映射 → 502 {"error":{"message":"trae 3003 all models failed","code":3003}}
pi-ai 收到非 2xx → 包装为 PI_AI_ERROR 呈现给用户
```

`PI_AI_ERROR` 只是宿主 LLM 层对上游非 2xx 的通用包装；真正的内容是网关透传的
Trae 业务码 3003。

## 2. 根因判定：服务端 inline 面故障

对照实验（同凭据、同头组、同信封 `buildChatRequest`，唯一变量=模型名/function；
证据 `docs/probes/trae-3003-diagnosis-1787564352939.json`、`…4582671.json`）：

| 实验 | function | model | 结果 |
|---|---|---|---|
| A | inline_chat | glm-5.3（非默认） | SSE error **3003** "all models failed" |
| B | inline_chat | kimi-k2.6（文档记载的账户默认） | SSE error **3003** |
| B' | inline_chat | kimi-k2.7-code / Doubao-Seed-Code / 不带 model 字段 | 均 **3003** |
| C | chat_v3 | glm-5.3 | **200 正常回答**（"成功"），信封/鉴权全链路健康 |

**排除项（逐一证伪）**：
- **非凭据问题**：GetUserInfo 有效、同 JWT 在 chat_v3 面完整走通对话。
- **非配额问题**：`ide_user_ent_usage` 实测 IDE 池（endpoint=0）主包 2000 只用
  0.63 credits；work 池（endpoint=1）1803/2000 且另有十余个 200-credit 包在期。
- **非限流**：raw 面 4011 会显式报 "requests have exceeded the rate limit"，
  且 C 实验紧随 A/B 成功。
- **非信封/头组回归**：同一构造器产出的请求 chat_v3 通过；0.8.4 已用真实端到端
  双绿锁定过信封形态（CHANGELOG 0.8.4）。
- **非插件路由代码缺陷**：网关对 3003 的映射路径（SSE error → 502 结构化错误）
  与 mock 回归一致；失败流里连 `timing_cost` 都没有——服务端根本没走到选模型
  成功的那一步。

**服务端行为三阶段时间线（时变！）**：
1. ≤08-23 深夜 UTC：inline_chat 对任意 model 名返回 200 并静默改派到账户默认
   （证据 `docs/probes/trae-chat-live-17875277*.json`：glm-5.2/glm-5.3/V4-Pro 全通）。
2. 08-24 ~08:06 UTC：改为硬错——仅非默认模型 3003（证据 `trae-model-routing3-*`，
   即 CHANGELOG 0.8.4 记录的"function 位钉死"）。
3. 08-24 ~09:39–10:05+ UTC：**扩大到一切 model 名（含默认、含缺省 model 字段）**
   （本诊断 A/B/B' 复现三次，跨约 30 分钟）。remote 面同时段出现间歇性边缘故障（§3）。

## 3. 次要发现（同日取证）

- **remote create_session 间歇性裸 404**：`/api/remote/v1/chat_sessions` 在
  TLB/nginx 节点间路由表漂移——带凭据请求命中缺路由节点时返回**裸文本**
  `404 Not Found`（content-type: text/plain）；无凭据探测同路径则稳定 401 JSON
  （业务鉴权层正常）。该 404 与请求头组/体内容无关（逐头逐字段二分均复现/消失
  与节点有关），数分钟窗口后自愈。**业务级拒绝恒为 JSON 信封**——这是判别
  边缘层 vs 应用层的可靠指纹。
- **边缘 WAF 动态拦截**：高频探测触发全路径 403 空体（含无凭据请求），冷却
  数分钟自愈。联调节奏必须克制。
- **991502 并发门**：`solo_agent_parallel_limit` 用满时报业务 429；只创建会话
  不消费事件流的僵尸会话同样占位，只能等沙箱 TTL 自灭（stop 端点对未运行
  会话回 409 "chat session is not running"）。
- remote 模型清单出现新默认位（solo_agent_remote 默认=Doubao-Seed-Code、
  solo_design_remote 默认=kimi-k2.7-code，证据 `trae-remote-models-*`），
  印证服务端当日在大规模调整模型注册表——与 inline 面故障时段吻合。

## 4. 已落地的加固（0.8.5）

1. **errors.js**：码表新增 3003/991502 语义；新导出 `formatTraeErrorMessage`，
   对已知码在透传消息后追加**可操作处置提示**（如 3003 → 建议切 remote 通道）。
2. **gateway.js**：三处错误文案（inline 非 OK 上游 / inline SSE error /
   remote SSE error）统一走 `formatTraeErrorMessage`。
3. **remote.js**：`createRemoteSession` 对**裸文本 404/403（边缘漂移指纹）**
   自动短退避重试一次（创建失败不产生会话，幂等安全）；持续失败时报文带自愈指引。
4. **verify-trae-provider.mjs** 新增 4 断言锁以上形态（77 项断言全绿）：
   mock 云端发 3003 → 网关消息含提示且 code 透传；mock 首次裸 404 → 重试成功；
   持续裸 404 → 文案带指引；formatTraeErrorMessage 单元三态。
5. 规范化诊断脚本 `scripts/probe-trae-3003-diagnosis.mjs`（可重跑复现本轮实验）。

## 5. 用户侧操作指引

- **立即恢复可用**：设置卡 TraeWork CN 分区把「聊天传输」从 `inline` 切为
  `remote`（真模型路由；注意耗 work 额度池、不支持 OpenAI tools）。
- 或：稍后重试 inline 通道等服务端恢复（该面历史上多次自愈/翻转）。
- 若 remote 报"边缘节点路由漂移"提示：等几分钟再试（TLB 节点自愈）。
- 报 991502：等待存活会话过期或在 Trae 端手动停止会话。
