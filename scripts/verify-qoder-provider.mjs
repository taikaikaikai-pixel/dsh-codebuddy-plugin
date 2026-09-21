#!/usr/bin/env node
/**
 * verify-qoder-provider.mjs — Qoder CN 通道离线回归（mock 上游，断言响应完成）。
 *
 * 锁定的契约（证据 docs/reverse/qoder-cn.md）：
 *   [1] PKCE 形态：verifier 长度 43–128、charset 合法、challenge = base64url(SHA256)
 *   [2] normalizeExpiry 三形态（相对秒 / 绝对秒 / 绝对毫秒）
 *   [3] tokenFrom 双形态（poll 给 token，refresh 给 device_token）
 *   [4] 设备流快乐路径：404 pending ×N → 200 出令牌 → 落盘 + 账户信息
 *   [5] 授权 URL 形态 + 出宿主门禁（非 https / 域外 / javascript: 一律拒）
 *   [6] refresh 成功回写；失败置 needsRelogin
 *   [7] 临期自动刷新（resolveQoderCredential 内联）
 *   [8] logout 代际守卫：在飞 poll 拿到的迟到令牌不落盘
 *   [9] machine_id 自持且跨登录复用
 *   [10] 视图绝不外泄令牌与 machine_id
 *   [11] 轮询期网络抖动不判失败
 */

import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  createQoderOAuth, createPkce, createMachineId, normalizeExpiry, QODER_CLIENT_ID,
} from '../providers/qoder/oauth.js'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── mock 上游 ──────────────────────────────────────────────────────────────
const mock = {
  pollScript: [],      // 每项：{status, body} 或 'netfail'
  pollHits: 0,
  refreshReply: null,  // {status, body}
  refreshHits: 0,
  refreshBodySeen: null,
  userinfo: null,      // {status, body}
  userinfoHits: 0,
  lastPollQuery: null,
}
const handlers = {
  'GET /api/v1/deviceToken/poll': (req, res, q) => {
    mock.pollHits++
    mock.lastPollQuery = Object.fromEntries(q)
    const step = mock.pollScript[Math.min(mock.pollHits - 1, mock.pollScript.length - 1)]
    if (step === 'netfail') { req.socket.destroy(); return }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body))
  },
  'POST /api/v1/deviceToken/refresh': async (req, res) => {
    mock.refreshHits++
    const raw = Buffer.concat(await collect(req)).toString('utf8')
    try { mock.refreshBodySeen = JSON.parse(raw) } catch { mock.refreshBodySeen = raw }
    const step = mock.refreshReply ?? { status: 200, body: { device_token: 'dt-new' } }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(step.body))
  },
  'GET /api/v1/userinfo': (req, res) => {
    mock.userinfoHits++
    const step = mock.userinfo ?? { status: 200, body: { uid: 'u-1', name: 'tester', email: 't@e.cn' } }
    res.writeHead(step.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(step.body))
  },
}
const collect = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(chunks))
})
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const h = handlers[`${req.method} ${url.pathname}`]
  if (!h) { res.writeHead(404); res.end('{}'); return }
  Promise.resolve(h(req, res, url.searchParams)).catch(() => { res.writeHead(500); res.end() })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const SETTINGS = {
  qoderOpenapiBaseURL: BASE,
  qoderLoginHost: BASE,
  qoderClientId: QODER_CLIENT_ID,
}

// 文件层（真实 store，避免 mock 掉原子写纪律）
const { readJson, writeJson } = await import('../core/json-store.js')
const dir = mkdtempSync(join(tmpdir(), 'qoder-verify-'))
const AUTH_PATH = join(dir, 'qoder-plugin-auth.json')
let store = {}
const readAuth = () => store
const writeAuth = (v) => { store = v; writeJson(AUTH_PATH, v) }
const oauth = createQoderOAuth({ readAuth, writeAuth })

// ── [1] PKCE ───────────────────────────────────────────────────────────────
console.log('\n[1] PKCE 形态')
{
  const charset = /^[A-Za-z0-9\-._~]+$/
  let good = true, lenOk = true
  for (let i = 0; i < 60; i++) {
    const { verifier, challenge } = createPkce()
    if (verifier.length < 43 || verifier.length > 128) lenOk = false
    if (!charset.test(verifier)) good = false
    if (!/^[A-Za-z0-9_-]+$/.test(challenge)) good = false
    const expect = createHash('sha256').update(verifier).digest().toString('base64url')
    if (challenge !== expect) good = false
  }
  ok(lenOk, 'verifier 长度恒在 43–128')
  ok(good, 'charset 合法且 challenge=S256(verifier)')
  ok(new Set(Array.from({ length: 40 }, () => createPkce().verifier)).size === 40, 'verifier 逐次随机')
  ok(/^[0-9a-f]{48}$/.test(createMachineId()), 'machine_id = 48 hex')
}

// ── [2] 有效期归一 ─────────────────────────────────────────────────────────
console.log('\n[2] normalizeExpiry 三形态')
{
  const now = 1_700_000_000_000
  ok(normalizeExpiry(3600, now) === now + 3_600_000, '相对秒 → now+δ')
  ok(normalizeExpiry(1_700_001_000, now) === 1_700_001_000_000, '绝对秒 → ms')
  ok(normalizeExpiry(now + 5000, now) === now + 5000, '绝对毫秒原样')
  ok(normalizeExpiry('1700001000', now) === 1_700_001_000_000, '字符串数值也收')
  ok(normalizeExpiry(0, now) === null && normalizeExpiry(null, now) === null && normalizeExpiry('x', now) === null, '非法值 → null')
  // 2026-09-19 实测：expires_at 是 ISO 字符串（早先按数字解 → NaN → 落 0，令"永不过期
  // 但立即该刷新"，真实登录联调才暴露）
  ok(normalizeExpiry('2026-09-19T13:00:00Z') === Date.parse('2026-09-19T13:00:00Z'), 'ISO 字符串 → epoch ms')
  ok(normalizeExpiry('2026-09-19T13:00:00.000Z') === Date.parse('2026-09-19T13:00:00Z'), '带毫秒 ISO 也收')
  ok(normalizeExpiry('2026-09-19T13:00:00Z', now) > now, 'ISO 解析不再退化为 0')
}

// ── [5] 授权 URL 与门禁 ────────────────────────────────────────────────────
console.log('\n[5] 授权 URL 形态与出宿主门禁')
{
  const verdicts = []
  for (const host of ['https://evil.example', 'http://x.cn/', 'javascript:alert(1)', 'not a url', 'https://qoder.cn.evil.example']) {
    // startOAuth 是 async：门禁失败以 rejection 呈现（组合根 await + catch）。
    let r = '未拒'
    try { await createQoderOAuth({ readAuth, writeAuth }).startOAuth({ ...SETTINGS, qoderLoginHost: host }) }
    catch (e) { r = /必须使用 https|不在 Qoder 官方登录站点族|合法 URL/.test(e.message) ? '拒' : '意外:' + e.message }
    verdicts.push(`${host}:${r}`)
  }
  ok(verdicts.every((x) => x.endsWith('拒')), `门禁拒绝越域/非法基址/后缀伪装域（${verdicts.join(' | ')}）`)

  // 官方站点族必须放行（收紧不得把自己人挡掉）
  for (const host of ['https://qoder.cn', 'https://qoder.com.cn']) {
    const o = createQoderOAuth({ readAuth, writeAuth })
    const { authUrl } = await o.startOAuth({ ...SETTINGS, qoderLoginHost: host, qoderOpenapiBaseURL: BASE })
    ok(new URL(authUrl).origin === host, `官方域放行：${host}`)
    await o.logout()
  }
  // 门禁失败时不留副作用：不激活 pending、不写 machine_id
  {
    const o = createQoderOAuth({ readAuth: () => ({}), writeAuth: () => { throw new Error('不应发生写入') } })
    let threw = false
    try { await o.startOAuth({ ...SETTINGS, qoderLoginHost: 'https://evil.example' }) } catch { threw = true }
    ok(threw && o.oauthStatus().pending === false, '越域拒绝时不激活 pending 且不写盘')
  }

  mock.pollScript = [{ status: 404, body: { errorCode: 'NotFound' } }]
  const { authUrl } = await oauth.startOAuth(SETTINGS)
  const u = new URL(authUrl)
  ok(u.pathname === '/device/selectAccounts', '授权页路径 /device/selectAccounts')
  ok(u.searchParams.get('challenge_method') === 'S256', 'challenge_method=S256')
  ok(u.searchParams.get('client_id') === QODER_CLIENT_ID, 'client_id = prod uuid')
  ok(/^[A-Za-z0-9_-]{43,128}$/.test(u.searchParams.get('challenge')), 'challenge 为 b64url')
  ok(u.searchParams.get('machine_id')?.length === 48, 'machine_id 带上')
  await oauth.logout()
}

// ── [4][9] 设备流快乐路径 + machine_id 复用 ────────────────────────────────
console.log('\n[4] 设备流：404 pending → 200 出令牌；[9] machine_id 复用')
{
  const mid0 = oauth.ensureMachineId()
  mock.pollHits = 0
  mock.userinfoHits = 0
  mock.pollScript = [
    { status: 404, body: { errorCode: 'NotFound', errorMessage: 'Not found' } },
    { status: 404, body: { errorCode: 'NotFound' } },
    { status: 404, body: { errorCode: 'NotFound' } },
    { status: 200, body: { token: 'qt-access-1', refresh_token: 'drt-r-1', expires_at: 3600, refresh_token_expires_at: 86400 } },
  ]
  const { authUrl } = await oauth.startOAuth(SETTINGS)
  ok(oauth.oauthStatus().pending === true, 'pending 置位')
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  const st = oauth.oauthStatus()
  ok(st.signedIn === true, `登录落定（轮询 ${mock.pollHits} 次，authUrl 已给出）`, st.error)
  ok(st.pending === false, 'pending 收敛')
  ok(store.auth.accessToken === 'qt-access-1', 'accessToken 写入')
  ok(store.auth.refreshToken === 'drt-r-1', 'refreshToken 写入（drt- 前缀原样保留）')
  ok(Math.abs(store.auth.expiresAt - (Date.now() + 3_600_000)) < 20_000, 'expiresAt 由相对秒算出')
  ok(store.account?.uid === 'u-1' && store.account.nickname === 'tester', '账户信息拉取并入')
  ok(mock.userinfoHits === 1, 'userinfo 恰好一次')
  ok(mock.lastPollQuery?.challenge_method === 'S256' && /^[0-9a-f-]{36}$/.test(mock.lastPollQuery?.nonce ?? ''), 'poll 带 nonce/challenge_method')
  ok(mock.lastPollQuery?.verifier?.length >= 43, 'poll 带 verifier（授权页只有 challenge，轮询用全量）')
  ok(oauth.ensureMachineId() === mid0, 'machine_id 跨登录稳定')
  ok(new URL(authUrl).searchParams.get('machine_id') === mid0, '授权页 machine_id 与存储一致')
}

// ── [10] 视图不泄密 ─────────────────────────────────────────────────────────
console.log('\n[10] 视图字段脱敏')
{
  const v = oauth.oauthStatus()
  const flat = JSON.stringify(v) + JSON.stringify(Object.keys(v))
  ok(!flat.includes('qt-access-1') && !flat.includes('drt-r-1'), '令牌不在视图内')
  ok(!flat.includes(store.machine.machineId), 'machine_id 不在视图内')
  ok(v.accessTokenExpiresAt > Date.now(), '过期时间以 epoch 出视图')
}

// ── [7] 临期自动刷新 ────────────────────────────────────────────────────────
console.log('\n[7] 临期自动刷新')
{
  store.auth = { ...store.auth, expiresAt: Date.now() + 1000 } // 触发临期
  mock.refreshHits = 0
  mock.refreshReply = { status: 200, body: { device_token: 'qt-access-2', refresh_token: 'drt-r-2', expires_at: 7200 } }
  const cred = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred?.authorization === 'Bearer qt-access-2', '返回新令牌')
  ok(mock.refreshHits === 1, '刷新恰好一次')
  ok(mock.refreshBodySeen?.refresh_token === 'drt-r-2' || mock.refreshBodySeen?.refresh_token === 'drt-r-1', '请求体带 refresh_token')
  ok(/^[0-9a-f]{48}$/.test(mock.refreshBodySeen?.machine_id ?? ''), '请求体带 machine_id')
  ok(store.auth.accessToken === 'qt-access-2' && store.auth.refreshToken === 'drt-r-2', '新令牌对回写')
  ok(cred.uid === 'u-1' && cred.machineId === store.machine.machineId, 'cred 带 uid/machineId（/algo 面备用）')
  // 未临期不再刷新
  const h = mock.refreshHits
  await oauth.resolveQoderCredential(SETTINGS)
  ok(mock.refreshHits === h, '未临期不触发刷新')
}

// ── [6] refresh 失败 → needsRelogin ────────────────────────────────────────
console.log('\n[6] refresh 失败形态')
{
  store.auth = { ...store.auth, expiresAt: Date.now() + 1000 }
  const rExpiryBefore = store.auth.refreshExpiresAt
  mock.refreshReply = { status: 400, body: { errorCode: 'DeviceRefreshTokenPrefixInvalid', errorMessage: 'invalid refresh_token: must start with drt-' } }
  const cred = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred === null, '刷新失败不出凭据')
  ok(oauth.oauthStatus().needsRelogin === true, 'needsRelogin 置位（令牌在但已不可续）')
  mock.refreshReply = { status: 200, body: { device_token: 'qt-access-3', expires_at: 3600 } }
  const cred2 = await oauth.resolveQoderCredential(SETTINGS)
  ok(cred2?.authorization === 'Bearer qt-access-3', '再刷新成功')
  ok(oauth.oauthStatus().needsRelogin === false, '刷新成功自愈')
  ok(store.auth.refreshToken === 'drt-r-2', '响应不带 refresh_token 时沿用旧值')
  ok(store.auth.refreshExpiresAt === rExpiryBefore, '响应不带 refresh 有效期时沿用旧值')
  ok(store.auth.loginMethod === 'browser', 'loginMethod 不被刷新丢弃')
}

// ── [8] logout 代际守卫 ─────────────────────────────────────────────────────
console.log('\n[8] logout 使在飞 poll 失效')
{
  writeAuth({ machine: store.machine }) // 清令牌，保留 machine
  mock.pollScript = [
    { status: 404, body: {} }, { status: 404, body: {} }, { status: 404, body: {} },
    { status: 404, body: {} }, { status: 404, body: {} },
    { status: 200, body: { token: 'late-token', expires_at: 3600 } },
  ]
  mock.pollHits = 0
  await oauth.startOAuth(SETTINGS)
  await sleep(700) // 让它进入轮询中
  await oauth.logout()
  const before = JSON.stringify(store)
  await sleep(2500) // 越过"迟到令牌"那一步
  ok(JSON.stringify(store) === before, 'logout 后迟到令牌未落盘')
  ok(!JSON.stringify(store).includes('late-token'), 'late-token 未进存储')
  ok(oauth.oauthStatus().pending === false, 'logout 后 pending 收敛')
}

// ── [11] 网络抖动容错 ───────────────────────────────────────────────────────
console.log('\n[11] 轮询期网络抖动不判失败')
{
  writeAuth({ machine: store.machine })
  mock.pollHits = 0
  mock.pollScript = ['netfail', 'netfail', { status: 200, body: { token: 'qt-net', expires_at: 3600 } }]
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  const st = oauth.oauthStatus()
  ok(st.signedIn === true, '抖动后仍完成登录')
  ok(st.error === '', `无错误残留（error=${st.error}）`)
  await oauth.logout()
}

// ── 非 JSON 404 与 400 业务码 ───────────────────────────────────────────────
console.log('\n[12] 失败形态：非 JSON / 业务错误码')
{
  writeAuth({ machine: store.machine })
  mock.pollHits = 0
  mock.pollScript = [{ status: 400, body: { errorCode: 'DeviceTokenVerifierRequired', errorMessage: 'verifier is required' } }]
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 30 && oauth.oauthStatus().pending; i++) await sleep(100)
  const st = oauth.oauthStatus()
  ok(st.signedIn === false, '400 不产出登录')
  ok(/DeviceTokenVerifierRequired/.test(st.error), `错误带业务码（${st.error}）`)
  await oauth.logout()

  mock.pollHits = 0
  mock.pollScript = [{ status: 404, body: '<html>nginx</html>' }]
  await oauth.startOAuth(SETTINGS)
  await sleep(1400)
  ok(oauth.oauthStatus().error === '' || oauth.oauthStatus().pending, '裸 HTML 404 不误判为失败')
  await oauth.logout()
}

// ── [13] 真实线缆形态回放锁（2026-09-19 真实登录捕获的 poll 响应键集）────────
console.log('\n[13] 真实 poll 响应形态回放')
{
  // 真机捕获键集：id, token, user_id, code_challenge, code_challenge_method, nonce,
  // expires_at, refresh_token_id, created_at, updated_at, refresh_token,
  // expires_in, refresh_token_expires_in, refresh_token_expires_at
  const real = {
    id: 'dt-abc', token: 'dt-realshape', user_id: '019efdac-1bf3-792a-a63d-1b94c1ea9fb0',
    code_challenge: 'x', code_challenge_method: 'S256', nonce: 'n-1',
    expires_at: '2026-09-20T11:03:28.128Z', refresh_token_id: 'rtr-1',
    created_at: '2026-09-19T11:03:28.128Z', updated_at: '2026-09-19T11:03:28.128Z',
    refresh_token: 'drt-realshape', expires_in: 86400,
    refresh_token_expires_in: 2592000, refresh_token_expires_at: '2026-10-19T11:03:28.128Z',
  }
  writeAuth({ machine: { machineId: 'f'.repeat(48) } })
  mock.pollHits = 0
  mock.pollScript = [{ status: 200, body: real }]
  mock.userinfo = { status: 200, body: { id: real.user_id, name: 'aliyun1985984145' } }
  await oauth.startOAuth(SETTINGS)
  for (let i = 0; i < 40 && oauth.oauthStatus().pending; i++) await sleep(120)
  ok(store.auth.accessToken === 'dt-realshape', 'dt- 设备令牌入库')
  ok(store.auth.refreshToken === 'drt-realshape', 'drt- 刷新令牌入库')
  ok(store.auth.expiresAt === Date.parse(real.expires_at), 'expires_at(ISO) 正确解析为 epoch', String(store.auth.expiresAt))
  ok(store.auth.expiresAt > Date.now(), '有效期落在未来（旧实现这里会写成 0）')
  ok(store.auth.refreshExpiresAt === Date.parse(real.refresh_token_expires_at), 'refresh_token_expires_at(ISO) 解析')
  ok(oauth.oauthStatus().account?.uid === real.user_id, 'uid 经 userinfo 补全（poll 只给 user_id）')
  ok(oauth.oauthStatus().needsRelogin === false, '新鲜登录不误报需重登')
  mock.userinfo = null
  await oauth.logout()
}

// ── [14] 翻译网关：真实 WASM 签名 + mock infer 上游（2026-09-20 打通的形态锁）──
console.log('\n[14] 翻译网关：COSY 信封 ↔ OpenAI 流式/非流式翻译')
{
  const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
  const { createQoderGateway } = await import('../providers/qoder/gateway.js')
  const { fileURLToPath } = await import('node:url')
  const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers', 'qoder', 'qoder_auth.wasm')

  // mock infer 上游：认 URL 形态（agent_chat_generation），回脚本化 SSE 信封
  let inferScript = 'normal'
  let inferBodySeen = null
  const infer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.endsWith('/algo/api/v2/service/pro/sse/agent_chat_generation')) {
      res.writeHead(404); res.end(); return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      inferBodySeen = Buffer.concat(chunks).toString('utf8')
      if (inferScript === 'http401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"unauthorized"}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (inferScript === 'errorframe') {
        res.end('event:error\ndata:{"stackTrace":[{"methodName":"x"}],"msgInfo":"boom"}\n\n')
        return
      }
      const chunk = (delta, extra = {}) => JSON.stringify({ choices: [{ delta, index: 0, ...(extra.finish ? { finish_reason: extra.finish } : {}) }], created: 1, id: 'c1', model: 'auto', object: 'chat.completion.chunk' })
      const env = (body) => `data:${JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body, statusCodeValue: 200, statusCode: 'OK' })}\n\n`
      const usageChunk = JSON.stringify({ choices: [], created: 1, id: 'c1', model: 'auto', object: 'chat.completion.chunk', usage: { billable: true, prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 0.5 } })
      res.end(
        env(chunk({ content: '你' }))
        + env(chunk({ content: '好' }, { finish: 'stop' }))
        + env(usageChunk)
        + env('[DONE]')
        + `data:${JSON.stringify({ firstTokenDuration: 1, totalDuration: 2, serverDuration: 2 })}\n\n`,
      )
    })
  })
  await new Promise((r) => infer.listen(0, '127.0.0.1', r))
  const inferOrigin = `http://127.0.0.1:${infer.address().port}`

  const metered = []
  const cosy = createCosyRuntime({ wasmPath })
  const runtime = { running: false, port: null, lastError: null }
  const gateway = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: inferOrigin, maxConcurrentPerSession: 4, upstreamFirstByteTimeoutMs: 5000 }),
    resolveCredential: async () => ({ authorization: 'Bearer dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }),
    cosy,
    meter: { record: (r) => metered.push(r) },
    runtime,
    forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [{ id: 'auto', name: 'Auto' }],
    getModelSource: () => 'system',
  })
  const stopGw = gateway.listen(0)
  for (let i = 0; i < 50 && !runtime.running; i++) await sleep(50)
  ok(runtime.running === true, '网关监听成功')
  const gw = `http://127.0.0.1:${runtime.port}`

  // 流式：信封 chunk 逐帧透传 + [DONE] 收尾 + usage.credits → credit 计量
  const resp = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const sseText = await resp.text()
  ok(resp.status === 200, '流式 200')
  ok(sseText.includes('"content":"你"') && sseText.includes('"content":"好"'), '内容增量逐帧透传')
  ok(sseText.includes('"finish_reason":"stop"'), 'finish_reason 透传')
  ok(sseText.trimEnd().endsWith('data: [DONE]'), '[DONE] 收尾')
  ok(inferBodySeen !== null && inferBodySeen.length > 0, '上游收到加密 body', String(inferBodySeen).slice(0, 40))
  ok(metered.length === 1 && metered[0].usage.credit === 0.5 && metered[0].usage.total_tokens === 12,
    '计量落盘且 credits→credit 归一', JSON.stringify(metered[0]?.usage))

  // 非流式：聚合成单个 chat.completion
  const resp2 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const agg = await resp2.json()
  ok(agg.object === 'chat.completion' && agg.choices[0].message.content === '你好', '非流式聚合正文')
  ok(agg.choices[0].finish_reason === 'stop' && agg.usage.total_tokens === 12, '非流式聚合 finish/usage')

  // 错误帧：流中段 error event → 错误 chunk + [DONE]
  inferScript = 'errorframe'
  const resp3 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const errSse = await resp3.text()
  ok(errSse.includes('"error"') && errSse.trimEnd().endsWith('data: [DONE]'), 'error 帧 → 错误 chunk + [DONE]')

  // 上游 401 → 状态与错误码透传
  inferScript = 'http401'
  const resp4 = await fetch(`${gw}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const err401 = await resp4.json()
  ok(resp4.status === 401 && err401.error.code === 'qoder_401', '上游 401 透传')
  inferScript = 'normal'

  // Host 门：非回环 Host 拒绝（fetch 会覆盖伪造 Host——必须原生客户端）
  const resp5 = await new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port: runtime.port, path: '/v1/models', method: 'GET', headers: { Host: 'evil.example.com' } }, (rs) => {
      rs.resume() // 消费响应（踩坑 #29：paused 流永不 close）
      rs.on('end', () => resolve({ status: rs.statusCode }))
    })
    r.on('error', reject)
    r.end()
  })
  ok(resp5.status === 403, 'Host 门拒绝非回环')

  // /v1/models 来自目录
  const resp6 = await fetch(`${gw}/v1/models`)
  const models6 = await resp6.json()
  ok(Array.isArray(models6.data) && models6.data[0]?.id === 'auto', '/v1/models 出目录')

  await stopGw()
  infer.close()
}

// ── [15] 目录投影：明文形态 + 过滤 + sources 映射 ───────────────────────────
console.log('\n[15] 目录投影（fetchQoderCatalog）')
{
  const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
  const { fetchQoderCatalog } = await import('../providers/qoder/catalog.js')
  const { fileURLToPath } = await import('node:url')
  const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers', 'qoder', 'qoder_auth.wasm')
  const cosy = createCosyRuntime({ wasmPath })
  const catServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      chat: [
        { key: 'auto', format: 'openai', source: 'system', enable: true, display_name: 'Auto', is_vl: true, max_input_tokens: 180000 },
        { key: 'qmodel_38max', format: 'openai', source: 'system', enable: true, display_name: 'Qwen3.8-Max', is_vl: true, context_config: { '200K': { token_count: 200000, is_default: true }, '1M': { token_count: 1000000 } } },
        { key: 'disabled-m', format: 'openai', enable: false },
        { key: 'other-fmt', format: 'anthropic', enable: true },
      ],
    }))
  })
  await new Promise((r) => catServer.listen(0, '127.0.0.1', r))
  const catOrigin = `http://127.0.0.1:${catServer.address().port}`
  const cred = { accessToken: 'dt-test', machineId: 'a'.repeat(48), uid: 'u-1' }
  const result = await fetchQoderCatalog(cosy, cred, catOrigin)
  ok(result.profiles.length === 2, 'enable+format 过滤后 2 条', String(result.profiles.length))
  ok(result.profiles[1].contextWindow === 200000, 'contextWindow 取 context_config 默认档')
  ok(result.profiles[0].contextWindow === 180000, '无 context_config 回落 max_input_tokens')
  ok(result.profiles[0].input.includes('image') && result.profiles[1].input.includes('image'), 'is_vl → input 含 image')
  ok(result.sources.qmodel_38max === 'system', 'sources 映射保留')
  catServer.close()
}

server.close()
console.log(`\n=== verify-qoder-provider: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
