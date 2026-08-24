#!/usr/bin/node
// 诊断探测：Trae inline 面 "3003 all models failed" 故障取证（2026-08-24）。
//
// 背景：用户经 dsh-codebuddy-plugin 使用 TraeWork CN 模型报
//   "trae 3003 all models failed" + PI_AI_ERROR。
// 本脚本做最小对照实验并落证据盘（docs/probes/trae-3003-diagnosis-<ts>.json）：
//   [0] 双额度池余额（只读 ide_user_ent_usage，req_source 0/1）
//   [A] inline_chat + 非默认模型（glm-5.3）
//   [B] inline_chat + 账户默认模型（kimi-k2.6）
//   [C] function=chat_v3 + glm-5.3（同信封同鉴权对照——健康则证明故障只在
//       inline_chat 的模型解析层，非凭据/非信封/非配额）
//   [R] remote 会话创建（含边缘节点漂移重试观测；成功即停，避免占并发额度）
// 判读要点：错误事件名在 `event:` 行（data JSON 内无 event 字段）；业务级拒绝
// 恒为 JSON 信封，**裸文本 404/403 是 TLB/WAF 层行为**（docs/diagnosis-trae-3003.md）。
// 纪律：raw 面请求间隔 ≥20s（4011 限流很紧）；本脚本单轮共 4 个 chat 请求。
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')
const MCHOST = 'https://trae-api-cn.mchost.guru'

const { readJson } = await import('../core/json-store.js')
const { createTraeOAuth } = await import('../providers/trae/oauth.js')
const { buildChatRequest, traeOutboundHeaders } = await import('../providers/trae/gateway.js')
const { createRemoteSession } = await import('../providers/trae/remote.js')

const SETTINGS = { traeAuthBaseURL: 'https://api.trae.cn', traeChatBaseURL: MCHOST, traeLoginHost: 'https://www.trae.cn' }
const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: (v) => fs.writeFileSync(AUTH_PATH, JSON.stringify(v)) })
const cred = await oauth.resolveTraeCredential(SETTINGS)
if (!cred) { console.error('未登录（先在设置卡 TraeWork CN 分区登录或跑 probe-trae-live.mjs --login）'); process.exit(1) }
const authStore = readJson(AUTH_PATH)
const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
const device = authStore.device ?? {}
const uid = String(authStore.account?.uid ?? '')
const ideHeaders = (requestId) => ({
  ...traeOutboundHeaders(device, uid ? Number(uid) : undefined, requestId),
  Authorization: `Cloud-IDE-JWT ${token}`,
  'X-Cloudide-Token': token,
  'x-ide-token': token,
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 raw 面 SSE：event 名在 event: 行；裸 {code} 数据也算业务错误。 */
function parseRawSse(raw) {
  let lastEvt = null
  const events = []
  for (const line of raw.split('\n')) {
    const l = line.trim()
    if (!l) { lastEvt = null; continue }
    if (l.startsWith('event:')) { lastEvt = l.slice(6).trim(); continue }
    if (!l.startsWith('data:')) continue
    try {
      const j = JSON.parse(l.slice(5).trim())
      const evName = (typeof j.event === 'string' && j.event) ? j.event : lastEvt
      const isErr = evName === 'error' || (typeof j.code === 'number' && j.response === undefined && j.usage === undefined)
      events.push({ ev: evName ?? null, code: isErr ? j.code : undefined, message: isErr ? j.message : undefined, providerModel: j.provider_model_name })
    } catch { /* 非 JSON data 忽略 */ }
  }
  return events
}

async function rawChatProbe(label, fn, model /* undefined=不带 model 字段 */) {
  const payload = { stream: true, messages: [{ role: 'user', content: '只回复两个字：成功' }] }
  if (model !== undefined) payload.model = model
  const { body, requestId } = buildChatRequest(payload, `diag-${label}`)
  body.function = fn
  const t0 = Date.now()
  const resp = await fetch(`${MCHOST}/api/agent/v3/llm_utils_chat`, {
    method: 'POST', headers: ideHeaders(requestId), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  })
  const raw = await resp.text()
  const events = parseRawSse(raw)
  return {
    label, fn, model: model ?? '(omitted)', status: resp.status,
    errors: events.filter((e) => e.code != null).slice(0, 2),
    providerModels: [...new Set(events.map((e) => e.providerModel).filter(Boolean))],
    hasText: events.some((e) => e.ev === 'output'),
    ms: Date.now() - t0, rawBytes: raw.length,
  }
}

const evidence = {
  at: new Date().toISOString(), note: '诊断脚本见 scripts/probe-trae-3003-diagnosis.mjs；结论见 docs/diagnosis-trae-3003.md',
  accountUidMasked: uid.slice(0, 3) + '***', steps: {},
}

console.log('[0] 双额度池余额（只读）')
for (const src of [0, 1]) {
  try {
    const r = await fetch('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage', {
      method: 'POST', headers: ideHeaders(crypto.randomUUID()),
      body: JSON.stringify({ require_usage: true, req_source: src }), signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json().catch(() => null)
    evidence.steps[`pool_src${src}`] = (j?.user_entitlement_pack_list ?? []).map((p) => ({
      endpoint: p?.entitlement_base_info?.available_endpoint, limit: p?.entitlement_base_info?.quota?.credits_limit, used: p?.usage?.credits_amount,
    }))
    console.log(`   req_source=${src}:`, JSON.stringify(evidence.steps[`pool_src${src}`]))
  } catch (e) { evidence.steps[`pool_src${src}`] = { error: String(e?.message ?? e).slice(0, 120) } }
}

await sleep(21_000)
console.log('[A] inline_chat + glm-5.3（非默认模型）')
evidence.steps.A_inline_nonDefault = await rawChatProbe('A', 'inline_chat', 'glm-5.3')
console.log('  ', JSON.stringify(evidence.steps.A_inline_nonDefault))
await sleep(21_000)
console.log('[B] inline_chat + kimi-k2.6（账户默认模型）')
evidence.steps.B_inline_default = await rawChatProbe('B', 'inline_chat', 'kimi-k2.6')
console.log('  ', JSON.stringify(evidence.steps.B_inline_default))
await sleep(21_000)
console.log('[C] chat_v3 + glm-5.3（对照组：信封/鉴权健康性）')
evidence.steps.C_chatv3 = await rawChatProbe('C', 'chat_v3', 'glm-5.3')
console.log('  ', JSON.stringify(evidence.steps.C_chatv3))
await sleep(21_000)
console.log('[R] remote 会话创建（观测边缘节点漂移；成功即停善后）')
try {
  const s = await createRemoteSession(MCHOST + '/api/remote/v1', token, 'glm-5.3', [{ role: 'user', content: '只回复两个字：成功' }])
  evidence.steps.R_remote_create = { ok: true, sessionIdMasked: s.sessionId.slice(0, 10) + '…' }
  console.log('   创建成功 sid=' + s.sessionId.slice(0, 10) + '…')
} catch (e) {
  evidence.steps.R_remote_create = { ok: false, error: String(e?.message ?? e).slice(0, 240) }
  console.log('  ', evidence.steps.R_remote_create.error)
}

const a = evidence.steps.A_inline_nonDefault, b = evidence.steps.B_inline_default, c = evidence.steps.C_chatv3
evidence.verdict =
  a.errors.length && b.errors.length && !c.errors.length
    ? `INLINE-FACE-BROKEN: inline_chat 对默认与非默认模型一律 ${a.errors[0].code}，同信封 chat_v3 正常 → 服务端 inline 面模型解析故障（非凭据/配额/信封）；解法=切 remote 传输`
    : a.errors.length && !b.errors.length
      ? 'DEFAULT-ONLY: 仅非默认模型失败 → 与 trae-cloud-api.md §5.1 一致（function 位钉死到账户默认模型）'
      : '见证据详情'
console.log('==>', evidence.verdict)

const outPath = join('docs/probes', `trae-3003-diagnosis-${Date.now()}.json`)
fs.mkdirSync('docs/probes', { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2))
console.log('证据落盘 →', outPath)
