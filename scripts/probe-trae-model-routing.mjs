#!/usr/bin/env node
// 探测 Trae 上游模型路由生效条件 —— 四轮合并版（2026-08-29 合并）。
// Usage: node scripts/probe-trae-model-routing.mjs [--round 2|evidence|3|4]（默认 2）
//
// 轮次考古（臂表/判据/证据落盘路径格式均保持各轮原样）：
//   --round 2        = 原 probe-trae-model-routing.mjs（2026-08-24，v2）
//     A/B: raw llm_utils_chat 用网关同款完整头组；C2/C3: remote 9router 变体对照双模型。
//     判据：raw 看 timing_cost.provider_model_name；remote 看事件流内容+自报模型名对照。
//     证据落盘 docs/probes/trae-model-routing2-<ts>.json。
//   --round evidence = 原 probe-trae-routing-evidence.mjs（2026-08-24）
//     补充证据：完整事件流落盘 + plan_item/model_config/timing_cost 形态打印。
//     落盘 docs/probes/trae-raw-stream-glm53.jsonl / docs/probes/trae-remote-stream-glm53.txt。
//   --round 3        = 原 probe-trae-routing3.mjs（2026-08-24）
//     raw 路径模型路由终局判定。F0: get_model_list 按 function 取模型清单（免费）；
//     F1: kimi-k3；F2: glm-5.3+custom_model；F3: DeepSeek-V4-Flash-Official；F4: function=chat_v3。
//     全部完整落盘 docs/probes/trae-model-routing3-<ts>.json，判据 = timing_cost.provider_model_name 或错误码。
//   --round 4        = 原 probe-trae-routing4.mjs（2026-08-24）
//     llm_utils_chat 其他 function 位的模型路由探测。solo_agent_lite / solo_work_lite
//     的模型清单含 glm-5.3/kimi-k3/DeepSeek-V4 全系（state.vscdb）。
//     落盘 docs/probes/trae-model-routing4-<ts>.json，判据 = timing_cost.provider_model_name。
import fs from "node:fs";
import path from "node:path";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
}
const ROUNDS = { 2: runRound2, evidence: runRoundEvidence, 3: runRound3, 4: runRound4 };
const ROUND = argValue("--round") ?? "2";
if (process.argv.includes("--help") || !ROUNDS[ROUND]) {
  console.log("Usage: node scripts/probe-trae-model-routing.mjs [--round 2|evidence|3|4]（默认 2；轮次对应见文件头注释）");
  process.exit(process.argv.includes("--help") ? 0 : 1);
}

const AUTH_PATH = process.env.HOME + "/.dsh/trae-plugin-auth.json";
const RAW_URL = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";
const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";

const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
const token = auth.auth.accessToken;
const { device, account } = auth;
const uid = account.uid;

const rawHeaders = {
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  Connection: "keep-alive",
  "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  "x-ide-version": "3.3.67",
  "x-ide-version-code": "20260401",
  "x-ide-version-type": "stable",
  "x-device-cpu": "AMD",
  "x-device-type": "windows",
  "x-os-version": "Windows 10",
  "x-system-type": "Windows",
  "x-request-id": crypto.randomUUID(),
  "User-Agent": "",
  "x-device-id": device.deviceId,
  "x-machine-id": device.machineId,
  "x-device-brand": device.deviceBrand,
  "x-uid": String(uid),
  "Authorization": "Cloud-IDE-JWT " + token,
  "X-Cloudide-Token": token,
  "x-ide-token": token,
};
const webHeaders = {
  "Authorization": "Cloud-IDE-JWT " + token,
  "Content-Type": "application/json",
  "X-Trae-Client-Type": "web",
  "X-Preferenced-Language": "zh-CN",
  "x-user-region": "CN",
  "Origin": "https://solo.trae.cn",
  "Referer": "https://solo.trae.cn/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Accept: "text/event-stream",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── ROUND 2（原 probe-trae-model-routing.mjs） ───────────────────────────

async function runRound2() {
  function glm53CustomModel() {
    return {
      name: "glm-5.3", config_name: "glm-5.3", config_source: 1, provider: "",
      multimodal: false, ak: "", sk: "", base_url: "", auth_type: 0, use_remote_service: true,
      features: {
        access: { data: { identity_list: [0, 5, 1, 2, 3, 100] } },
        consumption_rate: { enable: true, data: { rate: 0.4 } },
        discount: { enable: true, subKey: "exclusive_discount", data: {} },
        reasoning: { enable: true },
      },
    };
  }

  async function rawChat(label, prompt, body) {
    const full = {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      function: "inline_chat",
      request_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      stream: true,
      ...body,
    };
    const resp = await fetch(RAW_URL, { method: "POST", headers: rawHeaders, body: JSON.stringify(full) });
    const status = resp.status;
    if (status !== 200) return { label, status, error: (await resp.text()).slice(0, 500) };
    const raw = await resp.text();
    let timingModel = null, finalText = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let obj; try { obj = JSON.parse(t.slice(5).trim()); } catch { continue; }
      if (obj.timing_cost?.provider_model_name) timingModel = obj.timing_cost.provider_model_name;
      if (typeof obj.response === "string") finalText = obj.response;
    }
    return { label, status, timingModel, finalText: finalText.slice(0, 300) };
  }

  async function remoteChat(label, modelName, prompt) {
    const commonParams = JSON.stringify({
      language: "zh-cn", app_language: "zh-CN", quality: "stable",
      app_version: "1.0.0.1229", web_id: "", user_identity: "Free",
      is_freshman: "0", biz_user_id: "", user_unique_id: "",
      scope: "marscode-cn", tenant: "marscode", region: "cn", aiRegion: "cn",
      is_privacy_mode: 0, privacy_mode: "off", solo_chat_mode: "code",
    });
    const body = {
      mode: "code",
      environment_id: "default",
      initial_message: {
        chat_session_id: "",
        content: [],
        query: JSON.stringify([{ type: "text", data: { content: prompt } }]),
        model_name: modelName,
        agent_type: "solo_agent_remote",
        model_selection_strategy: "manual",
        common_params: commonParams,
      },
      env: "remote",
      auto_create_project: false,
      origin: "web",
    };
    const resp = await fetch(REMOTE_BASE + "/chat_sessions", { method: "POST", headers: { ...webHeaders, Accept: "application/json" }, body: JSON.stringify(body) });
    const status = resp.status;
    const text = await resp.text();
    if (status !== 200) return { label, status, error: text.slice(0, 500) };
    const data = JSON.parse(text);
    const payload = data.data ?? data;
    const sid = payload.chat_session_id, mid = payload.message_id;
    if (!sid || !mid) return { label, status, createResp: data, error: "missing ids" };
    const ev = await fetch(`${REMOTE_BASE}/chat_sessions/${sid}/events?reply_to_message_id=${mid}`, { headers: webHeaders });
    const evText = await ev.text();
    // 提取 plan_item 累计文本与事件类型清单
    const eventTypes = [];
    const thoughts = {};
    let usage = null, done = null, error = null;
    for (const chunk of evText.split("\n\n")) {
      let evName = null, dataLine = null;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) evName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!dataLine) continue;
      let obj; try { obj = JSON.parse(dataLine); } catch { continue; }
      const name = evName || obj.event || "message";
      eventTypes.push(name);
      if (name === "plan_item" && obj.id) thoughts[obj.id] = obj.thought ?? obj.text ?? JSON.stringify(obj).slice(0, 200);
      if (name === "token_usage") usage = obj;
      if (name === "done") done = obj;
      if (name === "error") error = obj;
    }
    return {
      label, status, session_id: sid, eventTypes,
      thoughtText: Object.values(thoughts).join("\n---\n").slice(0, 500),
      usage, done: done ? JSON.stringify(done).slice(0, 300) : null, error,
      rawTail: evText.slice(-1500),
    };
  }

  const out = { ts: new Date().toISOString(), probes: [] };
  const push = (p) => { out.probes.push(p); console.log("   ", p.label, "status:", p.status, "| timingModel:", p.timingModel ?? "-", "| events:", (p.eventTypes ?? []).join(",") || "-", "| err:", (p.error && JSON.stringify(p.error).slice(0, 150)) ?? "-"); };

  console.log("[A] raw kimi-k3 ...");
  push(await rawChat("A-raw-kimi-k3", "Reply with exactly: ok", { model: "kimi-k3" }));
  await sleep(22000);
  console.log("[B] raw glm-5.3 + custom_model ...");
  push(await rawChat("B-raw-custom_model", "Reply with exactly: ok", { model: "glm-5.3", custom_model: glm53CustomModel() }));
  await sleep(22000);
  console.log("[C2] remote glm-5.3 ...");
  push(await remoteChat("C2-remote-glm53", "glm-5.3", "你是哪个模型？请只回答你的模型名称，不要其他内容。"));
  await sleep(8000);
  console.log("[C3] remote kimi-k2.6 ...");
  push(await remoteChat("C3-remote-kimi26", "kimi-k2.6", "你是哪个模型？请只回答你的模型名称，不要其他内容。"));

  const fname = "docs/probes/trae-model-routing2-" + out.ts.replace(/[:.]/g, "-").slice(0, 19) + ".json";
  fs.writeFileSync(path.resolve(fname), JSON.stringify(out, null, 2));
  console.log("saved:", fname);
}

// ─────────────────────────── ROUND evidence（原 probe-trae-routing-evidence.mjs） ───────────────────────────

async function runRoundEvidence() {
  // [D] raw glm-5.3 全事件落盘（形态校准）
  console.log("[D] raw glm-5.3 full stream ...");
  {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }],
      model: "glm-5.3", function: "inline_chat",
      request_id: crypto.randomUUID(), session_id: crypto.randomUUID(), stream: true,
    };
    const resp = await fetch(RAW_URL, { method: "POST", headers: rawHeaders, body: JSON.stringify(body) });
    const raw = await resp.text();
    fs.writeFileSync("docs/probes/trae-raw-stream-glm53.jsonl", raw);
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let obj; try { obj = JSON.parse(t.slice(5).trim()); } catch { continue; }
      const keys = Object.keys(obj).join(",");
      if (obj.event === "timing_cost" || obj.provider_model_name) console.log("  timing:", JSON.stringify(obj).slice(0, 250));
      else if (obj.event === "output" || obj.response !== undefined) console.log("  output keys:", keys, "| resp:", JSON.stringify(obj.response ?? "").slice(0, 60));
      else console.log("  event:", obj.event ?? "(none)", "| keys:", keys.slice(0, 120));
    }
  }

  await sleep(22000);

  // [E] remote glm-5.3 全事件落盘（plan_item 形态校准）
  console.log("[E] remote glm-5.3 full stream ...");
  {
    const prompt = "你是哪个模型？请只回答你的模型名称。";
    const commonParams = JSON.stringify({
      language: "zh-cn", app_language: "zh-CN", quality: "stable", app_version: "1.0.0.1229",
      web_id: "", user_identity: "Free", is_freshman: "0", biz_user_id: "", user_unique_id: "",
      scope: "marscode-cn", tenant: "marscode", region: "cn", aiRegion: "cn",
      is_privacy_mode: 0, privacy_mode: "off", solo_chat_mode: "code",
    });
    const body = {
      mode: "code", environment_id: "default",
      initial_message: {
        chat_session_id: "", content: [],
        query: JSON.stringify([{ type: "text", data: { content: prompt } }]),
        model_name: "glm-5.3", agent_type: "solo_agent_remote",
        model_selection_strategy: "manual", common_params: commonParams,
      },
      env: "remote", auto_create_project: false, origin: "web",
    };
    const resp = await fetch(REMOTE_BASE + "/chat_sessions", { method: "POST", headers: { ...webHeaders, Accept: "application/json" }, body: JSON.stringify(body) });
    const data = JSON.parse(await resp.text());
    const sid = data.data?.chat_session_id, mid = data.data?.message_id;
    console.log("  session:", sid, "message:", mid);
    const ev = await fetch(`${REMOTE_BASE}/chat_sessions/${sid}/events?reply_to_message_id=${mid}`, { headers: webHeaders });
    const evText = await ev.text();
    fs.writeFileSync("docs/probes/trae-remote-stream-glm53.txt", evText);
    // 形态打印：每种事件的第一条
    const seen = new Set();
    for (const chunk of evText.split("\n\n")) {
      let evName = null, dataLine = null;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) evName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!dataLine || !evName || seen.has(evName)) continue;
      seen.add(evName);
      console.log("  [" + evName + "]", dataLine.slice(0, 280));
    }
  }
  console.log("done");
}

// ─────────────────────────── ROUND 3（原 probe-trae-routing3.mjs） ───────────────────────────

async function runRound3() {
  const out = { ts: new Date().toISOString(), probes: [] };

  // F0: get_model_list（两域名各试一次）
  console.log("[F0] get_model_list ...");
  for (const host of ["https://api.trae.cn", "https://trae-api-cn.mchost.guru"]) {
    try {
      const r = await fetch(host + "/api/ide/v1/get_model_list", {
        method: "POST", headers: rawHeaders,
        body: JSON.stringify({ functions: ["assistant", "chat_v3", "inline_chat", "solo_agent_lite", "solo_work_lite"], force_refresh: false }),
      });
      const text = await r.text();
      let d = null;
      try { d = JSON.parse(text); } catch { /* HTML 错误页 */ }
      out.probes.push({ label: "F0-get_model_list", host, status: r.status, body: d ?? text.slice(0, 300) });
      console.log("  host:", host, "status:", r.status, d ? "(json)" : "(non-json)");
      const data = d?.data ?? d;
      for (const [fn, models] of Object.entries(data?.model_list_map ?? {})) {
        if (!Array.isArray(models)) continue;
        console.log("    [" + fn + "]", models.map((m) => m.name ?? m.config_name).join(", "));
      }
    } catch (e) { console.log("  host:", host, "ERR", String(e).slice(0, 120)); }
  }

  async function rawFull(label, extra) {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }],
      function: "inline_chat", request_id: crypto.randomUUID(), session_id: crypto.randomUUID(), stream: true,
      ...extra,
    };
    const resp = await fetch("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat", { method: "POST", headers: rawHeaders, body: JSON.stringify(body) });
    const raw = await resp.text();
    let timing = null, err = null, text = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let obj; try { obj = JSON.parse(t.slice(5).trim()); } catch { continue; }
      if (obj.event === "error" || (obj.code != null && obj.code !== 0)) err = obj;
      if (obj.event === "timing_cost" && obj.provider_model_name) timing = obj.provider_model_name;
      if (typeof obj.response === "string") text = obj.response;
    }
    const rec = { label, status: resp.status, timing, err, text: text.slice(0, 80), raw: raw.slice(0, 2000) };
    out.probes.push(rec);
    console.log("  ", label, "status:", resp.status, "| timing:", timing ?? "-", "| err:", err ? JSON.stringify(err).slice(0, 120) : "-", "| text:", JSON.stringify(text.slice(0, 40)));
  }

  console.log("[F1] raw kimi-k3 ...");
  await rawFull("F1-kimi-k3", { model: "kimi-k3" });
  await sleep(22000);
  console.log("[F2] raw glm-5.3 + custom_model ...");
  await rawFull("F2-glm53-custom_model", { model: "glm-5.3", custom_model: { name: "glm-5.3", config_name: "glm-5.3", config_source: 1, provider: "", multimodal: false, ak: "", sk: "", base_url: "", auth_type: 0, use_remote_service: true } });
  await sleep(22000);
  console.log("[F3] raw DeepSeek-V4-Flash-Official ...");
  await rawFull("F3-ds-v4-flash-official", { model: "DeepSeek-V4-Flash-Official" });
  await sleep(22000);
  console.log("[F4] raw function=chat_v3 + model=glm-5.3 ...");
  await rawFull("F4-chat_v3-glm53", { model: "glm-5.3", function: "chat_v3" });

  const fname = "docs/probes/trae-model-routing3-" + out.ts.replace(/[:.]/g, "-").slice(0, 19) + ".json";
  fs.writeFileSync(fname, JSON.stringify(out, null, 2));
  console.log("saved:", fname);
}

// ─────────────────────────── ROUND 4（原 probe-trae-routing4.mjs） ───────────────────────────

async function runRound4() {
  const out = { ts: new Date().toISOString(), probes: [] };

  async function rawFull(label, extra) {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }],
      function: "inline_chat", request_id: crypto.randomUUID(), session_id: crypto.randomUUID(), stream: true,
      ...extra,
    };
    const resp = await fetch("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat", { method: "POST", headers: rawHeaders, body: JSON.stringify(body) });
    const raw = await resp.text();
    let timing = null, err = null, text = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      let obj; try { obj = JSON.parse(t.slice(5).trim()); } catch { continue; }
      if (obj.event === "error" || (obj.code != null && obj.code !== 0)) err = obj;
      if (obj.event === "timing_cost" && obj.provider_model_name) timing = obj.provider_model_name;
      if (typeof obj.response === "string" && obj.response) text = obj.response;
    }
    out.probes.push({ label, status: resp.status, timing, err, text: text.slice(0, 80), raw: raw.slice(0, 3000) });
    console.log("  ", label, "| status:", resp.status, "| timing:", timing ?? "-", "| err:", err ? JSON.stringify(err).slice(0, 130) : "-", "| text:", JSON.stringify(text.slice(0, 40)));
  }

  console.log("[G1] solo_agent_lite + glm-5.3 ...");
  await rawFull("G1-lite-glm53", { model: "glm-5.3", function: "solo_agent_lite" });
  await sleep(22000);
  console.log("[G2] solo_agent_lite + kimi-k3 ...");
  await rawFull("G2-lite-kimik3", { model: "kimi-k3", function: "solo_agent_lite" });
  await sleep(22000);
  console.log("[G3] solo_work_lite + DeepSeek-V4-Flash-Official ...");
  await rawFull("G3-worklite-dsflash", { model: "DeepSeek-V4-Flash-Official", function: "solo_work_lite" });
  await sleep(22000);
  console.log("[G4] solo_agent_lite + 错误模型名（负对照） ...");
  await rawFull("G4-lite-bogus", { model: "not-a-model", function: "solo_agent_lite" });

  const fname = "docs/probes/trae-model-routing4-" + out.ts.replace(/[:.]/g, "-").slice(0, 19) + ".json";
  fs.writeFileSync(fname, JSON.stringify(out, null, 2));
  console.log("saved:", fname);
}

// ─────────────────────────── 轮次调度 ───────────────────────────

ROUNDS[ROUND]().catch((e) => { console.error(e); process.exit(1); });
