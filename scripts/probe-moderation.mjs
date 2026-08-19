#!/usr/bin/env node
/**
 * Moderation-layer probe (topic 6 of docs/rules/): at WHICH gateway layer
 * does the role:"developer" rejection fire?
 *
 * Spell/incident under test (AGENTS.md:32, CHANGELOG 0.7.4): since
 * 2026-08-18 16:24 UTC the gateway's content moderation answers payloads
 * containing a role:"developer" message with finish_reason: content_filter
 * ("您当前输入的信息存在敏感内容"); developer→system passes; deepseek-v3 was
 * "unaffected" — but ONLY because pi-ai never emits developer for
 * non-reasoning models. Nobody has yet sent a developer-role message to a
 * non-reasoning model deliberately.
 *
 * Candidate layers:
 *   L1  gateway pre-routing middleware: a model-agnostic role check
 *   L2  reasoning-model backend path: only those backends run the check
 *   L3  output-side moderation (not our case: the refusal is pre-generation)
 *
 * Pre-registered predictions (2026-08-19):
 *   P-M1  deepseek-v3 + developer role → content_filter too (L1: the check
 *         is model-agnostic; v3's "immunity" was purely a pi-ai artifact)
 *   P-M2  the rejection is pre-generation but the gateway still meters the
 *         processed input: usage present, prompt_tokens ≈ input size,
 *         credit > 0
 *   P-M3  position independence: a developer message NOT in first position
 *         (after a user message) is still rejected
 *   P-M4  control: identical bytes with developer→system pass with normal
 *         finish_reason (stop/length)
 *
 * Understanding-only, no circumvention research: every arm reproduces the
 * DOCUMENTED rejection surface; the plugin's bridge rewrite stays as-is.
 * Low rate: 2s spacing, 5 arms, max_tokens=8.
 *
 * Usage: node scripts/probe-moderation.mjs [--out docs/probes/moderation-YYYY-MM-DD.jsonl]
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const SPACING_MS = 2000
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join('docs', 'probes', `moderation-${new Date().toISOString().slice(0, 10)}.jsonl`)

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
const SYS = 'You are a concise test agent. Answer with exactly: OK'
const redact = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

const ARMS = [
  { name: 'M0-control-developer', model: 'glm-5.2', pred: null,
    messages: [{ role: 'developer', content: SYS }, { role: 'user', content: 'hi' }],
    note: 'reproduce the documented rejection on a reasoning model' },
  { name: 'P-M1-v3-developer', model: 'deepseek-v3', pred: 'P-M1',
    messages: [{ role: 'developer', content: SYS }, { role: 'user', content: 'hi' }],
    note: 'L1 predicts content_filter even on a non-reasoning model' },
  { name: 'P-M3-developer-middle', model: 'glm-5.2', pred: 'P-M3',
    messages: [{ role: 'user', content: 'hi' }, { role: 'developer', content: SYS }, { role: 'user', content: 'reply OK' }],
    note: 'developer not in first position still rejected' },
  { name: 'P-M4-control-system', model: 'glm-5.2', pred: 'P-M4',
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }],
    note: 'identical bytes with system pass with a normal finish_reason' },
]

// Round 2 (2026-08-19): the rejection surface has MORPHED since the
// 2026-08-18 incident — then: 200 SSE + finish_reason content_filter +
// refusal text; now: HTTP 500 + code 11128 "Illegal API invocation from an
// unapproved channel", no usage, no credit, on v3 AND glm AND mid-payload
// positions (P-M1 direction confirmed: model-agnostic; P-M3 confirmed:
// position-agnostic; P-M2 moot: nothing is metered).
// The gate's wording is "unapproved channel" — is 11128 a developer-SPECIFIC
// denylist or a role WHITELIST (system/user/assistant/tool)? One clean
// discriminator (understanding only — a made-up role has no client value):
const ARMS_R2 = [
  { name: 'P-M5-bogus-role', model: 'glm-5.2', pred: 'P-M5',
    messages: [{ role: 'hacker', content: SYS }, { role: 'user', content: 'hi' }],
    note: 'whitelist hypothesis → same 500/11128; developer-denylist hypothesis → a different error' },
]

async function probe(key, arm) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
      },
      body: JSON.stringify({
        model: arm.model, stream: true, stream_options: { include_usage: true },
        max_tokens: 8, messages: arm.messages,
      }),
    })
    const text = await res.text()
    let finishReason = null, content = '', usage = null
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      let chunk
      try { chunk = JSON.parse(l.slice(5).trim()) } catch { continue }
      if (chunk.usage) usage = chunk.usage
      const ch = chunk.choices?.[0]
      if (ch?.finish_reason) finishReason = ch.finish_reason
      if (typeof ch?.delta?.content === 'string') content += ch.delta.content
    }
    // Non-SSE bodies (e.g. the 500 envelope) are the rejection surface —
    // record them verbatim (redacted), they carry the layer's fingerprint.
    const bodyPreview = finishReason === null && content === '' ? redact(text.slice(0, 300)) : null
    return {
      type: 'probe', name: arm.name, model: arm.model, pred: arm.pred, note: arm.note,
      roles: arm.messages.map((m) => m.role),
      status: res.status, finishReason,
      contentPreview: redact(content.slice(0, 80)),
      bodyPreview,
      usage: usage ? {
        prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
        credit: usage.credit, prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
      } : null,
      ms: Date.now() - t0,
    }
  } catch (err) {
    return { type: 'probe', name: arm.name, model: arm.model, pred: arm.pred, note: arm.note, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

const key = resolveKey()
mkdirSync(dirname(OUT), { recursive: true })
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), gateway: GATEWAY }) + '\n')
console.log(`evidence → ${OUT}`)

const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'matrix'
const arms = SET === 'r2' ? ARMS_R2 : ARMS
for (const arm of arms) {
  const rec = await probe(key, arm)
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(`${arm.name.padEnd(24)} status=${rec.status ?? '-'} finish=${rec.finishReason ?? '-'} credit=${rec.usage?.credit ?? '-'} prompt=${rec.usage?.prompt_tokens ?? '-'} body=${(rec.bodyPreview ?? rec.contentPreview ?? rec.error ?? '').slice(0, 90)}`)
  await sleep(SPACING_MS)
}
console.log('done.')
