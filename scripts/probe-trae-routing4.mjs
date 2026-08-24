#!/usr/bin/env node
// Round 4：llm_utils_chat 其他 function 位的模型路由探测（2026-08-24）。
// solo_agent_lite / solo_work_lite 的模型清单含 glm-5.3/kimi-k3/DeepSeek-V4 全系（state.vscdb）。
// 判据 = timing_cost.provider_model_name。
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
