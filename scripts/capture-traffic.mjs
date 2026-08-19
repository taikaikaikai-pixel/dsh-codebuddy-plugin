#!/usr/bin/env node
/**
 * Traffic driver for bridge forensics: talks to a RUNNING `dsh web` over its
 * loopback RPC API and produces a controlled main-chat request sequence, so
 * the bridge log (CODEBUDDY_BRIDGE_LOG) can be classified afterwards:
 *
 *   session A: three short turns       → full-history resend growth + title call
 *   session B: A's first prompt verbatim → "manual resend" instance
 *   session C: asks for a subagent      → parent/child request streams
 *
 * Real gateway cost: ~8-12 tiny completions (answers are short by prompt
 * design; title calls cap at 64 tokens). Requires: dsh web on 127.0.0.1:3080
 * with this plugin loaded and the bridge log enabled.
 *
 * Usage: node scripts/capture-traffic.mjs [port]
 */

const PORT = process.argv[2] ?? '3080'
const BASE = `http://127.0.0.1:${PORT}/api/`

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

/** Poll session.list until the session reports running=false. */
async function waitIdle(sessionId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  await sleep(1500) // let the turn register first
  while (Date.now() < deadline) {
    const { items } = await rpc('session.list', {})
    const item = items.find((i) => i.sessionId === sessionId)
    if (item && item.running === false) return item
    await sleep(1000)
  }
  throw new Error(`session ${sessionId} still running after ${timeoutMs}ms`)
}

async function prompt(sessionId, text) {
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  })
  const item = await waitIdle(sessionId)
  const usage = item?.projections?.values?.tokenUsage ?? null
  console.log(`  done: turns=${item.projections.values.sessionStats.turns} steps=${item.projections.values.sessionStats.steps}`
    + ` tokenUsage=${JSON.stringify(usage)}`)
  return item
}

const Q1 = '只回复两个字：好的'
const Q2 = '再只回复两个字：收到'
const Q3 = '最后只回复两个字：完成'

console.log('[A] session with three short turns')
const a = await rpc('session.create', { cwd: process.cwd() })
console.log('  session A:', a.sessionId)
await prompt(a.sessionId, Q1)
await sleep(3000) // the title call fires after the first turn settles
await prompt(a.sessionId, Q2)
await prompt(a.sessionId, Q3)

console.log('[B] new session, A’s first prompt verbatim (manual resend)')
const b = await rpc('session.create', { cwd: process.cwd() })
console.log('  session B:', b.sessionId)
await prompt(b.sessionId, Q1)
await sleep(3000)

console.log('[C] new session, subagent attempt')
const c = await rpc('session.create', { cwd: process.cwd() })
console.log('  session C:', c.sessionId)
await prompt(c.sessionId, '请使用 subagent 工具启动一个子代理，让它回答"1+1等于几"并报告结果。你自己不要回答。')

console.log('\ncapture done — now classify the bridge log (CODEBUDDY_BRIDGE_LOG).')
