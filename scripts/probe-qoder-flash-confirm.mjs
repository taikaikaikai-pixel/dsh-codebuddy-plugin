#!/usr/bin/env node
/**
 * Qoder CN — Qwen3.8-Flash（qfmodel）上游节点状态确认探针（幂等、只读）。
 *
 * 背景（2026-09-22 定案，证据 docs/diagnosis-qoder-flash.md）：qfmodel 的上游后端节点
 * `oa_qwen-plus-main` 于 04:21:38–04:21:51 之间进入持久失败——任何客户端形态（含 Qoder
 * 官方客户端自己的签名器/元数据/body/版本号）都会拿到 HTTP 200 信封装带内业务错误
 * `{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}`。
 * 本探针只做一件事：3 次 qfmodel + 2 次对照（qmodel_38max/q37fmodel），节点恢复的瞬间
 * 就会翻绿。
 *
 * 用法：
 *   node scripts/probe-qoder-flash-confirm.mjs            # 打印 + 落证据 docs/probes/
 *   node scripts/probe-qoder-flash-confirm.mjs --quiet    # 只打印一行结论
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROBES_DIR = join(ROOT, 'docs', 'probes')
const ENDPOINT = process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn'
const GAP_MS = Number(process.env.QODER_GAP_MS ?? 2000)
const quiet = process.argv.includes('--quiet')

const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')

const store = readJson(join(DSH_HOME, 'qoder-plugin-auth.json'))
if (!store?.auth?.accessToken) {
  console.error('未登录：先跑 scripts/probe-qoder-live.mjs --login')
  process.exit(1)
}
const cred = { accessToken: store.auth.accessToken, machineId: store.machine?.machineId, uid: store.account?.uid }
const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** SSE 信封 → {text, err, frames}。 */
function dissect(raw) {
  let text = '', err = null, frames = 0
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    let frame; try { frame = JSON.parse(line.slice(5)) } catch { continue }
    if (typeof frame?.body !== 'string' || frame.body === '[DONE]') continue
    frames++
    let chunk; try { chunk = JSON.parse(frame.body) } catch { err = frame.body.slice(0, 200); continue }
    if (chunk.message && !chunk.choices) { err = `${chunk.code}: ${chunk.message}`; continue }
    if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content
  }
  return { text, err, frames }
}

async function probe(label, modelKey) {
  const body = JSON.stringify({
    model: modelKey, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
  })
  const rec = { label, modelKey, at: new Date().toISOString() }
  try {
    const signed = await cosy.prepareChat(cred, { endpoint: ENDPOINT, body, modelKey, modelSource: 'system' })
    rec.url = signed.url
    rec.clientType = signed.headers['Cosy-ClientType']
    const res = await fetch(signed.url, {
      method: 'POST',
      headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: signed.body,
    })
    rec.status = res.status
    const raw = await res.text()
    rec.raw = raw.slice(0, 20_000)
    Object.assign(rec, dissect(raw))
  } catch (e) {
    rec.netErr = String(e?.message ?? e)
  }
  const verdict = rec.netErr ? `netErr=${rec.netErr}` : rec.err ? `❌ ${rec.err}` : rec.text?.trim() ? `✅ "${rec.text.trim().slice(0, 30)}"` : '⚠️ 无正文'
  if (!quiet) console.log(`${(rec.err || rec.netErr) ? '❌' : '✅'} ${label.padEnd(28)} HTTP ${rec.status ?? '-'} frames=${rec.frames ?? 0} ${verdict}`)
  return rec
}

const records = []
for (let i = 1; i <= 3; i++) { records.push(await probe(`qfmodel #${i}`, 'qfmodel')); await sleep(GAP_MS) }
for (const m of ['qmodel_38max', 'q37fmodel']) { records.push(await probe(`control ${m}`, m)); await sleep(GAP_MS) }

const flashOk = records.filter((r) => r.modelKey === 'qfmodel' && !r.err && !r.netErr && r.text?.trim()).length
const controlOk = records.filter((r) => r.modelKey !== 'qfmodel' && !r.err && !r.netErr && r.text?.trim()).length
mkdirSync(PROBES_DIR, { recursive: true })
const out = join(PROBES_DIR, `qoder-flash-confirm-${Date.now()}.json`)
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), endpoint: ENDPOINT, records }, null, 2))
console.log(`\n【结论】qfmodel 成功 ${flashOk}/3，对照成功 ${controlOk}/2 → ${flashOk > 0 ? '★ 上游节点已恢复，可复测 --suite flash' : (controlOk === 2 ? '上游节点仍故障（对照正常，链路健康）' : '⚠️ 连对照都失败：先查账号/网络')}`)
console.log('证据 →', out)
process.exit(0)
