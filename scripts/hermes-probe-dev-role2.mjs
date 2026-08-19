#!/usr/bin/env node
/**
 * developer-rejection boundary probe — ROUND 2 (Hermes exploration)
 *
 * Round 1 established: gate is exact-literal byte match on lowercase "developer".
 * Round 2 maps POSITION and STRUCTURE sensitivity of that literal check:
 *
 *   P1  developer as SECOND message (after user)      → still rejected? (position)
 *   P2  developer LAST message (after user+assistant)  → still rejected?
 *   P3  mixed: system + developer + user               → affects?
 *   P4  two developers in different messages           → counted individually?
 *   P5  role:"developer " + role:"developer" together   → does trailing-space one trigger?
 *   P6  role as string "developer" but in a nested object (tool message) → does tool path check?
 *   P7  control: all system + user                     → pass
 *
 * All max_tokens=8, 2.5s spacing, understanding-only (no completion of any
 * rejected path; passing arms only answer "OK").
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const SPACING_MS = 2500
const MODEL = 'glm-5.2'
const OUT = join('docs', 'probes', `dev-role-boundary2-${new Date().toISOString().slice(0, 10)}.jsonl`)

function resolveKey() {
  try {
    const cfg = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin.json'), 'utf8'))
    const active = (cfg.apiKeys ?? []).find((k) => k.name === cfg.activeApiKey)
    if (active?.key) return active.key
  } catch { /* fall through */ }
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return m[1]
  }
  throw new Error('no CodeBuddy credential found')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (v) => typeof v === 'string' ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>') : v
const SYS = 'You are a concise test agent. Answer with exactly: OK'

// messages builder per arm
const ARMS = [
  { name: 'P7-control', mk: () => [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }], note: 'control: no developer at all, expect 200' },
  { name: 'P1-dev-second', mk: () => [{ role: 'user', content: 'hi' }, { role: 'developer', content: SYS }, { role: 'user', content: 'ok?' }], note: 'developer in middle position' },
  { name: 'P2-dev-last', mk: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hi' }, { role: 'developer', content: SYS }], note: 'developer as last message' },
  { name: 'P3-sys-dev-user', mk: () => [{ role: 'system', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'system then developer then user' },
  { name: 'P4-two-dev', mk: () => [{ role: 'developer', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'two developer messages' },
  { name: 'P5-space-then-dev', mk: () => [{ role: 'developer ', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'trailing-space dev (passes) then real dev (rejects?)' },
  { name: 'P6-tool-dev', mk: () => [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'call tool', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'developer deep inside' }], note: 'developer string only inside tool content' },
]

async function run() {
  const key = resolveKey()
  for (const arm of ARMS) {
    const messages = arm.mk()
    const body = { model: MODEL, stream: true, max_tokens: 8, messages }
    try {
      const started = Date.now()
      const resp = await fetch(`${GATEWAY}/v2/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'User-Agent': 'CLI/unknown CodeBuddy/2.136.0' },
        body: JSON.stringify(body),
      })
      const text = await resp.text()
      const ms = Date.now() - started
      let code = null, msg = null
      try { const j = JSON.parse(text); code = j.code; msg = j.msg } catch { /* sse */ }
      const entry = { type: 'probe', at: new Date().toISOString(), name: arm.name, note: arm.note, status: resp.status, code, msg, ms, raw: redact(text.slice(0, 120)) }
      appendFileSync(OUT, JSON.stringify(entry) + '\n')
      console.log(`${arm.name.padEnd(20)} status=${resp.status} code=${code ?? '-'} msg=${(msg ?? '').slice(0, 44)} ${ms}ms`)
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ type: 'probe', at: new Date().toISOString(), name: arm.name, error: String(e) }) + '\n')
      console.log(`${arm.name.padEnd(20)} ERROR ${e}`)
    }
    await sleep(SPACING_MS)
  }
  console.log(`\nDone → ${OUT}`)
}
run().catch((e) => { console.error(e); process.exit(1) })