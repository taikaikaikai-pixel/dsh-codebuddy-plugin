#!/usr/bin/env node
/**
 * Cache invalidation-boundary probe (topic 2 of docs/rules/).
 *
 * Spell under test (AGENTS.md:30-31): "提示缓存按内容寻址、自动生效；命中
 * 粒度 128 token；按模型分策略；glm-5.1/5.2 缓存条目秒-分钟级失效；
 * v4-flash 阈值 412 tok；v4-flash TTL ≥60s 无影响"。
 *
 * What is NOT yet pinned (the boundary this probe maps):
 *   dim 1 前缀长度 — minimum cacheable prefix per model (only v4-flash has
 *          412; v4-pro only has ≤2684)
 *   dim 2 时间窗  — TTL per model (only v4-flash has ≥60s)
 *   dim 3 按模型  — policy table for the 10 uncharacterized models
 *
 * Pre-registered hypotheses (2026-08-19):
 *   H-POLICY  vendor-cluster: kimi-k2.5/k2.6/k3/k3-1 cache like kimi-k2.7;
 *             glm-5v-turbo flaps like glm-5.1/5.2; hy3-preview caches like
 *             hy3; deepseek-v3.2/r1 do NOT cache (like v3); minimax-m2.7/m3
 *             DO cache (non-DeepSeek vendors on this gateway all do)
 *   H-TTL     glm-5.2 entry dies somewhere in 5s..120s ("秒-分钟级");
 *             v4-pro entry survives 120s (real-session evidence: hits across
 *             multi-minute turns)
 *   H-THRESH  v4-pro minimum cacheable prefix is a 128-token multiple in
 *             (412, 2684] — most likely 1024 or 2048
 *   H-GRAN    hit values are multiples of 128 on every caching model
 *
 * Modes:
 *   --mode ttl       seed once, re-send at cumulative gaps (default
 *                    5,15,30,60,120 s), record hit on each probe
 *   --mode sweep     policy sweep: N models × 2 immediate re-sends each
 *   --mode thresh    threshold ladder: prefix sizes × 2 immediate re-sends
 *   --mode predict   pre-registered confirmation round P1–P4 (2026-08-19):
 *                    P1  v3.2 entry survives a 60s gap (DeepSeek caching
 *                        family shares v4-pro's TTL behaviour) → hit>0
 *                    P2  hy3-preview stays 0-hit at ~5k tokens (policy none,
 *                        not threshold) → hit=0 on both calls
 *                    P3  glm-5.2 retention is probabilistic: among 4 rapid
 *                        (2s) resends after a seeded write, ≥1 misses →
 *                        not all hit
 *                    P4  v3.2 hit granularity: at a fresh ~3.3k prompt the
 *                        second call's hit == floor(prompt/128)*128 exactly
 *
 * Every arm embeds a unique nonce so entries never collide across runs.
 * Low rate: ≤1 call in flight, 2s between calls, max_tokens=16.
 *
 * Usage:
 *   node scripts/probe-cache-ttl.mjs --mode ttl --model glm-5.2 --gaps 5,15,30,60,120
 *   node scripts/probe-cache-ttl.mjs --mode sweep --models a,b,c [--repeat 72]
 *   node scripts/probe-cache-ttl.mjs --mode thresh --model deepseek-v4-pro --sizes 500,1000,1500,2000,2500
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
const MODE = argValue('--mode') ?? 'ttl'
const MODEL = argValue('--model') ?? 'glm-5.2'
const MODELS = argValue('--models')?.split(',') ?? null
const GAPS = (argValue('--gaps') ?? '5,15,30,60,120').split(',').map(Number)
const SIZES = (argValue('--sizes') ?? '500,1000,1500,2000,2500').split(',').map(Number)
const REPEAT = Number(argValue('--repeat') ?? 72) // 72 ≈ 2.6k tokens
const OUT = argValue('--out')
  ?? join('docs', 'probes', `cache-boundary-${new Date().toISOString().slice(0, 10)}.jsonl`)
const GAP_CALL_MS = 2000

const runId = Math.random().toString(36).slice(2, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function buildBody(model, nonce, repeat) {
  const paragraph = `Cache boundary probe paragraph ${nonce}. Engineers measure prefix-cache invalidation across time gaps and prefix sizes while the quick brown fox jumps over the lazy dog. `
  return JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
    messages: [
      { role: 'system', content: paragraph.repeat(repeat) },
      { role: 'user', content: `Probe ${nonce}: reply with exactly: OK` },
    ],
  })
}

async function call(key, model, nonce, repeat) {
  const t0 = Date.now()
  let ttfbMs = null
  try {
    const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
      },
      body: buildBody(model, nonce, repeat),
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
  } catch (err) {
    return { status: 0, ttfbMs, ms: Date.now() - t0, error: String(err?.message ?? err) }
  }
}

function report(rec) {
  const u = rec.usage ?? {}
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(
    `${rec.mode.padEnd(6)} ${rec.model.padEnd(16)} ${rec.tag.padEnd(14)} http=${rec.status}`
    + ` prompt=${u.prompt_tokens ?? '-'} hit=${u.prompt_cache_hit_tokens ?? '-'} miss=${u.prompt_cache_miss_tokens ?? '-'}`
    + ` credit=${u.credit ?? '-'}${rec.error ? ' err=' + rec.error : ''}`,
  )
}

const key = resolveKey()
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), mode: MODE, runId, args: process.argv.slice(2) }) + '\n')
console.log(`evidence → ${OUT}  (run ${runId})`)

if (MODE === 'ttl') {
  const nonce = `${runId}-ttl`
  report({ type: 'probe', mode: 'ttl', model: MODEL, tag: 'seed', gapS: 0, ...await call(key, MODEL, nonce, REPEAT) })
  let prev = 0
  for (const gap of GAPS) {
    await sleep((gap - prev) * 1000)
    prev = gap
    report({ type: 'probe', mode: 'ttl', model: MODEL, tag: `gap${gap}s`, gapS: gap, ...await call(key, MODEL, nonce, REPEAT) })
    await sleep(GAP_CALL_MS)
  }
} else if (MODE === 'sweep') {
  for (const model of MODELS ?? []) {
    const nonce = `${runId}-${model.replace(/[^a-z0-9]/gi, '')}`
    for (let i = 1; i <= 2; i++) {
      report({ type: 'probe', mode: 'sweep', model, tag: `call${i}`, ...await call(key, model, nonce, REPEAT) })
      await sleep(GAP_CALL_MS)
    }
  }
} else if (MODE === 'thresh') {
  // map approximate token sizes to repeat counts using the calibration from
  // the first size, then probe each size twice (seed + immediate resend)
  for (const size of SIZES) {
    const repeat = Math.max(1, Math.round((size / 2600) * REPEAT))
    const nonce = `${runId}-t${size}`
    for (let i = 1; i <= 2; i++) {
      report({ type: 'probe', mode: 'thresh', model: MODEL, tag: `~${size}tok#${i}`, targetTokens: size, repeat, ...await call(key, MODEL, nonce, repeat) })
      await sleep(GAP_CALL_MS)
    }
  }
} else if (MODE === 'predict') {
  // P1 — v3.2 TTL 60s
  {
    const nonce = `${runId}-p1`
    report({ type: 'probe', mode: 'predict', pred: 'P1', model: 'deepseek-v3.2', tag: 'seed', ...await call(key, 'deepseek-v3.2', nonce, REPEAT) })
    await sleep(60000)
    report({ type: 'probe', mode: 'predict', pred: 'P1', model: 'deepseek-v3.2', tag: 'gap60s', gapS: 60, ...await call(key, 'deepseek-v3.2', nonce, REPEAT) })
    await sleep(GAP_CALL_MS)
  }
  // P2 — hy3-preview at ~5k tokens
  {
    const nonce = `${runId}-p2`
    for (let i = 1; i <= 2; i++) {
      report({ type: 'probe', mode: 'predict', pred: 'P2', model: 'hy3-preview', tag: `call${i}`, ...await call(key, 'hy3-preview', nonce, 140) })
      await sleep(GAP_CALL_MS)
    }
  }
  // P3 — glm-5.2 probabilistic retention: 4 rapid resends
  {
    const nonce = `${runId}-p3`
    report({ type: 'probe', mode: 'predict', pred: 'P3', model: 'glm-5.2', tag: 'seed', ...await call(key, 'glm-5.2', nonce, REPEAT) })
    await sleep(GAP_CALL_MS)
    for (let i = 1; i <= 4; i++) {
      report({ type: 'probe', mode: 'predict', pred: 'P3', model: 'glm-5.2', tag: `rapid${i}`, ...await call(key, 'glm-5.2', nonce, REPEAT) })
      await sleep(GAP_CALL_MS)
    }
  }
  // P4 — v3.2 granularity at ~3.3k
  {
    const nonce = `${runId}-p4`
    report({ type: 'probe', mode: 'predict', pred: 'P4', model: 'deepseek-v3.2', tag: '~3300tok#1', ...await call(key, 'deepseek-v3.2', nonce, 92) })
    await sleep(GAP_CALL_MS)
    report({ type: 'probe', mode: 'predict', pred: 'P4', model: 'deepseek-v3.2', tag: '~3300tok#2', ...await call(key, 'deepseek-v3.2', nonce, 92) })
  }
}
console.log('done.')
