#!/usr/bin/env node
// Round 3：raw 路径模型路由终局判定（2026-08-24）。
// F0: get_model_list 按 function 取模型清单（免费）；F1: kimi-k3；F2: glm-5.3+custom_model；F3: DeepSeek-V4-Flash-Official。
// 全部完整落盘，判据 = timing_cost.provider_model_name 或错误码。
import fs from "node:fs";

const auth = JSON.parse(fs.readFileSync(process.env.HOME + "/.dsh/trae-plugin-auth.json", "utf8"));
const token = auth.auth.accessToken;
const { device, account } = auth;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rawHeaders = {
  "Content-Type": "application/json", Accept: "text/event-stream", Connection: "keep-alive",
  "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  "x-ide-version": "3.3.67", "x-ide-version-code": "20260401", "x-ide-version-type": "stable",
  "x-device-cpu": "AMD", "x-device-type": "windows", "x-os-version": "Windows 10", "x-system-type": "Windows",
  "x-request-id": crypto.randomUUID(), "User-Agent": "",
  "x-device-id": device.deviceId, "x-machine-id": device.machineId, "x-device-brand": device.deviceBrand,
  "x-uid": String(account.uid),
  "Authorization": "Cloud-IDE-JWT " + token, "X-Cloudide-Token": token, "x-ide-token": token,
};

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
