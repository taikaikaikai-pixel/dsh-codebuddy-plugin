#!/usr/bin/env node
/**
 * Qoder CN — 用量统计归因梯度实验（真实网络、本人账号）。
 *
 * 前序（docs/probes/qoder-quota-1790026311843.json）：裸 OpenAI body 聊天后
 * quota/usage、me/usage、credits-heatmap、credits-summary 计数器全部不动
 * （高精度哨兵 creditsSummary.totalCredits 纹丝不动），尽管 SSE usage 帧
 * billable:true——服务端不按裸推理请求记账。
 *
 * 官方客户端的记账候选（bundle 逆向实证，见 qoder-worker-runtime.obf.mjs）：
 *   a) 一轮 query 结束后 POST /algo/api/v2/service/business/finish?Encode=1
 *      （BUSINESS_FINISH 事件，prepareRequest mode "auth"）；
 *   b) 聊天 body 明文里的归因字段（request_id/request_set_id/chat_record_id/
 *      session_id/chat_task/source:1/version:"3"/agent_id/task_id/session_type…）；
 *   c) 聊天 body 的 business 块（id 与 request_set_id 同源）；
 *   d) POST /api/v1/tracking（mode "sign"，聚合 total_credits，best-effort 遥测）。
 *
 * 梯度（每臂 = 计数器快照 → 动作 → 静置 → 复拍，逐臂判定谁让计数器动）：
 *   1 finish-only   裸聊天 + business/finish
 *   2 envelope      聊天带归因字段（无 business 块），不上报
 *   3 env-business  聊天带归因字段 + business 块，不上报
 *   4 env-finish    归因字段 + business 块 + business/finish
 *   5 tracking      裸聊天 + /api/v1/tracking 回流上报
 *
 * 用法：node scripts/probe-qoder-attribution.mjs [--arm N] [--settle-ms 15000]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROBES_DIR = join(ROOT, 'docs', 'probes')
const OPENAPI = process.env.QODER_OPENAPI ?? 'https://openapi.qoder.com.cn'
const INFER = process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn'
const MODEL = process.env.QODER_QUOTA_MODEL ?? 'q37fmodel'
const PROMPT = '只回复两个字：收到'

const args = process.argv.slice(2)
const optVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d }
const onlyArm = optVal('--arm', 0)
const SETTLE_MS = optVal('--settle-ms', 15_000)

const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')

const store = readJson(join(DSH_HOME, 'qoder-plugin-auth.json'))
if (!store?.auth?.accessToken) { console.error('未登录：先跑 probe-qoder-live --login'); process.exit(1) }
const token = store.auth.accessToken
const machineId = store.machine?.machineId
const uid = store.account?.uid ?? ''
const oid = store.account?.organizationId ?? ''
const cred = { accessToken: token, machineId, uid }
const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// aid/yx_uid 不在令牌仓里，userinfo 现取（取不到就空串，与 service account 形态一致）
let aid = '', yid = ''
try {
  const res = await fetch(`${OPENAPI}/api/v1/userinfo`, { headers: { Authorization: `Bearer ${token}` } })
  const j = JSON.parse(await res.text())
  aid = j?.aid ?? j?.data?.aid ?? ''
  yid = j?.yx_uid ?? j?.data?.yx_uid ?? ''
  console.log(`userinfo HTTP ${res.status}：aid=${aid ? '有' : '无'} yx_uid=${yid ? '有' : '无'}`)
} catch (e) { console.log('userinfo 拉取失败（继续，aid/yid 空串）：', String(e?.message ?? e)) }

// ── 计数器（高精度哨兵 = creditsSummary.totalCredits）─────────────────────
async function counters(tag) {
  const grab = async (name, url, pick) => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const j = JSON.parse(await res.text())
      return { name, status: res.status, value: pick(j) }
    } catch (e) { return { name, netErr: String(e?.message ?? e) } }
  }
  const today = new Date().toISOString().slice(0, 10)
  const snap = {
    tag, at: new Date().toISOString(),
    addOnUsed: (await grab('quotaUsage', `${OPENAPI}/api/v2/quota/usage`, (j) => j?.addOnQuota?.used)).value,
    totalCredits: (await grab('creditsSummary', `${OPENAPI}/sash/api/v1/ai-conversations/credits-summary`, (j) => j?.totalCredits)).value,
    heatToday: (await grab('creditsHeatmap', `${OPENAPI}/sash/api/v1/ai-conversations/credits-heatmap?days=1`, (j) => j?.items?.find?.((i) => i.date === today)?.value ?? j?.items?.[0]?.value)).value,
  }
  console.log(`  [${tag}] addOnUsed=${snap.addOnUsed} totalCredits=${snap.totalCredits} heatToday=${snap.heatToday}`)
  return snap
}

// ── 动作原语 ─────────────────────────────────────────────────────────────
async function chatOnce(extraFields) {
  const body = JSON.stringify({
    model: MODEL, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: PROMPT }],
    ...extraFields,
  })
  const signed = await cosy.prepareChat(cred, { endpoint: INFER, body, modelKey: MODEL, modelSource: 'system' })
  const res = await fetch(signed.url, {
    method: 'POST',
    headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: signed.body,
  })
  const raw = await res.text()
  let usage = null, text = '', err = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    let frame; try { frame = JSON.parse(line.slice(5)) } catch { continue }
    if (typeof frame?.body !== 'string' || frame.body === '[DONE]') continue
    let chunk; try { chunk = JSON.parse(frame.body) } catch { continue }
    if (chunk.message && !chunk.choices) { err = `${chunk.code}: ${chunk.message}`; continue }
    if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content
    if (chunk.usage) usage = chunk.usage
  }
  console.log(`  chat HTTP ${res.status} text=${JSON.stringify(text.slice(0, 20))} credits=${usage?.credits} billable=${usage?.billable} reqId=${usage?.request_id ?? '(无)'} ${err ? 'ERR=' + err : ''}`)
  return { status: res.status, usage, text: text.slice(0, 100), err, raw: raw.slice(0, 12_000) }
}

async function businessFinish({ sessionId, requestSetId }) {
  const inner = {
    event_time: Date.now(), event_type: 'BUSINESS_FINISH',
    mid: machineId, aid, rid: randomUUID(), oid, yid, uid,
    event_data: {
      session_id: sessionId,
      business: { product: 'cli', version: '1.1.57', type: 'agent', id: requestSetId, end_at: Date.now(), stage: 'complete', name: PROMPT.slice(0, 10) },
    },
  }
  const bodyJson = JSON.stringify({ payload: JSON.stringify(inner), encodeVersion: '1' })
  const signed = await cosy.prepareSigned(cred, { endpoint: INFER, path: '/api/v2/service/business/finish?Encode=1', method: 'POST', mode: 'auth', body: bodyJson })
  const res = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'Content-Type': 'application/json' }, body: signed.body })
  const text = await res.text()
  console.log(`  business/finish HTTP ${res.status} url=${signed.url} resp=${text.slice(0, 160)}`)
  return { url: signed.url, status: res.status, resp: text.slice(0, 2000), plainBody: inner }
}

async function tracking({ sessionId, requestSetId, usage }) {
  const envelope = [{
    uuid: randomUUID(),
    event_type: 'qodercli-back-flow-agent-query-finish',
    event_time: Date.now(),
    uid, oid, mid: machineId, aid,
    os_arch: process.arch, os_version: '',
    ide_type: 'CLI', ide_version: '1.1.57', cluster_env: '',
    business_id: requestSetId, git_remote: '',
    event_data: {
      items: [{
        schema_version: 2, session_id: sessionId, task_id: requestSetId,
        request_set_id: requestSetId, prompt_id: randomUUID(),
        entry: 'cli', product: 'cli', client_type: '5', cli_version: '1.1.57', os_type: process.platform,
        query_callback: 'end', terminal_reason: 'complete', business_state_final: 'complete',
        duration_ms: 3000, loop_iteration_count: 1,
        model_request_count: 1, model_request_success_count: 1, actual_model: MODEL,
        total_input_tokens: usage?.prompt_tokens ?? 0, total_output_tokens: usage?.completion_tokens ?? 0,
        total_cache_read_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0, total_cache_write_tokens: 0,
        total_thinking_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        total_credits: usage?.credits ?? 0, total_original_credits: usage?.original_credits ?? usage?.credits ?? 0,
        average_ttft_ms: 1000, delivery_mode: 'best_effort_background',
      }],
    },
  }]
  const signed = await cosy.prepareSigned(cred, { endpoint: INFER, path: '/api/v1/tracking', method: 'POST', mode: 'sign', body: JSON.stringify(envelope) })
  const res = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'Content-Type': 'application/json' }, body: signed.body })
  const text = await res.text()
  console.log(`  tracking HTTP ${res.status} url=${signed.url} resp=${text.slice(0, 160)}`)
  return { url: signed.url, status: res.status, resp: text.slice(0, 2000) }
}

/** 归因字段信封（官方 A6e 形态的归因子集，无语义字段）。 */
function attributionFields({ sessionId, requestId, requestSetId, withBusiness }) {
  const f = {
    request_id: requestId, request_set_id: requestSetId, chat_record_id: requestId,
    session_id: sessionId,
    chat_task: 'FREE_INPUT',
    chat_context: { text: PROMPT, features: [], extra: { context: [], modelConfig: { key: MODEL, is_reasoning: false }, originalContent: PROMPT }, chatPrompt: '', imageUrls: null },
    is_reply: true, is_retry: false,
    source: 1, version: '3',
    agent_id: 'agent_common', task_id: 'common',
    session_type: 'qoderclicn', aliyun_user_type: '',
    model_config: { key: MODEL, display_name: MODEL, model: '', format: 'openai', is_vl: false, is_reasoning: true, api_key: '', url: '', source: 'system', max_input_tokens: 131072 },
  }
  if (withBusiness) {
    f.business = { product: 'cli', version: '1.1.57', type: 'agent', id: requestSetId, name: PROMPT.slice(0, 10), begin_at: Date.now(), stage: 'processing' }
  }
  return f
}

// ── 梯度 ─────────────────────────────────────────────────────────────────
const evidence = { at: new Date().toISOString(), model: MODEL, settleMs: SETTLE_MS, arms: [] }
const ARMS = {
  1: async () => { // finish-only
    const ids = { sessionId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce({})
    const finish = await businessFinish(ids)
    return { ids, chat, finish }
  },
  2: async () => { // envelope
    const ids = { sessionId: randomUUID(), requestId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce(attributionFields({ ...ids, withBusiness: false }))
    return { ids, chat }
  },
  3: async () => { // env-business
    const ids = { sessionId: randomUUID(), requestId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce(attributionFields({ ...ids, withBusiness: true }))
    return { ids, chat }
  },
  4: async () => { // env-finish
    const ids = { sessionId: randomUUID(), requestId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce(attributionFields({ ...ids, withBusiness: true }))
    const finish = await businessFinish(ids)
    return { ids, chat, finish }
  },
  5: async () => { // tracking
    const ids = { sessionId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce({})
    const track = await tracking({ ...ids, usage: chat.usage })
    return { ids, chat, track }
  },
  6: async () => { // 全保真信封：归因字段 + business 块 + system/parameters/tools（官方 A6e 全字段）
    const ids = { sessionId: randomUUID(), requestId: randomUUID(), requestSetId: randomUUID() }
    const chat = await chatOnce({
      ...attributionFields({ ...ids, withBusiness: true }),
      system: 'You are Qoder, an AI coding assistant.',
      tools: [],
      parameters: { max_tokens: 32768 },
    })
    return { ids, chat }
  },
  7: async () => { // IDE 面：session_type=qoder_work + business.product=ide（桌面客户端形态）
    const ids = { sessionId: randomUUID(), requestId: randomUUID(), requestSetId: randomUUID() }
    const fields = attributionFields({ ...ids, withBusiness: true })
    fields.session_type = 'qoder_work'
    fields.business.product = 'ide'
    const chat = await chatOnce(fields)
    const finishInner = await businessFinish(ids)
    return { ids, chat, finish: finishInner }
  },
}

for (const n of [1, 2, 3, 4, 5, 6, 7]) {
  if (onlyArm && n !== onlyArm) continue
  console.log(`\n══ 臂 ${n} ══`)
  const before = await counters(`arm${n}-before`)
  const result = await ARMS[n]()
  console.log(`  静置 ${SETTLE_MS / 1000}s…`)
  await sleep(SETTLE_MS)
  const after = await counters(`arm${n}-after`)
  const moved = ['addOnUsed', 'totalCredits', 'heatToday'].filter((k) => typeof before[k] === 'number' && typeof after[k] === 'number' && after[k] !== before[k])
  console.log(`  → ${moved.length ? '★ 动了：' + moved.map((k) => `${k} ${before[k]}→${after[k]}`).join(', ') : '计数器不动'}`)
  evidence.arms.push({ arm: n, before, after, moved, result })
  await sleep(2000)
}

const movedArms = evidence.arms.filter((a) => a.moved.length).map((a) => a.arm)
evidence.verdict = movedArms.length
  ? `★ 臂 ${movedArms.join(',')} 让计数器增长——记账归因要素在其中`
  : '全部臂计数器不动——归因要素未覆盖（候选：system/parameters 语义字段、sub_task、或服务端按日批处理）'
console.log('\n【总结】', evidence.verdict)

mkdirSync(PROBES_DIR, { recursive: true })
const out = join(PROBES_DIR, `qoder-attribution-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('证据 →', out)
process.exit(0)
