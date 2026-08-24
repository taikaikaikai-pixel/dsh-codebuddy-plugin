#!/usr/bin/env node
// 补充证据：完整事件流落盘 + plan_item/model_config/timing_cost 形态打印（2026-08-24）。
import fs from "node:fs";

const AUTH_PATH = process.env.HOME + "/.dsh/trae-plugin-auth.json";
const RAW_URL = "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat";
const REMOTE_BASE = "https://trae-api-cn.mchost.guru/api/remote/v1";
const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
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
const webHeaders = {
  "Authorization": "Cloud-IDE-JWT " + token, "Content-Type": "application/json",
  "X-Trae-Client-Type": "web", "X-Preferenced-Language": "zh-CN", "x-user-region": "CN",
  "Origin": "https://solo.trae.cn", "Referer": "https://solo.trae.cn/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Accept: "text/event-stream",
};

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
