#!/usr/bin/env node
/**
 * Cache-decline probe (docs/diagnosis-cache-decline.md, 2026-09-03).
 *
 * Question: why does deepseek-v4-flash prefix-cache hit rate decline much
 * faster through the dsh-tap plugin (CodeBuddy gateway) than through direct
 * dsh (DeepSeek official API)? This probe isolates the GATEWAY-side variables
 * under controlled payloads (max_tokens=16, ≤1 in flight):
 *
 *   --mode whoami  account identity behind the ck_ key vs the OAuth token
 *                  (are the two credentials even the same account?)
 *   --mode burst   same-prompt re-fires: read stability of one entry.
 *                  --auth ck|oauth|ab interleaves the two credentials (ABAB)
 *                  — credential-class routing is the confound this settles.
 *   --mode ttl     seed once, re-send at cumulative --gaps (entry unrefreshed
 *                  between fires) → time dimension of the decay curve.
 *   --mode grow    append-only growing prefix (mimics dsh tool-loop steps),
 *                  short gaps → write+read stability within a "turn";
 *                  --idle-after/--idle-grow adds one grown send after an idle
 *                  gap (mimics a turn start after idle).
 *   --mode replay  re-fire one REAL request body (--payload-file, a bridge
 *                  dump; the bridge's developer→system + stream transform is
 *                  applied) — same-prompt stability for the real dsh shape.
 *
 * Every arm embeds a unique nonce so entries never collide across runs.
 * Evidence → docs/probes/cache-decline-2026-09-03.jsonl (append).
 *
 * Usage:
 *   node scripts/probe-cache-decline.mjs --mode whoami
 *   node scripts/probe-cache-decline.mjs --mode burst --auth ab --size 16000 --calls 12
 *   node scripts/probe-cache-decline.mjs --mode ttl --auth oauth --size 16000 --gaps 30,120,600
 *   node scripts/probe-cache-decline.mjs --mode ttl --auth oauth --size 32000 --gaps 30,120,600
 *   node scripts/probe-cache-decline.mjs --mode grow --auth oauth --start 16000 --step 1500 --steps 8 --idle-after 60 --idle-grow 1500
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : null
}
const MODE = argValue('--mode') ?? 'burst'
const AUTH = argValue('--auth') ?? 'ck'
const MODEL = argValue('--model') ?? 'deepseek-v4-flash'
const SIZE = Number(argValue('--size') ?? 16000)
const CALLS = Number(argValue('--calls') ?? 12)
const GAPS = (argValue('--gaps') ?? '30,120,600').split(',').map(Number)
const START = Number(argValue('--start') ?? 16000)
const STEP = Number(argValue('--step') ?? 1500)
const STEPS = Number(argValue('--steps') ?? 8)
const GAP_MS = Number(argValue('--gap-ms') ?? 2000)
const IDLE_AFTER = Number(argValue('--idle-after') ?? 0)
const IDLE_GROW = Number(argValue('--idle-grow') ?? 0)
const OUT = join('docs', 'probes', 'cache-decline-2026-09-03.jsonl')

const runId = Math.random().toString(36).slice(2, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// calibration from probe-cache-ttl.mjs: 72 repeats ≈ 2.6k tokens
const TOK_PER_REPEAT = 36.1

// ---------------------------------------------------------------- credentials
function resolveCk() {
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
  throw new Error('no CodeBuddy ck_ credential found')
}

const AUTH_PATH = join(DSH_HOME, 'codebuddy-plugin-auth.json')

/** OAuth access token, refreshing via the documented endpoint when near expiry. */
async function resolveOauth() {
  const file = JSON.parse(readFileSync(AUTH_PATH, 'utf8'))
  const auth = file.auth ?? file // live layout nests tokens under `auth`
  if (!auth?.accessToken) throw new Error('no OAuth token in codebuddy-plugin-auth.json')
  if (!auth.expiresAt || auth.expiresAt - Date.now() > 120_000) return auth.accessToken
  const res = await fetch(`${GATEWAY}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      'X-Refresh-Token': auth.refreshToken ?? '',
    },
  })
  const body = await res.json().catch(() => null)
  if (!body || body.code !== 0 || !body.data?.accessToken) {
    throw new Error(`oauth refresh failed: http=${res.status}`)
  }
  writeFileSync(AUTH_PATH, JSON.stringify({
    ...file,
    auth: {
      ...auth,
      accessToken: body.data.accessToken,
      expiresAt: Date.now() + (body.data.expiresIn ?? 3600) * 1000,
      refreshToken: body.data.refreshToken ?? auth.refreshToken,
      refreshExpiresAt: body.data.refreshExpiresAt != null
        ? Date.now() + body.data.refreshExpiresAt * 1000
        : auth.refreshExpiresAt,
    },
  }))
  return body.data.accessToken
}

// ---------------------------------------------------------------- payload
const PARAGRAPH = 'Cache decline probe paragraph. The quick brown fox jumps over the lazy dog near the riverbank while engineers measure prefix-cache retention across identical and growing requests under controlled budgets. '
const REPEAT = Math.max(1, Math.round(SIZE / TOK_PER_REPEAT))
const START_REPEAT = Math.max(1, Math.round(START / TOK_PER_REPEAT))
const STEP_REPEAT = Math.max(1, Math.round(STEP / TOK_PER_REPEAT))

/** Fixed-shape payload: big system + probe user (burst/ttl). */
function fixedPayload(nonce) {
  return JSON.stringify({
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
    messages: [
      { role: 'system', content: `${nonce}\n` + PARAGRAPH.repeat(REPEAT) },
      { role: 'user', content: `Probe ${nonce}: reply with exactly: OK` },
    ],
  })
}

/** Growing payload: fixed system head + k synthetic user blocks + probe tail. */
function growPayload(nonce, k) {
  const blocks = []
  for (let i = 1; i <= k; i++) {
    blocks.push({ role: 'user', content: `Block ${nonce}-${i}: ` + PARAGRAPH.repeat(STEP_REPEAT) })
  }
  return JSON.stringify({
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
    messages: [
      { role: 'system', content: `${nonce} fixed system head.\n` + PARAGRAPH.repeat(START_REPEAT) },
      ...blocks,
      { role: 'user', content: `Probe ${nonce} step ${k}: reply with exactly: OK` },
    ],
  })
}

// ---------------------------------------------------------------- one call
async function call(token, body) {
  const t0 = Date.now()
  let ttfbMs = null
  try {
    const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
      },
      body,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let usage = null
    let sawDone = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (ttfbMs === null) ttfbMs = Date.now() - t0
      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line === 'data: [DONE]') { sawDone = true; continue }
        if (!line.startsWith('data:') || !line.includes('"usage"')) continue
        try {
          const chunk = JSON.parse(line.slice(5).trim())
          if (chunk.usage) usage = chunk.usage
        } catch { /* skip */ }
      }
    }
    return { status: res.status, ttfbMs, ms: Date.now() - t0, usage, complete: sawDone || usage != null }
  } catch (err) {
    return { status: 0, ttfbMs, ms: Date.now() - t0, error: String(err?.message ?? err), complete: false }
  }
}

function report(rec) {
  const u = rec.usage ?? {}
  const prompt = u.prompt_tokens ?? 0
  const hit = u.prompt_cache_hit_tokens ?? 0
  const rate = prompt > 0 ? (100 * hit / prompt).toFixed(1) + '%' : '-'
  appendFileSync(OUT, JSON.stringify({ type: 'probe', runId, ...rec }) + '\n')
  console.log(
    `${(rec.mode || '').padEnd(6)} ${(rec.auth ?? '').padEnd(5)} ${String(rec.tag ?? '').padEnd(12)} http=${rec.status}`
    + ` prompt=${u.prompt_tokens ?? '-'} hit=${hit} miss=${u.prompt_cache_miss_tokens ?? '-'} rate=${rate}`
    + ` credit=${u.credit ?? '-'} ttfb=${rec.ttfbMs ?? '-'}ms${rec.complete === false ? ' INCOMPLETE' : ''}`,
  )
}

const ck = resolveCk()
const oauth = MODE === 'whoami' || AUTH === 'oauth' || AUTH === 'ab' ? await resolveOauth() : null
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), mode: MODE, runId, model: MODEL, args: process.argv.slice(2) }) + '\n')
console.log(`evidence → ${OUT}  (run ${runId}, mode=${MODE})`)

if (MODE === 'whoami') {
  for (const [name, token] of [['ck', ck], ['oauth', oauth]]) {
    try {
      const res = await fetch(`${GATEWAY}/v2/accounts`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'CLI/unknown CodeBuddy/2.136.0' },
      })
      const body = await res.json().catch(() => null)
      const accounts = body?.data?.accounts ?? body?.data ?? []
      const summary = JSON.stringify(accounts).replace(/[a-f0-9-]{16,}/g, (m) => m.slice(0, 4) + '…')
      appendFileSync(OUT, JSON.stringify({ type: 'whoami', runId, auth: name, status: res.status, body: JSON.parse(summary) }) + '\n')
      console.log(name.padEnd(5), 'http=' + res.status, summary.slice(0, 400))
    } catch (err) {
      console.log(name, 'ERR', err.message)
    }
  }
} else if (MODE === 'burst') {
  const arms = AUTH === 'ab' ? [['ck', ck], ['oauth', oauth]] : [[AUTH, AUTH === 'oauth' ? oauth : ck]]
  // arm-unique nonces → independent entries; ABAB interleave controls for time
  const nonceOf = Object.fromEntries(arms.map(([name]) => [name, `${runId}-${name}`]))
  const bodyOf = (name) => fixedPayload(nonceOf[name])
  // warm seed: one call per arm first so every measured call reads a live entry
  for (const [name, token] of arms) {
    report({ mode: 'burst', auth: name, tag: 'seed', ...await call(token, bodyOf(name)) })
    await sleep(GAP_MS)
  }
  for (let i = 1; i <= CALLS; i++) {
    for (const [name, token] of arms) {
      report({ mode: 'burst', auth: name, tag: `fire${i}`, ...await call(token, bodyOf(name)) })
      await sleep(GAP_MS)
    }
  }
} else if (MODE === 'ttl') {
  const token = AUTH === 'oauth' ? oauth : ck
  const nonce = `${runId}-ttl`
  report({ mode: 'ttl', auth: AUTH, tag: 'seed', gapS: 0, ...await call(token, fixedPayload(nonce)) })
  let prev = 0
  for (const gap of GAPS) {
    await sleep((gap - prev) * 1000)
    prev = gap
    report({ mode: 'ttl', auth: AUTH, tag: `age${gap}s`, gapS: gap, ...await call(token, fixedPayload(nonce)) })
    await sleep(GAP_MS)
  }
} else if (MODE === 'replay') {
  // re-fire one REAL request body (a bridge dump, post developer→system
  // transform as the bridge would send it) — tests same-prompt read
  // stability for the real dsh shape (tools array, real content).
  const payloadFile = argValue('--payload-file')
  if (!payloadFile) throw new Error('--mode replay needs --payload-file')
  const parsed = JSON.parse(readFileSync(payloadFile, 'utf8'))
  parsed.stream = true
  for (const m of parsed.messages ?? []) if (m?.role === 'developer') m.role = 'system'
  const body = JSON.stringify(parsed)
  const arms = AUTH === 'ab' ? [['ck', ck], ['oauth', oauth]] : [[AUTH, AUTH === 'oauth' ? oauth : ck]]
  for (const [name, token] of arms) {
    report({ mode: 'replay', auth: name, tag: 'seed', ...await call(token, body) })
    await sleep(GAP_MS)
  }
  for (let i = 1; i <= CALLS; i++) {
    for (const [name, token] of arms) {
      report({ mode: 'replay', auth: name, tag: `fire${i}`, ...await call(token, body) })
      await sleep(GAP_MS)
    }
  }
} else if (MODE === 'grow') {
  const token = AUTH === 'oauth' ? oauth : ck
  const nonce = `${runId}-grow`
  for (let k = 1; k <= STEPS; k++) {
    report({ mode: 'grow', auth: AUTH, tag: `step${k}`, ...await call(token, growPayload(nonce, k)) })
    await sleep(GAP_MS)
  }
  if (IDLE_AFTER > 0 && IDLE_GROW > 0) {
    await sleep(IDLE_AFTER * 1000)
    const k = STEPS + 1
    // one more block than the ladder covers → grown prefix after idle
    report({ mode: 'grow', auth: AUTH, tag: `idle${IDLE_AFTER}s-grown`, ...await call(token, growPayload(nonce, k)) })
  }
}
console.log('done.')
