#!/usr/bin/env node
/**
 * developer-rejection boundary probe — ROUND 3 (Hermes exploration)
 *
 * R1: exact-literal match on lowercase "developer" in role field.
 * R2: position-independent; per-message independent check; role field only.
 *
 * R3 maps the *shape* the validator can see — i.e. HOW it enumerates
 * messages. Questions:
 *
 *   S1  duplicate role fields in ONE message object  → validator reads first? last? any?
 *   S2  role as non-string (number)                   → parse tolerance?
 *   S3  role missing entirely (bare content)          → does it 400/accept?
 *   S4  role:"developer" with content as array        → content shape affects the check? (true content block form)
 *   S5  multi-content blocks (one developer, one user) → same object, mixed roles?
 *   S6  control again
 *
 * All max_tokens=8, 2.5s, understanding-only.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const SPACING_MS = 2500
const MODEL = 'glm-5.2'
const OUT = join('docs', 'probes', `dev-role-boundary3-${new Date().toISOString().slice(0, 10)}.jsonl`)

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

// raw body per arm (we need raw object control for structural probes)
const ARMS = [
  { name: 'S6-control', mk: () => ({ messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }] }), note: 'control' },
  { name: 'S1-dup-role', mk: () => ({ messages: [{ role: 'developer', role2: 'user', content: SYS }, { role: 'user', content: 'hi' }] }), note: 'two role-ish keys in one object' },
  { name: 'S2-role-number', mk: () => ({ messages: [{ role: 1, content: SYS }, { role: 'user', content: 'hi' }] }), note: 'role as integer' },
  { name: 'S3-no-role', mk: () => ({ messages: [{ content: SYS }, { role: 'user', content: 'hi' }] }), note: 'message without any role field' },
  { name: 'S4-dev-array', mk: () => ({ messages: [{ role: 'developer', content: [{ type: 'text', text: SYS }] }, { role: 'user', content: 'hi' }] }), note: 'developer with content as array of blocks' },
  { name: 'S5-mixed-blocks', mk: () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: SYS }] }], extra: { role: 'developer' } }), note: 'developer only in top-level extra (not messages array)' },
]

async function run() {
  const key = resolveKey()
  for (const arm of ARMS) {
    const base = arm.mk()
    const body = { model: MODEL, stream: true, max_tokens: 8, ...base }
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
      console.log(`${arm.name.padEnd(18)} status=${resp.status} code=${code ?? '-'} msg=${(msg ?? '').slice(0, 44)} ${ms}ms`)
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ type: 'probe', at: new Date().toISOString(), name: arm.name, error: String(e) }) + '\n')
      console.log(`${arm.name.padEnd(18)} ERROR ${e}`)
    }
    await sleep(SPACING_MS)
  }
  console.log(`\nDone → ${OUT}`)
}
run().catch((e) => { console.error(e); process.exit(1) })