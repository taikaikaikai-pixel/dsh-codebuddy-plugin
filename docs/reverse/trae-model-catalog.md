# TraeWork CN 模型目录只读提取器

`scripts/trae-model-catalog.mjs` 从本机 Windows 版 TRAE SOLO CN / TraeWork CN 的 VS Code
全局状态数据库中**离线、只读**地提取模型缓存（`AI.agent.model.model_list_map`），生成稳定
JSON 目录与人类可读 Markdown 表格。上游背景见 [traework-cn.md](./traework-cn.md)。

## 1. 这是什么

- 数据源：`%APPDATA%\TRAE SOLO CN\User\globalStorage\state.vscdb`（SQLite，表
  `ItemTable(key TEXT, value BLOB)`），关键 key 形如
  `<user_id>:AI.agent.model.model_list_map` 与 `<user_id>_AI.agent.model.model_list_map`，
  value 为按 function/category 分组的模型 JSON。
- 输出：去重后的模型目录（同模型跨 category 合并，差异保留在 `categoryProfiles`）。
- 仅此而已：**不做 OAuth、不做聊天、不调用云端接口、不提取凭据**。

## 2. 安全边界

- **绝不读取/打印/保存** token、refresh token、API key、secret。条目中的 `ak`/`sk` 等
  字段在归一化时被丢弃，且成品再过一道递归 scrub（精确名匹配，故 `promptMaxTokens`
  这类含 "token" 字样的字段不受影响）。
- 禁删名单（键名小写、去非字母数字后精确匹配）：`ak`、`sk`、`token`、`secret`、
  `password`、`authorization`、`credential`、`apiKey`/`api_key`、`refreshToken`、
  `sessionToken`、`encrypted_model_params`。
- 输出只含 SHA-256 前 12 位指纹（db 路径 / itemKey / user_id），**不含明文 user_id、
  完整 itemKey、原始 db 路径**。
- 只输出模型技术信息；账号资料、`base_url`、`commercial_info` 等非白名单字段一律忽略，
  warnings 只记录字段名、不记录值。
- 原始 `state.vscdb` 与数据库 dump 永不进仓库；本工具每次运行前先把数据库（连同
  `-wal`/`-shm` 若存在）复制到临时目录再打开副本，Windows 侧应用占用与否都不受影响。

## 3. 如何运行

需要带 `node:sqlite` 的 Node（22.5+，23.4+/24 无需 flag）。

```sh
# 自动发现数据库（扫描 /mnt/c/Users/*/AppData/Roaming/{TRAE SOLO CN,TraeWork CN}/…，取 mtime 最新）
node scripts/trae-model-catalog.mjs --pretty

# 指定数据库
node scripts/trae-model-catalog.mjs \
  --db "/mnt/c/Users/<user>/AppData/Roaming/TRAE SOLO CN/User/globalStorage/state.vscdb" \
  --out docs/probes/trae-model-catalog.json \
  --md docs/probes/trae-model-catalog.md \
  --pretty

# 本地 stdout 列出候选 key、长度、指纹（不写文件）
node scripts/trae-model-catalog.mjs --list-keys

# 只解析某个候选 key / 输出全部候选
node scripts/trae-model-catalog.mjs --key "<完整 itemKey>" --pretty
node scripts/trae-model-catalog.mjs --all --pretty
```

选项：`--db`、`--out`（默认 `docs/probes/trae-model-catalog.json`）、`--md`（默认
`docs/probes/trae-model-catalog.md`）、`--pretty`、`--list-keys`、`--key`、`--all`。
`--key` 与 `--all` 互斥。

默认候选选择规则：模型条目总数最多 → value 字节最长 → key 字典序最小。

离线回归（fixture 全断言，本机有真实库时追加一次端到端真实提取，输出只落临时目录）：

```sh
npm run verify:trae
```

## 4. 如何查看输出

- `docs/probes/trae-model-catalog.md`：一眼看全模型表（列含 id / openaiCompatibleId /
  displayName / provider / multimodal / contextWindowDefault / contextWindowMax /
  maxOutputTokens / maxTurns / categories，按 displayName 再按 id 排序），底部 warnings
  列出被忽略/被移除的字段名。
- `docs/probes/trae-model-catalog.json`：机器可读版，结构与下节一致；`--all` 模式为
  `{schemaVersion, kind: "trae-model-catalog-multi", candidates: [...]}` 信封。

## 5. JSON 字段说明

```
schemaVersion  固定 1
source         来源描述：kind、dbPathFingerprint、itemKeyFingerprint、
               userIdFingerprint（均 sha256 前 12 位）、generatedAt（ISO8601）
functions      按 category 分组的 {id, displayName} 列表（assistant、solo_agent_lite…）
models[]       去重后的模型条目（见下）
warnings[]     排序去重后的告警（忽略字段名、敏感字段移除、跳过的坏条目等）
```

模型条目字段：

| 字段 | 来源/规则 |
|---|---|
| `id` | 稳定 id：`config_name` > `name` > `display_name` |
| `openaiCompatibleId` | id 的 slug：非 `[A-Za-z0-9_-]` 一律替换为 `-`（**含点号**，样例契约 `glm-5.3`→`glm-5-3`） |
| `configName` / `displayName` | 原字段；displayName 缺失时回落 name/id |
| `provider` | 第三方 provider（空串归一 null） |
| `modelType` | `reasoning_model` / `chat_model` |
| `multimodal` / `input` | true → `["text","image"]`，否则 `["text"]` |
| `promptMaxTokens` | `prompt_max_tokens` |
| `contextWindowDefault` | `context_window_size.default` |
| `contextWindowMax` | `context_window_size.max`，数字或数组原样保留 |
| `maxOutputTokens` | `max_tokens` |
| `maxTurns` | `max_turns`（数字或 `{default,max}` 取 max 优先）回落 `max_turn` |
| `isDefault` / `isPreset` / `selectable` / `status` | 布尔化（缺省 null） |
| `feeModelLevel` | `fee_model_level` |
| `reasoningEffortOptions` | `reasoning_effort_options` 原样透传（递归 scrub 后） |
| `categories` | 出现过的全部 category（源顺序） |
| `categoryProfiles` | 每个 category 下与合并值不同的限制字段（`promptMaxTokens`、`contextWindowDefault`、`contextWindowMax`、`maxOutputTokens`、`maxTurns`）；相同则为 `{}` |
| `technical` | 白名单技术字段：`temperature`、`top_p`、`top_k`、`thinking_enable`、`tags`、`features` |

合并规则：同一 id 首次出现者定基线（限制/标签取首个），`isDefault` 跨 category 取或，
`provider`/`reasoningEffortOptions` 取首个非空；限制差异全部落在 `categoryProfiles`。

## 6. 当前限制

- 只读本地缓存：快照可能滞后于云端目录（IDE 下次启动/刷新才更新）。
- 跨 category 的 `displayName`/`modelType`/`multimodal`/`technical` 差异只保留首个
  出现值（限制类字段才有 per-category 记录）。
- 非 `[A-Za-z0-9_-]` 字符统一折叠为 `-`，`deepseek//x` 会变成 `deepseek--x`，无法还原。
- `warnings` 中"忽略字段"按字段名全局去重，不区分 category。
- 依赖 `node:sqlite`（Node 22.5+）；在非 WSL/无 `/mnt/c` 环境自动发现返回空，需 `--db`。
- `--all` 输出的多候选信封与单候选结构不同，消费方需按 `candidates` 字段分支。

## 7. 与后续 OAuth/chat 桥的关系

这是 traework-cn.md「最小适配方案」第 1 步（本地只读桥）。后续若做聊天能力：

- 模型目录可由本工具的 JSON 直接生成静态清单（对应 CodeBuddy 插件的
  catalog 同步层），无需先破解 `POST /api/ide/v1/get_model_list` 网络协议；
- 聊天需要 `Cloud-IDE-JWT` / `x-cloudide-token` 认证与设备 ECDSA 签名 refresh，
  建议仍走"本地桥收口凭据"路线（对应 CodeBuddy 的流式桥 + 凭据边缘层），
  本工具**不**为该步骤读取任何凭据。
