#!/usr/bin/env node
/**
 * Qoder CN — 用量统计归因判别实验（真实网络、本人账号、幂等只读+1 次最小聊天）。
 *
 * 课题（2026-09-22 用户报障）：经 dsh 插件使用 Qoder CN 通道后，Qoder 官方
 * 用量统计（quota/usage、sash me/usage、网页 account/usage）不显示/不增长；
 * 用官方客户端聊天则正常统计。官方客户端每轮 query 结束后额外上报
 * business/finish（BUSINESS_FINISH 事件）与 /api/v1/tracking（聚合 credits），
 * 且聊天 body 明文带 business/session_id/request_id 等归因字段——插件发的是
 * 裸 OpenAI body，两边都没有。
 *
 * 判别逻辑（一次定案）：
 *   聊天前后各拉一遍统计端点，对比 addOnQuota.used 等计数器——
 *   - 涨   = 服务端按请求自动记账，缺的只是展示层归因（business 块 + finish 上报）；
 *   - 不涨 = 服务端对缺归因信封的请求不计入配额，需把字段塞进聊天 body 明文。
 *
 * 用法：
 *   node scripts/probe-qoder-quota.mjs             # 基线 → 1 次聊天 → 5s/20s 后复拉
 *   node scripts/probe-qoder-quota.mjs --read-only # 只拉端点不聊天
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROBES_DIR = join(ROOT, 'docs', 'probes')
const OPENAPI = process.env.QODER_OPENAPI ?? 'https://openapi.qoder.com.cn'
const INFER = process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn'
const CHAT_MODEL = process.env.QODER_QUOTA_MODEL ?? 'q37fmodel' // 对照健康、单价最低档
const readOnly = process.argv.includes('--read-only')

const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')

const store = readJson(join(DSH_HOME, 'qoder-plugin-auth.json'))
if (!store?.auth?.accessToken) {
  console.error('未登录：先跑 scripts/probe-qoder-live.mjs --login')
  process.exit(1)
}
const token = store.auth.accessToken
const cred = { accessToken: token, machineId: store.machine?.machineId, uid: store.account?.uid }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ENDPOINTS = [
  ['quotaUsage', 'GET', `${OPENAPI}/api/v2/quota/usage`],
  ['quotaUsageOuter', 'GET', `${OPENAPI}/api/v2/quota/usage?outerProviders=cmcc`],
  ['meUsage', 'GET', `${OPENAPI}/sash/api/v2/me/usage`],
  ['creditsHeatmap', 'GET', `${OPENAPI}/sash/api/v1/ai-conversations/credits-heatmap?days=1`],
  ['creditsSummary', 'GET', `${OPENAPI}/sash/api/v1/ai-conversations/credits-summary`],
  ['userPlan', 'GET', `${OPENAPI}/api/v2/user/plan`],
]

async function pullAll(tag) {
  const snap = { tag, at: new Date().toISOString(), endpoints: {} }
  for (const [name, method, url] of ENDPOINTS) {
    const rec = {}
    try {
      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } })
      rec.status = res.status
      const text = await res.text()
      rec.body = text.length <= 20_000 ? text : text.slice(0, 20_000) + '…(截断)'
    } catch (e) {
      rec.netErr = String(e?.message ?? e)
    }
    snap.endpoints[name] = rec
    console.log(`  [${tag}] ${name.padEnd(16)} HTTP ${rec.status ?? '-'} ${rec.body ? String(rec.body).slice(0, 160) : (rec.netErr ?? '')}`)
    await sleep(400)
  }
  return snap
}

/** 提取计数器摘要用于 diff（结构未知时原样保留原文）。 */
function summarize(snap) {
  const out = {}
  for (const [name, rec] of Object.entries(snap.endpoints)) {
    try {
      const j = JSON.parse(rec.body)
      out[name] = j
    } catch { out[name] = rec.body ?? rec.netErr }
  }
  return out
}

const evidence = { at: new Date().toISOString(), openapi: OPENAPI, chatModel: CHAT_MODEL, steps: [] }

console.log('① 基线拉取：')
const before = await pullAll('before')
evidence.steps.push({ step: 'before', data: summarize(before) })

if (!readOnly) {
  console.log('\n② 最小聊天（cosy 签名裸 OpenAI body，与插件网关出站同形态）：')
  const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
  const body = JSON.stringify({
    model: CHAT_MODEL, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
  })
  const chatRec = { model: CHAT_MODEL }
  try {
    const signed = await cosy.prepareChat(cred, { endpoint: INFER, body, modelKey: CHAT_MODEL, modelSource: 'system' })
    chatRec.url = signed.url
    const res = await fetch(signed.url, {
      method: 'POST',
      headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: signed.body,
    })
    chatRec.status = res.status
    const raw = await res.text()
    chatRec.raw = raw.slice(0, 20_000)
    // 取尾帧 usage
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      let frame; try { frame = JSON.parse(line.slice(5)) } catch { continue }
      if (typeof frame?.body !== 'string' || frame.body === '[DONE]') continue
      let chunk; try { chunk = JSON.parse(frame.body) } catch { continue }
      if (chunk.usage) chatRec.usage = chunk.usage
      if (chunk.choices?.[0]?.delta?.content) chatRec.text = (chatRec.text ?? '') + chunk.choices[0].delta.content
    }
    console.log(`  chat HTTP ${chatRec.status} 正文=${JSON.stringify((chatRec.text ?? '').slice(0, 30))} usage=${JSON.stringify(chatRec.usage)}`)
  } catch (e) {
    chatRec.netErr = String(e?.message ?? e)
    console.log('  chat 网络错误：', chatRec.netErr)
  }
  evidence.steps.push({ step: 'chat', data: chatRec })

  console.log('\n③ 5s 后复拉：')
  await sleep(5000)
  const after5 = await pullAll('after5s')
  evidence.steps.push({ step: 'after5s', data: summarize(after5) })

  console.log('\n④ 20s 后复拉：')
  await sleep(20_000)
  const after25 = await pullAll('after25s')
  evidence.steps.push({ step: 'after25s', data: summarize(after25) })

  // 计数器 diff（只关心数字字段）
  const num = (snap, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), snap)
  const counters = [
    ['quotaUsage', 'addOnQuota.used'], ['quotaUsage', 'userQuota.used'],
    ['quotaUsageOuter', 'addOnQuota.used'], ['quotaUsageOuter', 'userQuota.used'],
  ]
  console.log('\n【计数器 diff】')
  const diffs = []
  for (const [ep, path] of counters) {
    const pick = (snap) => { const e = snap.data[ep]; const parts = path.split('.'); let v = e; for (const p of parts) v = v?.[p]; return typeof v === 'number' ? v : null }
    const b = pick(evidence.steps[0]), a = pick(evidence.steps[evidence.steps.length - 1])
    const line = `  ${ep}.${path}: ${b ?? '?'} → ${a ?? '?'} ${b != null && a != null ? (a > b ? '★ 涨了 +' + (a - b) : (a === b ? '（不变）' : '（降了？!）')) : ''}`
    console.log(line)
    diffs.push({ counter: `${ep}.${path}`, before: b, after: a })
  }
  evidence.diffs = diffs
  const grew = diffs.some((d) => d.before != null && d.after != null && d.after > d.before)
  evidence.verdict = grew
    ? 'billing-ok-display-gap：扣费计数器在涨，缺的只是展示层归因（business 块/finish 上报）'
    : 'not-counted：计数器不动——服务端对缺归因信封的请求可能不计入配额，需在聊天 body 明文补归因字段复测'
  console.log('\n【结论】', evidence.verdict)
}

mkdirSync(PROBES_DIR, { recursive: true })
const out = join(PROBES_DIR, `qoder-quota-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('\n证据 →', out)
process.exit(0)
