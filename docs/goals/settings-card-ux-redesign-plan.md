# 设置卡通道手风琴重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置卡从「8 标签 + 三套状态展示」重写为「4 区块通道手风琴 + 区块头单一状态行」，消灭"找不到、太散"。

**Architecture:** 纯前端重写 `lib/client.js`（浏览器半，无构建步骤、手写 `React.createElement`）。顶层 4 个可展开区块（CodeBuddy / TraeWork CN / Qoder CN / 通用），区块头常显状态行（口径沿用 `buildChips`），展开才挂载分区、收起不卸载。后端 `/dsh-tap/settings` 契约、槽位注册、`core/`、`providers/` 全部零改动。

**Tech Stack:** React（宿主 seed 模块 `react`，经 `require`）、宿主原语 `@deepseek-ai/dsh-client-ui-primitives`（缺失时退原生）、`--dsw-alias-*` 设计 token、注入式 `cbc-` 样式；测试 = puppeteer-core + 系统 Chrome（仓库外 `dsh-ui-test/`）。

**Spec:** `docs/goals/settings-card-ux-redesign.md`（提交 `4d41f8d`，含证据核对与"必须原样迁移的硬修复清单"）

## Global Constraints

- 目标版本 **0.10.0**（`package.json` 现为 `0.9.11`）。
- 浏览器半无构建步骤：只能用 `var`/`function` + `React.createElement`，**禁止** JSX、ESM `import`、`require('@deepseek-ai/*')`（踩坑 #9）。
- 颜色一律走 `--dsw-alias-*` token；**不存在** `--dsw-alias-accent` / `--dsw-alias-label-error`，正确名是 `state-business-primary` / `state-error-primary`。
- 样式只有一个注入块 `<style data-plugin="dsh-tap" data-plugin-css="dsh-tap-card">`，类名一律 `cbc-` 前缀。
- 所有 hooks 必须在任何条件 `return` 之前调用；字段编辑器组件（`TextField`/`NumberField`/`LimitInput`）必须模块级定义（组件身份随父重渲染变化会丢焦点）。
- 受控 checkbox/select 用 `useRef` **同值去重**（不用时间窗），失败分支必须**销账**（踩坑 #27/#32）。
- `window.open` 必须在点击处理器内**同步**发起（异步被弹窗拦截器吃掉）。
- 后端契约零变化：`GET /dsh-tap/settings` 与全部 `POST {patch}` / `{action}` 的名称、参数、响应结构不动。
- 测试纪律：浏览器回归的 mock 通道**零真实写入**（跑前跑后对 `~/.dsh/codebuddy-plugin.json` 取哈希对账）；选择器一律按 `.cbc-*` 类精确匹配（模糊匹配曾误删 Key）。
- **mock 隔离纪律**：`page.evaluateOnNewDocument` 装的 fetch 补丁**跨 reload 持久**——所有 mock 组一律用 `newPage(installer)` 开独立页面，主页面 `page` 自始至终不装 mock（否则后续组的 `getView(page)` 会被上一个 mock 拦掉，读到假视图）。
- `dsh-ui-test/` 在**仓库外**（`C:/Users/21613/dev/dsh-ui-test`）——它的改动**不进 git**，每个任务的 `git add` 只含仓库内文件。
- 文档中出现的 `lib/client.js` 行号均为提交 `4d41f8d` 时的位置；实施时**以 grep 锚点定位为准**（行号会随任务推进漂移）。

## 测试环境速查（所有任务共用）

已实测（2026-09-23）：Windows 侧 `dsh` 不在 PATH，可执行入口在 launcher 的 node_modules；`~/.dsh/profiles/web/package.json` 用 `link:C:/Users/21613/dev/dsh-tap` 指向本仓库 ⇒ **改 `lib/client.js` 后刷新页面即生效，无需重装**。

```bash
# ① 起测试服务（后台；启动行打印一次 token）
cd /c/Users/21613/dev/dsh-launcher && ./node_modules/.bin/dsh web \
  > /c/Users/21613/dev/dsh-ui-test/dsh-web.log 2>&1 &
sleep 8
grep -o 'token=[A-Za-z0-9_.-]*' /c/Users/21613/dev/dsh-ui-test/dsh-web.log | head -1
#   ↑ 取到的值拼成 http://127.0.0.1:3080/?token=<TOKEN>
#   若 grep 不中，直接看 dsh-web.log 的启动行（token 只打印一次）

# ② 跑回归
cd /c/Users/21613/dev/dsh-ui-test && node card-accordion.js "http://127.0.0.1:3080/?token=<TOKEN>"

# ③ 收尾：杀掉 3080（Windows 无 pkill；按 PID 杀，别用 taskkill //IM node.exe）
netstat -ano | grep ':3080' | head -3      # 最后一列是 PID
taskkill //PID <PID> //F
```

哈希对账（mock 通道任务必做）：

```bash
md5sum ~/.dsh/codebuddy-plugin.json   # 跑前 / 跑后各一次，必须一致
```

离线回归（Task 9 收尾跑全量；纯前端改动预期零影响，作为保险）：

```bash
cd /c/Users/21613/dev/dsh-tap
npm run verify:bridge && npm run verify:core && npm run verify:providers \
  && npm run verify:trae-provider && npm run verify:qoder && npm run verify:host-config \
  && node scripts/verify-models.mjs --list
```

---

### Task 1: 手风琴骨架（4 区块 + 状态行 + 懒挂载）

**Files:**
- Modify: `lib/client.js` — CSS 块（grep 锚点 `".cbc-help summary:hover"` 之后追加）、`TAB_DEFS`（`:363`）、`CodeBuddyCard`（`:381`–`:611`）、`tabBadge`（`:682`–`:712`，整个函数删除）、各 `PANEL_RENDERERS.x = Y`（8 处）
- Create: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`（仓库外，不进 git）

**Interfaces:**
- Consumes: `buildChips(data)`（`:619`，返回 `{login,models,bridge,search,image,trae,qoder}`，每项 `{tone,text,tab,tabTitle}`）、`Dot({tone})`、`PanelBoundary`、8 个分区组件（`LoginSection`/`ModelsSection`/`UsageSection`/`ToolsSection`/`ProvidersSection`/`TraeSection`/`QoderSection`/`BridgeAdvancedSection`）、`overriddenFor(data)`、`fetchWithTimeout`、`settleGateways`
- Produces（后续任务依赖，签名固定）:
  - `BLOCK_DEFS` = `[{id:"codebuddy",title:"CodeBuddy"},{id:"trae",title:"TraeWork CN"},{id:"qoder",title:"Qoder CN"},{id:"general",title:"通用"}]`
  - `BLOCK_SECTIONS` = `{codebuddy:["login","models","tools","bridge"], trae:["trae"], qoder:["qoder"], general:["usage","providers"]}`
  - `SECTION_RENDERERS`（由 `PANEL_RENDERERS` 重命名，键同上 8 个分区 id）
  - `blockStatus(data, generalText)` → `{codebuddy:{tone,text}, trae:{...}, qoder:{...}, general:{...}}`
  - `worstTone(chips)` → `"ok"|"warn"|"err"|"off"`
  - `BlockHead(props)`，props = `{id,title,status:{tone,text},open,mounted,onToggle,control,flash}`
  - `toggleBlock(id)`、`openBlocks`（`{[id]:true}`）、`mountedBlocks`（`{[id]:true}`）、`saved`（`{block,at}|null`）、`saveIn(blockId)` → `(patch)=>void`
  - DOM 契约：`.cbc-acc[data-block=<id>]`（区块根）、`.cbc-acc.cbc-open`（展开态）、`.cbc-acc-toggle[data-block=<id>]`（展开按钮）、`.cbc-acc-title`、`.cbc-acc-status`、`.cbc-acc-body[data-block=<id>]#cbc-block-<id>`（`hidden` 表示收起）
  - CSS 类：`.cbc-acc`、`.cbc-acc-head`、`.cbc-acc-toggle`、`.cbc-acc-title`、`.cbc-acc-status`、`.cbc-acc-body`

- [ ] **Step 1: 写失败的回归脚本（新套件，从零建）**

创建 `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`，完整内容：

```js
// dsh-tap 设置卡「通道手风琴」回归套件。
// 设计依据：dsh-tap/docs/goals/settings-card-ux-redesign.md
// 用法: node card-accordion.js <url-with-token>
const puppeteer = require("puppeteer-core");
const fs = require("fs");

const BASE = process.argv[2];
if (!BASE) { console.error("usage: node card-accordion.js <url-with-token>"); process.exit(2); }
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync("shots", { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--disable-http-cache", "--window-size=1440,900", "--no-first-run"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => { const s = String(e).slice(0, 200); if (!/turnTail/.test(s)) pageErrors.push(s); });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(4000);

  // ---- 驱动助手（宿主 DOM 精确匹配，踩坑 #16/#34）----
  const openPM = (pg) => pg.evaluate(() => {
    const els = [...document.querySelectorAll("button, [role=button], a, li, span")];
    const hit = els.find((e) => /插件|Plugin/i.test(e.textContent || "") && (e.textContent || "").length < 30);
    if (hit) { hit.click(); return true; }
    return false;
  });
  const openCard = (pg) => pg.evaluate(() => {
    const btns = [...document.querySelectorAll("button[class*=cardTitle], [class*=cardTitle]")];
    const hit = btns.find((b) => (b.textContent || "").trim() === "dsh-tap");
    if (hit) { hit.click(); return true; }
    return false;
  });
  const getView = (pg) => pg.evaluate(async () =>
    await (await fetch("/dsh-tap/settings", { headers: { accept: "application/json" } })).json());
  const openBlock = (pg, id) => pg.evaluate((bid) => {
    const b = document.querySelector('.cbc-acc-toggle[data-block="' + bid + '"]');
    if (!b) return false;
    b.click();
    return true;
  }, id);
  const blockState = (pg) => pg.evaluate(() => ({
    ids: [...document.querySelectorAll(".cbc-acc[data-block]")].map((x) => x.getAttribute("data-block")),
    titles: [...document.querySelectorAll(".cbc-acc-title")].map((x) => (x.textContent || "").trim()),
    open: [...document.querySelectorAll(".cbc-acc.cbc-open[data-block]")].map((x) => x.getAttribute("data-block")),
    bodies: [...document.querySelectorAll(".cbc-acc-body[data-block]")].map((x) => x.getAttribute("data-block")),
    visible: [...document.querySelectorAll(".cbc-acc-body[data-block]")]
      .filter((x) => !x.hidden).map((x) => x.getAttribute("data-block")),
    status: [...document.querySelectorAll(".cbc-acc[data-block]")].map((x) => ({
      id: x.getAttribute("data-block"),
      text: ((x.querySelector(".cbc-acc-status") || {}).textContent || "").trim(),
      tone: (((x.querySelector(".cbc-dot") || {}).className || "").match(/cbc-(ok|warn|err|off)/) || [])[1] || "none",
    })),
    tabs: document.querySelectorAll(".cbc-tab").length,
    strips: document.querySelectorAll(".cbc-strip").length,
    headchips: document.querySelectorAll(".cbc-headchips").length,
    badges: document.querySelectorAll(".cbc-tabcount").length,
  }));
  const setNativeValue = (pg, sel, val) => pg.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, sel, val);
  // 每组断言用独立页面：evaluateOnNewDocument 的 fetch 补丁跨 reload 持久，
  // 复用同一页面会污染后续断言（连 getView 都会被拦）。installMock 在 goto 之前调用。
  const newPage = async (installMock) => {
    const pg = await browser.newPage();
    const errors = [];
    pg.on("pageerror", (e) => { const s = String(e).slice(0, 200); if (!/turnTail/.test(s)) errors.push(s); });
    if (installMock) await installMock(pg);
    await pg.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(4000);
    const pm = await openPM(pg);
    await sleep(2500);
    const card = await openCard(pg);
    await sleep(4000);
    return { page: pg, errors: errors, opened: !!(pm && card) };
  };
  // 幂等展开（已展开则不点，避免把区块又收起）
  const ensureOpen = (pg, id) => pg.evaluate((bid) => {
    const acc = document.querySelector('.cbc-acc[data-block="' + bid + '"]');
    if (!acc) return false;
    if (acc.classList.contains("cbc-open")) return true;
    const t = acc.querySelector(".cbc-acc-toggle");
    if (!t) return false;
    t.click();
    return true;
  }, id);

  check("[0] Plugin Manager 可开", await openPM(page));
  await sleep(2500);
  check("[0] dsh-tap 卡可点开", await openCard(page));
  await sleep(4000);

  // ---- [A1] 四区块齐全 + 顺序固定 + 标题 ----
  let st = await blockState(page);
  check("[A1] 四区块顺序固定",
    JSON.stringify(st.ids) === JSON.stringify(["codebuddy", "trae", "qoder", "general"]), JSON.stringify(st.ids));
  check("[A1] 区块标题",
    JSON.stringify(st.titles) === JSON.stringify(["CodeBuddy", "TraeWork CN", "Qoder CN", "通用"]), JSON.stringify(st.titles));

  // ---- [A2] 默认全部收起 ----
  check("[A2] 默认全收（四区块都在、无一展开、无 body DOM）",
    st.ids.length === 4 && st.open.length === 0 && st.bodies.length === 0,
    JSON.stringify({ ids: st.ids, open: st.open, bodies: st.bodies }));

  // ---- [A3] 展开才挂载 ----
  check("[A3] 点开 CodeBuddy", await openBlock(page, "codebuddy"));
  await sleep(2500);
  st = await blockState(page);
  check("[A3] 展开后 body 挂载且可见",
    st.bodies.includes("codebuddy") && st.visible.includes("codebuddy"), JSON.stringify(st));
  check("[A3] 只有点过的区块挂载（恰一个 body = codebuddy）",
    st.bodies.length === 1 && st.bodies[0] === "codebuddy", JSON.stringify(st.bodies));
  const hasCred = await page.evaluate(() =>
    /登录方式/.test((document.querySelector('.cbc-acc-body[data-block=codebuddy]') || {}).textContent || ""));
  check("[A3] CodeBuddy 区块含凭据内容", hasCred);

  // ---- [A4] 收起不卸载 + 草稿保留 ----
  const FILTER_SEL = '.cbc-acc-body[data-block=codebuddy] input[placeholder*="过滤"]';
  check("[A4] 前置：筛选框可输入", await setNativeValue(page, FILTER_SEL, "glm"));
  await sleep(800);
  check("[A4] 收起 CodeBuddy", await openBlock(page, "codebuddy"));
  await sleep(600);
  st = await blockState(page);
  check("[A4] 收起后 body 仍在 DOM（隐藏不卸载）",
    st.bodies.includes("codebuddy") && !st.visible.includes("codebuddy"), JSON.stringify(st));
  check("[A4] 重开 CodeBuddy", await openBlock(page, "codebuddy"));
  await sleep(600);
  const draft = await page.evaluate((s) => { const el = document.querySelector(s); return el ? el.value : null; }, FILTER_SEL);
  check("[A4] 草稿跨收起/重开保留", draft === "glm", JSON.stringify(draft));
  await setNativeValue(page, FILTER_SEL, "");   // 复原，避免影响后续断言

  // ---- [A5] 多开独立 ----
  check("[A5] 点开 Trae", await openBlock(page, "trae"));
  await sleep(1500);
  st = await blockState(page);
  check("[A5] CodeBuddy 与 Trae 同时可见",
    st.visible.includes("codebuddy") && st.visible.includes("trae"), JSON.stringify(st.visible));

  // ---- [A6] 标签栏已退役 ----
  check("[A6] 无 .cbc-tab 残留", st.tabs === 0, "cbc-tab=" + st.tabs);
  check("[A7] 无 dsh-tap pageerror", pageErrors.length === 0, pageErrors.join(" | "));
  await page.screenshot({ path: "shots/acc-task1.png" });

  await browser.close();
  console.log("\n=== card-accordion: " + passed + " 通过 / " + failed + " 失败 ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
```

- [ ] **Step 2: 跑一次确认红**

```bash
cd /c/Users/21613/dev/dsh-launcher && ./node_modules/.bin/dsh web > /c/Users/21613/dev/dsh-ui-test/dsh-web.log 2>&1 &
sleep 8 && grep -o 'token=[A-Za-z0-9_.-]*' /c/Users/21613/dev/dsh-ui-test/dsh-web.log | head -1
cd /c/Users/21613/dev/dsh-ui-test && node card-accordion.js "http://127.0.0.1:3080/?token=<TOKEN>"
```

Expected: `[A1]`–`[A6]` 全 FAIL（`.cbc-acc*` 尚不存在，`st.ids` 为 `[]`），`[0]` 两条 ok，退出码 1。

- [ ] **Step 3: 加 CSS（追加到 `CSS_TEXT` 数组末尾，锚点 `".cbc-help summary:hover{...}"` 之后）**

```js
			// ---- 通道手风琴（0.10.0 交互模型）----
			".cbc-acc{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-acc.cbc-open{background:var(--dsw-alias-bg-layer-2,#fff)}",
			".cbc-acc-head{display:flex;align-items:center;gap:8px;padding:10px 12px}",
			".cbc-acc-toggle{all:unset;flex:1 1 auto;display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0}",
			".cbc-acc-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:-2px;border-radius:8px}",
			".cbc-acc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);flex:0 0 auto}",
			".cbc-acc-status{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}",
			".cbc-acc-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));padding:8px 12px 10px}",
			".cbc-acc-body[hidden]{display:none}",
```

- [ ] **Step 4: 用区块定义替换标签定义（锚点 `var TAB_DEFS = [`，`:363`–`:373`）**

把 `TAB_DEFS` 与 `var PANEL_RENDERERS = {};` 整体替换为：

```js
		// ------------------------------------------------------------------
		// Blocks（通道手风琴）。顺序 = 主通道 → 两家订阅通道 → 跨通道通用；
		// 归类原则「谁提供归谁」，证据见 docs/goals/settings-card-ux-redesign.md §3。
		// ------------------------------------------------------------------
		var BLOCK_DEFS = [
			{ id: "codebuddy", title: "CodeBuddy" },
			{ id: "trae", title: "TraeWork CN" },
			{ id: "qoder", title: "Qoder CN" },
			{ id: "general", title: "通用" },
		];
		// 区块 → 分区序列（渲染顺序即数组顺序）。
		var BLOCK_SECTIONS = {
			codebuddy: ["login", "models", "tools", "bridge"],
			trae: ["trae"],
			qoder: ["qoder"],
			general: ["usage", "providers"],
		};
		var SECTION_RENDERERS = {};
```

然后把 8 处 `PANEL_RENDERERS.xxx = YyySection;` 改名为 `SECTION_RENDERERS.xxx = YyySection;`（键不变：`login`/`models`/`usage`/`tools`/`providers`/`trae`/`qoder`/`bridge`）。

- [ ] **Step 5: 加状态行与区块头（放在 `buildChips` 之后、`LoginSection` 之前；同时删掉 `tabBadge` 整个函数 `:682`–`:712`）**

```js
		// 区块头状态行：判定口径沿用 buildChips（唯一真源）。每个区块取自己那几枚
		// 芯片拼一行，tone = 其中最差的一枚——warn/err 因此就地出现在所属区块头，
		// 不再需要独立的注意条（0.10.0 状态收敛）。
		var TONE_RANK = { off: 0, ok: 1, warn: 2, err: 3 };
		function worstTone(chips) {
			var t = "off";
			chips.forEach(function (c) {
				if (c && (TONE_RANK[c.tone] || 0) > TONE_RANK[t]) t = c.tone;
			});
			return t;
		}
		function blockStatus(data, generalText) {
			var c = buildChips(data);
			var cb = [c.login, c.models, c.bridge];
			var join = function (list) {
				return list.map(function (x) { return x.text; }).join(" · ");
			};
			return {
				codebuddy: { tone: worstTone(cb), text: join(cb) },
				trae: { tone: c.trae.tone, text: c.trae.text },
				qoder: { tone: c.qoder.tone, text: c.qoder.text },
				general: { tone: "off", text: generalText || "额度与用量 · 服务商" },
			};
		}

		// 区块头：div 里两个独立交互元素（展开 button + 可选开关），避免嵌套交互。
		// Task 3 起 control 槽放 Trae/Qoder 的启用开关。
		function BlockHead(props) {
			var chevron = IconChevron
				? createElement("span", { className: "cbc-chevron" + (props.open ? " cbc-open" : "") }, createElement(IconChevron, { size: 14 }))
				: createElement("span", { className: "cbc-chevron" + (props.open ? " cbc-open" : "") }, "▾");
			var kids = [
				createElement("button", {
					key: "t", type: "button", className: "cbc-acc-toggle", "data-block": props.id,
					"aria-expanded": props.open ? "true" : "false",
					// 未挂载时没有对应 body，不留空引用（同原 tablist 纪律）。
					"aria-controls": props.mounted ? "cbc-block-" + props.id : undefined,
					onClick: props.onToggle,
				},
					createElement(Dot, { tone: props.status.tone }),
					createElement("span", { className: "cbc-acc-title" }, props.title),
					createElement("span", { className: "cbc-acc-status" }, props.status.text)),
			];
			if (props.control) kids.push(createElement("span", { key: "c", className: "cbc-acc-ctl" }, props.control));
			if (props.flash) kids.push(createElement("span", { key: "f", className: "cbc-saveflash" }, "已保存 ✓"));
			kids.push(createElement("span", { key: "v", className: "cbc-chevronwrap" }, chevron));
			return createElement("div", { className: "cbc-acc-head" }, kids);
		}
```

同时在 CSS 块补两条（接 Step 3 那组后面）：

```js
			".cbc-acc-ctl{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,gray)}",
			".cbc-chevronwrap{flex:0 0 auto;display:inline-flex}",
```

- [ ] **Step 6: 重写 `CodeBuddyCard` 的状态与渲染（`:381`–`:611`）**

改动点（其余逻辑——`load`/`post`/`save`/`settleGateways`/`prevOpenRef` 副作用——原样保留）：

6a. 卡片自身折叠态改名，避免与区块展开态撞名（锚点 `var openState = useState(embedded);`）：

```js
			var cardOpenState = useState(embedded);
			var cardOpen = cardOpenState[0];
			var setCardOpen = cardOpenState[1];
```

同函数内所有 `open` 引用改 `cardOpen`、`setOpen` 改 `setCardOpen`（共 5 处：`prevOpenRef` 副作用、`chevron`、`headChips` 条件、`cardClass`、`!open && !embedded` 早退、header 的 `aria-expanded`/`onClick`）。

6b. 标签状态换区块状态（删掉 `tabState`/`activeTab`/`setActiveTab`/`mountedState`/`mounted`/`setMounted`/`savedState`/`savedAt`/`setSavedAt`/`switchTab`，换成）：

```js
			// 手风琴：多开互不联动；展开才挂载、收起不卸载（hidden 保留 DOM，
			// 草稿/滚动/已拉目录跨展开与保存保留）。
			var openBlocksState = useState({});
			var openBlocks = openBlocksState[0];
			var setOpenBlocks = openBlocksState[1];
			var mountedBlocksState = useState({});
			var mountedBlocks = mountedBlocksState[0];
			var setMountedBlocks = mountedBlocksState[1];
			// 「已保存 ✓」落在触发该次保存的区块头右侧，1.8s 自愈。
			var savedState = useState(null);   // { block, at }
			var saved = savedState[0];
			var setSaved = savedState[1];

			var toggleBlock = function (id) {
				setOpenBlocks(function (prev) {
					var next = Object.assign({}, prev);
					if (next[id]) delete next[id]; else next[id] = true;
					return next;
				});
				setMountedBlocks(function (prev) {
					if (prev[id]) return prev;
					var next = Object.assign({}, prev);
					next[id] = true;
					return next;
				});
			};
```

6c. `save` 带上区块归属（锚点 `var save = function (patch) {`）：

```js
			var save = function (patch, blockId) {
				post({ patch: patch }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "保存失败（HTTP " + res.status + "）"); return; }
					setSaved({ block: blockId || null, at: Date.now() });
					load().then(function (d) { if (gatewayPending(d)) settleGateways(0); });
				}).catch(function (e) { setErr(e && e.message ? e.message : "保存失败（网络）"); });
			};
			// 分区拿到的是绑定了所属区块的 save —— 「已保存 ✓」才知道浮在哪个区块头。
			var saveIn = function (blockId) {
				return function (patch) { save(patch, blockId); };
			};
```

6d. 闪存副作用改依赖 `saved`（锚点 `if (!savedAt) return undefined;`）：

```js
			useEffect(function () {
				if (!saved) return undefined;
				var t = setTimeout(function () { setSaved(null); }, 1800);
				return function () { clearTimeout(t); };
			}, [saved]);
```

6e. 渲染部分：删掉 `attn`/`strip` 之外的 `tabBar`（含 `onTabKeyDown`、`tabIds`、`badge = tabBadge(data)`）与 `panels`，换成 `blocks`。`panelProps` 改名 `sectionProps`，并把每个分区的 `save` 换成 `saveIn(<所属区块>)`、`usage` 的 `active` 换成 `!!openBlocks.general`：

```js
			var sectionProps = {
				login: { value: data.value || {}, oauth: data.oauth || {}, save: saveIn("codebuddy"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data) },
				models: { post: post, setErr: setErr, reload: load, modelsInfo: data.models || {}, value: data.value || {}, save: saveIn("codebuddy") },
				tools: { value: data.value || {}, save: saveIn("codebuddy"), overridden: overriddenFor(data) },
				bridge: { value: data.value || {}, save: saveIn("codebuddy"), overridden: overriddenFor(data), bridgeView: data.bridge || {} },
				trae: { value: data.value || {}, save: saveIn("trae"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data), trae: data.trae || {} },
				qoder: { value: data.value || {}, save: saveIn("qoder"), post: post, reload: load, setErr: setErr, overridden: overriddenFor(data), qoder: data.qoder || {} },
				usage: { post: post, value: data.value || {}, save: saveIn("general"), overridden: overriddenFor(data), active: !!openBlocks.general },
				providers: { post: post, setErr: setErr },
			};
			var status = blockStatus(data, null);
			var blocks = BLOCK_DEFS.map(function (def) {
				var isOpen = !!openBlocks[def.id];
				var isMounted = !!mountedBlocks[def.id];
				return createElement("div", {
					key: def.id, className: "cbc-acc" + (isOpen ? " cbc-open" : ""), "data-block": def.id,
				},
					createElement(BlockHead, {
						id: def.id, title: def.title, status: status[def.id],
						open: isOpen, mounted: isMounted,
						onToggle: function () { toggleBlock(def.id); },
						flash: !!(saved && saved.block === def.id),
					}),
					isMounted ? createElement("div", {
						className: "cbc-acc-body cbc-block", "data-block": def.id,
						id: "cbc-block-" + def.id,
						hidden: isOpen ? undefined : true,
					}, BLOCK_SECTIONS[def.id].map(function (sid) {
						// PanelBoundary 粒度 = 每分区：一处塌落不影响同区块其它分区。
						return createElement(PanelBoundary, { key: sid },
							createElement(SECTION_RENDERERS[sid], sectionProps[sid]));
					})) : null);
			});
```

6f. 卡片返回体（锚点 `return createElement(cardTag, { className: cardClass }, embedded ? null : header,`）：

```js
			return createElement(cardTag, { className: cardClass }, embedded ? null : header,
				createElement("div", { className: "cbc-body" },
					errorBanner,
					strip,
					blocks,
					createElement("p", { className: "cbc-status" }, "修改即保存（写入 ~/.dsh/codebuddy-plugin.json），立即生效；标\u201C重置\u201D的字段可一键恢复默认值。")));
```

（`strip` 本任务**保留**，Task 2 删；`headChips` 同样保留到 Task 2。）

- [ ] **Step 7: 跑回归确认绿**

```bash
cd /c/Users/21613/dev/dsh-ui-test && node card-accordion.js "http://127.0.0.1:3080/?token=<TOKEN>"
```

Expected: `[A1]`–`[A7]` 全 ok（14 通过 / 0 失败），退出码 0。刷新页面即生效（profile 已 link 本仓库）；若断言全红先确认没有浏览器缓存（脚本已带 `--disable-http-cache`）。

- [ ] **Step 8: 提交**

```bash
cd /c/Users/21613/dev/dsh-tap
git add lib/client.js
git commit -m "feat(client): 设置卡改通道手风琴骨架（4 区块 + 区块头状态行 + 懒挂载）"
```

（`dsh-ui-test/card-accordion.js` 在仓库外，不进本次提交。）

---

### Task 2: 状态收敛（删注意条/折叠芯片/品牌前缀 + 移植两组 mock 通道）

**Files:**
- Modify: `lib/client.js` — `buildChips`（grep 锚点 `function buildChips(data) {`）、`CodeBuddyCard` 里的 `headChips`（锚点 `var headChips = null;`）与 `attn`/`strip`（锚点 `var attn = [chips.login`）、`gatewayPending`（锚点 `var gatewayPending = function (d) {`）
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`（追加断言）

**Interfaces:**
- Consumes: Task 1 的 `blockStatus`/`BlockHead`/`.cbc-acc-*` DOM 契约、`settleGateways`/`GATEWAY_SETTLE_DELAYS`
- Produces: `buildChips(data)` 的 `text` 去掉品牌前缀（`"Trae 运行中"` → `"运行中"`）并删除 `tab`/`tabTitle` 字段（消费者已消失）；`attentionCount(data)` → `number`（warn/err 芯片个数，旧槽折叠态按需芯片用）；`blockStatus(data, generalText)` 签名不变

- [ ] **Step 1: 追加失败断言（插在 `card-accordion.js` 的 `await browser.close();` 之前）**

```js
  // ---- [B] 状态收敛：三套状态展示退役，warn 只出现在区块头 ----
  st = await blockState(page);
  check("[B1] 无注意条", st.strips === 0, "strips=" + st.strips);
  check("[B1] 无标签徽标", st.badges === 0, "badges=" + st.badges);

  // [B2] 状态行口径 = 独立预言机（从 GET 视图另算一遍，双向对齐；
  //      避免 .cbc-acc-status 缺席时 [].every() 恒真的空洞通过）
  const view = await getView(page);
  const oracle = (() => {
    const v = view.value || {}, o = view.oauth || {}, b = view.bridge || {}, m = view.models || {};
    const t = (view.trae || {}).bridge || {}, q = (view.qoder || {}).bridge || {};
    const qo = ((view.qoder || {}).oauth || {});
    const login = v.authMode === "oauth"
      ? (o.needsRelogin ? "OAuth 需重新登录" : o.signedIn ? "OAuth 已登录" : (o.pending ? "OAuth 登录中…" : "OAuth 未登录"))
      : (v.activeApiKey ? "API Key · " + v.activeApiKey : "API Key 未配置");
    const models = "模型 " + (m.effectiveCount != null ? m.effectiveCount : "?") + " 个";
    const bridge = v.bridgeEnabled === false ? "桥已禁用"
      : b.running ? "桥 :" + b.port : "桥未监听 :" + (b.port || v.bridgePort || "?");
    const trae = v.traeEnabled === true
      ? (t.running === true ? "运行中" : "网关未监听 :" + (v.traeBridgePort || "?"))
      : "未启用";
    const qoder = v.qoderEnabled === true
      ? (q.running === true ? "运行中" : "网关未监听 :" + (v.qoderBridgePort || "?"))
      : (qo.signedIn ? (qo.needsRelogin ? "需重登" : "已登录·未启用") : (qo.pending ? "登录中" : "未启用"));
    return { codebuddy: [login, models, bridge], trae: [trae], qoder: [qoder] };
  })();
  const byId = {};
  st.status.forEach((s) => { byId[s.id] = s; });
  ["codebuddy", "trae", "qoder"].forEach((id) => {
    const got = (byId[id] || {}).text || "";
    const missing = oracle[id].filter((frag) => got.indexOf(frag) === -1);
    check("[B2] " + id + " 状态行含全部应有片段", missing.length === 0,
      JSON.stringify({ got: got, missing: missing }));
  });
  check("[B2] 状态行不含品牌前缀（Trae/Qoder 已由区块标题承载）",
    !/^(Trae|Qoder) /.test((byId.trae || {}).text || "") && !/^(Trae|Qoder) /.test((byId.qoder || {}).text || ""),
    JSON.stringify({ trae: (byId.trae || {}).text, qoder: (byId.qoder || {}).text }));
  check("[B2] 预言机与 DOM 数量双向对齐", Object.keys(oracle).length === 3 && st.status.length === 4,
    JSON.stringify(st.status.map((s) => s.id)));

  // [B3] mock 通道：启用但网关未监听 → warn 落在所属区块头（带端口），且无注意条
  const mock = JSON.parse(JSON.stringify(view));
  mock.value.traeEnabled = true;
  mock.value.qoderEnabled = true;
  mock.value.traeBridgePort = 3902;
  mock.value.qoderBridgePort = 3903;
  mock.trae = Object.assign({}, mock.trae, { bridge: { running: false, port: null, lastError: "mock-eaddrinuse" } });
  mock.qoder = Object.assign({}, mock.qoder, { bridge: { running: false, port: null, lastError: "mock-eaddrinuse" } });
  const b3 = await newPage((pg) => pg.evaluateOnNewDocument((m) => {
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") !== -1 && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify(m), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return orig.apply(this, arguments);
    };
  }, mock));
  check("[B3] mock 通道：PM 与卡可开", b3.opened);
  st = await blockState(b3.page);
  const sById = {}; st.status.forEach((s) => { sById[s.id] = s; });
  check("[B3] Trae/Qoder 区块头 tone=warn", sById.trae.tone === "warn" && sById.qoder.tone === "warn",
    JSON.stringify({ trae: sById.trae, qoder: sById.qoder }));
  check("[B3] 未监听文案带端口（:3902 / :3903）",
    /:3902/.test(sById.trae.text) && /:3903/.test(sById.qoder.text),
    JSON.stringify({ trae: sById.trae.text, qoder: sById.qoder.text }));
  check("[B3] 仍无注意条（warn 只在区块头）", st.strips === 0, "strips=" + st.strips);
  await b3.page.screenshot({ path: "shots/acc-task2-warn.png" });
  await b3.page.close();

  // [B4] mock 通道 2：保存后的网关退避补拉（踩坑 #45）在新结构下仍自愈
  const settleView = JSON.parse(JSON.stringify(view));
  settleView.value.bridgeEnabled = true;
  settleView.value.traeEnabled = false;
  settleView.value.qoderEnabled = false;
  settleView.bridge = { running: false, port: 3901, lastError: null };
  const b4 = await newPage((pg) => pg.evaluateOnNewDocument((v) => {
    const stt = { posts: 0, gets: 0 };
    const orig = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } }));
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") === -1) return orig.apply(this, arguments);
      if (method === "POST") { stt.posts++; stt.gets = 0; return json({ ok: true, value: v.value, user: {} }); }
      stt.gets++;
      const body = JSON.parse(JSON.stringify(v));
      // 第 1 次 GET 仍未监听（复现竞态窗口），第 2 次起已监听（退避补拉应自愈）
      body.bridge = { running: stt.gets >= 2, port: 3901, lastError: null };
      return json(body);
    };
    window.__settleProbe = stt;
  }, settleView));
  const page2 = b4.page;
  const pageErrors2 = b4.errors;
  check("[B4] mock 通道 2 可开", b4.opened);
  const headOf = (pg) => pg.evaluate(() => ({
    text: ((document.querySelector('.cbc-acc[data-block=codebuddy] .cbc-acc-status') || {}).textContent || "").trim(),
    probe: window.__settleProbe || null,
  }));
  const before = await headOf(page2);
  check("[B4] 前置：CodeBuddy 区块头含「桥未监听 :3901」",
    /桥未监听 :3901/.test(before.text), JSON.stringify(before));
  check("[B4] 展开 CodeBuddy", await openBlock(page2, "codebuddy"));
  await sleep(2000);
  const toggled = await page2.evaluate(() => {
    const cb = document.querySelector('.cbc-acc-body[data-block=codebuddy] input.cbc-check');
    if (!cb) return false;
    cb.click();
    return true;
  });
  await sleep(600);   // 首次 GET 已回，仍在 1s 退避窗内
  const mid = await headOf(page2);
  check("[B4] 保存后首次 GET 仍「桥未监听」（复现竞态窗口）",
    toggled && !!mid.probe && mid.probe.posts === 1 && mid.probe.gets >= 1 && /桥未监听/.test(mid.text),
    JSON.stringify({ toggled: toggled, mid: mid }));
  await sleep(2500);  // 越过 1s 退避
  const after = await headOf(page2);
  check("[B4] 退避补拉后自愈：区块头假「桥未监听」消失",
    !!after.probe && after.probe.gets >= 2 && !/桥未监听/.test(after.text), JSON.stringify(after));
  check("[B4] mock 通道 2 无 pageerror", pageErrors2.length === 0, pageErrors2.join(" | "));
  await page2.screenshot({ path: "shots/acc-task2-settle.png" });
  await page2.close();
```

- [ ] **Step 2: 跑一次确认红**

Expected: `[B1]` 无注意条 FAIL（`strip` 仍在）、`[B2]` 品牌前缀 FAIL、`[B3]`/`[B4]` 相关项 FAIL；退出码 1。

- [ ] **Step 3: 删三套状态展示 + 去品牌前缀**

3a. `buildChips` 内：删掉每个芯片的 `tab`/`tabTitle` 包装（`Object.assign({ tab: ..., tabTitle: ... }, login)` → 直接 `login`），并把 trae/qoder 的 `text` 去掉品牌前缀：

```js
				text: value.traeEnabled === true
					? ((((data.trae || {}).bridge || {}).running === true) ? "运行中" : "网关未监听 :" + (value.traeBridgePort || "?"))
					: "未启用",
```
```js
				text: value.qoderEnabled === true
					? ((((data.qoder || {}).bridge || {}).running === true) ? "运行中" : "网关未监听 :" + (value.qoderBridgePort || "?"))
					: (qoauth.signedIn ? (qoauth.needsRelogin ? "需重登" : "已登录·未启用") : (qoauth.pending ? "登录中" : "未启用")),
```

3b. `CodeBuddyCard` 内删掉 `attn`/`strip` 两个变量与渲染体里的 `strip,` 一行（Task 1 Step 6f 的返回体变成 `errorBanner, blocks, createElement("p", ...)`）。

3c. `gatewayPending` 里对芯片 `text` 的 `/未监听/` 判定不变（文案仍含"未监听"）；确认它只读 `c.bridge`/`c.trae`/`c.qoder` 三枚，不依赖已删字段。

3d. `headChips`（折叠态三芯片）换成按需单芯片：

```js
			// 折叠态（仅旧槽 settings.plugin.item 会走到）：不再常显三芯片——
			// 状态由区块头承载；只在确有待处理项时浮一枚计数芯片。
			var headChips = null;
			if (!cardOpen && data) {
				var n = attentionCount(data);
				if (n > 0) {
					headChips = createElement("span", { className: "cbc-headchips" },
						createElement("span", { className: "cbc-chip" },
							createElement(Dot, { tone: "warn" }), n + " 项需处理"));
				}
			}
```

3e. 在 `blockStatus` 之后加：

```js
		// 待处理项计数（warn/err）：旧槽折叠态的按需芯片用；展开态由区块头就地承载。
		function attentionCount(data) {
			var c = buildChips(data);
			return [c.login, c.models, c.bridge, c.search, c.image, c.trae, c.qoder]
				.filter(function (x) { return x.tone === "warn" || x.tone === "err"; }).length;
		}
```

3f. CSS 清理：删 `".cbc-strip{...}"`（注意条已无），并删掉 Task 1 留下的死规则 `.cbc-tabs` / `.cbc-tab` / `.cbc-tab:hover` / `.cbc-tab:focus-visible` / `.cbc-tab.cbc-active` / `.cbc-tabcount` / `.cbc-tabcount.cbc-ok` / `.cbc-tabcount.cbc-warn` / `.cbc-panel` / `.cbc-panel[hidden]`（删前 grep 确认 JS 侧零引用）。**必须保留** `.cbc-saveflash`（`BlockHead` 的「已保存 ✓」在用）、`.cbc-chip` 与 `button.cbc-chip*`（折叠态按需芯片 + 用量页账户/流式桥行内芯片在用）、`.cbc-dot*`。

- [ ] **Step 4: 跑回归确认绿**

Expected: 全部 ok（Task 1 的 14 条 + `[B1]`–`[B4]` 共 12 条 = 26 通过 / 0 失败）。

- [ ] **Step 5: 哈希对账（mock 通道零写入）**

```bash
md5sum ~/.dsh/codebuddy-plugin.json
```

Expected: 与跑前一致（`[B3]`/`[B4]` 全走 mock，不应有任何真实写入）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/21613/dev/dsh-tap && git add lib/client.js
git commit -m "feat(client): 状态收敛到区块头——删注意条/折叠三芯片/标签徽标与品牌前缀"
```

---

### Task 3: 区块头启用开关（Trae / Qoder）

**Files:**
- Modify: `lib/client.js` — `CodeBuddyCard` 的 `blocks` 构造（Task 1 Step 6e）、`TraeSection` 的「启用通道」行（`:1628`–`:1635`）、`QoderSection` 的「启用通道」行（`:1897`–`:1904`）
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`

**Interfaces:**
- Consumes: `BlockHead` 的 `control` 槽、`saveIn(blockId)`、`data.value.traeEnabled`/`qoderEnabled`、`overriddenFor(data)`
- Produces: DOM 契约 `.cbc-acc-head input.cbc-check[data-field=traeEnabled|qoderEnabled]`；`BlockHead` 的 `control` 用法固定为「checkbox + 文案 + ResetButton」

- [ ] **Step 1: 追加失败断言（插在 `[B4]` 组之后、`await browser.close();` 之前）**

```js
  // ---- [C] 区块头启用开关（Trae/Qoder 唯一落点）----
  // `page` 自始至终不装 mock（mock 组都走 newPage 的独立页面），故此处无需 reload。
  const heads = await page.evaluate(() => ({
    codebuddy: !!document.querySelector('.cbc-acc[data-block=codebuddy] .cbc-acc-head input.cbc-check'),
    general: !!document.querySelector('.cbc-acc[data-block=general] .cbc-acc-head input.cbc-check'),
    trae: !!document.querySelector('.cbc-acc-head input.cbc-check[data-field=traeEnabled]'),
    qoder: !!document.querySelector('.cbc-acc-head input.cbc-check[data-field=qoderEnabled]'),
  }));
  check("[C1] Trae/Qoder 头部有启用开关", heads.trae && heads.qoder, JSON.stringify(heads));
  check("[C1] CodeBuddy/通用头部无开关", !heads.codebuddy && !heads.general, JSON.stringify(heads));

  // [C2] 展开区内不再有「启用通道」行（唯一落点 = 头部）
  await ensureOpen(page, "trae"); await sleep(2000);
  const dupRow = await page.evaluate(() => {
    const body = document.querySelector('.cbc-acc-body[data-block=trae]');
    const labels = [...(body ? body.querySelectorAll(".cbc-row-label") : [])].map((x) => (x.textContent || "").trim());
    return labels;
  });
  check("[C2] Trae 展开区无「启用通道」行", !dupRow.includes("启用通道"), JSON.stringify(dupRow));

  // [C3] 点头部开关 = 恰好 1 次 POST，patch 只含该字段（mock，零真实写入）
  const realView3 = await getView(page);
  const c3 = await newPage((pg) => pg.evaluateOnNewDocument((v) => {
    const stt = { posts: 0, bodies: [] };
    const orig = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } }));
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") === -1) return orig.apply(this, arguments);
      if (method === "POST") {
        stt.posts++;
        try { stt.bodies.push(JSON.parse((init && init.body) || "{}")); } catch (e) { stt.bodies.push({}); }
        const next = JSON.parse(JSON.stringify(v));
        if (stt.bodies[stt.bodies.length - 1].patch) Object.assign(next.value, stt.bodies[stt.bodies.length - 1].patch);
        return json({ ok: true, value: next.value, user: {}, trae: next.trae, qoder: next.qoder });
      }
      return json(JSON.parse(JSON.stringify(v)));
    };
    window.__swProbe = stt;
  }, realView3));
  const page3 = c3.page;
  const pageErrors3 = c3.errors;
  check("[C3] mock 通道可开", c3.opened);
  const clicked = await page3.evaluate(() => {
    const cb = document.querySelector('.cbc-acc-head input.cbc-check[data-field=traeEnabled]');
    if (!cb) return false;
    cb.click();
    return true;
  });
  await sleep(1200);
  const sw = await page3.evaluate(() => window.__swProbe);
  check("[C3] 头部开关触发恰好 1 次 POST", clicked && sw.posts === 1, JSON.stringify({ clicked: clicked, posts: sw.posts }));
  check("[C3] patch 只含 traeEnabled",
    sw.bodies.length === 1 && sw.bodies[0].patch && Object.keys(sw.bodies[0].patch).length === 1
    && "traeEnabled" in sw.bodies[0].patch, JSON.stringify(sw.bodies));
  check("[C3] mock 通道 3 无 pageerror", pageErrors3.length === 0, pageErrors3.join(" | "));
  await page3.close();
```

- [ ] **Step 2: 跑一次确认红**

Expected: `[C1]`–`[C3]` FAIL（头部还没有开关），退出码 1。

- [ ] **Step 3: 在 `blocks` 构造里给 Trae/Qoder 传 `control`**

在 Task 1 Step 6e 的 `blocks` map 内，`createElement(BlockHead, {...})` 的参数对象上加 `control`：

```js
			// 通道级启用开关：Trae/Qoder 的唯一落点（收起态也能一眼看状态并直接启停）。
			// 头部是 div + 两个独立交互元素，不构成嵌套交互。
			var channelSwitch = function (blockId, fieldKey) {
				return createElement("span", null,
					createElement("input", {
						type: "checkbox", className: "cbc-check", "data-field": fieldKey,
						checked: (data.value || {})[fieldKey] === true,
						title: (data.value || {})[fieldKey] === true ? "停用该通道（其模型整体移出选择器）" : "启用该通道",
						onChange: function (e) {
							var p = {};
							p[fieldKey] = e.target.checked;
							save(p, blockId);
						},
					}),
					createElement(ResetButton, { fieldKey: fieldKey, overridden: overriddenFor(data)(fieldKey), save: saveIn(blockId) }));
			};
```

`BlockHead` 调用处加：

```js
						control: def.id === "trae" ? channelSwitch("trae", "traeEnabled")
							: def.id === "qoder" ? channelSwitch("qoder", "qoderEnabled")
								: null,
```

- [ ] **Step 4: 删掉两个分区里的「启用通道」行**

`TraeSection`：删除 `createElement("div", { className: "cbc-row" }, createElement("div", { className: "cbc-row-label" }, "启用通道"), ...)` 整段（`:1628`–`:1635`，含其中的 `ResetButton`）。原行内那句"翻译网关已上线（:3902，运行中/未监听）"的信息不丢——它已由区块头状态行 + 网关组承载（Task 4 会在网关组补一行状态文字）。

`QoderSection`：同样删除「启用通道」整段（`:1897`–`:1904`）。

- [ ] **Step 5: 跑回归确认绿**

Expected: 全部 ok（26 + 6 = 32 通过 / 0 失败）。

- [ ] **Step 6: 哈希对账 + 提交**

```bash
md5sum ~/.dsh/codebuddy-plugin.json   # 必须与跑前一致
cd /c/Users/21613/dev/dsh-tap && git add lib/client.js
git commit -m "feat(client): Trae/Qoder 启用开关上移到区块头（收起态可直读可直控）"
```

---

### Task 4: 通道内部分组（凭据 / 模型 / 工具 / 网关 / 高级）

**Files:**
- Modify: `lib/client.js` — `BridgeAdvancedSection`（`:1933`–`:1986`，拆成「网关」+「高级」两组）、`TraeSection` 的「连接域名」折叠组（`:1673`–`:1683`）、`QoderSection` 的「连接域名」折叠组（`:1916`–`:1927`）、`LoginSection`/`ModelsSection`/`ToolsSection` 的组标题
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`

**Interfaces:**
- Consumes: 各分区组件现有 props（不变）
- Produces: DOM 契约 `.cbc-acc-body[data-block=X] .cbc-group-title` 文本序列；`高级` 组统一用 `<details className="cbc-adv">`（`summary` 文本 `高级`），与说明用的 `details.cbc-help`（`summary` 文本 `使用说明`）区分开

- [ ] **Step 1: 追加失败断言**

```js
  // ---- [D] 通道内部分组：固定顺序 + 高级折叠 ----
  const groupTitles = async (pg, id) => pg.evaluate((bid) => {
    const body = document.querySelector('.cbc-acc-body[data-block="' + bid + '"]');
    return [...(body ? body.querySelectorAll(".cbc-group-title") : [])].map((x) => (x.textContent || "").trim());
  }, id);
  await openBlock(page, "codebuddy"); await sleep(1500);
  const cbGroups = await groupTitles(page, "codebuddy");
  check("[D1] CodeBuddy 分组顺序", JSON.stringify(cbGroups) === JSON.stringify(["凭据", "模型", "工具", "网关", "高级"]), JSON.stringify(cbGroups));
  await openBlock(page, "qoder"); await sleep(1500);
  const qGroups = await groupTitles(page, "qoder");
  check("[D1] Qoder 分组顺序", JSON.stringify(qGroups) === JSON.stringify(["凭据", "模型", "网关", "高级"]), JSON.stringify(qGroups));
  const tGroups = await groupTitles(page, "trae");
  check("[D1] Trae 分组顺序", JSON.stringify(tGroups) === JSON.stringify(["凭据", "模型", "网关", "高级"]), JSON.stringify(tGroups));

  const advState = async (pg, id) => pg.evaluate((bid) => {
    const d = document.querySelector('.cbc-acc-body[data-block="' + bid + '"] details.cbc-adv');
    if (!d) return null;
    return { open: d.open, text: (d.textContent || "").replace(/\s+/g, " ").slice(0, 200) };
  }, id);
  const cbAdv = await advState(page, "codebuddy");
  check("[D2] CodeBuddy 高级组默认折叠且含网关地址", !!cbAdv && cbAdv.open === false && /baseURL|网关地址|copilot/.test(cbAdv.text), JSON.stringify(cbAdv));
  const qAdv = await advState(page, "qoder");
  check("[D2] Qoder 高级组含四个域名/client_id 字段", !!qAdv && /qoder|client_id|infer|openapi/i.test(qAdv.text), JSON.stringify(qAdv));
  const tAdv = await advState(page, "trae");
  check("[D2] Trae 高级组含认证/聊天/登录域", !!tAdv && /trae|认证|登录域/i.test(tAdv.text), JSON.stringify(tAdv));
  // [D3] 工程项不再与日常项同层：端口在网关组、域名在高级组
  const loc = await page.evaluate(() => {
    const body = document.querySelector('.cbc-acc-body[data-block=trae]');
    const rows = [...body.querySelectorAll(".cbc-row")];
    const findRow = (label) => rows.find((r) => ((r.querySelector(".cbc-row-label") || {}).textContent || "").trim() === label);
    const portRow = findRow("网关端口");
    return { hasPortRow: !!portRow };
  });
  check("[D3] Trae 网关组仍有「网关端口」行", loc.hasPortRow, JSON.stringify(loc));
  await page.screenshot({ path: "shots/acc-task4-groups.png" });
```

- [ ] **Step 2: 跑一次确认红**

Expected: `[D1]`–`[D3]` FAIL（分组标题与 `details.cbc-adv` 尚不存在）。

- [ ] **Step 3: 加 CSS 与各分区的组标题**

CSS 追加：

```js
			".cbc-adv{margin:10px 0 2px}",
			".cbc-adv>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,gray);list-style:none;display:inline-flex;align-items:center;gap:4px;user-select:none}",
			".cbc-adv>summary::-webkit-details-marker{display:none}",
			".cbc-adv>summary:after{content:\"▸\";font-size:10px}",
			".cbc-adv[open]>summary:after{content:\"▾\"}",
			".cbc-adv>summary:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-advbody{margin-top:6px}",
```

各分区在返回体的最前面插入组标题（`createElement("p", { className: "cbc-group-title" }, "凭据")` 等）：

- `LoginSection`（锚点 `return createElement("div", { className: "cbc-section" }, modeRow, body);`）→ 改为 `return createElement("div", { className: "cbc-section" }, createElement("p", { className: "cbc-group-title" }, "凭据"), modeRow, body);`
- `ModelsSection`（锚点 `return createElement("div", { className: "cbc-section" },` 后紧跟「目录同步」行）→ 在最前面插 `createElement("p", { className: "cbc-group-title" }, "模型"),`
- `ToolsSection`（锚点 `createElement("p", { className: "cbc-group-title" }, "网络搜索与抓取")`）→ 把它替换为两条：`createElement("p", { className: "cbc-group-title" }, "工具"), createElement("p", { className: "cbc-hint" }, "网络搜索与抓取"),`（后半段的 `"图像生成"` 小标题同样降为 `cbc-hint`，避免与一级组标题同级）
- `TraeSection` / `QoderSection`：返回体最前插 `createElement("p", { className: "cbc-group-title" }, "凭据"),`；在模型启停组之前插 `createElement("p", { className: "cbc-group-title" }, "模型"),`（`tmodelRows`/`qmodelRows` 之前）；在传输/端口行之前插 `createElement("p", { className: "cbc-group-title" }, "网关"),`
- `UsageSection`：返回体最前插 `createElement("p", { className: "cbc-group-title" }, "额度与用量"),`
- `ProvidersSection`：返回体最前插 `createElement("p", { className: "cbc-group-title" }, "服务商"),`

- [ ] **Step 4: 拆 `BridgeAdvancedSection` 为「网关」+「高级」**

把函数体重排为（保留全部字段与 `ResetButton`，只改分组与容器）：

```js
	function BridgeAdvancedSection(props) {
		var value = props.value;
		var save = props.save;
		var overridden = props.overridden;
		var bridgeView = props.bridgeView || {};
		return createElement("div", { className: "cbc-section" },
			createElement("p", { className: "cbc-group-title" }, "网关"),
			// 流式桥开关行（原文案与 ResetButton 不变）
			/* …bridgeEnabled 行、端口行、会话归因行、会话头格式行、并发上限行原样… */
			createElement(HelpNote, null, "桥统一解析凭据（凭据组选 OAuth 或 Key），主聊天也经由此桥。同一会话超过上限的请求排队（FIFO）；无会话 id 的请求不限流。非流式入站聚合成标准 JSON，chat/completions 之外的请求直接透传。"),
			createElement("details", { className: "cbc-adv" },
				createElement("summary", null, "高级"),
				createElement("div", { className: "cbc-advbody" },
					/* …原「高级」组的网关地址 baseURL 行 + 一行 hint 原样搬进来… */)));
	}
```

（`/* … */` 处是把现有 `:1940`–`:1976` 的 5 个 `cbc-row` 与 `:1980`–`:1984` 的 baseURL 行**原样剪切**过来，不改字段、不改文案、不改 `ResetButton`；删掉中间的 `hr.cbc-divider` 与旧的 `"流式桥"`/`"高级"` 两个 `cbc-group-title`。）

- [ ] **Step 5: Trae/Qoder 的域名组统一为 `details.cbc-adv`**

`TraeSection`：把「连接域名」那一行 `cbc-toggle` 按钮 + `advOpen ? ... : null` 的两段（`:1673`–`:1683`）替换为：

```js
				createElement("details", { className: "cbc-adv" },
					createElement("summary", null, "高级"),
					createElement("div", { className: "cbc-advbody" },
						createElement(TextField, { fieldKey: "traeAuthBaseURL", value: value.traeAuthBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeAuthBaseURL") }),
						createElement(TextField, { fieldKey: "traeChatBaseURL", value: value.traeChatBaseURL, save: save, widthClass: "cbc-w220", overridden: overridden("traeChatBaseURL") }),
						createElement(TextField, { fieldKey: "traeLoginHost", value: value.traeLoginHost, save: save, widthClass: "cbc-w220", overridden: overridden("traeLoginHost") })))),
```

同时删掉 `advOpenState`/`advOpen`/`setAdvOpen`（`details` 自带状态，零 JS——与 `HelpNote` 同纪律）。

`QoderSection`：同样替换 `:1916`–`:1927`，四个字段 `qoderLoginHost`/`qoderOpenapiBaseURL`/`qoderInferBaseURL`/`qoderClientId` 原样搬进 `details.cbc-adv`，删掉 `advOpenState`/`advOpen`/`setAdvOpen`。

- [ ] **Step 6: 跑回归确认绿**

Expected: 全部 ok（32 + 7 = 39 通过 / 0 失败）。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/21613/dev/dsh-tap && git add lib/client.js
git commit -m "feat(client): 通道内分组（凭据/模型/工具/网关/高级），工程项收进 details.cbc-adv"
```

---

### Task 5: 模型组统一（同步按钮合并 + 三家都有筛选框）

**Files:**
- Modify: `lib/client.js` — `ModelsSection` 的「目录同步」行（`:1281`–`:1291`，两个按钮 → 一个）、`TraeSection` 的「模型目录」行（`:1646`–`:1650`）+ 模型组加筛选、`QoderSection` 的「模型目录」行（`:1905`–`:1909`）+ 模型组加筛选
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`

**Interfaces:**
- Consumes: `post({action:'model-sync'})` / `post({action:'model-list'})` / `post({action:'trae-model-sync'})` / `post({action:'trae-model-list'})` / `post({action:'qoder-model-sync'})` / `post({action:'qoder-model-list'})`（全部现有 action，不改）
- Produces: DOM 契约 `.cbc-acc-body[data-block=X] .cbc-syncbar`（操作条：1 个 `button` + `.cbc-muted` 状态文字 + 筛选 `input[placeholder*="过滤"]`）

- [ ] **Step 1: 追加失败断言**

```js
  // ---- [E] 模型组统一 ----
  await ensureOpen(page, "codebuddy"); await ensureOpen(page, "trae"); await ensureOpen(page, "qoder");
  await sleep(1500);
  const syncBar = async (pg, id) => pg.evaluate((bid) => {
    const bar = document.querySelector('.cbc-acc-body[data-block="' + bid + '"] .cbc-syncbar');
    if (!bar) return null;
    return {
      buttons: [...bar.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
      hasFilter: !!bar.querySelector('input[placeholder*="过滤"]'),
      text: (bar.textContent || "").replace(/\s+/g, " ").trim(),
    };
  }, id);
  const cbBar = await syncBar(page, "codebuddy");
  check("[E1] CodeBuddy 只有一个同步按钮，文案「同步目录」",
    !!cbBar && cbBar.buttons.length === 1 && cbBar.buttons[0] === "同步目录", JSON.stringify(cbBar));
  check("[E1] CodeBuddy 操作条含筛选框", !!cbBar && cbBar.hasFilter, JSON.stringify(cbBar));
  const qBar = await syncBar(page, "qoder");
  check("[E1] Qoder 操作条同构（1 按钮 + 筛选）",
    !!qBar && qBar.buttons.length === 1 && qBar.buttons[0] === "同步目录" && qBar.hasFilter, JSON.stringify(qBar));
  const tBar = await syncBar(page, "trae");
  check("[E1] Trae 操作条同构（1 按钮 + 筛选）",
    !!tBar && tBar.buttons.length === 1 && tBar.buttons[0] === "同步目录" && tBar.hasFilter, JSON.stringify(tBar));

  // [E2] 点「同步目录」= 先 model-sync 后 model-list（mock 记 POST 序列，零真实写入）
  const realView4 = await getView(page);
  const e2 = await newPage((pg) => pg.evaluateOnNewDocument((v) => {
    const stt = { actions: [] };
    const orig = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } }));
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") === -1) return orig.apply(this, arguments);
      if (method === "POST") {
        let b = {};
        try { b = JSON.parse((init && init.body) || "{}"); } catch (e) { b = {}; }
        if (b.action) stt.actions.push(b.action);
        if (b.action === "model-sync") return json({ ok: true, sync: { ok: true, count: 24, kept: false } });
        if (b.action === "model-list") return json({ ok: true, catalog: { models: [] }, staticIds: [], effectiveIds: [], state: { disabled: {}, extra: {}, overrides: {} } });
        return json({ ok: true, value: v.value, user: {} });
      }
      return json(JSON.parse(JSON.stringify(v)));
    };
    window.__syncProbe = stt;
  }, realView4));
  const page4 = e2.page;
  check("[E2] mock 通道可开", e2.opened);
  await ensureOpen(page4, "codebuddy"); await sleep(2500);
  const syncClicked = await page4.evaluate(() => {
    const bar = document.querySelector('.cbc-acc-body[data-block=codebuddy] .cbc-syncbar');
    const btn = bar && [...bar.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "同步目录");
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(2000);
  const acts = await page4.evaluate(() => window.__syncProbe.actions);
  const iSync = acts.indexOf("model-sync"), iList = acts.indexOf("model-list");
  check("[E2] 点「同步目录」触发 model-sync 与 model-list",
    syncClicked && iSync >= 0 && iList >= 0, JSON.stringify(acts));
  check("[E2] 顺序 = 先 sync 后 list", iSync >= 0 && iList > iSync, JSON.stringify(acts));
  check("[E2] 不重复触发（各恰好一次）",
    acts.filter((a) => a === "model-sync").length === 1 && acts.filter((a) => a === "model-list").length === 1,
    JSON.stringify(acts));
  await page4.close();
```

- [ ] **Step 2: 跑一次确认红**

Expected: `[E1]`/`[E2]` FAIL（`.cbc-syncbar` 不存在；CodeBuddy 仍是两个按钮）。

- [ ] **Step 3: CodeBuddy 模型组——两按钮合并 + 操作条容器**

把 `ModelsSection` 的「目录同步」行与「筛选」行（`:1281`–`:1291`）合并成一个 `.cbc-syncbar`：

```js
			// 「同步目录」= 一次点按做两件事：拉网关目录并铺镜像（model-sync）、
			// 刷新管理列表（model-list）。原先是两个按钮，语义重叠、用户要判断点哪个。
			var syncBusyState = useState(false);
			var syncBusy = syncBusyState[0];
			var setSyncBusy = syncBusyState[1];
			var syncNow = function () {
				setSyncBusy(true);
				post({ action: "model-sync" }).then(function (res) {
					if (!res.ok) { setSyncBusy(false); setErr(res.d && res.d.error ? res.d.error : "同步失败"); return; }
					if (res.d.sync && res.d.sync.ok === false) setErr("目录同步失败（已" + (res.d.sync.kept ? "保留上次清单" : "回落静态清单") + "）：" + res.d.sync.error);
					reload();
					// 目录同步失败也要刷新管理列表——两侧原因分别可见，不互相掩盖。
					return post({ action: "model-list" }).then(function (r2) {
						setSyncBusy(false);
						if (r2.ok) setData(r2.d);
						else setErr(r2.d && r2.d.error ? r2.d.error : "获取失败");
					});
				}).catch(function (e) { setSyncBusy(false); setErr(e && e.message ? e.message : "同步失败（网络）"); });
			};
```

（删掉原有的独立 `fetchList` 里的 `setBusy` 双态：`busy`/`setBusy` 仅保留给首次挂载拉取用；`syncNow` 用 `syncBusy`。）

返回体里那两行换成：

```js
				createElement("div", { className: "cbc-syncbar" },
					createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, disabled: syncBusy, onClick: syncNow }, syncBusy ? "同步中…" : "同步目录"),
					createElement("span", { className: "cbc-muted" }, syncText),
					createElement(CbcInput, { widthClass: "cbc-w220", placeholder: "输入 id 关键字过滤模型…", value: filter, onInput: function (e) { setFilter(e.target.value); } })),
```

CSS 追加：

```js
			".cbc-syncbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 8px}",
```

- [ ] **Step 4: Trae/Qoder 模型组同构（加 `.cbc-syncbar` + 筛选）**

两个分区各加一个 `filter` 本地态与同款操作条。`TraeSection`（把「模型目录」行 `:1646`–`:1650` 换掉，并在 `tmodelRows` 的列表渲染前按 filter 过滤）：

```js
			var tfilterState = useState("");
			var tfilter = tfilterState[0];
			var setTfilter = tfilterState[1];
```

```js
				createElement("div", { className: "cbc-syncbar" },
					createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, disabled: busy, onClick: syncModels }, busy ? "同步中…" : "同步目录"),
					createElement("span", { className: "cbc-muted" }, syncInfo),
					createElement(CbcInput, { widthClass: "cbc-w220", placeholder: "输入 id 关键字过滤模型…", value: tfilter, onInput: function (e) { setTfilter(e.target.value); } })),
```

`tmodelRows` 里的 `tlist.profiles.map(...)` 改为先过滤：

```js
					var tneedle = tfilter.trim().toLowerCase();
					var tshown = tlist.profiles.filter(function (p) {
						if (!tneedle) return true;
						return String(p.id).toLowerCase().indexOf(tneedle) >= 0
							|| (p.name && String(p.name).toLowerCase().indexOf(tneedle) >= 0);
					});
```

（`tshown.map(...)` 替代 `tlist.profiles.map(...)`；组标题的计数仍用全量 `tlist.profiles.length` 与 `enabledCount`，不受筛选影响。）

`QoderSection` 同款：加 `qfilter`/`setQfilter`，把「模型目录」行（`:1905`–`:1909`）换成 `.cbc-syncbar`（按钮文案「同步目录」、`onClick: syncModels`、状态文字 `syncInfo`、筛选框），`qlist.profiles.map` 前加同款过滤得 `qshown`。

**注意**：Trae/Qoder 的操作条要在「通道未启用」时也渲染（现在模型组整体在 `value.xxxEnabled === true` 才出现）——把 `.cbc-syncbar` 提到该条件之外，只有**列表**部分保留条件；未启用时状态文字后面追加一句「（通道未启用）」，避免用户对着一个不生效的按钮发愣。

- [ ] **Step 5: 跑回归确认绿**

Expected: 全部 ok（39 + 8 = 47 通过 / 0 失败）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/21613/dev/dsh-tap && git add lib/client.js
git commit -m "feat(client): 三家模型组同构——「同步目录」单按钮 + 统一筛选框"
```

---

### Task 6: 通用区块头取样（额度 / 服务商数）+ 轮询随展开

**Files:**
- Modify: `lib/client.js` — `CodeBuddyCard`（挂载取样 + `generalText` 传入 `blockStatus`）、`UsageSection`（`active` 语义已是"区块展开"，Task 1 已接；此处补首次取样与卡片级共享）、`ProvidersSection`（`credential-scan` 保持在分区挂载时）
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`

**Interfaces:**
- Consumes: `post({action:'usage'})` → `{ok,usage,bridge,quota}`；`post({action:'provider-list'})` → `{ok,providers,presets}`；`blockStatus(data, generalText)`
- Produces: `generalSummary(usageRes, providersRes)` → `string`（区块头文案）；`useGeneralSample(post)` → `{text, usage, providers}`（卡片级一次性取样，不轮询）

- [ ] **Step 1: 追加失败断言**

```js
  // ---- [F] 通用区块头取样 + 轮询随展开 ----
  const realView5 = await getView(page);
  const f1 = await newPage((pg) => pg.evaluateOnNewDocument((v) => {
    const stt = { usage: 0, providerList: 0, credentialScan: 0, log: [] };
    const orig = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } }));
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") === -1) return orig.apply(this, arguments);
      if (method === "POST") {
        let b = {};
        try { b = JSON.parse((init && init.body) || "{}"); } catch (e) { b = {}; }
        stt.log.push(b.action || (b.patch ? "patch" : "?"));
        if (b.action === "usage") {
          stt.usage++;
          return json({
            ok: true,
            usage: { today: { credit: 1.5, requests: 3 }, totalCredit: 42, totalRequests: 90, since: Date.now() - 86400000, turns: [] },
            bridge: { enabled: true, running: true, port: 3901, lastError: null },
            quota: { numericQuota: true, resource: { totalRemain: 1879.5, cycleRemain: 1200.25, cycleSize: 2000, cycleUsed: 799.75, packs: [] }, account: { nickname: "mock" } },
          });
        }
        if (b.action === "provider-list") { stt.providerList++; return json({ ok: true, providers: [{ id: "ark", displayName: "火山方舟", modelCount: 3, maskedKey: "x…y", keyRef: "ARK_API_KEY", baseURL: "https://ark.cn-hangzhou.volces.com/api/v3" }], presets: [] }); }
        if (b.action === "credential-scan") { stt.credentialScan++; return json({ ok: true, findings: [] }); }
        return json({ ok: true, value: v.value, user: {} });
      }
      return json(JSON.parse(JSON.stringify(v)));
    };
    window.__genProbe = stt;
  }, realView5));
  const page5 = f1.page;
  const pageErrors5 = f1.errors;
  check("[F1] mock 通道可开", f1.opened);

  let gen = await page5.evaluate(() => window.__genProbe);
  check("[F1] 挂载即取样：usage 与 provider-list 各恰好一次",
    gen.usage === 1 && gen.providerList === 1, JSON.stringify(gen.log));
  check("[F1] 挂载时不做本机凭据扫描（不上移）", gen.credentialScan === 0, JSON.stringify(gen.log));
  const genHead = await page5.evaluate(() =>
    ((document.querySelector('.cbc-acc[data-block=general] .cbc-acc-status') || {}).textContent || "").trim());
  check("[F2] 通用区块头显示额度与服务商数",
    /1200\.25|1,?200/.test(genHead) && /服务商 1/.test(genHead), JSON.stringify(genHead));
  await sleep(12000);
  gen = await page5.evaluate(() => window.__genProbe);
  check("[F3] 收起状态不轮询（12s 内 usage 仍为 1）", gen.usage === 1, JSON.stringify(gen.log));

  await openBlock(page5, "general"); await sleep(13000);
  gen = await page5.evaluate(() => window.__genProbe);
  check("[F4] 展开后进入 10s 轮询（usage ≥ 2）", gen.usage >= 2, JSON.stringify(gen.log));
  check("[F4] 展开时才做本机凭据扫描", gen.credentialScan === 1, JSON.stringify(gen.log));
  await openBlock(page5, "general"); await sleep(1500);
  const usageBefore = (await page5.evaluate(() => window.__genProbe)).usage;
  await sleep(12000);
  const usageAfter = (await page5.evaluate(() => window.__genProbe)).usage;
  check("[F5] 收起后停止轮询（12s 内无新增）", usageAfter === usageBefore,
    JSON.stringify({ usageBefore: usageBefore, usageAfter: usageAfter }));
  check("[F5] mock 通道 5 无 pageerror", pageErrors5.length === 0, pageErrors5.join(" | "));
  await page5.screenshot({ path: "shots/acc-task6-general.png" });
  await page5.close();

  // [F6] api-key 模式降级：无 numericQuota 时不编造数字
  const realView6 = await getView(page);
  const f6 = await newPage((pg) => pg.evaluateOnNewDocument((v) => {
    const orig = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } }));
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      if (url.indexOf("/dsh-tap/settings") === -1) return orig.apply(this, arguments);
      if (method === "POST") {
        let b = {};
        try { b = JSON.parse((init && init.body) || "{}"); } catch (e) { b = {}; }
        if (b.action === "usage") {
          return json({ ok: true, usage: { today: { credit: 0, requests: 0 }, totalCredit: 7, totalRequests: 2, since: Date.now(), turns: [] }, bridge: { enabled: true, running: true, port: 3901 }, quota: { numericQuota: false, error: "api-key 模式无数值额度" } });
        }
        if (b.action === "provider-list") return json({ ok: true, providers: [], presets: [] });
        if (b.action === "credential-scan") return json({ ok: true, findings: [] });
        return json({ ok: true, value: v.value, user: {} });
      }
      return json(JSON.parse(JSON.stringify(v)));
    };
  }, realView6));
  const page6 = f6.page;
  check("[F6] mock 通道可开", f6.opened);
  const genHead6 = await page6.evaluate(() =>
    ((document.querySelector('.cbc-acc[data-block=general] .cbc-acc-status') || {}).textContent || "").trim());
  check("[F6] api-key 模式头部标注「估算」且不编造数字",
    /估算/.test(genHead6) && !/credit/.test(genHead6.replace(/估算/g, "")), JSON.stringify(genHead6));
  await page6.close();
```

- [ ] **Step 2: 跑一次确认红**

Expected: `[F1]`–`[F6]` FAIL（挂载时没有取样，通用头部还是占位文案）。

- [ ] **Step 3: 卡片级一次性取样 + `generalText`**

在 `CodeBuddyCard` 里（`load` 之后）加：

```js
			// 通用区块头的「额度 / 服务商数」不在 GET 视图里（额度来自 action:'usage'、
			// 服务商数来自 provider-list）⇒ 卡片挂载时各取样一次（不轮询）；通用区块
			// 展开后才进入 UsageSection 自己的 10s 轮询。credential-scan 不上移——它扫
			// 本机文件，仍只在通用区块首次挂载时做。
			var genSampleState = useState(null);   // { text }
			var genSample = genSampleState[0];
			var setGenSample = genSampleState[1];
			useEffect(function () {
				var cancelled = false;
				Promise.all([
					post({ action: "usage" }).catch(function () { return null; }),
					post({ action: "provider-list" }).catch(function () { return null; }),
				]).then(function (res) {
					if (cancelled) return;
					setGenSample({ text: generalSummary(res[0], res[1]) });
				});
				return function () { cancelled = true; };
			}, []);
```

`blockStatus(data, null)` 调用处改为 `blockStatus(data, genSample ? genSample.text : null)`。

在 `blockStatus` 附近加纯函数：

```js
		// 通用区块头文案：额度（OAuth = 真实周期余量；api-key = 标注估算，不编数字）
		// + 服务商数。取样失败时回落到无数字文案，绝不显示假值。
		function generalSummary(usageRes, providersRes) {
			var parts = [];
			var q = usageRes && usageRes.ok ? usageRes.d && usageRes.d.quota : null;
			var u = usageRes && usageRes.ok ? usageRes.d && usageRes.d.usage : null;
			if (q && q.numericQuota && q.resource && q.resource.cycleRemain != null) {
				parts.push("额度 " + fmtCredit(q.resource.cycleRemain) + " credit");
			} else if (u && typeof u.totalCredit === "number") {
				parts.push("额度 估算（累计 " + fmtCredit(u.totalCredit) + "）");
			} else {
				parts.push("额度 —");
			}
			var list = providersRes && providersRes.ok && providersRes.d ? providersRes.d.providers : null;
			parts.push("服务商 " + (list ? list.length : "—"));
			return parts.join(" · ");
		}
```

**注意 `post()` 的返回形状**：现有 `post` 解析成 `{ok, status, d}`，所以取样读 `res.d.quota` / `res.d.providers`（上面代码已按此写）。

- [ ] **Step 4: 确认 `UsageSection` 的轮询条件已是"区块展开"**

Task 1 已把 `usage` 的 `active` 接到 `!!openBlocks.general`；本步只做核对：`UsageSection` 内 `useEffect(..., [active])` 在 `active === false` 时 `return undefined`（不设 interval），且分区**只在通用区块首次展开时才挂载** ⇒ `[F4]`/`[F5]` 的语义成立。若发现挂载即轮询（`active` 默认 `true`），改为 `props.active === true`。

- [ ] **Step 5: 跑回归确认绿**

Expected: 全部 ok（47 + 9 = 56 通过 / 0 失败）。注意 `[F3]`/`[F5]` 各含 12s 等待，整套耗时约 1 分钟。

- [ ] **Step 6: 哈希对账 + 提交**

```bash
md5sum ~/.dsh/codebuddy-plugin.json   # 必须与跑前一致
cd /c/Users/21613/dev/dsh-tap && git add lib/client.js
git commit -m "feat(client): 通用区块头挂载取样（额度/服务商数）+ 轮询严格随展开启停"
```

---

### Task 7: 存活断言移植 + 老套件退役

**Files:**
- Modify: `C:/Users/21613/dev/dsh-ui-test/card-accordion.js`（移植 `card-regression.js` 中仍然成立的断言）
- Delete: `C:/Users/21613/dev/dsh-ui-test/card-regression.js`
- Modify: `lib/client.js`（仅当移植断言暴露真缺陷时才改；无缺陷则本任务零代码改动）

**Interfaces:**
- Consumes: 前 6 个任务的全部 DOM 契约
- Produces: `card-accordion.js` 成为设置卡唯一回归套件（承接 `card-regression.js` 的全部仍然有效的不变式）

- [ ] **Step 1: 逐条移植（把 `card-regression.js` 里下列断言改选择器后追加到新套件）**

| 老断言（实测标签，共 14 组 28 条） | 移植后的选择器/做法 |
|---|---|
| `[1]` PM 入口可点 / 列出 dsh-tap 卡 + summary 行 | 新套件 `[0]` 已覆盖，补 summary 文案断言（`body.innerText` 含 `CodeBuddy / Trae / Qoder CN 通道`） |
| `[2]` 标签栏 8 标签齐全 | **作废**（标签栏退役）→ 由 `[A1]` 四区块顺序 + 标题断言接替 |
| `[3]` 注意条与预言机双向一致 | **作废**（注意条删除）→ 由 `[B1]`（无注意条）+ `[B2]`（状态行独立预言机双向对齐）+ `[B3]`（warn 落区块头）接替 |
| `[4]` 模型标签可点 / models 面板可见 + login 隐藏 | 已由 `[A3]`/`[A4]`/`[A5]` 覆盖（展开才挂载、收起隐藏、多开独立），跳过 |
| `[5]` 模型筛选（组标题计数 + 行全匹配） | 选择器换 `.cbc-acc-body[data-block=codebuddy] input[placeholder*="过滤"]`，组标题断言改查 `.cbc-group-title` 里「筛选命中 N（可用 x / 未启用 y）」 |
| `[6]` 幽灵输入存在（`input[aria-label*="上限"]`） | 选择器前缀换 `.cbc-acc-body[data-block=codebuddy]` |
| `[7]` HelpNote 折叠 / 展开 / 再收起 | 选择器换 `.cbc-acc-body[data-block=codebuddy] details.cbc-help summary` |
| `[8]` 用量刷新按钮 + 「更新于 HH:MM:SS」时间戳 | 用 `newPage()` 的独立页面（不要复用 `page`——`[G1]` 依赖 general 区块处于收起态），`ensureOpen(pg,'general')` 后查 `.cbc-acc-body[data-block=general]` 内的刷新按钮与 `.cbc-updated` 文案 |
| `[9]` 标签键盘导航（roving tabIndex / tabpanel / 方向键） | **删除**（tablist 已退役）；替换为区块头键盘断言：`.cbc-acc-toggle` 可 focus、`aria-expanded` 随 Enter 翻转、`aria-controls` 指向存在的 `#cbc-block-<id>` |
| `[10]` 浅色主题渲染 | `page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}])` 后重开卡截图，断言无 pageerror + 四区块仍在 |
| `[11]`/`[13]` 无 pageerror | 每个 mock 通道各自断言（`[B4]`/`[C3]`/`[F5]` 已有），真实视图阶段补一条 |
| `[12]` 启用+未监听 → warn 芯片带端口 | 已由 `[B3]` 覆盖（落到区块头），跳过 |
| `[14]` 保存后退避补拉自愈 | 已由 `[B4]` 覆盖，跳过 |

新区块头键盘断言代码：

```js
  // ---- [G] 区块头键盘可达性（接替老 [9] 的 tablist 断言）----
  const kb = await page.evaluate(() => {
    const t = document.querySelector('.cbc-acc-toggle[data-block=general]');
    if (!t) return null;
    t.focus();
    const before = t.getAttribute("aria-expanded");
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { focused: document.activeElement === t, before: before, controls: t.getAttribute("aria-controls") };
  });
  check("[G1] 区块头按钮可聚焦", !!kb && kb.focused, JSON.stringify(kb));
  check("[G1] 收起态 aria-expanded=false", !!kb && kb.before === "false", JSON.stringify(kb));
  await sleep(1500);
  const ctrlOk = await page.evaluate(() => {
    const t = document.querySelector('.cbc-acc-toggle[data-block=general]');
    const id = t && t.getAttribute("aria-controls");
    return { id: id, exists: !!id && !!document.getElementById(id), expanded: t && t.getAttribute("aria-expanded") };
  });
  check("[G1] aria-controls 指向真实存在的 body 且已翻转",
    ctrlOk.exists && ctrlOk.expanded === "true", JSON.stringify(ctrlOk));
  // 未挂载的区块不留空引用
  const dangling = await page.evaluate(() =>
    [...document.querySelectorAll(".cbc-acc-toggle")].filter((t) => {
      const id = t.getAttribute("aria-controls");
      return id && !document.getElementById(id);
    }).length);
  check("[G2] 无悬空 aria-controls", dangling === 0, "dangling=" + dangling);
```

- [ ] **Step 2: 跑新套件确认绿**

Expected: 全部 ok，退出码 0；记录总断言数（写进 Task 9 的 CHANGELOG 条目）。

- [ ] **Step 3: 删除老套件**

```bash
cd /c/Users/21613/dev/dsh-ui-test && rm card-regression.js && ls *.js
```

Expected: 列出 `card-accordion.js`、`debug-dom.js`、`debug-inputs.js`、`qoder-e2e.js`、`qoder-prefs-check.js`、`qoder-slot-check.js`、`qoder-tab-phase2.js`、`shots-baseline.js`。

- [ ] **Step 4: 提交（仅当本任务改了 `lib/client.js`）**

```bash
cd /c/Users/21613/dev/dsh-tap && git status --short
# 有改动才提交：
git add lib/client.js && git commit -m "fix(client): 回归移植暴露的缺陷修复"
```

（`dsh-ui-test/` 的改动不进 git；若本任务未改仓库文件，则无提交。）

---

### Task 8: 其余浏览器脚本适配 + 截图基线重拍

**Files:**
- Modify: `C:/Users/21613/dev/dsh-ui-test/qoder-slot-check.js`（10 断言）、`qoder-e2e.js`（8）、`qoder-prefs-check.js`（32）、`qoder-tab-phase2.js`（8）、`shots-baseline.js`
- Modify: `lib/client.js`（仅当适配暴露真缺陷）

**Interfaces:**
- Consumes: Task 1–6 的 DOM 契约（`.cbc-acc[data-block]`、`.cbc-acc-toggle[data-block]`、`.cbc-acc-body[data-block]`、`.cbc-syncbar`、`details.cbc-adv`、`.cbc-acc-head input[data-field]`）
- Produces: 全部脚本跑绿的证据（写进 Task 9 的 CHANGELOG）

- [ ] **Step 1: 统一驱动改法（每个脚本同一套替换）**

| 老写法 | 新写法 |
|---|---|
| `[...document.querySelectorAll(".cbc-tab")].find(t => t.textContent.includes("Qoder CN")).click()` | `document.querySelector('.cbc-acc-toggle[data-block=qoder]').click()` |
| `document.querySelector('.cbc-panel[data-tab=qoder] …')` | `document.querySelector('.cbc-acc-body[data-block=qoder] …')` |
| `.cbc-panel[data-tab=models]` | `.cbc-acc-body[data-block=codebuddy]` |
| `.cbc-panel[data-tab=usage]` / `[data-tab=providers]` | `.cbc-acc-body[data-block=general]` |
| `.cbc-panel[data-tab=bridge]` | `.cbc-acc-body[data-block=codebuddy]`（网关组） |
| 「Qoder CN 标签」相关文案断言 | 改为「Qoder CN 区块」；`qoder-tab-phase2.js` 的「启用开关」断言改查 `.cbc-acc-head input[data-field=qoderEnabled]` |
| 「连接域名」折叠组（`cbc-toggle` 按钮点开） | `details.cbc-adv` 的 `summary`（点开方式：`d.open = true` 或 `summary.click()`） |
| 模型组两个按钮（刷新列表 / 立即同步） | 单按钮「同步目录」（在 `.cbc-syncbar` 内） |

- [ ] **Step 2: 逐脚本跑绿**

```bash
cd /c/Users/21613/dev/dsh-ui-test
node qoder-slot-check.js "http://127.0.0.1:3080/?token=<TOKEN>"
node qoder-prefs-check.js "http://127.0.0.1:3080/?token=<TOKEN>"
node qoder-tab-phase2.js "http://127.0.0.1:3080/?token=<TOKEN>"
node qoder-e2e.js "http://127.0.0.1:3080/?token=<TOKEN>"
```

Expected: 四个脚本各自 `0 失败`，退出码 0。`qoder-e2e.js` 会真实发消息（消耗额度）——若不希望消耗，跳过并在 CHANGELOG 注明"e2e 未跑（额度考虑）"，其余三个必须绿。

- [ ] **Step 3: 重拍明暗基线**

```bash
cd /c/Users/21613/dev/dsh-ui-test && node shots-baseline.js "http://127.0.0.1:3080/?token=<TOKEN>" acc
ls shots/ | grep '^acc' | head -20
```

`shots-baseline.js` 顶部有 `const TABS = ["登录","模型","额度与用量","工具","服务商","TraeWork CN","Qoder CN","桥与高级"];`（实测现状）——改为四区块驱动：把 `TABS` 换成 `const BLOCKS = ["codebuddy","trae","qoder","general"];`，逐个点 `.cbc-acc-toggle[data-block=<id>]` 展开后截图。第二个参数 `acc` 是脚本已有的 out-prefix，实测命名规则为 `shots/<OUT>-<NN>-<名称>.png` ⇒ 输出 `shots/acc-00-overview.png`、`shots/acc-01-codebuddy.png` … `shots/acc-04-general.png`；暗色由脚本现有的 `document.body.setAttribute("data-ds-dark-theme","true")` 切换，收尾图 `shots/acc-dark-active-tab.png`。

- [ ] **Step 4: 人工核验截图**

用 Read 工具看 `shots/acc-01-codebuddy.png` 与 `shots/acc-04-general.png`（以及 `shots/acc-dark-active-tab.png`）：确认区块头状态行不溢出、幽灵输入边框在 hover/focus 才出现、`details.cbc-adv` 折叠标记正常、浅色主题下无不可读对比。发现问题回到对应任务修（不要在此任务里堆积 UI 修改）。

- [ ] **Step 5: 提交（仅当改了 `lib/client.js`）**

```bash
cd /c/Users/21613/dev/dsh-tap && git status --short && git add lib/client.js \
  && git commit -m "fix(client): 脚本适配暴露的缺陷修复"
```

---

### Task 9: 文档、版本与全量回归

**Files:**
- Modify: `wiki/07-web-client.md`（重写"卡片结构"与"改 UI 后的回归"两节）、`AGENTS.md`（架构表 `lib/client.js` 行）、`CHANGELOG.md`（新增 0.10.0 段）、`package.json`（version）
- Modify: `docs/goals/settings-card-ux-redesign.md`（状态行改为"已实施"，附实测结论）

**Interfaces:**
- Consumes: Task 1–8 的实测结果（断言数、脚本清单、截图名）
- Produces: 0.10.0 发版所需的文档一致性

- [ ] **Step 1: 重写 `wiki/07-web-client.md` 的"卡片结构"节**

把"状态芯片 + 8 标签页"整节换成通道手风琴的描述（4 区块、区块头状态行 = 单一真源、展开才挂载/收起不卸载、通道内 5 分组、`details.cbc-adv` 与 `details.cbc-help` 的分工、通用区块头挂载取样与轮询条件）。保留"请求契约"与"React 纪律"两节，并在纪律节补一条：**区块头是 `div` + 两个独立交互元素（展开 button + 启用开关），不要把开关嵌进 button**。

- [ ] **Step 2: 修掉文档漂移并写清回归驱动**

同文件"改 UI 后的回归"节：删掉不存在的 `window.__cbc.tab('分区名')` 说法（实测 `lib/client.js` 与 `dsh-ui-test/*.js` 均无此钩子），改为实测驱动方式：

```
驱动 = 点 `.cbc-acc-toggle[data-block=<id>]` 展开区块，再查 `.cbc-acc-body[data-block=<id>]` 内的行/控件。
选择器清单：.cbc-acc[data-block] / .cbc-acc.cbc-open / .cbc-acc-toggle / .cbc-acc-title /
.cbc-acc-status / .cbc-acc-body / .cbc-acc-head input.cbc-check[data-field] / .cbc-syncbar /
details.cbc-adv（高级组）/ details.cbc-help（使用说明）。
套件：card-accordion.js（设置卡唯一套件，N 断言）、qoder-slot-check.js、qoder-prefs-check.js、
qoder-tab-phase2.js、qoder-e2e.js、shots-baseline.js、debug-dom.js/debug-inputs.js。
跑法：dsh 入口 /c/Users/21613/dev/dsh-launcher/node_modules/.bin/dsh web（token 见启动行）；
profile ~/.dsh/profiles/web 已 link 本仓库 ⇒ 改 lib/client.js 刷新页面即生效；跑后按 PID 杀 3080。
```

（`N` 用 Task 7 Step 2 记录的真实数字。）

- [ ] **Step 3: 更新 `AGENTS.md`**

架构表"浏览器半 `lib/client.js`"那一行的职责描述：把"折叠态状态芯片 + 8 标签页懒挂载隐藏不卸载"改为"4 区块通道手风琴（区块头常显状态行 = 单一真源）+ 展开才挂载/收起不卸载"。踩坑速查节**不新增条目**（本轮无新坑；若实施中真踩到新坑，按纪律取新编号追加到 `docs/pitfalls.md` 并在此加一行）。

- [ ] **Step 4: 写 `CHANGELOG.md` 0.10.0 段**

按仓库既有风格（驱动 → 逐条改 → 验证）写：用户"交互有点麻烦、不够简单"驱动；痛点定位 = 找不到/太散；4 区块手风琴取代 8 标签；删三套状态展示；模型组同构（同步目录单按钮 + 统一筛选）；Trae/Qoder 启用开关上移区块头；通用区块头挂载取样 + api-key 估算降级；工程项收进 `details.cbc-adv`；后端契约零变化。验证段填实测数字：`card-accordion.js` N 断言全绿、`qoder-slot-check` / `qoder-prefs-check` / `qoder-tab-phase2` 各自断言数与结果、离线七套件全绿、截图基线重拍。

- [ ] **Step 5: 版本号与设计文档状态**

```bash
cd /c/Users/21613/dev/dsh-tap
node -e "const f='package.json',j=require('./'+f);j.version='0.10.0';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
grep -n '"version"' package.json
```

Expected: `"version": "0.10.0"`。再把 `docs/goals/settings-card-ux-redesign.md` 头部状态行改为"已实施（0.10.0，2026-09-23）"，并把标题的"（待评审）"去掉。

- [ ] **Step 6: 全量离线回归**

```bash
cd /c/Users/21613/dev/dsh-tap
npm run verify:bridge && npm run verify:core && npm run verify:providers \
  && npm run verify:trae-provider && npm run verify:qoder && npm run verify:host-config \
  && node scripts/verify-models.mjs --list
```

Expected: 七个命令全部退出码 0（纯前端改动，预期零影响；任何一个红都说明误改了宿主半）。

- [ ] **Step 7: 在线探测（可选，取决于凭据）**

```bash
cd /c/Users/21613/dev/dsh-tap && npm run verify
```

Expected: 18/18（需 `CODEBUDDY_API_KEY` 或已登录 OAuth）。若环境无凭据导致失败，**如实记录跳过原因**到 CHANGELOG 验证段，不得声称通过。

- [ ] **Step 8: 杀掉测试服务**

```bash
netstat -ano | grep ':3080' | head -3     # 取 PID
taskkill //PID <PID> //F
netstat -ano | grep ':3080' | head -1     # 确认已释放（无输出）
```

- [ ] **Step 9: 提交**

```bash
cd /c/Users/21613/dev/dsh-tap
git add package.json CHANGELOG.md AGENTS.md wiki/07-web-client.md docs/goals/settings-card-ux-redesign.md
git status --short
git commit -m "feat(client)!: 设置卡改通道手风琴（v0.10.0）——4 区块取代 8 标签，状态收敛到区块头"
```

（提交前用 `git status --short` 复核暂存内容，确认没有误加 `docs/probes/`、`node_modules/` 或凭据文件。）

---

## Self-Review（作者自查，已执行）

**1. Spec 覆盖**（逐条对 `docs/goals/settings-card-ux-redesign.md`）：

| Spec 条目 | 任务 |
|---|---|
| §3 顶层 4 区块 + 固定顺序 + 默认全收 | Task 1 |
| §3 状态行真源（沿用 `buildChips`、删 `tabBadge`） | Task 1（`blockStatus`）+ Task 2（去前缀、删 `tab`/`tabTitle`） |
| §3 通用区块头取样 + api-key 降级 + `credential-scan` 不上移 | Task 6 |
| §3 删注意条/折叠三芯片/标签徽标；旧槽按需单芯片 | Task 2 |
| §3 硬修复清单 11 条（`settleGateways`/`fetchWithTimeout`/`PanelBoundary`/同步开窗/图标候选/幽灵输入/同值去重/模块级编辑器/`e.message`/脱敏/失焦即保存） | 贯穿 Task 1–6；`settleGateways` 由 `[B4]` 锁定，`PanelBoundary` 粒度在 Task 1 Step 6e，同值去重与模块级编辑器为"不动即保留"（Task 3/5 明确沿用） |
| §4 通道内 5 分组 + `details.cbc-adv` | Task 4 |
| §4 模型组同构（同步合并 + 三家筛选） | Task 5 |
| §4 区块头开关（Trae/Qoder 唯一落点） | Task 3 |
| §4 保存提示落到触发保存的区块头 | Task 1 Step 6c/6d（`saveIn`/`saved.block`） |
| §4 轮询条件改"区块展开" | Task 1（接线）+ Task 6（`[F3]`–`[F5]` 锁定） |
| §4 键盘/ARIA（删 tablist、区块头普通 button） | Task 1（删）+ Task 7（`[G1]`/`[G2]` 新断言） |
| §5 31 字段落点 | Task 3/4/5 的搬迁步骤逐字段点名；Task 9 Step 1 的 wiki 重写复核 |
| §6 回归脚本适配 + 老套件退役 | Task 7 + Task 8 |
| §6 文档修正（`__cbc.tab` 漂移） | Task 9 Step 2 |
| §7 实施顺序 ①–④ | Task 1–2 = ①，Task 3–6 = ②，Task 7–8 = ③，Task 9 = ④ |
| §8 风险（头部开关误触回退方案） | Task 3 的 `control` 槽是单一改动点，回退 = 把 `channelSwitch` 挪进分区首行 |
| §9 验收标准 | Task 7 Step 2 / Task 8 Step 2 / Task 9 Step 6–7 |

**2. 占位符扫描**：无 TBD/TODO；Task 4 Step 4 的 `/* … */` 是"原样剪切现有行"的明确指令（附了源行号与"不改字段/文案/ResetButton"的约束），不是待填内容。

**3. 类型/命名一致性**：`BLOCK_DEFS`/`BLOCK_SECTIONS`/`SECTION_RENDERERS`/`blockStatus`/`worstTone`/`BlockHead`/`toggleBlock`/`openBlocks`/`mountedBlocks`/`saved`/`saveIn`/`channelSwitch`/`generalSummary`/`attentionCount` 在定义处与使用处同名；DOM 契约（`.cbc-acc*`/`.cbc-syncbar`/`details.cbc-adv`/`data-field`）在 Task 1/3/4/5 的定义与 Task 1–8 的断言中一致；`post()` 返回 `{ok,status,d}` 的形状在 Task 6 Step 3 显式提醒。

**4. 已知取舍**：Task 1 结束到 Task 2 之间，区块头状态行会短暂带品牌前缀（"Trae 未启用"）——因为 `strip` 还在用带前缀的文案；Task 2 一并清理。这是有意的中间态，不是遗漏。
