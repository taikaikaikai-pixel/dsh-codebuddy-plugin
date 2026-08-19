#!/usr/bin/env node
/**
 * Offline regression for the stream bridge (index.js): spins a mock gateway
 * plus the real bridge on loopback and asserts end-to-end behavior. Every
 * assertion waits for the response to FINISH (connection end), never just
 * the first byte — a queued request that hangs looks exactly like a slow
 * one until you demand completion.
 *
 * Covered:
 *   1. non-streaming inbound (stream:false / absent) → aggregated
 *      chat.completion JSON (the gateway is stream-only, error 11101)
 *   2. stream:true inbound → SSE passed through verbatim
 *   3. session-attribution headers: injected from the incoming session id,
 *      preserved when the caller already set one, absent otherwise
 *   4. per-session FIFO concurrency: excess requests queue and COMPLETE in
 *      waves (regression: release() once stranded the queue →永久挂起)
 *   5. no session id → no gating, all requests run concurrently
 *   6. non-chat paths (/agenttool/*) pass through untouched
 *   7. CODEBUDDY_BRIDGE_LOG forensics (hash-only in/out records)
 *   8. usage metering: every chat request's usage.credit is accumulated into
 *      codebuddy-plugin-usage.json and served via action:'usage'
 *   9. developer-role messages are rewritten to system on the way out
 *      (regression: gateway moderation content_filter on developer role)
 *   10. bridge listen EADDRINUSE degrades to a warning, never crashes
 *      (regression: an unhandled 'error' event took the whole process down)
 *
 * Usage: node scripts/verify-bridge.mjs   (no network, no credentials)
 */

import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const UPSTREAM_LATENCY_MS = 250

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
process.env.CODEBUDDY_API_KEY = 'ck_bridge_test_key'
process.env.CODEBUDDY_BRIDGE_LOG = join(process.env.DSH_HOME, 'bridge-log.jsonl')

// ---------------------------------------------------------------- mock gateway

const arrivals = [] // {path, stream, headers, at} in upstream-arrival order
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* non-JSON body */ }
    arrivals.push({
      path: req.url,
      raw,
      stream: parsed?.stream ?? null,
      sessionId: req.headers['session_id'] ?? null,
      clientRequestId: req.headers['x-client-request-id'] ?? null,
      affinity: req.headers['x-session-affinity'] ?? null,
      authorization: req.headers.authorization ?? null,
      at: Date.now(),
    })
    setTimeout(() => {
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end([
          'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"hello "}}]}',
          '',
          'data: {"id":"mock","choices":[{"index":0,"delta":{"content":"world"}}]}',
          '',
          'data: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":3,"credit":0.01}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, results: [{ url: 'https://example.com' }] }))
      }
    }, UPSTREAM_LATENCY_MS)
  })
})

// ---------------------------------------------------------------- test harness

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ephemeral port: bind 0, read it, release. */
async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

async function main() {
  const upstreamPort = await freePort()
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r))
  const bridgePort = await freePort()

  const { apply } = await import(join(ROOT, 'index.js'))
  // Route registrations are captured so the settings route can be driven
  // in-process (the usage view is asserted through it, like the card does).
  const routes = {}
  const ctx = {
    inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes[r.path] = r.handler } } }),
    web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
    on: () => {},
  }
  apply(ctx, {
    baseURL: `http://127.0.0.1:${upstreamPort}`,
    bridgePort,
    maxConcurrentPerSession: 2,
  })
  await sleep(200) // let the bridge bind

  const bridge = `http://127.0.0.1:${bridgePort}`
  const setLimit = (n) =>
    writeFileSync(
      join(process.env.DSH_HOME, 'codebuddy-plugin.json'),
      JSON.stringify({ maxConcurrentPerSession: n }) + '\n',
    )
  const chat = (body, headers = {}) =>
    fetch(`${bridge}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  /** Race a promise against a hard timeout; resolves 'TIMEOUT' instead of rejecting. */
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')])

  /** Drive a captured settings-route handler with a mock req/res pair. */
  const callRoute = (routesMap, body) => new Promise((resolve, reject) => {
    const handler = routesMap['/dsh-codebuddy-plugin/settings']
    if (!handler) return reject(new Error('settings route not registered'))
    const req = new EventEmitter()
    req.method = body ? 'POST' : 'GET'
    // sameOrigin() gate: origin host must match the Host header.
    req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(b) {
        let json = null
        try { json = JSON.parse(b) } catch { /* non-JSON */ }
        resolve({ status: this.status, json })
      },
    }
    handler(req, res)
    if (body) {
      req.emit('data', JSON.stringify(body))
      req.emit('end')
    }
  })

  // ---------------------------------------------------------- 1. aggregation
  console.log('\n[1] non-streaming inbound → aggregated chat.completion JSON')
  {
    const before = arrivals.length
    const res = await chat({ model: 'm1', stream: false, messages: [] })
    const text = await res.text() // reading to END proves the connection closed
    let json = null
    try { json = JSON.parse(text) } catch { /* SSE is not JSON */ }
    check('status 200', res.status === 200, `got ${res.status}`)
    check('response is a chat.completion, not SSE', json?.object === 'chat.completion', text.slice(0, 80))
    check('content aggregated from stream chunks', json?.choices?.[0]?.message?.content === 'hello world',
      JSON.stringify(json?.choices?.[0]?.message))
    check('finish_reason preserved', json?.choices?.[0]?.finish_reason === 'stop')
    check('upstream was forced to stream', arrivals[before]?.stream === true)
  }
  {
    const res = await chat({ model: 'm1', messages: [] }) // stream absent = OpenAI default false
    const json = await res.json().catch(() => null)
    check('stream absent also aggregates', json?.object === 'chat.completion')
  }

  // ---------------------------------------------------------- 2. SSE passthrough
  console.log('\n[2] stream:true inbound → SSE passed through')
  {
    const res = await chat({ model: 'm1', stream: true, messages: [] })
    const text = await res.text()
    check('content-type is event-stream', (res.headers.get('content-type') ?? '').includes('text/event-stream'))
    check('body is SSE with [DONE]', text.includes('data:') && text.includes('[DONE]'))
  }

  // ---------------------------------------------------------- 3. session headers
  console.log('\n[3] session-attribution headers')
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-A' })).text()
    const a = arrivals[before]
    check('injected from X-Session-ID', a?.sessionId === 'sess-A' && a?.clientRequestId === 'sess-A' && a?.affinity === 'sess-A',
      JSON.stringify({ s: a?.sessionId, c: a?.clientRequestId, a: a?.affinity }))
  }
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-B', session_id: 'caller-set' })).text()
    const a = arrivals[before]
    check('caller-set value wins per header (no overwrite, no drop)', a?.sessionId === 'caller-set', `got ${a?.sessionId}`)
    check('missing headers filled with the extracted id', a?.clientRequestId === 'sess-B' && a?.affinity === 'sess-B',
      JSON.stringify({ c: a?.clientRequestId, a: a?.affinity }))
  }
  {
    const before = arrivals.length
    await (await chat({ model: 'm1', stream: true, messages: [] })).text()
    const a = arrivals[before]
    check('no session id → nothing injected', a?.sessionId === null && a?.clientRequestId === null)
    check('host-side credential, caller auth never forwarded', a?.authorization === 'Bearer ck_bridge_test_key',
      a?.authorization ?? 'none')
  }

  // ---------------------------------------------------------- 4. FIFO limiter
  console.log('\n[4] per-session concurrency: excess queues and COMPLETES in waves')
  {
    setLimit(2)
    arrivals.length = 0
    const t0 = Date.now()
    const mk = async (name) => {
      const res = await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-C' })
      await res.text() // completion, not first byte
      return { name, ms: Date.now() - t0 }
    }
    const results = await withTimeout(Promise.all([mk('R1'), mk('R2'), mk('R3'), mk('R4')]), 5000)
    check('all four requests COMPLETE (no stranded queue)', results !== 'TIMEOUT')
    if (results !== 'TIMEOUT') {
      const wave1 = results.filter((r) => r.ms < UPSTREAM_LATENCY_MS * 1.8).length
      const wave2 = results.filter((r) => r.ms >= UPSTREAM_LATENCY_MS * 1.8).length
      check('two waves of two', wave1 === 2 && wave2 === 2, JSON.stringify(results))
      check('upstream saw exactly four, all tagged sess-C',
        arrivals.length === 4 && arrivals.every((a) => a.sessionId === 'sess-C'))
    }
  }
  {
    // The exact historical deadlock: limit=1, second request hung forever.
    setLimit(1)
    const t0 = Date.now()
    const mk = async (name) => {
      const res = await chat({ model: 'm1', stream: true, messages: [] }, { 'X-Session-ID': 'sess-D' })
      await res.text()
      return { name, ms: Date.now() - t0 }
    }
    const p1 = mk('R1')
    await sleep(50)
    const p2 = mk('R2')
    const r2 = await withTimeout(p2, 4000)
    check('limit=1: queued request completes after the first (deadlock regression)', r2 !== 'TIMEOUT')
    if (r2 !== 'TIMEOUT') {
      const r1 = await p1
      check('limit=1: strictly serialized', r2.ms > r1.ms && r2.ms >= UPSTREAM_LATENCY_MS * 1.8,
        JSON.stringify([r1, r2]))
    }
    setLimit(2)
  }

  // ---------------------------------------------------------- 5. no session id
  console.log('\n[5] no session id → no gating')
  {
    arrivals.length = 0
    const t0 = Date.now()
    const mk = async () => {
      const res = await chat({ model: 'm1', stream: true, messages: [] })
      await res.text()
      return Date.now() - t0
    }
    const times = await withTimeout(Promise.all([mk(), mk(), mk()]), 4000)
    check('three anonymous requests all complete concurrently',
      times !== 'TIMEOUT' && times.every((ms) => ms < UPSTREAM_LATENCY_MS * 1.8), JSON.stringify(times))
  }

  // ---------------------------------------------------------- 6. path passthrough
  console.log('\n[6] non-chat paths pass through untouched')
  {
    const before = arrivals.length
    const res = await fetch(`${bridge}/agenttool/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    const json = await res.json().catch(() => null)
    const a = arrivals[before]
    check('agenttool response verbatim', json?.code === 0 && json?.results?.[0]?.url === 'https://example.com')
    check('no session headers on non-chat paths', a?.sessionId === null && a?.clientRequestId === null)
    check('body bytes forwarded untouched', a?.raw === JSON.stringify({ query: 'x' }))
  }

  // ---------------------------------------------------------- 7. request forensics log
  console.log('\n[7] CODEBUDDY_BRIDGE_LOG forensics')
  {
    // A title-shaped payload must be classified by its prompt marker.
    const before = arrivals.length
    await (await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'system', content: 'Create a concise title for an AI coding-assistant session from the supplied human messages.' },
        { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"hi"}]' },
      ],
    }, { authorization: 'Bearer dsh-codebuddy-bridge' })).text()
    check('title-shaped request reached upstream', arrivals.length === before + 1)

    const records = (await import('node:fs')).readFileSync(process.env.CODEBUDDY_BRIDGE_LOG, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const ins = records.filter((r) => r.dir === 'in' && r.path === '/v2/chat/completions')
    const outs = records.filter((r) => r.dir === 'out')
    const inSeqs = new Set(records.filter((r) => r.dir === 'in').map((r) => r.seq))
    check('every chat request logged in+out', ins.length > 0
      && ins.every((r) => outs.some((o) => o.seq === r.seq))
      && outs.every((o) => inSeqs.has(o.seq)),
      `in=${ins.length} out=${outs.length}`)
    check('in records carry body hash + shape, no message text',
      ins.every((r) => r.chat?.bodySha && r.chat.msgsSha && !JSON.stringify(r).includes('hello world')))
    check('usage captured from the SSE stream',
      outs.some((r) => r.usage?.prompt_tokens === 3 && r.usage?.total_tokens === 5),
      JSON.stringify(outs[0]?.usage))
    const title = ins.find((r) => r.chat?.marker === 'session-title')
    check('title marker classified', Boolean(title))
    check('sentinel authorization classified, never logged verbatim',
      title?.hdr?.authorization === 'sentinel')
    check('session id logged with injected outbound headers',
      ins.some((r) => r.sessionIn === 'sess-C')
        && outs.some((r) => r.sessionOut?.session_id === 'sess-C'))
    check('non-chat path logged with raw body hash',
      records.some((r) => r.dir === 'in' && r.path === '/agenttool/v1/search' && r.bodySha))
  }

  // ---------------------------------------------------------- 8. usage metering
  console.log('\n[8] usage metering → action:usage')
  {
    // Chat requests so far: 2 aggregated + 14 SSE = 16, mock credit 0.01 each
    // (15 plain chat + 1 title from section 7).
    const res = await callRoute(routes, { action: 'usage' })
    check('usage action answers ok', res.status === 200 && res.json?.ok === true,
      `HTTP ${res.status}`)
    const u = res.json?.usage
    check('every billed chat request metered', u?.totalRequests === 16, `got ${u?.totalRequests}`)
    check('credit accumulated (16 × 0.01)', u?.totalCredit === 0.16, `got ${u?.totalCredit}`)
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    check('today bucket matches', u?.today?.day === day && u?.today?.requests === 16)
    check('recent rows newest-first, title kind classified',
      u?.recent?.length === 16 && u.recent[0]?.kind === 'title' && u.recent[0]?.credit === 0.01
        && u.recent[0]?.hit === 0 && u.recent[0]?.miss === 3,
      JSON.stringify(u?.recent?.[0]))
    check('turns gap-grouped into one row (all requests <45s apart)',
      u?.turns?.length === 1 && u.turns[0]?.requests === 16
        && u.turns[0]?.kinds?.includes('chat') && u.turns[0]?.kinds?.includes('title'),
      JSON.stringify(u?.turns))
    check('bridge state exposed in usage view',
      res.json?.bridge?.running === true && res.json?.bridge?.port === bridgePort
        && res.json?.bridge?.lastError === null)
    check('quota snapshot present (mock upstream → nulls, no throw)',
      typeof res.json?.quota?.fetchedAt === 'number')
    // Debounced persistence: the file appears within a few seconds.
    const { readFileSync, existsSync } = await import('node:fs')
    const usagePath = join(process.env.DSH_HOME, 'codebuddy-plugin-usage.json')
    let persisted = null
    for (let i = 0; i < 16 && !persisted; i++) {
      if (existsSync(usagePath)) {
        try { persisted = JSON.parse(readFileSync(usagePath, 'utf8')) } catch { /* mid-write */ }
      }
      if (!persisted) await sleep(500)
    }
    check('usage.json persisted with totals + day bucket + recent rows',
      persisted?.totalRequests === 16 && persisted?.days?.[day]?.requests === 16
        && Array.isArray(persisted?.recent) && persisted.recent.length === 16)
  }

  // -------------------------------------------- 9. developer-role rewrite
  // pi-ai serializes the system prompt as role "developer" for reasoning
  // models; since 2026-08-18 the gateway's moderation answers such payloads
  // with finish_reason=content_filter. The bridge rewrites developer→system.
  console.log('\n[9] developer-role messages rewrite to system upstream')
  {
    const before = arrivals.length
    const res = await chat({
      model: 'm1',
      stream: true,
      messages: [
        { role: 'developer', content: 'You are a test agent.' },
        { role: 'user', content: 'ping' },
      ],
    }, { authorization: 'Bearer dsh-codebuddy-bridge' })
    await res.text()
    const a = arrivals[before]
    const forwarded = JSON.parse(a?.raw ?? 'null')
    check('request reached upstream', Boolean(a))
    check('developer role rewritten to system',
      forwarded?.messages?.[0]?.role === 'system'
        && forwarded?.messages?.[0]?.content === 'You are a test agent.'
        && forwarded?.messages?.every((m) => m.role !== 'developer'),
      JSON.stringify(forwarded?.messages?.map((m) => m.role)))
  }

  // ---------------------------------------------------------- 10. EADDRINUSE
  console.log('\n[10] bridge listen EADDRINUSE degrades, never crashes')
  {
    const squatter = createServer()
    await new Promise((r) => squatter.listen(0, '127.0.0.1', r))
    const occupiedPort = squatter.address().port
    // A second apply() on the occupied port stands in for the second dsh
    // process (bridgeRuntime is per-process module state; production runs one
    // plugin instance per process, so last-apply-wins is correct here).
    const routes2 = {}
    const ctx2 = {
      inject: (_deps, cb) => cb({ webServer: { register: (r) => { routes2[r.path] = r.handler } } }),
      web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
      on: () => {},
    }
    apply(ctx2, { baseURL: `http://127.0.0.1:${upstreamPort}`, bridgePort: occupiedPort })
    await sleep(300)
    // Reaching this line at all is half the regression: the process survived.
    const res = await callRoute(routes2, { action: 'usage' })
    check('occupied port: process alive, route still answers', res.status === 200 && res.json?.ok === true)
    check('bridge state reports EADDRINUSE and not running',
      res.json?.bridge?.running === false && res.json?.bridge?.lastError === 'EADDRINUSE'
        && res.json?.bridge?.port === occupiedPort,
      JSON.stringify(res.json?.bridge))
    const stillUp = await withTimeout(chat({ model: 'm1', stream: true, messages: [] }).then((r) => r.text()), 3000)
    check('first bridge keeps serving afterwards', stillUp !== 'TIMEOUT' && stillUp.includes('[DONE]'))
    await new Promise((r) => squatter.close(r))
  }

  console.log(failures === 0 ? '\nall bridge checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`verify-bridge crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
