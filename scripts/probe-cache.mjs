#!/usr/bin/env node
/**
 * Gateway cache-routing probe (small, bounded: 4 arms × 3 calls = 12 chat
 * completions, max_tokens 16 each).
 *
 * Question: does the CodeBuddy gateway's prompt/KV cache care about
 * (a) session-affinity headers (openai set: session_id / x-client-request-id /
 *     x-session-affinity), or (b) a body `prompt_cache_key`? The dsh main chat
 * sends neither (the pi-ai adapter strips the affinity switch), so every
 * request is anonymous — live captures show hit rates swinging 0 → 15.7k
 * tokens between consecutive turns of one session.
 *
 * Design: each arm sends the SAME payload 3 times back-to-back; every arm
 * embeds a unique nonce so arms can never share cache entries. We record the
 * full usage object (prompt_cache_hit_tokens / prompt_cache_miss_tokens /
 * credit) plus TTFB and total latency.
 *
 * Usage: node scripts/probe-cache.mjs [--out /path/probe.jsonl]
 * Credentials resolve exactly like the plugin's: active key from
 * ~/.dsh/codebuddy-plugin.json (fallback: CODEBUDDY_API_KEY / credentials file).
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : null
}
// --base overrides the URL prefix, e.g. http://127.0.0.1:3901/v2 to send the
// identical payload through the plugin bridge instead of direct to gateway.
const BASE = argValue('--base') ?? `${GATEWAY}/v2`
const MODEL = argValue('--model') ?? 'deepseek-v3'
const EFFORT = argValue('--effort') ?? null
const ONLY_ARMS = argValue('--arms')?.split(',') ?? null
const REPEAT = Number(argValue('--repeat') ?? 72)
const CALLS = Number(argValue('--calls') ?? 3)
const MAX_TOKENS = 16

// ------------------------------------------------------------- credential
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

// ------------------------------------------------------------- payload
/** ~1300-token system prompt with an arm-unique nonce baked in. */
function buildPayload(nonce, cacheKey) {
  const paragraph = `Cache-routing probe paragraph ${nonce}. The quick brown fox jumps over the lazy dog near the riverbank while engineers measure prefix-cache behaviour across identical requests. `
  const system = paragraph.repeat(REPEAT) // 72 ≈ 2.6k tokens; scale via --repeat
  const body = {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Probe ${nonce}: reply with exactly: OK` },
    ],
  }
  if (cacheKey) body.prompt_cache_key = cacheKey
  if (EFFORT) body.reasoning_effort = EFFORT
  return JSON.stringify(body)
}

// ------------------------------------------------------------- one call
async function call(key, { nonce, sessionHeaders, cacheKey }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    // the CLI-shaped UA the bridge sends (v2 does not enforce it, keep it faithful)
    'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': '2.133.1',
    'X-Product-Version': '2.133.1',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Private-Data': 'false',
  }
  if (sessionHeaders) {
    headers.session_id = sessionHeaders
    headers['x-client-request-id'] = sessionHeaders
    headers['x-session-affinity'] = sessionHeaders
  }
  const t0 = Date.now()
  let ttfbMs = null
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: buildPayload(nonce, cacheKey),
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttfbMs === null) ttfbMs = Date.now() - t0
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue
      try {
        const chunk = JSON.parse(line.slice(5).trim())
        if (chunk.usage) usage = chunk.usage
      } catch { /* skip */ }
    }
  }
  return { status: res.status, ttfbMs, ms: Date.now() - t0, usage }
}

// ------------------------------------------------------------- arms
const runId = Math.random().toString(36).slice(2, 8)
const ARMS = [
  { name: 'anon', sessionHeaders: null, cacheKey: null },
  { name: 'session', sessionHeaders: `probe-${runId}-s`, cacheKey: null },
  { name: 'cachekey', sessionHeaders: null, cacheKey: `probe-${runId}-k` },
  { name: 'session+cachekey', sessionHeaders: `probe-${runId}-sk`, cacheKey: `probe-${runId}-sk` },
]

const outPath = argValue('--out')
const key = resolveKey()
const arms = ONLY_ARMS ? ARMS.filter((a) => ONLY_ARMS.includes(a.name)) : ARMS

console.log(`probe run ${runId}: ${arms.length} arms × ${CALLS} calls, model=${MODEL}, base=${BASE}, max_tokens=${MAX_TOKENS}`)
for (const arm of arms) {
  const nonce = `${runId}-${arm.name}`
  for (let i = 1; i <= CALLS; i++) {
    const r = await call(key, { nonce, sessionHeaders: arm.sessionHeaders, cacheKey: arm.cacheKey })
    const u = r.usage ?? {}
    const record = { runId, arm: arm.name, call: i, status: r.status, ttfbMs: r.ttfbMs, ms: r.ms, usage: r.usage }
    if (outPath) appendFileSync(outPath, JSON.stringify(record) + '\n')
    console.log(
      `${arm.name.padEnd(17)} #${i}  http=${r.status} ttfb=${String(r.ttfbMs).padStart(5)}ms total=${String(r.ms).padStart(5)}ms`
      + `  prompt=${u.prompt_tokens ?? '-'} hit=${u.prompt_cache_hit_tokens ?? '-'} miss=${u.prompt_cache_miss_tokens ?? '-'}`
      + ` cached_details=${u.prompt_tokens_details?.cached_tokens ?? '-'} credit=${u.credit ?? '-'}`,
    )
  }
}
console.log('probe done.')
