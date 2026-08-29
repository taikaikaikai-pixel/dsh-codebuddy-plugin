# 07 — 浏览器半 lib/client.js（设置卡）

> 文件：[lib/client.js](../lib/client.js)（~70KB，无构建步骤：手写 `React.createElement`）。宿主经 `package.json` 的 `exports["./client"]` + `dsh.client.manifest` 加载。

## 模块格式

```js
window.__ModuleLoader__.load({
  id: "dsh-codebuddy-plugin",
  factory: (require) => {
    const react = require("react")
    // ... 组件定义与注册 ...
  },
})
```

- 包声明：`dsh.client.inject = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots']`，platform web。
- 注册卡：带 `key: "dsh-codebuddy-plugin"`（rc.7 keyed 槽位）——卡片渲染前提是宿主半 `settings.register('dsh-codebuddy-plugin', Config)` 命名空间声明已落地（见 [02](02-composition-root.md)）。

## 卡片结构（九个分区）

卡片以折叠卡（PluginCard 形态）呈现，分区顺序按依赖排列（登录是一切功能的前提）：

| 分区组件 | 内容 |
|----------|------|
| `LoginSection` | 登录模式（api-key / oauth）、多 Key 管理（脱敏列表 + 增删 + 活跃选择）、OAuth 启动/状态/登出 |
| `UsageSection` | 额度与用量：`action:'usage'` 轮询（分区可见期间 10s）——桥计量的消耗/轮次 + 账户侧额度信号（OAuth 数值剩余额度；api-key 手填估算档） |
| `ModelsSection` | 模型：目录同步状态 + 逐模型启停 + 行内 contextWindow/maxTokens 调节 + 思考档位徽标 |
| `ProvidersSection` | 服务商（G6）：preset/自定义添加、刷新模型、删除、本机凭据扫描导入（G7） |
| `TraeSection` | TraeWork CN：启用开关、OAuth 登录、目录同步、端口/域名、聊天传输（inline/remote） |
| `SearchSection` | 网络搜索与抓取：searchEnabled / searchMaxResults / fetchBodyCap |
| `ImageGenSection` | 图像生成：imageGenEnabled / imageGenModel |
| `BridgeSection` | 流式桥：bridgeEnabled / bridgePort / 会话归因 / 并发上限 |
| `AdvancedSection` | 高级：keyCooldownMs / quotaTotalManual / 首字节超时等 |

## 请求契约（与组合根设置路由对齐）

```text
GET  /dsh-codebuddy-plugin/settings
     → { value（脱敏）, user, fields, oauth, bridge, trae, models }
POST { patch: {...} }            → 保存（合并 + 校验 + 热生效）
POST { action: 'oauth-start' | 'oauth-status' | 'oauth-logout'
       | 'model-list' | 'model-sync'
       | 'provider-list' | 'provider-add' | 'provider-remove' | 'provider-refresh'
       | 'credential-scan' | 'credential-import'
       | 'trae-oauth-*' | 'trae-model-sync' | 'trae-model-list'
       | 'usage' }
```

## UI 资源复用（0.7.1 原生化）

- **平台 primitives**：`require('@deepseek-ai/dsh-client-ui-primitives')`（Button/Input/图标），try/catch 失败回落原生元素——卡片不白屏（`CbcButton` 等适配组件内部封装）。
- **设计 tokens**：全部颜色走 `--dsw-alias-*` CSS 变量（深色主题经 `body[data-ds-dark-theme]` 自动跟随）。**注意两个不存在的名字**：`--dsw-alias-accent` / `--dsw-alias-label-error`——正确名是 `state-business-primary` / `state-error-primary`。
- **注入样式**：单个 `<style data-plugin="dsh-codebuddy-plugin" data-plugin-css="…">` 块，类名 `cbc-` 前缀（与第一方同协议，模块加载器可按插件归因/热清理）。外壳数值抄第一方 PluginCard：radius 12、border-l2、bg-layer-3→展开 bg-layer-2、padding 14/16。

## React 纪律（踩坑 #4/#5/#16）

1. 所有 hooks 必须在任何条件 return 之前调用；`useSyncExternalStore(scope.subscribe, ...)` 必须传绑定包装（裸方法引用丢 `this`）。
2. 受控 checkbox 可能双 change——写操作去抖；保存严格 1 POST + 1 GET（Enter 双提交已修）。
3. 脚本派发的原生 blur 不触发 React onBlur——用真实 `input.blur()`；setInput 与 blur 分两个任务（同任务内 commit 闭包读到旧草稿会静默不保存）。
4. 字段编辑器组件必须在**模块级**定义——组件身份随父重渲染变化会导致输入失焦。

## 改 UI 后的回归

文案/结构改动先 grep 浏览器回归脚本的选择器（`.cbc-*` 类与行内单元格精确匹配），再跑 `dsh-ui-test/` 的 step 系列（仓库外本地目录，puppeteer-core + 系统 Chrome；step20/22/24/25 等，断言数见 AGENTS.md）。跑前 `dsh web`，跑后杀 3080。
