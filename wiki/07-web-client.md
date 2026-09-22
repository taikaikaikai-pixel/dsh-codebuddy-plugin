# 07 — 浏览器半 lib/client.js（设置卡）

> 文件：[lib/client.js](../lib/client.js)（~70KB，无构建步骤：手写 `React.createElement`）。宿主经 `package.json` 的 `exports["./client"]` + `dsh.client.manifest` 加载。

## 模块格式

```js
window.__ModuleLoader__.load({
  id: "dsh-tap",
  factory: (require) => {
    const react = require("react")
    // ... 组件定义与注册 ...
  },
})
```

- 包声明：`dsh.client.inject = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots']`，platform web。
- 注册卡：dsh 0.1.5 起 `settings.plugin.item` 槽位改为设置页运行时声明——卡片经 `slots.inject("settings.plugin.item", () => slots.register({ name, key, inject }, Card))` 等声明落地再注册（直接 register 抢跑会**静默不出现**，踩坑 #30；带 rc.7 keyed 槽位回退写法）——卡片渲染前提是宿主半 `settings.register('dsh-tap', Config)` 命名空间声明已落地（见 [02](02-composition-root.md)）。

## 卡片结构（状态芯片 + 8 标签页，2026-09 重设计）

卡片外壳仍是折叠卡（PluginCard 形态），信息分三层：

1. **折叠态**：头部右侧常显 3 枚状态芯片（登录 / 模型数 / 流式桥）——数据来自组件挂载即拉的 GET 视图（展开时再刷一次），不展开也能读卡。
2. **展开态顶部 = 注意条**（0.9.11 起，原"状态条"）：只浮出 warn/err 的**需处理态**，芯片可点击直跳所属标签；全绿时整条消失。常态状态的唯一承载处 = 标签徽标（含 `工具 n/2`），不再与注意条重复铺一整排。
3. **标签栏**：8 个分区，懒挂载（首次访问才 mount），此后**隐藏不卸载**（display:none）——草稿/滚动/已拉目录跨标签切换与保存保留；usage 轮询仅在分区可见期间运行（切走即停）。←/→ 切标签并移动焦点，roving tabIndex（只有活跃标签在 Tab 序里）+ `aria-controls` ↔ `role="tabpanel"`/`aria-labelledby` 双向引用；方向键从**当前聚焦**的标签起算，不是从 activeTab。

| 标签 | 内容 |
|------|------|
| `LoginSection`（登录） | 登录模式（api-key / oauth）、多 Key 管理（脱敏列表 + 增删 + 活跃选择）、OAuth 启动/状态/登出、环境变量引用、失败冷却 |
| `ModelsSection`（模型） | 目录同步状态 + 筛选框 + 逐模型启停 + 行内 contextWindow/maxTokens 调节 + 思考强度 select（G8：静态行有档位表即可设档，存 `effortByModel`，桥出站注入；off 线值为 null 不进选项） |
| `UsageSection`（额度与用量） | `action:'usage'` 轮询（仅分区可见期间 10s）——hero 大数字 + 周期进度条、资源包按名聚合（>4 包默认折叠、明细可展开）、今日/累计统计卡、轮次表；api-key 模式手填估算档 |
| `ToolsSection`（工具） | 网络搜索与抓取（searchEnabled / searchMaxResults / fetchBodyCap）+ 图像生成（imageGenEnabled / imageGenModel） |
| `ProvidersSection`（服务商） | preset/自定义添加、刷新模型、删除、本机凭据扫描导入（G7） |
| `TraeSection`（TraeWork CN） | 启用开关、OAuth 登录（同步开窗再导航）、目录同步、**逐模型启停**（traeModelSetEnabled）、聊天传输、端口、首字节超时、连接域名折叠组 |
| `QoderSection`（Qoder CN） | 启用开关、设备流 OAuth 登录/退出（二次确认，pending 3s 轮询收敛、needsRelogin 引导重登）、网关目录同步、**逐模型启停**（qoderModelSetEnabled）、网关端口、连接域名折叠组（登录域/OpenAPI/infer/client_id） |
| `BridgeAdvancedSection`（桥与高级） | 流式桥（bridgeEnabled / bridgePort / 会话归因 / 并发上限）+ 网关地址 baseURL |

除上表外每个 schema 字段都有落点：`keyCooldownMs` 在登录（Key 轮换语境）、`quotaTotalManual` 在额度（api-key 估算语境）。

## 请求契约（与组合根设置路由对齐）

```text
GET  /dsh-tap/settings
     → { value（脱敏）, user, oauth, bridge, trae, qoder, models }
POST { patch: {...} }            → 保存（合并 + 校验 + 热生效）
POST { action: 'oauth-start' | 'oauth-status' | 'oauth-logout'
       | 'model-list' | 'model-sync'
       | 'provider-list' | 'provider-add' | 'provider-remove' | 'provider-refresh'
       | 'credential-scan' | 'credential-import'
       | 'trae-oauth-*' | 'trae-model-sync' | 'trae-model-list'
       | 'qoder-oauth-*' | 'qoder-model-sync' | 'qoder-model-list'
       | 'usage' }
```

## UI 资源复用（0.7.1 原生化）

- **平台 primitives**：`require('@deepseek-ai/dsh-client-ui-primitives')`（Button/Input/图标），try/catch 失败回落原生元素——卡片不白屏（`CbcButton` 等适配组件内部封装）。
- **设计 tokens**：全部颜色走 `--dsw-alias-*` CSS 变量（深色主题经 `body[data-ds-dark-theme]` 自动跟随）。**注意两个不存在的名字**：`--dsw-alias-accent` / `--dsw-alias-label-error`——正确名是 `state-business-primary` / `state-error-primary`。
- **注入样式**：单个 `<style data-plugin="dsh-tap" data-plugin-css="…">` 块，类名 `cbc-` 前缀（与第一方同协议，模块加载器可按插件归因/热清理）。外壳数值抄第一方 PluginCard：radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16。

## React 纪律（踩坑 #4/#5/#16/#27）

1. 所有 hooks 必须在任何条件 return 之前调用；`useSyncExternalStore(scope.subscribe, ...)` 必须传绑定包装（裸方法引用丢 `this`）。
2. 受控 checkbox 可能双 change——**useRef 同值去重**（重复事件携带与上次已发送相同的目标态；不用时间窗——勾选往返 POST+reload 可以快过任何时间窗，0.9.1 实踩）；保存严格 1 POST + 1 GET（Enter 双提交已修）。
3. 脚本派发的原生 blur 不触发 React onBlur——用真实 `input.blur()`；setInput 与 blur 分两个任务（同任务内 commit 闭包读到旧草稿会静默不保存）。
4. 字段编辑器组件必须在**模块级**定义——组件身份随父重渲染变化会导致输入失焦。
5. 标签面板懒挂载后**隐藏不卸载**——组件状态（草稿/目录数据）跨标签与保存保留；挂载即拉数据的分区（model-list 等）不会因切标签重复请求。

## 健壮性护栏（0.9.11）

1. **`fetchWithTimeout`**：GET 20s / POST 30s，AbortController 超时后把 AbortError 换成带时长的中文错误——设置服务挂起不再永久停在"正在读取"。全部 fetch 走它（成功/失败两条路径都 `clearTimeout`）。注意护栏只到响应头，`r.text()` 阶段不设防。
2. **`PanelBoundary`**：分区级渲染错误隔离（class 组件 + `getDerivedStateFromError`）。单标签塌落只影响自己，出 fallback + 「重试」按钮（换 `key` 强制重挂载子树）；`componentDidCatch` 把堆栈进 console（fallback 只显示 message，踩坑 #7）。
3. **错误提示带原因**：save / OAuth / 用量 pull / 目录同步 / Key 增删 / 登出等 catch 一律 `e.message` 优先，"（网络）"只是兜底。
4. **保存后的网关退避补拉**（`settleGateways`，踩坑 #45）：POST 响应同步返回，而 `runtime.running` 由 `'listening'` 事件异步翻转 ⇒ 紧随的 GET 可能读到假「未监听」；主视图没有轮询，不补拉就永久驻留。保存后若仍有「未监听」芯片，按 1s/2s/4s 补拉三次，真失败则用尽后停手、warn 如实留下。
5. **`HelpNote`**：>60 字的背景说明折进原生 `details.cbc-help`（summary「使用说明」），零 JS 状态、父组件重渲染不复位；短的就地点提示保持直显。
6. **幽灵输入 `cbc-ghost`**（模型行上限）：常态无边框、hover/focus 显边框、去数字步进器。宿主 `Input` 原语把 className 落在 **wrapper span**、内层 input 只带 CSS-module 类 ⇒ 规则必须同时写 `:focus-within`（wrapper）与 `.cbc-ghost input::-webkit-*-spin-button`（内层）双路径。

## 改 UI 后的回归

文案/结构改动先 grep 浏览器回归脚本的选择器（`.cbc-*` 类与行内单元格精确匹配），再跑 `dsh-ui-test/`（仓库外本地目录，puppeteer-core + 系统 Chrome）：`card-regression.js`（设置卡 28 断言）+ `qoder-slot-check.js`（10 断言）；Qoder 专项另有 `qoder-e2e.js` / `qoder-prefs-check.js` / `qoder-tab-phase2.js`，截图基线 `shots-baseline.js`，选择器校准用 `debug-dom.js` / `debug-inputs.js`（旧 step 系列已丢失，勿按名引用）。测试驱动先用 `window.__cbc.tab('分区名')` 激活标签再操作行（querySelector 能点中隐藏 DOM，但那不再是真实用户路径）。跑前 `dsh web`，跑后杀 3080。
