#!/usr/bin/env node
/**
 * Offline regression for providers/trae/ (v0.8.x TraeWork CN channel):
 *
 *   1. OAuth device flow against a mock api.trae.cn:
 *      - PKCE (code_challenge == SHA256(code_verifier), S256 method)
 *      - authUrl shape (client_id / auth_callback_url on 127.0.0.1)
 *      - browser callback -> AuthCode exchange -> tokens + account persisted
 *      - refresh path with DeviceProof VERIFIED by the mock using the public
 *        key our flow registered (proves the self-held ECDSA keypair works)
 *      - failure/timeout/logout semantics
 *   2. catalog: fixture state.vscdb -> profiles (BYOK excluded, multimodal,
 *      ctx fallback), syncCatalog/catalogView/catalogIds
 *   3. gateway translation against a mock Trae cloud:
 *      - outbound headers (Cloud-IDE-JWT + x-cloudide-token + region)
 *      - Trae SSE -> OpenAI SSE (stream mode) and aggregation (non-stream)
 *      - usage metering, upstream 401 mapping, credential-unavailable 503,
 *        GET /v1/models from synced catalog
 *   4. provider factory shape
 *
 * No network beyond 127.0.0.1; no real credentials. Usage:
 *   node scripts/verify-trae-provider.mjs
 */

import { createServer } from 'node:http'
import { createHash, verify as cryptoVerify, createPublicKey } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { catalogToProfiles } from '../providers/trae/catalog.js'
import { buildChatRequest, createTraeStreamParser, createTraeGateway, cumulativeDelta, TRAE_APP_ID, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE } from '../providers/trae/gateway.js'
import { normalizeTraeError } from '../providers/trae/errors.js'
import { createTraeProvider } from '../providers/trae/index.js'

let failures = 0
let checks = 0
function check(label, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// mock api.trae.cn (OAuth + account)
// ---------------------------------------------------------------------------

function mockTraeAuth() {
  const state = {
    issued: [],           // {token, refreshToken}
    exchanges: [],        // every ExchangeToken request body (for assertions)
    registeredKeys: new Map(), // clientId -> SPKI base64 (from AuthCode exchange)
    userInfoCalls: [],
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      if (req.url === '/trae/api/v3/oauth/ExchangeToken' && req.method === 'POST') {
        state.exchanges.push(body)
        if (body.ClientID !== 'en1oxy7wnw8j9n' && body.ClientID !== 'ono9krqynydwx5') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'Invalid client.' } } }))
          return
        }
        if (body.AuthCode) {
          if (body.AuthCode !== 'test-auth-code') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: '无效参数：{__Message.field}.' } } }))
            return
          }
          if (!body.CodeVerifier || !body.DeviceInfo?.DevicePublicKey) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'missing PKCE/device fields' } } }))
            return
          }
          state.registeredKeys.set(body.ClientID, body.DeviceInfo.DevicePublicKey)
          const out = {
            Token: `tok-${state.issued.length + 1}`,
            RefreshToken: `rt-${state.issued.length + 1}`,
            TokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
            RefreshExpireAt: Math.floor(Date.now() / 1000) + 86400,
          }
          state.issued.push(out)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ Result: out }))
          return
        }
        if (body.RefreshToken) {
          // DeviceProof 验签：用 AuthCode 阶段注册的公钥验证 ECDSA P-256 签名。
          const spki = state.registeredKeys.get(body.ClientID)
          const proof = body.DeviceProof
          if (!spki || !proof) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10102', Message: 'device not registered' } } }))
            return
          }
          const stringToSign = ['POST', '/trae/api/v3/oauth/ExchangeToken', body.ClientID, body.RefreshToken, String(proof.Timestamp), proof.Nonce].join('\n')
          let ok = false
          try {
            ok = cryptoVerify('sha256', Buffer.from(stringToSign, 'utf8'), createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(proof.Signature, 'base64'))
          } catch { ok = false }
          if (!ok) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10103', Message: 'device proof signature invalid' } } }))
            return
          }
          const known = state.issued.some((i) => i.RefreshToken === body.RefreshToken)
          if (!known) {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10104', Message: 'refresh token invalid' } } }))
            return
          }
          const out = {
            Token: `tok-${state.issued.length + 1}`,
            RefreshToken: `rt-${state.issued.length + 1}`,
            TokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
            RefreshExpireAt: Math.floor(Date.now() / 1000) + 86400,
          }
          state.issued.push(out)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ Result: out }))
          return
        }
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '10101', Message: 'no AuthCode/RefreshToken' } } }))
        return
      }
      if (req.url === '/cloudide/api/v3/trae/GetUserInfo' && req.method === 'POST') {
        state.userInfoCalls.push(req.headers)
        const token = req.headers['x-cloudide-token']
        const latest = state.issued[state.issued.length - 1]
        if (!token || token !== latest?.Token) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ResponseMetadata: { Error: { Code: '20310', Message: 'The user is not logged in,' } } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Result: { Name: '测试用户', UserId: 'u-001' } }))
        return
      }
      res.writeHead(404)
      res.end('nf')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })
  }))
}

// ---------------------------------------------------------------------------
// mock Trae chat cloud (SSE)
// ---------------------------------------------------------------------------

function mockTraeChat({ authedToken = 'tok-live', status = 200 } = {}) {
  const state = { requests: [] }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      state.requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1001, message: "We're sorry, but we are not able to authenticate you." }))
        return
      }
      const token = req.headers['x-cloudide-token']
      const authz = req.headers['authorization']
      if (token !== authedToken || authz !== `Cloud-IDE-JWT ${authedToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1001, message: 'auth failed (mock)' }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 事件语法 = 2026-08-24 带凭据联调校准形态（response/reasoning_content 为累计快照）
      res.write('event: metadata\n')
      res.write(`data: ${JSON.stringify({ model: '', session_id: 's', prompt_completion_id: 0 })}\n\n`)
      res.write('event: timing_cost\n')
      res.write(`data: ${JSON.stringify({ name: 'llm_raw_chat_v2', provider_model_name: 'kimi-k2.6' })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好', reasoning_content: null })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好，', reasoning_content: '思' })}\n\n`)
      res.write('event: output\n')
      res.write(`data: ${JSON.stringify({ response: '你好，世界', reasoning_content: '思' })}\n\n`)
      res.write('event: token_usage\n')
      res.write(`data: ${JSON.stringify({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })}\n\n`)
      res.write('event: done\n')
      res.write(`data: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, state })
  }))
}

// ---------------------------------------------------------------------------
// fixture state.vscdb for the catalog
// ---------------------------------------------------------------------------

function buildCatalogFixture(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const payload = {
    solo_agent_lite: [
      {
        config_name: 'glm-5.3', name: 'glm-5.3', display_name: 'GLM-5.3', provider: '',
        model_type: 'reasoning_model', multimodal: false, prompt_max_tokens: 936000,
        max_tokens: 64000, max_turn: 500, context_window_size: { default: 200000, max: [1000000] },
        is_preset: true, selectable: true, status: true, fee_model_level: 2,
      },
      {
        config_name: 'kimi-k3', name: 'kimi-k3', display_name: 'Kimi-K3', provider: '',
        model_type: 'chat_model', multimodal: true, prompt_max_tokens: 936000,
        max_tokens: 64000, max_turn: 500, context_window_size: { default: null, max: [500000] },
        is_preset: true, selectable: true, status: true,
      },
      {
        config_name: 'deepseek//deepseek-v4-pro', name: 'deepseek//deepseek-v4-pro', display_name: 'DeepSeek-V4-Pro',
        provider: 'deepseek', model_type: 'reasoning_model', multimodal: false, is_preset: false, selectable: true, status: true,
      },
      {
        config_name: 'dead-model', name: 'dead-model', display_name: 'Dead', provider: '',
        multimodal: false, is_preset: true, selectable: false, status: false,
      },
    ],
  }
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('111:AI.agent.model.model_list_map', JSON.stringify(payload))
  db.close()
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'verify-trae-provider-'))
const authPath = join(workDir, 'trae-auth.json')

try {
  // =========================================================================
  console.log('== OAuth 设备流（mock api.trae.cn）==')
  const mock = await mockTraeAuth()
  const settings = {
    traeAuthBaseURL: mock.base,
    traeLoginHost: 'https://login.example.test',
    traeChatBaseURL: 'http://127.0.0.1:1',
  }
  const store = { read: () => JSON.parse(readFileOr(authPath, '{}')) }
  const oauth = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })

  const started = await oauth.startOAuth(settings)
  check('startOAuth 返回授权页 URL', typeof started.authUrl === 'string' && started.authUrl.length > 0)
  const authUrl = new URL(started.authUrl)
  check('授权页路径与 host 正确', authUrl.pathname === '/authorization' && authUrl.hostname === 'login.example.test')
  check('PKCE method=S256 + challenge 存在', authUrl.searchParams.get('code_challenge_method') === 'S256' && (authUrl.searchParams.get('code_challenge') ?? '').length > 20)
  check('client_id 用 SOLO Lite 分支', authUrl.searchParams.get('client_id') === 'en1oxy7wnw8j9n')
  const cb = authUrl.searchParams.get('auth_callback_url')
  check('回调 URL 在 127.0.0.1 且路径 /authorize', cb != null && /^http:\/\/127\.0\.0\.1:\d+\/authorize$/.test(cb))
  check('设备双 id 已上 URL（machine_id/device_id）', (authUrl.searchParams.get('machine_id') ?? '').length === 64 && /^\d+$/.test(authUrl.searchParams.get('device_id') ?? ''))

  // 模拟浏览器 302 回调
  const cbUrl = new URL(cb)
  cbUrl.search = '?' + new URLSearchParams({
    authCodeInfo: JSON.stringify({ AuthCode: 'test-auth-code' }),
    userInfo: JSON.stringify({ name: '测试用户' }),
    consoleHost: mock.base,
  }).toString()
  const cbRes = await fetch(cbUrl)
  check('回调应答 200 成功页', cbRes.status === 200 && (await cbRes.text()).includes('登录成功'))
  await sleep(150) // 回调内后续写入

  const authAfter = store.read()
  check('令牌与刷新令牌落盘', authAfter.auth?.accessToken === 'tok-1' && authAfter.auth?.refreshToken === 'rt-1')
  check('账号信息落盘（GetUserInfo）', authAfter.account?.nickname === '测试用户' && authAfter.account?.uid === 'u-001')
  check('设备私钥持久化（P-256 PKCS8）', typeof authAfter.device?.privateKeyPem === 'string' && authAfter.device.privateKeyPem.includes('PRIVATE KEY'))

  const exchange = mock.state.exchanges[0]
  const challenge = authUrl.searchParams.get('code_challenge')
  const verifierMatch = createHash('sha256').update(exchange.CodeVerifier).digest('base64url') === challenge
  check('PKCE：code_challenge == SHA256(code_verifier)（base64url）', verifierMatch)
  check('DeviceInfo 公钥形态（SPKI base64，P-256 长度档）', typeof exchange.DeviceInfo?.DevicePublicKey === 'string' && exchange.DeviceInfo.DevicePublicKey.length > 100 && exchange.DeviceInfo.PlatformCode === 'SOLO_PC')

  const cred = await oauth.resolveTraeCredential(settings)
  check('resolveTraeCredential 双头形态', cred?.authorization === 'Cloud-IDE-JWT tok-1' && cred?.headers?.['x-cloudide-token'] === 'tok-1' && cred?.headers?.['X-User-Region'] === 'CN')

  // 刷新：把过期时间拨到过去，resolve 应自动走 DeviceProof 刷新并被 mock 验签通过
  const st = store.read()
  st.auth.expiresAt = Date.now() - 1000
  writeFileSync(authPath, JSON.stringify(st))
  const cred2 = await oauth.resolveTraeCredential(settings)
  check('临期自动刷新拿到新令牌（DeviceProof 验签通过）', cred2?.authorization === 'Cloud-IDE-JWT tok-2')
  check('刷新模式请求带 DeviceProof 三件套', (() => {
    const r = mock.state.exchanges[mock.state.exchanges.length - 1]
    return r?.RefreshToken === 'rt-1' && r?.DeviceProof?.Signature && r?.DeviceProof?.Nonce?.length === 32 && Number.isInteger(r?.DeviceProof?.Timestamp)
  })())
  check('oauthStatus 视图（不泄露令牌/私钥）', (() => {
    const v = oauth.oauthStatus()
    const s = JSON.stringify(v)
    return v.signedIn === true && v.account?.nickname === '测试用户' && !s.includes('tok-2') && !s.includes('PRIVATE KEY')
  })())

  // 登出：清令牌、保设备
  oauth.logout()
  const afterLogout = store.read()
  check('登出清令牌保设备身份', afterLogout.auth == null && afterLogout.device?.privateKeyPem != null)

  // 坏 AuthCode 路径
  const oauth2 = createTraeOAuth({
    readAuth: () => store.read(),
    writeAuth: (v) => writeFileSync(authPath, JSON.stringify(v)),
  })
  const s2 = await oauth2.startOAuth(settings)
  const cb2 = new URL(new URL(s2.authUrl).searchParams.get('auth_callback_url'))
  cb2.search = '?' + new URLSearchParams({ authCodeInfo: JSON.stringify({ AuthCode: 'bogus' }) }).toString()
  await fetch(cb2)
  await sleep(150)
  check('坏 AuthCode → pending.error 记录、无令牌', oauth2.oauthStatus().error.includes('10101') && !oauth2.oauthStatus().signedIn)

  mock.server.closeAllConnections?.()
  mock.server.close()

  // =========================================================================
  console.log('== 目录（fixture state.vscdb）==')
  const dbPath = join(workDir, 'state.vscdb')
  buildCatalogFixture(dbPath)
  const traeRuntime = { running: false, port: null, lastError: null }
  const meterCalls = []
  const traeProvider = createTraeProvider({
    readAuth: () => ({}),
    writeAuth: () => {},
    settings: () => settings,
    withCredentials: async () => ({ cred: null, res: null, err: null }),
    meter: { record: (r) => meterCalls.push(r) },
    runtime: traeRuntime,
  })
  const sync1 = await traeProvider.syncCatalog({ dbPath })
  check('syncCatalog 成功（2 个可路由模型）', sync1.ok === true && sync1.count === 2, JSON.stringify(sync1))
  const view = traeProvider.catalogView()
  const ids = traeProvider.catalogIds()
  check('BYOK 条目被排除（deepseek//…）', !ids.includes('deepseek//deepseek-v4-pro'))
  check('禁用条目被排除（dead-model）', !ids.includes('dead-model'))
  const glm = view.profiles.find((p) => p.id === 'glm-5.3')
  const kimi = view.profiles.find((p) => p.id === 'kimi-k3')
  check('profile 字段映射（ctx/maxTokens/多模态）', glm.contextWindow === 200000 && glm.maxTokens === 64000 && !glm.input && kimi.input[1] === 'image')
  check('ctx 缺失回落 max 数组最大档', kimi.contextWindow === 500000)
  check('目录指纹进 view（不泄露 key）', typeof view.candidate === 'string' && view.candidate.startsWith('sha256:'))

  // catalogToProfiles 纯函数：空目录安全
  check('catalogToProfiles 容忍空输入', catalogToProfiles(null).length === 0 && catalogToProfiles({ models: [] }).length === 0)

  // =========================================================================
  console.log('== 翻译网关（mock Trae 云端 SSE）==')
  const chatMock = await mockTraeChat()
  const gwSettings = () => ({ ...settings, traeChatBaseURL: chatMock.base, maxConcurrentPerSession: 4 })
  const cred3 = { authorization: 'Cloud-IDE-JWT tok-live', headers: { 'x-cloudide-token': 'tok-live', 'X-User-Region': 'CN' } }
  const gateway = createTraeGateway({
    settings: gwSettings,
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => ({ deviceId: '123', machineId: 'abc', deviceBrand: 'b', deviceCpu: 'c', osVersion: 'v' }),
    readAuthMeta: () => ({ uid: 'u-001' }),
    meter: { record: (r) => meterCalls.push(r) },
    runtime: traeRuntime,
    getCatalogIds: () => ids,
  })
  const stop = gateway.listen(0)
  await sleep(80) // listening 事件异步回填 runtime.port
  const gwPort = traeRuntime.port
  check('网关监听临时端口', traeRuntime.running === true && gwPort > 0)

  // 流式
  const streamRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }),
  })
  const streamText = await streamRes.text()
  const sseLines = streamText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  let assembled = ''
  let reasoning = ''
  let streamUsage = null
  let sawDone = false
  for (const line of sseLines) {
    if (line === '[DONE]') { sawDone = true; continue }
    const c = JSON.parse(line)
    if (c.choices?.[0]?.delta?.content) assembled += c.choices[0].delta.content
    if (c.choices?.[0]?.delta?.reasoning_content) reasoning += c.choices[0].delta.reasoning_content
    if (c.usage) streamUsage = c.usage
    if (c.choices?.[0]?.finish_reason) check('流式 finish_reason=stop', c.choices[0].finish_reason === 'stop')
  }
  check('流式：SSE 200 且 OpenAI chunk 形态', streamRes.status === 200 && sseLines.length >= 4)
  check('流式：文本增量拼接（你好，世界，无改派通知混入）', assembled === '你好，世界')
  check('流式：reasoning_content 透传不混入正文', reasoning === '思')
  check('流式：usage 进末块 + [DONE] 收尾', streamUsage?.total_tokens === 13 && sawDone)
  check('模型改派：SSE 注释行 + 计量记真实模型（timing_cost.provider_model_name）',
    streamText.includes(': trae-reroute requested=glm-5.3 actual=kimi-k2.6')
    && meterCalls.some((m) => m.model === 'kimi-k2.6' && m.usage?.total_tokens === 13))
  const outbound = chatMock.state.requests[0]
  check('出站头：三头同 JWT + IDE 指纹 + 设备头', outbound.headers['authorization'] === 'Cloud-IDE-JWT tok-live'
    && outbound.headers['x-cloudide-token'] === 'tok-live' && outbound.headers['x-ide-token'] === 'tok-live'
    && outbound.headers['x-app-id'] === TRAE_APP_ID
    && outbound.headers['x-ide-version'] === TRAE_IDE_VERSION && outbound.headers['x-ide-version-code'] === TRAE_IDE_VERSION_CODE
    && typeof outbound.headers['x-request-id'] === 'string'
    && outbound.headers['x-device-id'] === '123' && outbound.headers['x-machine-id'] === 'abc'
    && outbound.headers['x-uid'] === 'u-001')
  check('出站路径 = /api/agent/v3/llm_utils_chat', outbound.url === '/api/agent/v3/llm_utils_chat')
  check('出站信封：model/function/session_id/request_id + content 块化保留 system 角色',
    outbound.body.model === 'glm-5.3' && outbound.body.function === 'inline_chat' && outbound.body.stream === true
    && outbound.body.messages[0].role === 'system'
    && outbound.body.messages[1].content?.[0]?.type === 'text' && outbound.body.messages[1].content[0].text === 'hi'
    && typeof outbound.body.session_id === 'string' && typeof outbound.body.request_id === 'string')

  // 非流式聚合
  const aggRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const agg = await aggRes.json()
  check('非流式：聚合 chat.completion JSON', aggRes.status === 200 && agg.object === 'chat.completion' && agg.choices[0].message.content === '你好，世界' && agg.choices[0].finish_reason === 'stop')

  // /models 端点
  const modelsRes = await fetch(`http://127.0.0.1:${gwPort}/v1/models`)
  const modelsBody = await modelsRes.json()
  check('GET /v1/models 回目录清单', modelsRes.status === 200 && modelsBody.data?.length === 2 && modelsBody.data[0].object === 'model')

  // 上游 401 映射
  const unauthMock = await mockTraeChat({ authedToken: 'wrong' })
  const gwSettings2 = () => ({ ...settings, traeChatBaseURL: unauthMock.base, maxConcurrentPerSession: 4 })
  const rt2 = { running: false, port: null, lastError: null }
  const gateway2 = createTraeGateway({
    settings: gwSettings2,
    withCredentials: async (attempt) => {
      try { return { cred: cred3, res: await attempt(cred3), err: null } } catch (err) { return { cred: cred3, res: null, err } }
    },
    readAuthDevice: () => null,
    meter: { record: () => {} },
    runtime: rt2,
    getCatalogIds: () => [],
  })
  const stop2 = gateway2.listen(0)
  await sleep(80)
  const errRes = await fetch(`http://127.0.0.1:${rt2.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const errBody = await errRes.json()
  check('上游 401 → 401 + code 透传', errRes.status === 401 && String(errBody.error?.code) === '1001')
  stop2()
  unauthMock.server.closeAllConnections?.()
  unauthMock.server.close()

  // 凭据不可用 → 503
  const rt3 = { running: false, port: null, lastError: null }
  const gateway3 = createTraeGateway({
    settings: gwSettings,
    withCredentials: async () => {
      const e = new Error('Trae 凭据不可用')
      e.credentialUnavailable = true
      return { cred: null, res: null, err: e }
    },
    readAuthDevice: () => null,
    meter: { record: () => {} },
    runtime: rt3,
    getCatalogIds: () => [],
  })
  const stop3 = gateway3.listen(0)
  await sleep(80)
  const noCredRes = await fetch(`http://127.0.0.1:${rt3.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const noCredBody = await noCredRes.json()
  check('凭据不可用 → 503 + 稳定文案', noCredRes.status === 503 && noCredBody.error?.message.includes('Trae 凭据不可用'))
  stop3()

  // 坏 payload
  const badRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  })
  check('坏 payload → 400', badRes.status === 400)

  check('计量：非流式请求也记录（真实模型口径）', meterCalls.filter((m) => m.usage?.total_tokens === 13).length >= 2)
  stop()
  chatMock.server.closeAllConnections?.()
  chatMock.server.close()

  // =========================================================================
  console.log('== 单元：信封与事件解析 ==')
  const { body: envBody, requestId: envReqId } = buildChatRequest({
    model: 'm1', max_tokens: 64, temperature: 0.5,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url' }] }],
  }, 'conv-1')
  check('buildChatRequest：content 块化 + function/stream + 生成参数透传',
    envBody.messages[0].content?.length === 1 && envBody.messages[0].content[0].type === 'text' && envBody.messages[0].content[0].text === 'a'
    && envBody.model === 'm1' && envBody.session_id === 'conv-1' && envBody.function === 'inline_chat' && envBody.stream === true
    && envBody.max_tokens === 64 && envBody.temperature === 0.5 && typeof envBody.request_id === 'string' && envReqId === envBody.request_id)
  check('buildChatRequest：默认模型 + tool 角色原生透传',
    buildChatRequest({ messages: [] }, 's').body.model === 'glm-5.3'
    && buildChatRequest({ messages: [{ role: 'tool', tool_call_id: 'c1', content: 'out' }] }, 's').body.messages[0].tool_call_id === 'c1')

  // createTraeStreamParser：累计快照差分 / 思考 / 用量 / 排队 / 工具 / 终结
  const p = createTraeStreamParser()
  const pa = p.handle('output', { response: '你好', reasoning_content: '思' })
  const pb = p.handle('output', { response: '你好，世界', reasoning_content: '思考' })
  check('流解析：累计快照前缀差分', pa.text === '你好' && pb.text === '，世界' && pa.reasoning === '思' && pb.reasoning === '考')
  p.handle('token_usage', { prompt_tokens: 16, completion_tokens: 19, total_tokens: 35 })
  check('流解析：token_usage 顶层计数', p.usage()?.total_tokens === 35)
  const pq1 = p.handle('request_wait_in_queue', { position: 2 })
  const pq2 = p.handle('request_wait_in_queue', { position: 2 })
  check('流解析：排队位置变化才报', pq1.queue === 2 && Object.keys(pq2).length === 0)
  const pt = p.handle('output', { response: '你好，世界', tool_call_info: { id: 't1', name: 'fn', params: { a: 1 } } })
  check('流解析：tool_call_info 归一为 OpenAI 工具调用', pt.toolCall?.id === 't1' && pt.toolCall.name === 'fn' && pt.toolCall.arguments === '{"a":1}')
  const pd = p.handle('done', { finish_reason: 'stop' })
  check('流解析：done 终结语义', pd.finish === 'stop' && p.isDone() === true && p.finish() === 'stop')
  const pe = createTraeStreamParser().handle('error', { code: 1001, message: 'auth' })
  check('流解析：error 事件归一', pe.error?.code === 1001)
  check('cumulativeDelta：前缀差分/回退/纯增量三态', cumulativeDelta('abc', 'abcdef') === 'def'
    && cumulativeDelta('abc', 'ab') === '' && cumulativeDelta('', 'x') === 'x')
  const nerr = normalizeTraeError(400, { ResponseMetadata: { Error: { Code: '10101', Message: 'Invalid client.' } } })
  check('normalizeTraeError：火山信封/裸码/非 JSON 三态', nerr.code === '10101' && normalizeTraeError(401, { code: 1001 }).code === 1001 && normalizeTraeError(500, null).message === 'HTTP 500')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readFileOr(path, fallback) {
  try { return readFileSync(path, 'utf8') } catch { return fallback }
}

console.log('')
if (failures) {
  console.log(`verify:trae-provider FAILED — ${failures}/${checks} 项断言未通过`)
  process.exit(1)
}
console.log(`verify:trae-provider OK — ${checks} 项断言全部通过`)
