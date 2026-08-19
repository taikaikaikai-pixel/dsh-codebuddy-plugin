/**
 * Browser half of dsh-codebuddy-plugin: a settings card in
 * Settings → 插件配置, in seven sections (登录 / 额度与用量 / 模型 /
 * 网络搜索与抓取 / 图像生成 / 流式桥 / 高级) — login first, because every
 * other feature keys off the credential.
 * Talks to the host route /dsh-codebuddy-plugin/settings:
 *   GET  → { value, user, fields, oauth, bridge, models }
 *   POST → { patch } | { action: 'oauth-start'|'oauth-status'|'oauth-logout'|'model-list'|'usage' }
 *   ('usage' → { usage, bridge, quota }: live consumption metered by the
 *   bridge from the gateway's per-request usage.credit, plus the account-side
 *   quota signals the credentials can reach — /v2/accounts + dosage banner.)
 *
 * Loaded by the dsh web client module loader via package.json
 * exports["./client"]. No build step: plain React.createElement.
 *
 * Host resources this module reuses (see AGENTS.md):
 * - `@deepseek-ai/dsh-client-ui-primitives` (Button/Input/icons) — a
 *   platform seed module, require()'d with a native-element fallback so the
 *   card still renders if the primitives table ever goes missing.
 * - The `--dsw-alias-*` design tokens (never hard-coded colors; dark theme
 *   follows automatically via body[data-ds-dark-theme]). Two token names do
 *   NOT exist upstream (`--dsw-alias-accent`, `--dsw-alias-label-error`) —
 *   use state-business-primary / state-error-primary instead.
 * - Styling follows the host's own protocol: one injected
 *   <style data-plugin="dsh-codebuddy-plugin" data-plugin-css="card"> block,
 *   cbc- prefixed classes, values mirrored from the first-party PluginCard
 *   (border-l2, bg-layer-3 → open bg-layer-2, radius 12, padding 14/16).
 *
 * House rules (hard-won, see AGENTS.md): all hooks before any conditional
 * return; window.open must fire synchronously inside the click handler or
 * popup blockers eat it; controlled checkboxes can fire change twice —
 * debounce writes.
 */
window.__ModuleLoader__.load({
	id: "dsh-codebuddy-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var createElement = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;

		// Platform primitives are a seed module; require defensively anyway —
		// a missing table must degrade to native elements, not a dead card.
		var ui = null;
		try { ui = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { ui = null; }
		var UIButton = ui && ui.Button ? ui.Button : null;
		var UIInput = ui && ui.Input ? ui.Input : null;
		var IconChevron = ui && ui.IconChevronDownOutline14 ? ui.IconChevronDownOutline14 : null;
		var IconRefresh = ui && ui.IconRefreshOutline14 ? ui.IconRefreshOutline14 : null;

		var ROUTE = "/dsh-codebuddy-plugin/settings";

		// ------------------------------------------------------------------
		// Styles: one injected block, cbc- prefixed, token-backed. Idempotent.
		// ------------------------------------------------------------------
		var CSS_TEXT = [
			".cbc-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);list-style:none;transition:border-color .16s}",
			".cbc-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.5))}",
			".cbc-card.cbc-open{background:var(--dsw-alias-bg-layer-2,#fff)}",
			".cbc-header{all:unset;display:flex;width:100%;box-sizing:border-box;padding:14px 16px;cursor:pointer;align-items:center;justify-content:space-between;gap:12px;border-radius:12px}",
			".cbc-header:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#1a66ff);outline-offset:-2px}",
			".cbc-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-desc{font-size:13px;color:var(--dsw-alias-label-tertiary,gray);margin-top:2px}",
			".cbc-chevron{display:inline-flex;color:var(--dsw-alias-label-tertiary,gray);font-size:12px;transition:transform .16s}",
			".cbc-chevron.cbc-open{transform:rotate(180deg)}",
			".cbc-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));margin:0 16px;padding:4px 0 12px;display:flex;flex-direction:column}",
			".cbc-section{padding:10px 0}",
			".cbc-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);margin:0 0 10px}",
			".cbc-divider{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));margin:4px 0}",
			".cbc-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}",
			".cbc-row-label{flex:0 0 132px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-row-control{flex:1;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
			".cbc-check{width:16px;height:16px;flex:0 0 auto;accent-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);margin:4px 0 6px;line-height:1.5}",
			".cbc-status{font-size:12px;color:var(--dsw-alias-label-tertiary,gray);line-height:1.5}",
			".cbc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid rgba(211,51,51,.35);border-radius:8px;padding:6px 10px;margin:6px 0}",
			".cbc-error-close{all:unset;cursor:pointer;font-size:13px;padding:0 4px;color:inherit;display:inline-flex}",
			".cbc-listrow{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin-bottom:6px;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".cbc-cell-name{font-weight:600;min-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-cell-masked{color:var(--dsw-alias-label-tertiary,gray);flex:1;font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".cbc-badge{font-size:11px;color:var(--dsw-alias-state-success-primary,#2a9d4a);border:1px solid rgba(42,157,74,.35);border-radius:4px;padding:1px 4px;white-space:nowrap;flex:0 0 auto}",
			".cbc-effort{font-size:11px;color:var(--dsw-alias-label-tertiary,gray);font-family:var(--ds-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".cbc-model-name{font-weight:600;flex:0 1 auto;min-width:90px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-model-ctx{font-size:11px;font-family:var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-tertiary,gray);white-space:nowrap;flex:0 0 auto}",
			".cbc-radio{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit)}",
			".cbc-radio input{accent-color:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".cbc-muted{color:var(--dsw-alias-label-tertiary,gray);font-size:12px}",
			".cbc-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,gray);margin:10px 0 6px}",
			".cbc-addrow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}",
			".cbc-w110{width:110px}.cbc-w140{width:140px}.cbc-w200{width:200px}.cbc-w220{width:220px}.cbc-w260{width:260px}.cbc-wfull{width:100%}",
			".cbc-danger{color:var(--dsw-alias-state-error-primary,#d33)!important}",
			".cbc-select{font:inherit;font-size:13px;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-input{font:inherit;font-size:13px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#1a66ff);outline:none}",
			".cbc-btn{all:unset;display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:4px 10px;border-radius:14px;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}",
			".cbc-btn-outline{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4))}",
			".cbc-btn-primary{background:var(--dsw-alias-button-primary-fill,#1a66ff);color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".cbc-btn:disabled{cursor:not-allowed;opacity:.4}",
			".cbc-scrollbox{max-height:300px;overflow-y:auto}",
			".cbc-link{color:var(--dsw-alias-state-business-primary,#1a66ff);text-decoration:none}",
			".cbc-link:hover{text-decoration:underline}",
			".cbc-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b80);line-height:1.5;margin:4px 0}",
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-codebuddy-plugin-card"]')) return;
			var el = document.createElement("style");
			// Host protocol: data-plugin / data-plugin-css let the module loader
			// attribute (and hot-clean) injected styles per plugin.
			el.setAttribute("data-plugin", "dsh-codebuddy-plugin");
			el.setAttribute("data-plugin-css", "dsh-codebuddy-plugin-card");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}
		ensureStyles();

		// ------------------------------------------------------------------
		// Control adapters: primitives when available, native fallback when not.
		// ------------------------------------------------------------------
		function CbcButton(props) {
			if (UIButton) {
				return createElement(UIButton, {
					variant: props.variant || "outline",
					size: "sm",
					icon: props.icon || undefined,
					className: props.danger ? "cbc-danger" : undefined,
					type: "button",
					title: props.title,
					disabled: props.disabled,
					onClick: props.onClick,
				}, props.children);
			}
			return createElement("button", {
				type: "button",
				className: "cbc-btn cbc-btn-" + (props.variant || "outline") + (props.danger ? " cbc-danger" : ""),
				title: props.title,
				disabled: props.disabled,
				onClick: props.onClick,
			}, props.icon || null, props.children);
		}

		function CbcInput(props) {
			var w = props.widthClass || "cbc-wfull";
			var shared = {
				type: props.type || "text",
				value: props.value,
				placeholder: props.placeholder,
				onInput: props.onInput,
				onBlur: props.onBlur,
				onKeyDown: props.onKeyDown,
			};
			if (UIInput) return createElement(UIInput, Object.assign({ className: w }, shared));
			return createElement("input", Object.assign({ className: "cbc-input " + w }, shared));
		}

		function fmtTime(ms) {
			if (!ms) return "";
			var d = new Date(ms);
			var p = function (n) { return n < 10 ? "0" + n : "" + n; };
			return (d.getMonth() + 1) + "-" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		// ctx 数字缩写（1000000 → "1000k"）：模型行宽有限，给思考档位让出空间。
		function fmtCtx(n) {
			if (n == null) return "?";
			return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
		}

		function CodeBuddyCard(props) {
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var dataState = useState(null);
			var data = dataState[0];
			var setData = dataState[1];
			var errState = useState("");
			var err = errState[0];
			var setErr = errState[1];

			var load = function () {
				fetch(ROUTE, { headers: { accept: "application/json" } })
					.then(function (r) {
						// Tolerate a non-JSON error page instead of dying in the
						// parser and misreporting it as a network failure.
						return r.text().then(function (t) {
						var d = null;
						try { d = JSON.parse(t); } catch (e) { /* not JSON */ }
						if (d == null) throw new Error("设置服务返回了非 JSON（HTTP " + r.status + "）");
						return d;
						});
					})
					.then(function (d) { setData(d); setErr(""); })
					.catch(function (e) { setErr(e && e.message ? e.message : "设置服务不可达"); });
			};
			useEffect(function () {
				if (!open) return undefined;
				load();
				return undefined;
			}, [open]);

			var post = function (body) {
				return fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}).then(function (r) {
					return r.text().then(function (t) {
						var d = null;
						try { d = JSON.parse(t); } catch (e) { /* not JSON */ }
						return { ok: r.ok, status: r.status, d: d || {} };
					});
				});
			};
			var save = function (patch) {
				post({ patch: patch }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "保存失败（HTTP " + res.status + "）"); return; }
					load();
				}).catch(function () { setErr("保存失败（网络）"); });
			};

			var chevron = IconChevron
				? createElement("span", { className: "cbc-chevron" + (open ? " cbc-open" : "") }, createElement(IconChevron, { size: 14 }))
				: createElement("span", { className: "cbc-chevron" + (open ? " cbc-open" : "") }, "▾");
			var header = createElement(
				"button",
				{ type: "button", className: "cbc-header", "aria-expanded": open ? "true" : "false", onClick: function () { setOpen(!open); } },
				createElement("span", null,
					createElement("div", { className: "cbc-name" }, "CodeBuddy"),
					createElement("div", { className: "cbc-desc" }, "登录凭据、模型启停、搜索后端与流式桥（copilot.tencent.com）。")),
				chevron,
			);
			var cardClass = "cbc-card" + (open ? " cbc-open" : "");
			if (!open) return createElement("li", { className: cardClass }, header);
			if (!data) {
				return createElement("li", { className: cardClass }, header,
					createElement("div", { className: "cbc-body" }, createElement("p", { className: "cbc-status" }, err || "正在读取设置…")));
			}

			var value = data.value || {};
			var user = data.user || {};
			var oauth = data.oauth || {};
			var modelsInfo = data.models || {};
			var overridden = function (k) { return Object.prototype.hasOwnProperty.call(user, k); };

			// 顶部功能概览：数字全部来自宿主实时视图，不硬编码。
			var loginLabel = value.authMode === "oauth"
				? (oauth.signedIn ? "OAuth 已登录" : "OAuth 未登录")
				: "API Key" + (value.activeApiKey ? "（" + value.activeApiKey + "）" : "");
			var summary = createElement("p", { className: "cbc-status" },
				"可用模型：" + (modelsInfo.effectiveCount != null ? modelsInfo.effectiveCount : "?") + " 个 · 登录：" + loginLabel +
				" · 搜索后端：" + (value.searchEnabled === true ? "已启用" : "已禁用") +
				" · 流式桥：" + (value.bridgeEnabled === true ? "已启用（:" + value.bridgePort + "）" : "已禁用"));

			var errorBanner = err
				? createElement("p", { className: "cbc-error" },
					createElement("span", null, err),
					createElement("button", { type: "button", className: "cbc-error-close", title: "关闭", onClick: function () { setErr(""); } }, "✕"))
				: null;

			return createElement("li", { className: cardClass }, header,
				createElement("div", { className: "cbc-body" },
					errorBanner,
					summary,
					createElement("hr", { className: "cbc-divider" }),
					createElement(LoginSection, { value: value, oauth: oauth, save: save, post: post, reload: load, setErr: setErr, overridden: overridden }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(UsageSection, { post: post }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(ModelsSection, { post: post, setErr: setErr, reload: load }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(SearchSection, { value: value, save: save, overridden: overridden }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(ImageGenSection, { value: value, save: save, overridden: overridden }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(BridgeSection, { value: value, save: save, overridden: overridden }),
					createElement("hr", { className: "cbc-divider" }),
					createElement(AdvancedSection, { value: value, save: save, overridden: overridden }),
					createElement("p", { className: "cbc-status" }, "修改即保存（写入 ~/.dsh/codebuddy-plugin.json），立即生效；标\u201C重置\u201D的字段可一键恢复默认值。")));
		}

		// --- 登录：模式选择 + 多 API Key + OAuth（一切功能的前提，排第一） --------
		function LoginSection(props) {
			var value = props.value;
			var oauth = props.oauth;
			var save = props.save;
			var post = props.post;
			var reload = props.reload;
			var setErr = props.setErr;

			var addNameState = useState("");
			var addName = addNameState[0];
			var setAddName = addNameState[1];
			var addKeyState = useState("");
			var addKey = addKeyState[0];
			var setAddKey = addKeyState[1];
			var oauthBusyState = useState(false);
			var oauthBusy = oauthBusyState[0];
			var setOauthBusy = oauthBusyState[1];

			// While a login handshake is pending, poll its status.
			useEffect(function () {
				if (!oauth.pending) return undefined;
				var timer = setInterval(function () {
					post({ action: "oauth-status" }).then(function (res) {
						if (res.ok && res.d.oauth && !res.d.oauth.pending) reload();
					}).catch(function () {});
				}, 3000);
				return function () { clearInterval(timer); };
			}, [oauth.pending]);

			var modeRow = createElement("div", { className: "cbc-row" },
				createElement("div", { className: "cbc-row-label" }, "登录方式"),
				createElement("div", { className: "cbc-row-control" },
					createElement("label", { className: "cbc-radio" },
						createElement("input", { type: "radio", checked: value.authMode !== "oauth", onChange: function () { save({ authMode: "api-key" }); } }),
						"API Key"),
					createElement("label", { className: "cbc-radio" },
						createElement("input", { type: "radio", checked: value.authMode === "oauth", onChange: function () { save({ authMode: "oauth" }); } }),
						"OAuth 登录")));

			var body;
			if (value.authMode === "oauth") {
				var parts = [];
				if (oauth.signedIn) {
					var acct = oauth.account || {};
					parts.push(createElement("p", { key: "acct", className: "cbc-status" },
						"已登录：" + (acct.nickname || acct.uid || "未知账号"),
						acct.enterpriseName ? "（" + acct.enterpriseName + "）" : "",
						oauth.accessTokenExpiresAt ? "，令牌到期 " + fmtTime(oauth.accessTokenExpiresAt) : ""));
					parts.push(createElement("p", { key: "scope", className: "cbc-hint" },
						"此登录覆盖模型对话（主聊天经流式桥统一取凭据）、网络搜索与抓取。"));
					parts.push(createElement("div", { key: "out", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "outline", danger: true, onClick: function () { post({ action: "oauth-logout" }).then(reload); } }, "退出登录")));
				} else if (oauth.pending) {
					parts.push(createElement("p", { key: "pend", className: "cbc-status" }, "等待浏览器完成登录…（3 秒轮询，完成后自动刷新）"));
					parts.push(createElement("div", { key: "url", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "outline", onClick: function () { window.open(oauth.authUrl, "_blank"); } }, "重新打开登录页")));
				} else {
					parts.push(createElement("div", { key: "start", className: "cbc-addrow" },
						createElement(CbcButton, { variant: "primary", disabled: oauthBusy, onClick: function () {
							// window.open must fire synchronously in the click
							// handler — an async one (after the fetch) is eaten
							// by popup blockers and the click looks dead.
							var win = window.open("", "_blank");
							setOauthBusy(true);
							post({ action: "oauth-start" }).then(function (res) {
								setOauthBusy(false);
								if (res.ok && res.d.authUrl) {
									if (win) win.location.href = res.d.authUrl;
									reload();
								} else {
									if (win) win.close();
									setErr(res.d && res.d.error ? res.d.error : "发起登录失败");
								}
							}).catch(function () { setOauthBusy(false); if (win) win.close(); setErr("发起登录失败（网络）"); });
						} }, oauthBusy ? "发起中…" : "登录 CodeBuddy 账号")));
				}
				if (oauth.error) parts.push(createElement("p", { key: "err", className: "cbc-error" }, oauth.error));
				body = parts;
			} else {
				// 使用中置顶，其余按名称字典序（仅展示层排序，不动存储顺序）。
				var sortedKeys = (value.apiKeys || []).slice().sort(function (a, b) {
					var wa = value.activeApiKey === a.name ? 0 : 1;
					var wb = value.activeApiKey === b.name ? 0 : 1;
					return wa - wb || String(a.name).localeCompare(String(b.name));
				});
				var rows = sortedKeys.map(function (k) {
					var isActive = value.activeApiKey === k.name;
					return createElement("div", { key: k.name, className: "cbc-listrow" },
						createElement("input", { type: "radio", className: "cbc-check", checked: isActive, onChange: function () { save({ activeApiKey: k.name }); }, title: "设为当前使用" }),
						createElement("span", { className: "cbc-cell-name", title: k.name }, k.name),
						createElement("span", { className: "cbc-cell-masked" }, k.masked),
						isActive ? createElement("span", { className: "cbc-badge" }, "使用中") : null,
						createElement(CbcButton, { variant: "ghost", danger: true, onClick: function () { post({ patch: { apiKeysRemove: k.name } }).then(reload); } }, "删除"));
				});
				body = rows.concat([
					createElement("div", { key: "add", className: "cbc-addrow" },
						createElement(CbcInput, { widthClass: "cbc-w140", placeholder: "名称（如 工作）", value: addName, onInput: function (e) { setAddName(e.target.value); } }),
						createElement(CbcInput, { widthClass: "cbc-w260", placeholder: "ck_…", value: addKey, onInput: function (e) { setAddKey(e.target.value); } }),
						createElement(CbcButton, { variant: "outline", onClick: function () {
							var name = addName.trim();
							var key = addKey.trim();
							if (!name || !key) { setErr("名称和 Key 都不能为空"); return; }
							post({ patch: { apiKeysAdd: { name: name, key: key } } }).then(function (res) {
								if (res.ok) { setAddName(""); setAddKey(""); reload(); }
								else setErr(res.d && res.d.error ? res.d.error : "添加失败");
							});
						} }, "添加")),
					createElement("div", { key: "env", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "环境变量引用"),
						createElement("div", { className: "cbc-row-control" },
							createElement(TextField, { fieldKey: "apiKeyEnv", value: value.apiKeyEnv, save: save, widthClass: "cbc-w220", overridden: props.overridden("apiKeyEnv") }))),
					createElement("div", { key: "cooldown", className: "cbc-row" },
						createElement("div", { className: "cbc-row-label" }, "失败冷却 (ms)"),
						createElement("div", { className: "cbc-row-control" },
							createElement(NumberField, { fieldKey: "keyCooldownMs", value: value.keyCooldownMs, save: save, overridden: props.overridden("keyCooldownMs") }))),
					createElement("p", { key: "hint", className: "cbc-hint" }, "多把 Key 时逐请求轮询；遇 401/403/429/5xx 或网络错误自动换下一把，失败 Key 冷却指定毫秒后自动回到轮换。单选仅决定模型目录拉取用的 Key；一个都不选时回落到环境变量引用（进程环境或 ~/.dsh/.credentials.yaml 中的同名条目）。"),
				]);
			}

			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "登录"),
				modeRow,
				body);
		}

		// --- 额度与用量：桥计量的消耗 + 账户侧额度信号（登录之后，排第二） --------
		// 消耗量来自桥对每请求 usage.credit 的计量（精确，本插件路径）；剩余额度
		// 网关无数字 API（probe-quota.mjs 实测），展示账户套餐与低额告警，数字以
		// 网页版 profile/plan 为准——额度是账户级的，与 WorkBuddy 共用。
		function UsageSection(props) {
			var post = props.post;
			var dataState = useState(null); // {usage, bridge, quota}
			var usageData = dataState[0];
			var setUsageData = dataState[1];
			var failState = useState("");
			var fail = failState[0];
			var setFail = failState[1];

			// 实时 = 分区可见期间 10s 轮询（先例：LoginSection 的 oauth-status）。
			useEffect(function () {
				var stop = false;
				var pull = function () {
					post({ action: "usage" }).then(function (res) {
						if (stop) return;
						if (res.ok) { setUsageData(res.d); setFail(""); }
						else setFail(res.d && res.d.error ? res.d.error : "用量读取失败");
					}).catch(function () { if (!stop) setFail("用量读取失败（网络）"); });
				};
				pull();
				var timer = setInterval(pull, 10000);
				return function () { stop = true; clearInterval(timer); };
			}, []);

			var KIND_LABEL = { chat: "对话", title: "标题", compaction: "压缩", image: "生图", search: "搜索", fetch: "抓取" };
			var fmtCredit = function (n) {
				if (n == null) return "-";
				return (Math.round(n * 100) / 100).toFixed(2);
			};
			var fmtHit = function (hit, miss) {
				var total = (hit || 0) + (miss || 0);
				if (!total) return "-";
				return Math.round((hit / total) * 100) + "%";
			};

			var usage = usageData && usageData.usage || null;
			var bridge = usageData && usageData.bridge || null;
			var quota = usageData && usageData.quota || null;

			var rows = [];

			// 账户与剩余额度（账户级，与 WorkBuddy 共用）。
			if (quota && quota.error) {
				rows.push(createElement("p", { key: "qerr", className: "cbc-status" }, "账户信息：" + quota.error));
			} else if (quota) {
				var acct = quota.account;
				if (acct) {
					rows.push(createElement("p", { key: "acct", className: "cbc-status" },
						"账户：" + (acct.nickname || "-"),
						acct.enterpriseName ? "（" + acct.enterpriseName + "）" : "",
						" · 套餐：" + (acct.type || "?")));
				}
				if (quota.dosage && quota.dosage.text) {
					rows.push(createElement("p", { key: "dosage", className: "cbc-warn" }, "额度告警：" + quota.dosage.text));
				}
			}
			rows.push(createElement("p", { key: "qlink", className: "cbc-hint" },
				"网关未开放数字剩余额度 API（CLI 面只有低额告警）；准确余额见 ",
				createElement("a", { className: "cbc-link", href: "https://www.codebuddy.cn/profile/plan", target: "_blank", rel: "noreferrer" }, "codebuddy.cn 套餐页"),
				"。额度为账户级，与 WorkBuddy 共用。"));

			// 消耗统计（本插件路径实测）。
			if (usage) {
				rows.push(createElement("p", { key: "totals", className: "cbc-status" },
					"今日消耗：" + fmtCredit(usage.today.credit) + " credit（" + usage.today.requests + " 请求）· 累计：",
					fmtCredit(usage.totalCredit) + " credit（" + usage.totalRequests + " 请求，自 " + fmtTime(usage.since) + "）"));
			}

			// 桥状态（EADDRINUSE 等失败在这里可见，不再静默崩溃）。
			if (bridge) {
				var bridgeText = !bridge.enabled
					? "已禁用（主聊天将直连失败，请保持启用）"
					: bridge.running
						? "运行中（127.0.0.1:" + bridge.port + "）"
						: "未监听（:" + bridge.port + " " + (bridge.lastError || "启动中") + "）" + (bridge.lastError === "EADDRINUSE" ? "——若占用者是另一个 dsh 实例，其桥仍会代管本实例流量" : "");
				rows.push(createElement("p", { key: "bridge", className: bridge.enabled && !bridge.running ? "cbc-warn" : "cbc-status" },
					"流式桥：" + bridgeText));
			}

			// 最近轮次（>45s 间隔聚类的近似口径）。
			if (usage && usage.turns && usage.turns.length) {
				rows.push(createElement("p", { key: "th", className: "cbc-group-title" }, "最近轮次（按间隔聚类，近似）"));
				usage.turns.forEach(function (t, i) {
					var kinds = t.kinds.map(function (k) { return KIND_LABEL[k] || k; }).join("+");
					rows.push(createElement("div", { key: "t" + i, className: "cbc-listrow" },
						createElement("span", { className: "cbc-model-ctx" }, fmtTime(t.start)),
						createElement("span", { className: "cbc-cell-name" }, fmtCredit(t.credit)),
						createElement("span", { className: "cbc-effort" }, "命中 " + fmtHit(t.hit, t.miss)),
						createElement("span", { className: "cbc-effort" }, t.requests + " 请求"),
						createElement("span", { className: "cbc-cell-masked" }, kinds + (t.models.length ? " · " + t.models.join("/") : ""))));
				});
			} else if (usage) {
				rows.push(createElement("p", { key: "empty", className: "cbc-hint" }, "还没有经过桥的计费请求。消耗数据来自流式桥与搜索/抓取/生图路径的网关 usage 自报。"));
			}
			if (fail) rows.push(createElement("p", { key: "fail", className: "cbc-error" }, fail));
			if (!usageData && !fail) rows.push(createElement("p", { key: "loading", className: "cbc-status" }, "正在读取用量…"));

			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "额度与用量"),
				rows);
		}

		// --- 模型：目录获取 + 逐模型启停（同步到对话选择器） ----------------------
		function ModelsSection(props) {
			var post = props.post;
			var setErr = props.setErr;
			var reload = props.reload;
			var dataState = useState(null); // {catalog, staticIds, state}
			var data = dataState[0];
			var setData = dataState[1];
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			var fetchList = function () {
				setBusy(true);
				post({ action: "model-list" }).then(function (res) {
					setBusy(false);
					if (res.ok) setData(res.d);
					else setErr(res.d && res.d.error ? res.d.error : "获取失败");
				}).catch(function () { setBusy(false); setErr("获取失败（网络）"); });
			};
			// 展开即自动拉取，不用先找按钮；拉不动（未登录）时错误走全局横幅。
			useEffect(function () { fetchList(); }, []);

			var lastToggle = {};
			var toggleModel = function (m, enabled) {
				// A checkbox can fire change twice for one interaction on a
				// controlled input; two toggles would cancel out.
				var now = Date.now();
				if (lastToggle[m.id] && now - lastToggle[m.id] < 400) return;
				lastToggle[m.id] = now;
				var staticIds = (data && data.staticIds) || [];
				var isStatic = staticIds.indexOf(m.id) >= 0;
				var payload = { id: m.id, enabled: enabled };
				if (enabled && !isStatic) {
					payload.profile = {
						id: m.id,
						name: m.name || m.id,
						contextWindow: m.maxInputTokens != null ? m.maxInputTokens : 262144,
						maxTokens: m.maxOutputTokens != null ? m.maxOutputTokens : 32768,
					};
					if (m.images) payload.profile.input = ["text", "image"];
				}
				post({ patch: { modelSetEnabled: payload } }).then(function (res) {
					if (!res.ok) { setErr(res.d && res.d.error ? res.d.error : "操作失败"); return; }
					if (res.d.models) {
						// settingsView ships disabled/extraIds as arrays; turn
						// them into lookup maps and keep the fetched catalog.
						var dis = {}; (res.d.models.disabled || []).forEach(function (id) { dis[id] = true; });
						var ext = {}; (res.d.models.extraIds || []).forEach(function (id) { ext[id] = true; });
						setData(function (prev) {
							return prev ? { catalog: prev.catalog, staticIds: prev.staticIds, staticEfforts: prev.staticEfforts, state: { disabled: dis, extra: ext } } : prev;
						});
					}
					reload(); // 概览行的可用模型数随 effectiveCount 刷新
				}).catch(function (e) { setErr("操作失败：" + (e && e.message ? e.message : String(e))); });
			};

			var body = null;
			if (data && data.catalog) {
				var disabledMap = ((data.state && data.state.disabled) || {});
				var extraMap = ((data.state && data.state.extra) || {});
				var staticIds = data.staticIds || [];
				// 合并目录与静态清单，按"在选择器里/不在"分两组，勾选语义统一：
				// 勾上 = 出现在对话模型选择器。
				var seen = {};
				var enabledRows = [];
				var inactiveRows = [];
				var makeRow = function (m, fromCatalog) {
					if (seen[m.id]) return;
					seen[m.id] = true;
					var isStatic = staticIds.indexOf(m.id) >= 0;
					var enabled = isStatic ? !disabledMap[m.id] : Boolean(extraMap[m.id]);
					// 思考档位：静态模型用 cordis.patch.yml 的 reasoningEfforts
					// 键名（off/low/medium/high/max），目录新增模型用目录
					// reasoning.effort（目录标注的默认档，非档位清单）。
					var effortText = null;
					if (isStatic) {
						var tiers = (data.staticEfforts || {})[m.id];
						if (tiers && tiers.length) effortText = tiers.join("/");
					} else if (typeof m.reasoningEffort === "string" && m.reasoningEffort) {
						effortText = "思考:" + m.reasoningEffort;
					}
					var row = createElement("div", { key: m.id, className: "cbc-listrow" },
						createElement("input", {
							type: "checkbox", className: "cbc-check", checked: enabled,
							title: enabled ? "从对话选择器移除" : "加入对话选择器",
							onChange: function (e) { toggleModel(m, e.target.checked); },
						}),
						createElement("span", { className: "cbc-model-name", title: m.id }, m.id),
						createElement("span", { className: "cbc-model-ctx", title: fromCatalog ? "上下文 " + m.maxInputTokens + " / 输出 " + m.maxOutputTokens : undefined },
							fromCatalog
								? ("ctx " + fmtCtx(m.maxInputTokens) + " / " + fmtCtx(m.maxOutputTokens))
								: "旧 id（目录已无）"),
						isStatic ? createElement("span", { className: "cbc-badge" }, "插件") : createElement("span", { className: "cbc-muted" }, "目录"),
						m.cli ? createElement("span", { className: "cbc-badge" }, "CLI") : null,
						m.images ? createElement("span", { className: "cbc-badge" }, "图") : null,
						effortText
							? createElement("span", { className: "cbc-effort", title: isStatic ? "思考档位（插件静态清单）" : "目录标注的思考强度" }, effortText)
							: (m.reasoning ? createElement("span", { className: "cbc-badge" }, "思考") : null));
					(enabled ? enabledRows : inactiveRows).push(row);
				};
				(data.catalog.models || []).forEach(function (m) { makeRow(m, true); });
				// 静态清单里目录没有的（旧 id）：目录对象无 ctx 数据
				staticIds.forEach(function (id) {
					if (seen[id]) return;
					makeRow({ id: id, name: id }, false);
				});
				body = createElement("div", { style: { marginTop: 8 } },
					createElement("div", { className: "cbc-scrollbox" },
						createElement("p", { className: "cbc-group-title" }, "当前可用（" + enabledRows.length + "）"),
						enabledRows,
						inactiveRows.length
							? createElement("p", { className: "cbc-group-title" }, "未启用（" + inactiveRows.length + "）")
							: null,
						inactiveRows),
					createElement("p", { className: "cbc-status" },
						"目录 " + (data.catalog.models || []).length + " 个（按当前登录凭据获取）；勾选即同步到对话模型选择器，下次请求生效。"));
			}

			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "模型"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "模型管理"),
					createElement("div", { className: "cbc-row-control" },
						createElement(CbcButton, { variant: "outline", icon: IconRefresh ? createElement(IconRefresh, { size: 14 }) : undefined, disabled: busy, onClick: fetchList }, busy ? "获取中…" : "刷新模型列表"))),
				body,
				createElement("p", { className: "cbc-hint" }, "列表按当前 Key/OAuth 拉取网关目录（/v3/config）；勾选控制每个模型是否出现在对话可选列表（写入 ~/.dsh/settings.yaml 的 llm-pi-ai 覆盖层）。"));
		}

		// --- 网络搜索与抓取 -------------------------------------------------------
		function SearchSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "网络搜索与抓取"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "一键开关"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.searchEnabled === true, onChange: function (e) { save({ searchEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.searchEnabled === true ? "web_search / web_fetch 走 CodeBuddy" : "已禁用（web_search 将报 provider 未注册）"),
						createElement(ResetButton, { fieldKey: "searchEnabled", overridden: overridden("searchEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "搜索默认条数"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "searchMaxResults", value: value.searchMaxResults, save: save, overridden: overridden("searchMaxResults") }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "抓取正文上限"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "fetchBodyCap", value: value.fetchBodyCap, save: save, overridden: overridden("fetchBodyCap") }))),
				createElement("p", { className: "cbc-hint" }, "禁用即注销 dsh 原生 web_search/web_fetch 的 codebuddy 后端；搜索条数 1–20。"));
		}

		// --- 图像生成 -----------------------------------------------------------
		function ImageGenSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "图像生成"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "一键开关"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.imageGenEnabled === true, onChange: function (e) { save({ imageGenEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.imageGenEnabled === true ? "image_generate 工具已注册到 agent" : "已禁用（agent 不再看到 image_generate）"),
						createElement(ResetButton, { fieldKey: "imageGenEnabled", overridden: overridden("imageGenEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "生图模型"),
					createElement("div", { className: "cbc-row-control" },
						createElement(TextField, { fieldKey: "imageGenModel", value: value.imageGenModel, save: save, widthClass: "cbc-w260", overridden: overridden("imageGenModel") }))),
				createElement("p", { className: "cbc-hint" }, "经 dsh 工具缝注册 image_generate（/v2/images/generations，约 20s/张，目录标注 x5 credits）；图片保存到会话工作区 generated-images/（无工作区信息时落 ~/.dsh/generated-images/）。"));
		}

		// --- 流式桥 -------------------------------------------------------------
		function BridgeSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "流式桥"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "启用流式桥"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.bridgeEnabled === true, onChange: function (e) { save({ bridgeEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, value.bridgeEnabled === true
							? "主聊天与工具请求均经由此桥（127.0.0.1 智能代理）"
							: "已禁用——主聊天将中断（模型请求经由此桥）"),
						createElement(ResetButton, { fieldKey: "bridgeEnabled", overridden: overridden("bridgeEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "端口"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "bridgePort", value: value.bridgePort, save: save, overridden: overridden("bridgePort") }),
						createElement("span", { className: "cbc-muted" }, "须与 cordis.patch.yml 的 baseURL 端口一致（默认 3901），否则主聊天断"))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "会话归因注入"),
					createElement("div", { className: "cbc-row-control" },
						createElement("input", { type: "checkbox", className: "cbc-check", checked: value.sessionHeadersEnabled === true, onChange: function (e) { save({ sessionHeadersEnabled: e.target.checked }); } }),
						createElement("span", { className: "cbc-muted" }, "按入站会话 id 注入网关会话头（已设置的逐头保留）"),
						createElement(ResetButton, { fieldKey: "sessionHeadersEnabled", overridden: overridden("sessionHeadersEnabled"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "会话头格式"),
					createElement("div", { className: "cbc-row-control" },
						createElement("select", {
							className: "cbc-select cbc-w200",
							value: value.sessionHeaderFormat || "openai",
							onChange: function (e) { save({ sessionHeaderFormat: e.target.value }); },
						},
							createElement("option", { value: "openai" }, "openai（session_id 等）"),
							createElement("option", { value: "openrouter" }, "openrouter（x-session-id）")),
						createElement(ResetButton, { fieldKey: "sessionHeaderFormat", overridden: overridden("sessionHeaderFormat"), save: save }))),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "每会话并发上限"),
					createElement("div", { className: "cbc-row-control" },
						createElement(NumberField, { fieldKey: "maxConcurrentPerSession", value: value.maxConcurrentPerSession, save: save, overridden: overridden("maxConcurrentPerSession") }))),
				createElement("p", { className: "cbc-hint" }, "桥统一解析凭据（登录区选 OAuth 或 Key），主聊天也经由此桥。同一会话超过上限的请求排队（FIFO）；无会话 id 的请求不限流。非流式入站聚合成标准 JSON，chat/completions 之外的请求直接透传。"));
		}

		// --- 高级 -----------------------------------------------------------------
		function AdvancedSection(props) {
			var value = props.value;
			var save = props.save;
			var overridden = props.overridden;
			return createElement("div", { className: "cbc-section" },
				createElement("h4", { className: "cbc-section-title" }, "高级"),
				createElement("div", { className: "cbc-row" },
					createElement("div", { className: "cbc-row-label" }, "网关地址"),
					createElement("div", { className: "cbc-row-control" },
						createElement(TextField, { fieldKey: "baseURL", value: value.baseURL, save: save, overridden: overridden("baseURL") }))),
				createElement("p", { className: "cbc-hint" }, "一般无需修改；必须是 http/https 绝对地址。"));
		}

		// --- 字段控件 -----------------------------------------------------------

		// “重置”：字段在文件层被覆盖时出现，点一下写 null 删覆盖、回默认值。
		function ResetButton(props) {
			if (!props.overridden) return null;
			return createElement(CbcButton, {
				variant: "ghost", title: "恢复默认值",
				onClick: function () { var p = {}; p[props.fieldKey] = null; props.save(p); },
			}, "重置");
		}

		function TextField(props) {
			var draftState = useState(String(props.value == null ? "" : props.value));
			var draft = draftState[0];
			var setDraft = draftState[1];
			// 服务端回值变化（保存成功/被规范化/重置）时同步草稿，不困住旧值。
			useEffect(function () { setDraft(String(props.value == null ? "" : props.value)); }, [props.value]);
			var commit = function () {
				if (draft === String(props.value == null ? "" : props.value)) return;
				var patch = {};
				patch[props.fieldKey] = draft;
				props.save(patch);
			};
			// Enter 只 blur：提交统一走 onBlur。曾经 Enter 先 commit 再 blur，
			// blur 又触发一次 commit —— 一次保存产生两趟 POST+GET。
			return createElement(react.Fragment, null,
				createElement(CbcInput, {
					widthClass: props.widthClass,
					value: draft,
					onInput: function (e) { setDraft(e.target.value); },
					onBlur: commit,
					onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
				}),
				createElement(ResetButton, { fieldKey: props.fieldKey, overridden: props.overridden, save: props.save }));
		}

		function NumberField(props) {
			var draftState = useState(String(props.value == null ? "" : props.value));
			var draft = draftState[0];
			var setDraft = draftState[1];
			useEffect(function () { setDraft(String(props.value == null ? "" : props.value)); }, [props.value]);
			var commit = function () {
				var n = Number(draft);
				if (!Number.isFinite(n) || draft.trim() === "" || n === props.value) return;
				var patch = {};
				patch[props.fieldKey] = n;
				props.save(patch);
			};
			return createElement(react.Fragment, null,
				createElement(CbcInput, {
					type: "number",
					widthClass: "cbc-w110",
					value: draft,
					onInput: function (e) { setDraft(e.target.value); },
					onBlur: commit,
					onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
				}),
				createElement(ResetButton, { fieldKey: props.fieldKey, overridden: props.overridden, save: props.save }));
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.inject(["slots"], function (sctx) {
				sctx.slots.register(
					{
						name: "settings.plugin.item",
						// dsh ≥ rc.7 made this slot keyed: the tab dispatches
						// one entry per Host-served settings namespace, matched
						// on `key` (host half registers that namespace).
						// `id`/`order`/`label` keep rc.6 (list slot) working;
						// rc.7 ignores them.
						key: "dsh-codebuddy-plugin",
						id: "codebuddy",
						order: 60,
						label: function () { return "CodeBuddy"; },
						inject: function () { return {}; },
					},
					CodeBuddyCard,
				);
			});
		}

		exports.ROUTE = ROUTE;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
