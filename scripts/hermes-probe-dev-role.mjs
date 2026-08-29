#!/usr/bin/env node
/**
 * developer-rejection boundary probe (Hermes exploration) — 三轮合并版（2026-08-29）
 * Usage: node scripts/hermes-probe-dev-role.mjs [--round 1|2|3]（默认 1）
 *
 * 轮次考古（臂表/判据/落盘文件名/日志格式均保持各轮原样）：
 *   --round 1 = 原 hermes-probe-dev-role.mjs  （C0–C7，落盘 dev-role-boundary-<date>.jsonl）
 *   --round 2 = 原 hermes-probe-dev-role2.mjs （P1–P7，落盘 dev-role-boundary2-<date>.jsonl）
 *   --round 3 = 原 hermes-probe-dev-role3.mjs （S1–S6，落盘 dev-role-boundary3-<date>.jsonl）
 *
 * ── ROUND 1 (2026-08-19) ─────────────────────────────────────────────
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
 *
 * ── ROUND 2 ──────────────────────────────────────────────────────────
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
 *
 * ── ROUND 3 ──────────────────────────────────────────────────────────
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

// ─────────────────────────── ROUND 1（原 hermes-probe-dev-role.mjs） ───────────────────────────

const redactR1 = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

// Each variant: a function returning [role, content] or null (skip)
const ARMS_R1 = [
  { name: 'C0-control-system', role: 'system', note: 'control: system must pass', expectPass: true },
  { name: 'C1-developer-baseline', role: 'developer', note: 'baseline: literal developer must be rejected', expectPass: false },
  { name: 'C2-case-Developer', role: 'Developer', note: 'capital D: case-sensitive?', expectPass: null },
  { name: 'C3-case-DEVELOPER', role: 'DEVELOPER', note: 'all caps', expectPass: null },
  { name: 'C4-trailing-space', role: 'developer ', note: 'trailing space inside role value', expectPass: null },
  { name: 'C5-fullwidth', role: 'ｄｅｖｅｌｏｐｅｒ', note: 'fullwidth unicode homoglyph', expectPass: null },
  { name: 'C6-escaped-e', role: 'dev\u0065loper', note: 'JSON escape \\u0065 = literal e: should equal developer', expectPass: false },
  { name: 'C7-role-in-content', role: 'user', content: `developer message`, note: 'role user but content mentions developer: gate on content or role?', expectPass: true, useContent: true },
]

async function runRound1() {
  const OUT = join('docs', 'probes', `dev-role-boundary-${new Date().toISOString().slice(0, 10)}.jsonl`)
  const key = resolveKey()
  const results = []
  for (const arm of ARMS_R1) {
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
        raw: redactR1(raw),
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

// ─────────────────────────── ROUND 2（原 hermes-probe-dev-role2.mjs） ───────────────────────────

// messages builder per arm
const ARMS_R2 = [
  { name: 'P7-control', mk: () => [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }], note: 'control: no developer at all, expect 200' },
  { name: 'P1-dev-second', mk: () => [{ role: 'user', content: 'hi' }, { role: 'developer', content: SYS }, { role: 'user', content: 'ok?' }], note: 'developer in middle position' },
  { name: 'P2-dev-last', mk: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hi' }, { role: 'developer', content: SYS }], note: 'developer as last message' },
  { name: 'P3-sys-dev-user', mk: () => [{ role: 'system', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'system then developer then user' },
  { name: 'P4-two-dev', mk: () => [{ role: 'developer', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'two developer messages' },
  { name: 'P5-space-then-dev', mk: () => [{ role: 'developer ', content: SYS }, { role: 'developer', content: SYS }, { role: 'user', content: 'hi' }], note: 'trailing-space dev (passes) then real dev (rejects?)' },
  { name: 'P6-tool-dev', mk: () => [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'call tool', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'developer deep inside' }], note: 'developer string only inside tool content' },
]

async function runRound2() {
  const OUT = join('docs', 'probes', `dev-role-boundary2-${new Date().toISOString().slice(0, 10)}.jsonl`)
  const key = resolveKey()
  for (const arm of ARMS_R2) {
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

// ─────────────────────────── ROUND 3（原 hermes-probe-dev-role3.mjs） ───────────────────────────

// raw body per arm (we need raw object control for structural probes)
const ARMS_R3 = [
  { name: 'S6-control', mk: () => ({ messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }] }), note: 'control' },
  { name: 'S1-dup-role', mk: () => ({ messages: [{ role: 'developer', role2: 'user', content: SYS }, { role: 'user', content: 'hi' }] }), note: 'two role-ish keys in one object' },
  { name: 'S2-role-number', mk: () => ({ messages: [{ role: 1, content: SYS }, { role: 'user', content: 'hi' }] }), note: 'role as integer' },
  { name: 'S3-no-role', mk: () => ({ messages: [{ content: SYS }, { role: 'user', content: 'hi' }] }), note: 'message without any role field' },
  { name: 'S4-dev-array', mk: () => ({ messages: [{ role: 'developer', content: [{ type: 'text', text: SYS }] }, { role: 'user', content: 'hi' }] }), note: 'developer with content as array of blocks' },
  { name: 'S5-mixed-blocks', mk: () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: SYS }] }], extra: { role: 'developer' } }), note: 'developer only in top-level extra (not messages array)' },
]

async function runRound3() {
  const OUT = join('docs', 'probes', `dev-role-boundary3-${new Date().toISOString().slice(0, 10)}.jsonl`)
  const key = resolveKey()
  for (const arm of ARMS_R3) {
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

// ─────────────────────────── 轮次调度 ───────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : null
}
const ROUNDS = { 1: runRound1, 2: runRound2, 3: runRound3 }
const ROUND = argValue('--round') ?? '1'
if (process.argv.includes('--help') || !ROUNDS[ROUND]) {
  console.log('Usage: node scripts/hermes-probe-dev-role.mjs [--round 1|2|3]（默认 1；轮次对应见文件头注释）')
  process.exit(process.argv.includes('--help') ? 0 : 1)
}
ROUNDS[ROUND]().catch((e) => { console.error(e); process.exit(1) })
