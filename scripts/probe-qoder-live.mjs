#!/usr/bin/env node
/**
 * Live integration probe for the Qoder CN channel (REAL network, own account).
 *
 * Device-flow facts were extracted from the official CLI bundle
 * (@qodercn-ai/qoderclicn 1.1.57, deobfuscated); this script is the manual
 * calibration step that needs a real login to confirm the live envelopes.
 *
 *   node scripts/probe-qoder-live.mjs --login
 *     Real browser device flow: prints the authorization URL (open it while
 *     logged in to qoder.cn), polls /api/v1/deviceToken/poll (404 = pending)
 *     until the token arrives, then pulls userinfo. Tokens never print
 *     (masked only). Auth store: ~/.dsh/qoder-plugin-auth.json (DSH_HOME
 *     respected) — one login serves both probe and plugin.
 *
 *   node scripts/probe-qoder-live.mjs --catalog
 *     GET <infer>/api/v2/model/list?Encode=1 with the stored token; dumps raw
 *     body to docs/probes/qoder-catalog-raw.bin and tries decodings
 *     (identity / base64 / gzip / deflate / brotli / zstd) to establish the
 *     Encode=1 format.
 *
 *   node scripts/probe-qoder-live.mjs --chat "文本" [--model <key>] [--tools]
 *     COSY 签名（providers/qoder/cosy.js）+ 加密 POST 到 infer 节点
 *     （gateway.qoder.com.cn 的 agent_chat_generation），拆 SSE 信封聚合正文
 *     并落原始证据到 docs/probes/qoder-chat-live-*.json。
 *     （2026-09-20 起：旧的 api2-v2 OpenAI 面裸 Bearer 形态对本账号 401，
 *     已废弃——别再改回去。）
 *
 *   node scripts/probe-qoder-live.mjs --userinfo   # identity check
 *   node scripts/probe-qoder-live.mjs --refresh    # force one refresh cycle
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'qoder-plugin-auth.json')
const PROBES_DIR = join(ROOT, 'docs', 'probes')

const EP = {
  openapi: process.env.QODER_OPENAPI ?? 'https://openapi.qoder.com.cn',
  base: process.env.QODER_BASE ?? 'https://qoder.cn',
  infer: process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn',
  modelServer: process.env.QODER_MODEL_SERVER ?? 'https://api2-v2.qoder.sh',
}
const CLIENT_ID_PROD = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // bundle 常量：5 分钟
const POLL_INTERVAL_MS = 1000

const { readJson, writeJson } = await import('../core/json-store.js')

const mask = (t) => (typeof t === 'string' && t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}（${t.length} 字符）` : '(none)')
const b64url = (buf) => Buffer.from(buf).toString('base64url')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ensureDir = (p) => mkdirSync(p, { recursive: true })

const mkVerifier = () => {
  const n = 43 + Math.floor(86 * Math.random())
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = randomBytes(n)
  return [...bytes].map((b) => charset[b % 66]).join('')
}
const mkMachineId = () => randomBytes(24).toString('hex') // 48 hex；bundle 机器 id 形态为长 hex 串

function normalizeExpiry(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return Date.now() + n * 1000
  }
  const p = Date.parse(String(v)) // 实测：expires_at 常为 ISO 字符串
  return Number.isFinite(p) && p > 0 ? p : null
}

function currentToken() {
  const store = readJson(AUTH_PATH)
  const t = store.auth?.accessToken
  if (!t) { console.error('未登录（先跑 --login）'); process.exit(1) }
  return { store, token: t }
}

// ─────────────────────────────────────────────────────────── login
async function login() {
  const store = readJson(AUTH_PATH)
  if (store.auth?.accessToken) {
    console.log('已有登录态：', store.account ?? '', '令牌至', store.auth.expiresAt ? new Date(store.auth.expiresAt).toISOString() : '(未知)')
  }
  const verifier = mkVerifier()
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const nonce = randomUUID()
  const machineId = store.machine?.machineId ?? mkMachineId()

  const authUrl = `${EP.base}/device/selectAccounts?challenge=${challenge}&challenge_method=S256&nonce=${nonce}&machine_id=${machineId}&client_id=${CLIENT_ID_PROD}`
  console.log('\n在浏览器打开并完成授权（5 分钟内有效）：\n')
  console.log(authUrl, '\n')

  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let pollCount = 0
  while (Date.now() < deadline) {
    pollCount++
    const url = `${EP.openapi}/api/v1/deviceToken/poll?nonce=${nonce}&verifier=${verifier}&challenge_method=S256`
    let res, text
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } })
      text = await res.text().catch(() => '')
    } catch (err) {
      console.error(`\n轮询网络错误（第 ${pollCount} 次）：`, err?.cause?.code ?? err?.message)
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (res.status === 404) {
      if (pollCount % 10 === 1) process.stdout.write(`等待授权…（第 ${pollCount} 次 404）\n`)
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    let body = null
    try { body = JSON.parse(text) } catch { /* keep raw */ }
    if (!res.ok) {
      console.error(`\n轮询失败 HTTP ${res.status}：`, text.slice(0, 300))
      if (body && body.errorCode && body.errorCode !== 'NotFound') process.exit(1)
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (body?.token) {
      console.log(`\n\n登录成功 ✓（第 ${pollCount} 次轮询）`)
      const auth = {
        accessToken: body.token,
        refreshToken: body.refresh_token ?? null,
        expiresAt: normalizeExpiry(body.expires_at),
        refreshExpiresAt: normalizeExpiry(body.refresh_token_expires_at),
        loginMethod: 'browser',
      }
      console.log('token 响应键：', Object.keys(body).join(', '))
      console.log('accessToken：', mask(auth.accessToken))
      console.log('refreshToken：', mask(auth.refreshToken))
      let account = null
      try {
        const ui = await fetch(`${EP.openapi}/api/v1/userinfo`, { headers: { Accept: 'application/json', Authorization: `Bearer ${auth.accessToken}` } })
        const ub = await ui.json().catch(() => null)
        if (ub) {
          account = { uid: ub.uid ?? ub.user_id ?? ub.id ?? null, name: ub.name ?? ub.username ?? null, email: ub.email ?? null }
          console.log('userinfo：', JSON.stringify(account))
          ensureDir(PROBES_DIR)
          writeFileSync(join(PROBES_DIR, `qoder-userinfo-${Date.now()}.json`), JSON.stringify({ status: ui.status, body: ub }, null, 2))
        }
      } catch (e) { console.log('userinfo 拉取失败：', e?.message) }
      writeJson(AUTH_PATH, { machine: { machineId }, auth, account })
      console.log('已写入', AUTH_PATH)
      process.exit(0)
    }
    if (pollCount % 10 === 1) console.log(`200 无 token（第 ${pollCount} 次）：`, text.slice(0, 200))
    await sleep(POLL_INTERVAL_MS)
  }
  console.error('\n超时（5 分钟未完成授权）')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── refresh
async function refresh() {
  const { store } = currentToken()
  const rt = store.auth?.refreshToken
  if (!rt) { console.error('无 refreshToken'); process.exit(1) }
  const res = await fetch(`${EP.openapi}/api/v1/deviceToken/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: rt, machine_id: store.machine?.machineId ?? '' }),
  })
  const text = await res.text().catch(() => '')
  console.log('refresh HTTP', res.status)
  console.log(text.slice(0, 800))
  let body = null
  try { body = JSON.parse(text) } catch { /* raw */ }
  if (res.ok && body?.device_token) {
    const auth = {
      accessToken: body.device_token,
      refreshToken: body.refresh_token ?? rt,
      expiresAt: normalizeExpiry(body.expires_at),
      refreshExpiresAt: normalizeExpiry(body.refresh_token_expires_at),
      loginMethod: store.auth.loginMethod ?? 'browser',
    }
    writeJson(AUTH_PATH, { ...store, auth })
    console.log('refresh 成功 ✓ 新 accessToken：', mask(auth.accessToken))
  }
}

// ─────────────────────────────────────────────────────────── userinfo
async function userinfo() {
  const { token } = currentToken()
  const res = await fetch(`${EP.openapi}/api/v1/userinfo`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })
  const text = await res.text().catch(() => '')
  console.log('userinfo HTTP', res.status)
  console.log(text.slice(0, 1000))
  ensureDir(PROBES_DIR)
  writeFileSync(join(PROBES_DIR, `qoder-userinfo-${Date.now()}.json`), JSON.stringify({ status: res.status, body: text.slice(0, 20000) }, null, 2))
}

// ─────────────────────────────────────────────────────────── catalog
async function catalog() {
  const { token } = currentToken()
  const url = `${EP.infer}/api/v2/model/list?Encode=1`
  const res = await fetch(url, { headers: { Accept: '*/*', Authorization: `Bearer ${token}` } })
  const buf = Buffer.from(await res.arrayBuffer())
  console.log('catalog HTTP', res.status, 'bytes', buf.length, 'content-type', res.headers.get('content-type'))
  ensureDir(PROBES_DIR)
  const rawPath = join(PROBES_DIR, 'qoder-catalog-raw.bin')
  writeFileSync(rawPath, buf)
  console.log('原始响应 →', rawPath)
  const head = buf.subarray(0, 64)
  console.log('head hex：', head.toString('hex'))
  console.log('head utf8：', head.toString('utf8').replace(/[^\x20-\x7e]/g, '.'))

  const attempts = []
  const tryDecode = (name, fn) => {
    try {
      const out = fn()
      attempts.push({ name, ok: true, out, sample: out.subarray(0, 200).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.') })
    } catch (e) { attempts.push({ name, ok: false, err: String(e?.message ?? e).slice(0, 80) }) }
  }
  tryDecode('identity-utf8', () => buf)
  tryDecode('base64-text', () => Buffer.from(buf.toString('utf8').trim(), 'base64'))
  tryDecode('gzip', () => zlib.gunzipSync(buf))
  tryDecode('deflate', () => zlib.inflateSync(buf))
  tryDecode('brotli', () => zlib.brotliDecompressSync(buf))
  if (typeof zlib.zstdDecompressSync === 'function') tryDecode('zstd', () => zlib.zstdDecompressSync(buf))
  for (const a of attempts) {
    console.log(a.ok ? `  [${a.name}] len=${a.out.length} → ${a.sample.slice(0, 140)}` : `  [${a.name}] 失败：${a.err}`)
  }
  const jsonHit = attempts.find((a) => a.ok && /^\s*[[{]/.test(a.sample))
  if (jsonHit) {
    console.log('\n★ 可直接解析的 JSON 形态：', jsonHit.name)
    try {
      const parsed = JSON.parse(jsonHit.out.toString('utf8'))
      writeFileSync(join(PROBES_DIR, 'qoder-catalog-decoded.json'), JSON.stringify(parsed, null, 2))
      const arr = Array.isArray(parsed) ? parsed : (parsed.models ?? parsed.data ?? null)
      console.log('模型条数：', Array.isArray(arr) ? arr.length : '(非数组，见解码文件)')
      if (Array.isArray(arr)) console.log('首条键集：', Object.keys(arr[0] ?? {}).join(', '))
    } catch (e) { console.log('解析失败：', e?.message) }
  }
}

// ─────────────────────────────────────────────────────────── chat
// ─────────────────────────────────────────────────────────── chat
// 2026-09-20 打通后的真实形态：OpenAI 面（api2-v2，裸 Bearer）对本账号 401
// 不可用；可用面 = COSY 签名 + WASM 加密 POST 到 infer 节点（region 发现：
// gateway.qoder.com.cn）的 /algo/api/v2/service/pro/sse/agent_chat_generation，
// 响应是 SSE 信封（data:{body:"<OpenAI chunk JSON>"}）。签名由插件自带的
// providers/qoder/cosy.js 完成（手写胶水 + 官方 wasm）。
async function chat(text, { model, tools, stream }) {
  const { store, token } = currentToken()
  const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
  const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
  const cred = { accessToken: token, machineId: store.machine?.machineId, uid: store.account?.uid }
  const payload = {
    model,
    stream: true, // 上游恒流式；stream=false 只是本地聚合
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: text }],
  }
  if (tools) {
    payload.tools = [{
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Get the current local time for a given timezone.',
        parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai' } }, required: ['timezone'] },
      },
    }]
    payload.tool_choice = 'auto'
  }
  const signed = await cosy.prepareChat(cred, {
    endpoint: EP.infer, body: JSON.stringify(payload), modelKey: model, modelSource: 'system',
  })
  const res = await fetch(signed.url, {
    method: 'POST',
    headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: signed.body,
  })
  console.log(`chat model=${model} tools=${Boolean(tools)} → HTTP`, res.status, res.headers.get('content-type'), '\n  url:', signed.url)
  const hdrs = Object.fromEntries([...res.headers].slice(0, 30))
  const raw = await res.text()
  // 拆信封：data:{body: "<chunk json>"} / body:"[DONE]" / 尾帧计时
  let text2 = ''
  let usage = null
  const toolCalls = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    let frame
    try { frame = JSON.parse(line.slice(5)) } catch { continue }
    if (typeof frame.body !== 'string' || frame.body === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(frame.body) } catch { continue }
    const d = chunk.choices?.[0]?.delta
    if (d?.content) text2 += d.content
    if (d?.tool_calls) toolCalls.push(...d.tool_calls)
    if (chunk.usage) usage = chunk.usage
  }
  console.log('\n聚合正文:', JSON.stringify(text2.slice(0, 500)))
  if (toolCalls.length) console.log('tool_calls:', JSON.stringify(toolCalls).slice(0, 400))
  if (usage) console.log('usage:', JSON.stringify(usage))
  ensureDir(PROBES_DIR)
  const out = join(PROBES_DIR, `qoder-chat-live-${Date.now()}${stream ? '-stream' : ''}${tools ? '-tools' : ''}.json`)
  writeFileSync(out, JSON.stringify({ request: payload, signedUrl: signed.url, status: res.status, headers: hdrs, body: raw.slice(0, 200_000) }, null, 2))
  console.log('\n证据 →', out)
}

// ─────────────────────────────────────────────────────────── dispatch
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }

if (has('--login')) await login()
else if (has('--refresh')) await refresh()
else if (has('--userinfo')) await userinfo()
else if (has('--catalog')) await catalog()
else if (has('--chat')) {
  const text = val('--chat') ?? '你好'
  const model = val('--model') ?? (() => {
    try {
      const dec = readJson(join(PROBES_DIR, 'qoder-catalog-decoded.json'))
      const arr = Array.isArray(dec) ? dec : (dec.models ?? dec.data ?? [])
      const k = arr?.[0]?.key ?? arr?.[0]?.id
      if (k) { console.log('（未给 --model，采用目录首条：', k, '）'); return k }
    } catch { /* */ }
    return 'auto'
  })()
  await chat(text, { model, tools: has('--tools'), stream: !has('--no-stream') })
  if (has('--tools') && !has('--no-stream')) await chat(text, { model, tools: true, stream: false })
} else {
  console.log(`用法：
  --login            真实设备流登录（浏览器授权）
  --refresh          强制刷新一次
  --userinfo         账号信息
  --catalog          模型目录（Encode=1 解码尝试）
  --chat "文本" [--model <key>] [--tools] [--no-stream]`)
  process.exit(1)
}
