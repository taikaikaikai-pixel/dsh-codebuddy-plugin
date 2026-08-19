#!/usr/bin/env node
/**
 * OAuth handshake probe (topic 5 of docs/rules/): state lifecycle, token
 * privilege boundary, refresh invalidation conditions.
 *
 * Spell under test (AGENTS.md:25): "POST /v2/plugin/auth/state?platform=CLI
 * （三个 X-No-* 头）→ {state, authUrl} → 轮询 GET /v2/plugin/auth/token?state=
 * （11217=未完成）→ GET /v2/plugin/login/account；刷新 POST
 * /v2/plugin/auth/token/refresh（X-Refresh-Token）"。
 *
 * Probeable WITHOUT an interactive login (this script, read-only):
 *   state creation/polling semantics, bogus-state error shape, multi-flight,
 *   X-No-* necessity, platform parameter, short-horizon TTL, and the
 *   FAILURE SHAPE of the refresh endpoint with a bogus token.
 * Not probeable without a completed browser login: real-token privilege
 * boundary and refresh rotation semantics — recorded as 未解 with the exact
 * unlock condition (one interactive device login).
 *
 * Pre-registered predictions (2026-08-19):
 *   P-O1  bogus state → code ≠ 0 AND ≠ 11217 (invalid is distinguishable
 *         from pending)
 *   P-O2  two states coexist: creating state2 does NOT invalidate state1
 *         (state1 still answers 11217)
 *   P-O3  the three X-No-* headers are superstition: state creation without
 *         them still returns code 0 + a state
 *   P-O4  platform is a free-form client tag: platform=WORKBUDDY and the
 *         omitted-parameter form both still return code 0 + a state
 *   P-O5  state TTL ≥ 240s: a state still answers 11217 at t+60s and t+240s
 *         (the plugin's 10-min client timeout is unrelated to server TTL)
 *   P-O6  GET /v2/plugin/login/account with a PENDING state → code ≠ 0
 *   P-O7  refresh with a bogus X-Refresh-Token → non-2xx or code ≠ 0
 *         (failures are loud, not silent)
 *
 * Low rate: 2s spacing, single account, all endpoints are auth-flow reads;
 * no login is completed, no real token is minted.
 *
 * ── v0.8 G2 扩展（2026-08-19，真实 token 已解锁：用户已完成交互登录）────────
 * 新集合（证据默认落 docs/probes/oauth-token-<date>.jsonl）：
 *   matrix  token×端点矩阵：OAuth Bearer vs ck_ key 在
 *           accounts / config / dosage-notify / agenttool-search / chat 五端点
 *           的可达性对照（oauth-handshake.md §5 解锁清单第 1 条）
 *   quota   额度端点搜寻：copilot.tencent.com + www.workbuddy.cn 两域名的
 *           plan/billing/credit/quota 候选路径 + www.codebuddy.cn 控制台
 *           plan API 候选，全部 Bearer token 实测（解锁清单第 2 条，
 *           用户明确授权的探测面扩展）
 *   refresh 真实 refresh 轮换语义：真 refresh 一次（成功后按 refreshOAuth
 *           同逻辑回写 auth 文件）→ 旧 refresh token 复跑观测作废码 →
 *           旧 access token 复用观测（解锁清单第 3 条）
 *
 * 预注册预测（2026-08-19）：
 *   P-T1   OAuth token 五端点全可达（官方 CLI OAuth 模式即如此）
 *   P-T2   token 与 ck_ key 的端点可达矩阵无差异
 *   P-T6   OAuth 下 chat 响应头同样零额度字段（R-Q1 对认证方式不变）
 *   P-QP1  copilot.tencent.com 的 billing/plan/credit/quota/subscription
 *          猜测路径全部路径层 404（与"CLI 端点全集无 quota 查询"一致）
 *   P-QP2  www.workbuddy.cn 用同一 token 镜像可达 accounts/dosage/config
 *   P-QP3  workbuddy.cn 的 plan/credit 猜测路径同样 404
 *   P-QP4  www.codebuddy.cn 控制台 plan API 候选拒绝 Bearer（cookie 体系）
 *   P-QP5  控制台 SPA 逆向出的真实只读路径（/cgi/v2/user/getInfo、
 *          /console/accounts、/billing/meter/check-gift-claimed 等）在
 *          www.codebuddy.cn 上拒绝 Bearer（cookie 体系：uin/skey）
 *   P-QP6  同路径在 copilot.tencent.com → 404 路径层（路径族不同）
 *   P-QP7  控制台 /billing/meter/get-* 数值 API（enterprise-user-usage /
 *          daily-usage / resource / request-usage）Bearer 可达且有数值
 *   P-RR1  真实 refresh → 200 code 0 + 新 accessToken
 *   P-RR2  若 refreshToken 轮换：旧 refresh 复跑 → 401+12153（同 bogus 形态）
 *   P-RR3  旧 access token 在 refresh 后仍可用（access 不随 refresh 作废）
 *
 * Usage: node scripts/probe-oauth.mjs [--set core|ttl|matrix|quota|refresh]
 *   [--state <s>] [--ttl-check-only]
 *   core: creation/poll/bogus/headers/platform/multi-flight/account/refresh-shape
 *   ttl:  create one state, poll at +60s and +240s
 *   matrix/quota/refresh: G2 真实 token 集合（需 ~/.dsh/codebuddy-plugin-auth.json）
 *   --state <s> --ttl-check-only: poll a previously created state once
 *   (cross-session TTL check; state string is stored in the evidence file)
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

const GATEWAY = 'https://copilot.tencent.com'
const WORKBUDDY = 'https://www.workbuddy.cn'
const CONSOLE = 'https://www.codebuddy.cn'
const CLI_UA = 'CLI/unknown CodeBuddy/2.136.0'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_FILE = join(DSH_HOME, 'codebuddy-plugin-auth.json')
const SPACING_MS = 2000
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}
const SET = argValue('--set') ?? 'core'
const TOKEN_SETS = new Set(['matrix', 'quota', 'quota2', 'values', 'quota3', 'quota4', 'quota5', 'quota6', 'quota7', 'refresh'])
const OUT = argValue('--out')
  ?? join('docs', 'probes', TOKEN_SETS.has(SET)
    ? `oauth-token-${new Date().toISOString().slice(0, 10)}.jsonl`
    : `oauth-${new Date().toISOString().slice(0, 10)}.jsonl`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

const SPELL_HEADERS = { 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true' }

async function call(name, { method = 'GET', path, headers = {}, note = '', pred = '', body = null, baseURL = GATEWAY, captureHeaders = false }) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    const rec = {
      type: 'probe', name, base: baseURL, path, pred, note,
      status: res.status, code: json?.code ?? null,
      msg: redact(json?.msg ?? json?.error_msg ?? text.slice(0, 140)),
      dataKeys: json?.data && typeof json.data === 'object' ? Object.keys(json.data) : null,
      ms: Date.now() - t0,
    }
    if (captureHeaders) {
      const h = {}
      res.headers.forEach((v, k) => { h[k] = v })
      rec.headers = h
      rec.quotaHeaders = Object.keys(h).filter((k) => /quota|credit|limit|remain|balance|dosage/i.test(k))
      const credit = text.match(/"credit"\s*:\s*([0-9.]+)/)
      if (credit) rec.usageCredit = Number(credit[1])
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(`${name.padEnd(34)} status=${rec.status} code=${rec.code ?? '-'} keys=${JSON.stringify(rec.dataKeys)} msg=${(rec.msg ?? '').slice(0, 90)}`)
    return { rec, json, text }
  } catch (err) {
    const rec = { type: 'probe', name, base: baseURL, path, pred, note, error: String(err?.message ?? err), ms: Date.now() - t0 }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(`${name.padEnd(34)} ERROR ${rec.error}`)
    return { rec, json: null, text: '' }
  }
}

/** 令牌只以 sha256 指纹进入证据，永不落明文。 */
const fp = (t) => t ? createHash('sha256').update(String(t)).digest('hex').slice(0, 12) : null

/** 与插件同逻辑的双凭据解析：OAuth（auth 文件）+ 活跃 ck_ key（插件配置/env/凭据文件）。 */
function loadCredentials() {
  const out = { oauth: null, key: null }
  try {
    const store = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
    if (store?.auth?.accessToken) {
      out.oauth = {
        token: store.auth.accessToken,
        headers: {
          Authorization: `Bearer ${store.auth.accessToken}`,
          'X-Domain': store.auth.domain ?? '',
          ...(store.account?.uid ? { 'X-User-Id': store.account.uid } : {}),
          ...(store.account?.enterpriseId ? { 'X-Enterprise-Id': store.account.enterpriseId } : {}),
        },
        store,
      }
    }
  } catch { /* no auth file */ }
  let key = null
  try {
    const cfg = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin.json'), 'utf8'))
    key = (cfg.apiKeys ?? []).find((k) => k.name === cfg.activeApiKey)?.key ?? null
  } catch { /* fall through */ }
  key ??= process.env.CODEBUDDY_API_KEY ?? null
  if (!key) {
    const credFile = join(DSH_HOME, '.credentials.yaml')
    if (existsSync(credFile)) {
      const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
      if (m) key = m[1]
    }
  }
  if (key) out.key = { key, headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } }
  return out
}

mkdirSync(dirname(OUT), { recursive: true })
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), set: SET, args: process.argv.slice(2) }) + '\n')
console.log(`evidence → ${OUT}`)

if (process.argv.includes('--ttl-check-only')) {
  const state = argValue('--state')
  if (!state) throw new Error('--state required')
  await call(`ttl-check-${Date.now()}`, {
    path: `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    headers: { 'X-No-Authorization': 'true' },
    pred: 'P-O5-ext', note: 'cross-session state TTL check',
  })
  process.exit(0)
}

if (SET === 'core') {
  // 1. spell-faithful creation
  const s1 = await call('create-spell-headers', {
    method: 'POST', path: '/v2/plugin/auth/state?platform=CLI', headers: SPELL_HEADERS,
    note: 'baseline creation with all three X-No-* headers',
  })
  await sleep(SPACING_MS)
  const state1 = s1.json?.data?.state
  if (state1) {
    appendFileSync(OUT, JSON.stringify({ type: 'state', name: 'state1', state: state1, createdAt: Date.now() }) + '\n')
    console.log(`  state1 issued (${String(state1).length} chars)`)
  }

  // 2. poll twice — pending idempotence
  if (state1) {
    await call('poll-pending-1', { path: `/v2/plugin/auth/token?state=${encodeURIComponent(state1)}`, headers: { 'X-No-Authorization': 'true' }, note: 'expect 11217' })
    await sleep(SPACING_MS)
    await call('poll-pending-2', { path: `/v2/plugin/auth/token?state=${encodeURIComponent(state1)}`, headers: { 'X-No-Authorization': 'true' }, note: 'idempotent 11217' })
    await sleep(SPACING_MS)
  }

  // 3. P-O1 bogus state
  await call('P-O1-bogus-state', { path: '/v2/plugin/auth/token?state=bogus-k3r9x7', headers: { 'X-No-Authorization': 'true' }, pred: 'P-O1', note: 'invalid state distinguishable from pending (not 0, not 11217)' })
  await sleep(SPACING_MS)

  // 4. P-O6 account with pending state
  if (state1) {
    await call('P-O6-account-pending', { path: `/v2/plugin/login/account?state=${encodeURIComponent(state1)}`, headers: SPELL_HEADERS, pred: 'P-O6', note: 'account facts with a pending state → code ≠ 0' })
    await sleep(SPACING_MS)
  }

  // 5. P-O2 multi-flight: create state2, re-poll state1
  const s2 = await call('create-second-state', { method: 'POST', path: '/v2/plugin/auth/state?platform=CLI', headers: SPELL_HEADERS, pred: 'P-O2', note: 'second state creation' })
  await sleep(SPACING_MS)
  if (s2.json?.data?.state) {
    appendFileSync(OUT, JSON.stringify({ type: 'state', name: 'state2', state: s2.json.data.state, createdAt: Date.now() }) + '\n')
  }
  if (state1) {
    await call('P-O2-state1-after-state2', { path: `/v2/plugin/auth/token?state=${encodeURIComponent(state1)}`, headers: { 'X-No-Authorization': 'true' }, pred: 'P-O2', note: 'state1 still 11217 after state2 exists' })
    await sleep(SPACING_MS)
  }

  // 6. P-O3 creation without the X-No-* headers
  await call('P-O3-create-no-headers', { method: 'POST', path: '/v2/plugin/auth/state?platform=CLI', pred: 'P-O3', note: 'X-No-* headers are superstition' })
  await sleep(SPACING_MS)

  // 7. P-O4 platform variants
  await call('P-O4-platform-workbuddy', { method: 'POST', path: '/v2/plugin/auth/state?platform=WORKBUDDY', headers: SPELL_HEADERS, pred: 'P-O4', note: 'free-form platform tag' })
  await sleep(SPACING_MS)
  await call('P-O4-platform-omitted', { method: 'POST', path: '/v2/plugin/auth/state', headers: SPELL_HEADERS, pred: 'P-O4', note: 'platform omitted' })
  await sleep(SPACING_MS)

  // 8. P-O7 refresh failure shape with bogus token
  await call('P-O7-refresh-bogus', {
    method: 'POST', path: '/v2/plugin/auth/token/refresh',
    headers: { 'X-Refresh-Token': 'bogus-refresh-token', 'X-Domain': '' },
    pred: 'P-O7', note: 'refresh failure is loud (non-2xx or code ≠ 0)',
  })
}

if (SET === 'ttl') {
  const s = await call('ttl-create', { method: 'POST', path: '/v2/plugin/auth/state?platform=CLI', headers: SPELL_HEADERS, note: 'TTL ladder seed' })
  const state = s.json?.data?.state
  if (!state) throw new Error('no state issued')
  appendFileSync(OUT, JSON.stringify({ type: 'state', name: 'ttl-state', state, createdAt: Date.now() }) + '\n')
  console.log('  ttl state issued; polling at +60s and +240s')
  await sleep(60000)
  await call('P-O5-ttl-60s', { path: `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, headers: { 'X-No-Authorization': 'true' }, pred: 'P-O5', note: 'still 11217 at +60s' })
  await sleep(180000)
  await call('P-O5-ttl-240s', { path: `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, headers: { 'X-No-Authorization': 'true' }, pred: 'P-O5', note: 'still 11217 at +240s' })
}

let cred = null
if (TOKEN_SETS.has(SET)) {
  cred = loadCredentials()
  if (!cred.oauth) throw new Error(`no OAuth token at ${AUTH_FILE} — G1 交互登录是前置条件`)
  appendFileSync(OUT, JSON.stringify({
    type: 'credentials', at: new Date().toISOString(),
    accessTokenFp: fp(cred.oauth.token), hasKey: Boolean(cred.key), keyFp: fp(cred.key?.key),
    accountUid: cred.oauth.store.account?.uid ?? null, domain: cred.oauth.store.auth?.domain ?? null,
  }) + '\n')
}

if (SET === 'matrix') {
  // token×端点矩阵：五端点 × 双凭据。chat 两臂为 max_tokens=1 的极小微调用
  // （deepseek-v3 ≈0.03 credit/次），与存量探测口径一致。
  const arms = [['oauth', cred.oauth.headers], ['ck-key', cred.key?.headers]].filter(([, h]) => h)
  const endpoints = [
    ['accounts', { path: '/v2/accounts' }],
    ['config', { path: '/v3/config', headers: { 'User-Agent': CLI_UA } }],
    ['dosage-notify', { method: 'POST', path: '/v2/billing/meter/get-dosage-notify', headers: { 'Content-Type': 'application/json' }, body: {} }],
    ['agenttool-search', { method: 'POST', path: '/agenttool/v1/search', headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA }, body: { query: 'quota probe', max_results: 1 } }],
  ]
  for (const [authName, authHeaders] of arms) {
    for (const [epName, ep] of endpoints) {
      await call(`${epName}@${authName}`, {
        ...ep, headers: { ...ep.headers, ...authHeaders },
        pred: 'P-T1/P-T2', note: 'token vs ck_ key 端点可达矩阵',
      })
      await sleep(SPACING_MS)
    }
    await call(`chat@${authName}`, {
      method: 'POST', path: '/v2/chat/completions', captureHeaders: true,
      headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA, ...authHeaders },
      body: { model: 'deepseek-v3', stream: true, stream_options: { include_usage: true }, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      pred: 'P-T1/P-T6', note: 'chat 可达 + 响应头零额度字段（R-Q1 认证不变性）',
    })
    await sleep(SPACING_MS)
  }
}

if (SET === 'quota') {
  const H = cred.oauth.headers
  const HUA = { ...H, 'User-Agent': CLI_UA }
  const POSTJSON = { 'Content-Type': 'application/json' }
  // copilot.tencent.com：已知端点控制臂 + billing/plan/credit/quota 猜测路径
  await call('control-accounts', { path: '/v2/accounts', headers: H, note: '已知端点控制臂（token）' })
  await sleep(SPACING_MS)
  await call('control-dosage-notify', { method: 'POST', path: '/v2/billing/meter/get-dosage-notify', headers: { ...H, ...POSTJSON }, body: {}, note: '已知端点控制臂（token）' })
  await sleep(SPACING_MS)
  const guesses = [
    '/v2/billing/plan', '/v2/billing/quota', '/v2/billing/credit', '/v2/billing/credits',
    '/v2/billing/usage', '/v2/billing/meter/get-dosage', '/v2/billing/meter/get-quota',
    '/v2/plan', '/v2/quota', '/v2/credit', '/v2/credits',
    '/v2/subscription', '/v2/subscriptions', '/v2/user/plan', '/v2/user/quota', '/v2/accounts/plan',
  ]
  for (const p of guesses) {
    await call(`guess${p}`, { path: p, headers: H, pred: 'P-QP1', note: '额度端点猜测：预期路径层 404' })
    await sleep(SPACING_MS)
  }
  // www.workbuddy.cn：同账户体系镜像
  await call('wb-accounts', { baseURL: WORKBUDDY, path: '/v2/accounts', headers: H, pred: 'P-QP2', note: 'workbuddy 镜像 accounts' })
  await sleep(SPACING_MS)
  await call('wb-dosage-notify', { method: 'POST', baseURL: WORKBUDDY, path: '/v2/billing/meter/get-dosage-notify', headers: { ...H, ...POSTJSON }, body: {}, pred: 'P-QP2', note: 'workbuddy 镜像 dosage-notify' })
  await sleep(SPACING_MS)
  await call('wb-config', { baseURL: WORKBUDDY, path: '/v3/config', headers: HUA, pred: 'P-QP2', note: 'workbuddy 镜像 config（CLI UA）' })
  await sleep(SPACING_MS)
  for (const p of ['/v2/billing/plan', '/v2/plan', '/v2/quota', '/v2/credit']) {
    await call(`wb-guess${p}`, { baseURL: WORKBUDDY, path: p, headers: H, pred: 'P-QP3', note: 'workbuddy 额度猜测路径' })
    await sleep(SPACING_MS)
  }
  // www.codebuddy.cn 控制台 plan API 候选（cookie 体系；Bearer 预期被拒）
  for (const p of ['/profile/plan', '/api/profile/plan', '/api/v1/plan', '/api/user/plan', '/api/credit', '/api/v1/credit']) {
    await call(`console${p}`, { baseURL: CONSOLE, path: p, headers: H, pred: 'P-QP4', note: '控制台 plan API 候选：Bearer 预期进不去 cookie 体系' })
    await sleep(SPACING_MS)
  }
}

if (SET === 'quota2') {
  // 第二波：从控制台 SPA（www.codebuddy.cn/profile/plan → download.codebuddy.cn
  // 公开 bundle）逆向出的真实路径字面量。claim-gift / claim-compensation /
  // ide/trial / get-refund-price 为写操作，按红线不测；仅测只读路径。
  const H = cred.oauth.headers
  const POSTJSON = { 'Content-Type': 'application/json' }
  const consoleReads = [
    ['GET', '/cgi/v2/user/getInfo', null],
    ['GET', '/console/accounts', null],
    ['POST', '/billing/meter/check-gift-claimed', {}],
    ['POST', '/billing/meter/compensation-status', {}],
    ['POST', '/console/user/from', {}],
  ]
  for (const [m, p, b] of consoleReads) {
    await call(`console-real${p}`, { method: m, baseURL: CONSOLE, path: p, headers: b ? { ...H, ...POSTJSON } : H, body: b, pred: 'P-QP5', note: '控制台真实只读路径：Bearer 预期被拒（cookie 体系）' })
    await sleep(SPACING_MS)
  }
  for (const [m, p, b] of consoleReads) {
    await call(`gw-console-path${p}`, { method: m, path: p, headers: b ? { ...H, ...POSTJSON } : H, body: b, pred: 'P-QP6', note: '同路径在网关域：预期 404 路径层（路径族不同）' })
    await sleep(SPACING_MS)
  }
}

if (SET === 'values') {
  // 值捕获臂：quota2 发现的真实只读端点的 data 全值（uid/手机号等身份字段脱敏）。
  const H = cred.oauth.headers
  const POSTJSON = { 'Content-Type': 'application/json' }
  const scrub = (v) => {
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = /uid|uin|phone|openid|open_id|union/i.test(k) ? '<redacted>' : scrub(x)
      return o
    }
    return v
  }
  const arms = [
    ['GET', '/v2/accounts', null],
    ['GET', '/console/accounts', null],
    ['POST', '/billing/meter/check-gift-claimed', {}],
    ['POST', '/billing/meter/compensation-status', {}],
    ['POST', '/v2/billing/meter/get-dosage-notify', {}],
  ]
  for (const [m, p, b] of arms) {
    const r = await call(`values${p}`, { method: m, path: p, headers: b ? { ...H, ...POSTJSON } : H, body: b, note: 'data 全值捕获（身份字段脱敏）' })
    appendFileSync(OUT, JSON.stringify({ type: 'values', name: `values${p}`, data: scrub(r.json?.data ?? null) }) + '\n')
    console.log(`  values${p} → ${JSON.stringify(scrub(r.json?.data ?? null)).slice(0, 300)}`)
    await sleep(SPACING_MS)
  }
}

if (SET === 'quota3') {
  // 第三波：控制台 config chunk 逆向出的 /billing/meter/get-* 数值 API。
  // 全部 POST 只读（控制台 bundle 字面量），Bearer token 实测。
  const H = { ...cred.oauth.headers, 'Content-Type': 'application/json' }
  const scrub = (v) => {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) return v.slice(0, 3).map(scrub)
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = /uid|uin|phone|openid|open_id|union/i.test(k) ? '<redacted>' : scrub(x)
      return o
    }
    return v
  }
  const arms = [
    ['/billing/meter/get-enterprise-user-usage', {}],
    ['/billing/meter/get-user-daily-usage', {}],
    ['/billing/meter/get-user-resource', {}],
    ['/billing/meter/get-user-request-usage', { page: 1, page_size: 3 }],
  ]
  for (const baseURL of [GATEWAY, CONSOLE]) {
    for (const [p, b] of arms) {
      const r = await call(`meter${p}@${new URL(baseURL).hostname}`, { method: 'POST', baseURL, path: p, headers: H, body: b, pred: 'P-QP7', note: '数值额度/用量 API：Bearer 预期可达（check-gift-claimed 同族已证）' })
      if (r.json?.data != null) {
        appendFileSync(OUT, JSON.stringify({ type: 'values', name: `meter${p}@${new URL(baseURL).hostname}`, data: scrub(r.json.data) }) + '\n')
        console.log(`  data → ${JSON.stringify(scrub(r.json.data)).slice(0, 400)}`)
      }
      await sleep(SPACING_MS)
    }
  }
}

if (SET === 'quota4') {
  // 第四波：数值额度 API 的参数形态已逆向（控制台 bundle）：
  //   daily-usage   {startTime:"YYYY-MM-DD 00:00:00",endTime,pageNum,pageSize}
  //   request-usage {startTime,endTime,timezone,pageSize,version:2,pageToken}
  //   enterprise    {} + X-Enterprise-Id 头
  //   resource      {}（get-user-resource，截断修复：全量 Accounts）
  const H = { ...cred.oauth.headers, 'Content-Type': 'application/json' }
  const scrub = (v, depth = 0) => {
    if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1))
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = /^(uid|uin|phone|openid|open_id|unionid|payeruin|enterpriseusername|displayname)$/i.test(k) ? '<redacted>' : scrub(x, depth + 1)
      return o
    }
    return v
  }
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = `${today.slice(0, 8)}01`
  const arms = [
    ['resource-full', '/billing/meter/get-user-resource', {}, null, 'P-QP9'],
    ['daily-usage', '/billing/meter/get-user-daily-usage', { startTime: `${monthStart} 00:00:00`, endTime: `${today} 23:59:59`, pageNum: 1, pageSize: 50 }, null, 'P-QP10'],
    ['request-usage', '/billing/meter/get-user-request-usage', { startTime: `${monthStart} 00:00:00`, endTime: `${today} 23:59:59`, timezone: 'Asia/Shanghai', pageSize: 5, version: 2, pageToken: '' }, null, 'P-QP11'],
    ['enterprise-usage', '/billing/meter/get-enterprise-user-usage', {}, 'f0bwg2yofpq8', 'P-QP13'],
  ]
  for (const [name, p, b, entId, pred] of arms) {
    const headers = entId ? { ...H, 'X-Enterprise-Id': entId } : H
    const r = await call(`quota4-${name}`, { method: 'POST', path: p, headers, body: b, pred, note: '数值额度 API 带正确参数形态' })
    if (r.json?.data != null) {
      appendFileSync(OUT, JSON.stringify({ type: 'values', name: `quota4-${name}`, data: scrub(r.json.data) }) + '\n')
      console.log(`  data → ${JSON.stringify(scrub(r.json.data)).slice(0, 500)}`)
    }
    await sleep(SPACING_MS)
  }
  // P-QP12：ck_ key 特权边界——get-user-resource 是否 api-key 也可达
  if (cred.key) {
    const r = await call('quota4-resource-ck-key', {
      method: 'POST', path: '/billing/meter/get-user-resource',
      headers: { ...cred.key.headers, 'Content-Type': 'application/json' }, body: {},
      pred: 'P-QP12', note: 'ck_ key 对数值额度 API 的可达性',
    })
    if (r.json?.data != null) {
      appendFileSync(OUT, JSON.stringify({ type: 'values', name: 'quota4-resource-ck-key', data: scrub(r.json.data) }) + '\n')
      console.log(`  data → ${JSON.stringify(scrub(r.json.data)).slice(0, 200)}`)
    }
  }
}

if (SET === 'quota5') {
  // 第五波：daily/request-usage "invalid params" 变体判别。
  const H = { ...cred.oauth.headers, 'Content-Type': 'application/json' }
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 00:00:00`
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const variants = [
    ['daily-endtime-now', '/billing/meter/get-user-daily-usage', { startTime: todayStart, endTime: nowStr, pageNum: 1, pageSize: 10 }, null],
    ['daily-pascal', '/billing/meter/get-user-daily-usage', { StartTime: todayStart, EndTime: nowStr, PageNum: 1, PageSize: 10 }, null],
    ['daily-ent', '/billing/meter/get-user-daily-usage', { startTime: todayStart, endTime: nowStr, pageNum: 1, pageSize: 10 }, 'f0bwg2yofpq8'],
    ['request-endtime-now', '/billing/meter/get-user-request-usage', { startTime: todayStart, endTime: nowStr, timezone: 'Asia/Shanghai', pageSize: 5, version: 2, pageToken: '' }, null],
    ['request-no-token', '/billing/meter/get-user-request-usage', { startTime: todayStart, endTime: nowStr, timezone: 'Asia/Shanghai', pageSize: 5, version: 2 }, null],
    ['request-ent', '/billing/meter/get-user-request-usage', { startTime: todayStart, endTime: nowStr, timezone: 'Asia/Shanghai', pageSize: 5, version: 2, pageToken: '' }, 'f0bwg2yofpq8'],
  ]
  for (const [name, p, b, entId] of variants) {
    const headers = entId ? { ...H, 'X-Enterprise-Id': entId } : H
    const r = await call(`quota5-${name}`, { method: 'POST', path: p, headers, body: b, note: 'invalid params 变体判别' })
    if (r.json?.data != null) {
      appendFileSync(OUT, JSON.stringify({ type: 'values', name: `quota5-${name}`, data: r.json.data }) + '\n')
      console.log(`  data → ${JSON.stringify(r.json.data).slice(0, 300)}`)
    }
    await sleep(SPACING_MS)
  }
}

if (SET === 'quota6') {
  // 第六波：personal 上下文标记判别（sessionStorage profile-enterpriseId 缺省值）。
  const H = { ...cred.oauth.headers, 'Content-Type': 'application/json' }
  const uid = cred.oauth.store.account?.uid ?? ''
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 00:00:00`
  const nowStr = todayStart.slice(0, 10) + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const body = { startTime: todayStart, endTime: nowStr, pageNum: 1, pageSize: 10 }
  const variants = [
    ['ent-literal-personal', 'personal'],
    ['ent-empty-string', ''],
    ['ent-uid', uid],
  ]
  for (const [name, ent] of variants) {
    await call(`quota6-${name}`, {
      method: 'POST', path: '/billing/meter/get-user-daily-usage',
      headers: { ...H, 'X-Enterprise-Id': ent }, body,
      note: 'personal 上下文标记变体',
    })
    await sleep(SPACING_MS)
  }
}

if (SET === 'quota7') {
  // 第七波：personal 上下文的用量数据值捕获（daily + request，本月至今）。
  const H = { ...cred.oauth.headers, 'Content-Type': 'application/json', 'X-Enterprise-Id': 'personal' }
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01 00:00:00`
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) o[k] = /^(uid|uin|phone|openid|open_id|unionid|payeruin|enterpriseusername|displayname)$/i.test(k) ? '<redacted>' : scrub(x)
      return o
    }
    return v
  }
  const arms = [
    ['daily-personal-month', '/billing/meter/get-user-daily-usage', { startTime: monthStart, endTime: nowStr, pageNum: 1, pageSize: 31 }],
    ['request-personal-today', '/billing/meter/get-user-request-usage', { startTime: monthStart, endTime: nowStr, timezone: 'Asia/Shanghai', pageSize: 5, version: 2, pageToken: '' }],
  ]
  for (const [name, p, b] of arms) {
    const r = await call(`quota7-${name}`, { method: 'POST', path: p, headers: H, body: b, note: 'personal 用量值捕获' })
    if (r.json?.data != null) {
      appendFileSync(OUT, JSON.stringify({ type: 'values', name: `quota7-${name}`, data: scrub(r.json.data) }) + '\n')
      console.log(`  data → ${JSON.stringify(scrub(r.json.data)).slice(0, 600)}`)
    }
    await sleep(SPACING_MS)
  }
}

if (SET === 'refresh') {
  // 真实 refresh 轮换语义。成功后必须立即回写 auth 文件（运行中的 dsh 每次
  // 请求都重读该文件），否则旧 refresh 作废后插件将失凭。
  const old = cred.oauth.store.auth
  const oldAccessFp = fp(old.accessToken)
  const oldRefreshFp = fp(old.refreshToken)
  console.log(`  old access fp=${oldAccessFp} refresh fp=${oldRefreshFp}`)
  const r1 = await call('P-RR1-refresh-real', {
    method: 'POST', path: '/v2/plugin/auth/token/refresh',
    headers: {
      Authorization: `Bearer ${old.accessToken}`,
      'X-Domain': old.domain ?? '',
      'X-Refresh-Token': old.refreshToken ?? '',
    },
    pred: 'P-RR1', note: '真实 refresh：预期 200 code 0 + 新 accessToken',
  })
  const d = r1.json?.data
  if (r1.json?.code === 0 && d?.accessToken) {
    const rotated = Boolean(d.refreshToken) && fp(d.refreshToken) !== oldRefreshFp
    appendFileSync(OUT, JSON.stringify({
      type: 'refresh-result', at: new Date().toISOString(),
      newAccessFp: fp(d.accessToken), newRefreshFp: fp(d.refreshToken),
      accessRotated: fp(d.accessToken) !== oldAccessFp, refreshRotated: rotated,
      expiresIn: d.expiresIn ?? null, refreshExpiresIn: d.refreshExpiresAt ?? null, domain: d.domain ?? null,
    }) + '\n')
    console.log(`  refresh ok: access rotated=${fp(d.accessToken) !== oldAccessFp} refresh rotated=${rotated} expiresIn=${d.expiresIn ?? '-'}`)
    // 与 providers/codebuddy/oauth.js refreshOAuth 同逻辑回写
    const store = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
    store.auth = {
      accessToken: d.accessToken,
      expiresAt: Date.now() + (d.expiresIn ?? 3600) * 1000,
      refreshToken: d.refreshToken ?? old.refreshToken,
      refreshExpiresAt: d.refreshExpiresAt != null ? Date.now() + d.refreshExpiresAt * 1000 : store.auth.refreshExpiresAt,
      domain: d.domain ?? old.domain,
    }
    writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2))
    console.log('  auth file updated with fresh tokens')
    await sleep(SPACING_MS)
    await call('P-RR2-refresh-old-rerun', {
      method: 'POST', path: '/v2/plugin/auth/token/refresh',
      headers: {
        Authorization: `Bearer ${old.accessToken}`,
        'X-Domain': old.domain ?? '',
        'X-Refresh-Token': old.refreshToken ?? '',
      },
      pred: 'P-RR2', note: `旧 refresh 复跑：轮换情形预期 401+12153；本次 refreshRotated=${rotated}`,
    })
    await sleep(SPACING_MS)
    await call('P-RR3-old-access-accounts', {
      path: '/v2/accounts',
      headers: { Authorization: `Bearer ${old.accessToken}`, 'X-Domain': old.domain ?? '' },
      pred: 'P-RR3', note: '旧 access token 复用：预期仍可用（不随 refresh 作废）',
    })
    await sleep(SPACING_MS)
    await call('new-access-accounts', {
      path: '/v2/accounts',
      headers: { Authorization: `Bearer ${d.accessToken}`, 'X-Domain': (d.domain ?? old.domain) ?? '' },
      note: '新 access token 可用性确认',
    })
  } else {
    console.log('  refresh refused — auth file untouched (old access token still valid until stored expiresAt)')
  }
}
console.log('done.')
