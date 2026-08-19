#!/usr/bin/env node
/**
 * Cache-hit reproducer: two fresh dsh sessions get the SAME user prompt
 * verbatim (plus one second turn in the first), all pinned to the same model
 * (deepseek-v4-pro) via session.selectModel. The bridge dump/log then shows
 * exactly which prefix tokens survive between identical prompts.
 *
 * Requires: dsh web on :3080 with CODEBUDDY_BRIDGE_LOG + CODEBUDDY_BRIDGE_DUMP.
 * Usage: node scripts/capture-cache.mjs [port]
 */

const PORT = process.argv[2] ?? '3080'
const BASE = `http://127.0.0.1:${PORT}/api/`
const MODEL = { provider: 'codebuddy', model: 'deepseek-v4-pro' }

async function rpc(method, payload) {
  const res = await fetch(BASE + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  const body = await res.json().catch(() => null)
  if (!body?.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(body).slice(0, 200)}`)
  return body.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitIdle(sessionId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  await sleep(1500)
  while (Date.now() < deadline) {
    const { items } = await rpc('session.list', {})
    const item = items.find((i) => i.sessionId === sessionId)
    if (item && item.running === false) return item
    await sleep(1000)
  }
  throw new Error(`session ${sessionId} still running after ${timeoutMs}ms`)
}

async function prompt(sessionId, text) {
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  const item = await waitIdle(sessionId)
  console.log(`  done: turns=${item.projections.values.sessionStats.turns} steps=${item.projections.values.sessionStats.steps}`)
}

const Q1 = '请用一句话介绍深井水循环系统的维护要点。'
const Q2 = '再补充一句冬季防冻注意事项。'

console.log('[D] session D, model=v4-pro, prompt Q1 then Q2')
const d = await rpc('session.create', { cwd: process.cwd() })
console.log('  session D:', d.sessionId)
await rpc('session.selectModel', { sessionId: d.sessionId, ...MODEL })
await prompt(d.sessionId, Q1)
await sleep(3500) // let the title call settle
await prompt(d.sessionId, Q2)

console.log('[E] fresh session E, same model, Q1 verbatim (identical resend)')
const e = await rpc('session.create', { cwd: process.cwd() })
console.log('  session E:', e.sessionId)
await rpc('session.selectModel', { sessionId: e.sessionId, ...MODEL })
await prompt(e.sessionId, Q1)
await sleep(3500)

console.log('\ncapture done — analyze /tmp/bridge-cache.jsonl and /tmp/bridge-dump/')
