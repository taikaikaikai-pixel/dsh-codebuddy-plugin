#!/usr/bin/env node
// 探测 Trae 上游模型路由生效条件 v2（2026-08-24）。
// A/B: raw llm_utils_chat 用网关同款完整头组；C2/C3: remote 9router 变体对照双模型。
// 判据：raw 看 timing_cost.provider_model_name；remote 看事件流内容+自报模型名对照。
// 证据落盘 docs/probes/trae-model-routing2-<ts>.json。
import fs from "node:fs";
import path from "node:path";

const AUTH_PATH = process.env.HOME + "/.dsh/trae-plugin-auth.json";
const RAW_URL = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";
const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";

const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
const token = auth.auth.accessToken;
const device = auth.device;
const uid = auth.account.uid;

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
