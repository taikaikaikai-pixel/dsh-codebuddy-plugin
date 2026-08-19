#!/usr/bin/env node
/**
 * developer-rejection boundary probe (Hermes exploration, 2026-08-19)
 *
 * Understanding-only continuation of topic 6 (content-moderation.md).
 * Kimi's probe pinned the gate: L1 gateway pre-routing check, literal
 * role:"developer" → HTTP 500 / 11128.
 *
 * This round maps the BOUNDARY of that literal check, to understand what the
 * validator sees and does NOT see. Emphasis: understanding, not bypass.
 * We never use a variant to actually run a harmful/rejected request end-to-end
 * to completion — rejected arms simply confirm the boundary, passing arms
 * are max_tokens=8 stub completions that answer "OK".
 *
 * Arms (all max_tokens=8, 2.5s spacing, one account, read-only intent):
 *   case variants      : role:"Developer", "DEVELOPER", "developer " (trailing space)
 *   unicode variants   : fullwidth ｄｅｖｅｌｏｐｅｒ, "dev\u0065loper" (normalized-form test via JSON escape)
 *   structural variants: developer as object with extra keys, array-of-roles (role in content), role:"system" containing "developer" text
 *   control            : role:"system" (should pass 200)
 *
 * The goal: answer — is the gate an exact byte match on the string
 * "developer", or does it normalize (case/unicode/whitespace) before match?
 * This is a *classification* result (which variants are rejected vs passed),
 * NOT a circumvention — findings feed docs/rules content only.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const SPACING_MS = 2500
const MODEL = 'glm-5.2'
const OUT = join('docs', 'probes', `dev-role-boundary-${new Date().toISOString().slice(0, 10)}.jsonl`)

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
const redact = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

// Each variant: a function returning [role, content] or null (skip)
const SYS = 'You are a concise test agent. Answer with exactly: OK'

const ARMS = [
  { name: 'C0-control-system', role: 'system', note: 'control: system must pass', expectPass: true },
  { name: 'C1-developer-baseline', role: 'developer', note: 'baseline: literal developer must be rejected', expectPass: false },
  { name: 'C2-case-Developer', role: 'Developer', note: 'capital D: case-sensitive?', expectPass: null },
  { name: 'C3-case-DEVELOPER', role: 'DEVELOPER', note: 'all caps', expectPass: null },
  { name: 'C4-trailing-space', role: 'developer ', note: 'trailing space inside role value', expectPass: null },
  { name: 'C5-fullwidth', role: 'ｄｅｖｅｌｏｐｅｒ', note: 'fullwidth unicode homoglyph', expectPass: null },
  { name: 'C6-escaped-e', role: 'dev\u0065loper', note: 'JSON escape \\u0065 = literal e: should equal developer', expectPass: false },
  { name: 'C7-role-in-content', role: 'user', content: `developer message`, note: 'role user but content mentions developer: gate on content or role?', expectPass: true, useContent: true },
]

async function run() {
  const key = resolveKey()
  const results = []
  for (const arm of ARMS) {
    const role = arm.useContent ? 'user' : arm.role
    const content = arm.useContent
      ? (arm.content || `developer: ${SYS}`)
      : SYS
    const messages = [{ role, content }]
    const body = {
      model: MODEL,
      stream: true,
      max_tokens: 8,
      messages,
    }
    try {
      const started = Date.now()
      const resp = await fetch(`${GATEWAY}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
        },
        body: JSON.stringify(body),
      })
      const text = await resp.text()
      const ms = Date.now() - started
      let code = null, msg = null
      try { const j = JSON.parse(text); code = j.code; msg = j.msg } catch { /* sse */ }
      const raw = text.slice(0, 200)
      const entry = {
        type: 'probe',
        at: new Date().toISOString(),
        name: arm.name,
        role: role,
        expectPass: arm.expectPass,
        note: arm.note,
        status: resp.status,
        code,
        msg,
        ms,
        raw: redact(raw),
      }
      results.push(entry)
      appendFileSync(OUT, JSON.stringify(entry) + '\n')
      console.log(`${arm.name.padEnd(26)} status=${resp.status} code=${code ?? '-'} msg=${(msg ?? '').slice(0, 40)} ${ms}ms`)
    } catch (e) {
      const entry = { type: 'probe', at: new Date().toISOString(), name: arm.name, error: String(e) }
      results.push(entry)
      appendFileSync(OUT, JSON.stringify(entry) + '\n')
      console.log(`${arm.name.padEnd(26)} ERROR ${e}`)
    }
    await sleep(SPACING_MS)
  }
  console.log(`\nDone. ${results.length} arms → ${OUT}`)
}

run().catch((e) => { console.error(e); process.exit(1) })