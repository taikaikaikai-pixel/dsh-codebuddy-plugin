# dsh-codebuddy-plugin 代码质量审查报告

- 审查日期：2026-08-17
- 审查范围：`index.js`(1082 行) / `lib/client.js`(555 行) / `cordis.patch.yml` / `scripts/verify-bridge.mjs` / `scripts/verify-models.mjs`
- 审查方式：静态分析（华为规范检查器）+ 动态验证（桥回归 23 项断言 + 语法检查 + 模型清单解析）+ 人工 Code Review

---

## 一、验证执行情况

| 验证项 | 结果 | 说明 |
|---|---|---|
| 桥离线回归 `verify-bridge.mjs` | ✅ **23/23 全部通过** | 聚合、SSE 透传、会话头注入/保留、FIFO 并发分波、limit=1 死锁回归、无会话不限流、透传路径 |
| 语法检查 `node --check`（4 文件） | ✅ 全部通过 | index.js / client.js / 两个脚本 |
| 模型清单解析 `verify-models.mjs --list` | ✅ 18 个模型解析正确 | 含 contextWindow/maxTokens/input 字段 |
| 静态规范扫描（华为检查器） | ✅ 严重 0 / 一般 0 / 优化 151 | 151 条均为「代码行过长」类（见 §4） |
| 注释覆盖率 | 7.09% | 头注释/区块注释充分，行内注释偏少（可接受） |

**结论**：核心运行时逻辑（流式桥 + 会话并发控制）质量过硬，回归测试覆盖到位，AGENTS.md 记载的历史坑（死锁、头丢弃）均有对应回归锁定。

---

## 二、发现的问题（按严重度）

### 🔴 中危（建议尽快处理）

**M1. GET 接口返回明文 API Key，与「脱敏」设计意图不符**
- 位置：`index.js` `settingsView()` 约 L878-897
- 现象：`value` 中的 `apiKeys` 已脱敏（只回 `{name, masked}`），但响应的 **`user` 字段直接返回 `readFileLayer()` 原始文件内容**，其中 `user.apiKeys[].key` 是**明文密钥**，经 `GET /dsh-codebuddy-plugin/settings` 下发到浏览器。
- 风险：本机任意可访问 127.0.0.1:端口 的页面/进程（如其他标签页、本地恶意脚本）都能读到全部明文 `ck_` Key。OAuth 令牌走 `AUTH_PATH` 不会回传，但 **api-key 模式的密钥泄漏了**。
- 修复建议：`settingsView` 中构造 `user` 时同样脱敏（`apiKeys` 替换为 masked 列表），或前端仅消费 `value`，`user` 不下发 key。注意 `client.js` 的 `overridden()` 只用 `hasOwnProperty` 判断覆盖，不依赖 key 明文，可安全脱敏。

### 🟠 中低危（建议处理）

**M2. 流式桥 `server.listen` 无 error 监听，端口占用会崩整个 dsh 进程**
- 位置：`index.js` `startBridge()` 约 L797
- 现象：`server.listen(port, '127.0.0.1')` 未注册 `'error'` 事件。若 3901 被其他进程占用（或 `syncBridge` 端口切换竞态），Node 会抛出 **unhandled 'error' → 进程崩溃**，不是优雅降级。
- 修复建议：`server.on('error', (e) => { /* 记日志、标记未启动、可回退 */ })`，并在 `syncBridge` 中等待旧 server `close` 完成后再 listen 新端口（现为同步连续调用）。

### 🟡 低危

**M3. `client.js` 防抖 `lastToggle` 是组件体内局部变量，非 useRef**
- 位置：`lib/client.js` L297 `var lastToggle = {}`
- 现象：React 组件**每次渲染都会重建** `lastToggle`，双击防抖只在「无 re-render 的连续两次 change」内有效；一旦期间发生 setState/re-render（如 `setData`、`reload`），防抖失效，可能重复 toggle 互相抵消。
- 修复建议：改用 `useRef({})` 保存跨渲染状态。

**M4. `verify-bridge.mjs` 的 `import(join(ROOT,'index.js'))` 在 Windows 原生路径下不可运行**
- 位置：`scripts/verify-bridge.mjs` L104
- 现象：ESM `import()` 动态说明符要求 file:// URL；`join()` 产生的是 `C:\...` 绝对路径，Windows 下报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。本仓库在 WSL 内运行正常，但 Windows 侧（如本机直接 `node scripts/verify-bridge.mjs`）会失败。本次审查已打 `pathToFileURL` 补丁验证 23 项全绿。
- 修复建议：`import(pathToFileURL(join(ROOT, 'index.js')).href)`（一行改动）。

---

## 三、设计良好之处（维持现状）

1. **凭据单入口**：桥统一 `resolveCredential()`，OAuth/API-key 切换对调用方透明；`cordis.patch.yml` 用静态哨兵 Authorization 解决 `launch-environment 冻结` 问题——设计精巧且有踩坑记录支撑。
2. **SessionLimiter 并发控制**：`release()` 一次释放恰一个槽位、继承式唤醒，正确处理了历史死锁；回归测试专门锁定 limit=1 场景。
3. **会话头「逐头保留+补全」**：重建头集而非跳过注入，修复了静默丢头问题，语义清晰。
4. **错误提示带原因**：`(网络)` 等误导性文案已消除，符合踩坑 #7 教训。
5. **模型纯净态处理**：状态归零时删除 settings.yaml 覆盖层，避免陈旧清单遮蔽 patch 更新——边界处理严谨。
6. **安全基线**：`sameOrigin` 校验 POST、Key 前端仅展示脱敏值、OAuth 令牌独立文件存储，方向正确（唯 M1 未落实彻底）。

---

## 四、静态规范扫描（151 条优化项）

全部为「代码行过长（>80 字符）」，集中在：
- `lib/client.js` 的 css 样式对象定义（单行 141–212 字符）——无构建步骤的 `React.createElement` 风格所致，属可接受权衡，不必强拆；
- `index.js` 部分长注释行。

无 TABS 混用、无多语句行、无魔法数字滥用、无未使用变量告警。

---

## 五、评分

| 维度 | 评价 |
|---|---|
| 规范性 | 9/10 — 注释、命名、分层清晰 |
| 健壮性 | 8/10 — 回归全绿；M2 端口冲突会崩进程是主要短板 |
| 安全性 | 7/10 — M1 明文 Key 泄漏需立即修 |
| 可读性 | 9/10 — 函数职责单一，注释解释「为什么」而非「是什么」 |
| 可维护性 | 9/10 — AGENTS.md 踩坑记录 + CHANGELOG 完整，回归脚本自洽 |

**总体评级：良好（建议处理 M1、M2 后达优秀）**

---

## 六、修复优先级建议

1. **P0**：M1 — `settingsView` 脱敏 `user.apiKeys`（1 处小改，消除密钥明文下发）
2. **P1**：M2 — `server.on('error')` + `syncBridge` 等待旧 server 关闭
3. **P2**：M3 useRef 防抖；M4 `pathToFileURL` 一行修复（顺带让 Windows 侧也能跑回归）
