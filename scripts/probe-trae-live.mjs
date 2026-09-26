#!/usr/bin/env node
/**
 * Live integration probe for the Trae channel (REAL network, own account).
 *
 * The offline suite (verify:trae-provider) locks translation logic against
 * mocks; this script is the one manual calibration step that needs a real
 * login — the request envelope / SSE grammar of the Trae cloud gateway is
 * extracted from binary strings and must be confirmed against the live wire.
 *
 *   node scripts/probe-trae-live.mjs --login
 *     Real OAuth device flow against api.trae.cn: prints the authorization
 *     URL (open it, log in), waits for the 127.0.0.1 callback, then
 *     immediately exercises a DeviceProof refresh to prove the self-held
 *     keypair works online. Tokens never print (masked only).
 *
 *   node scripts/probe-trae-live.mjs --chat "你好"
 *     One-shot real chat via the gateway's request builder; dumps the RAW
 *     response (status/headers/body) to docs/probes/trae-chat-live-*.json
 *     for schema correction (no credentials in the dump).
 *
 *   node scripts/probe-trae-live.mjs --sig raw   # flip DeviceProof encoding
 *
 * Uses the SAME auth store as the plugin (~/.dsh/trae-plugin-auth.json,
 * DSH_HOME respected) — one login serves both.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createTraeOAuth } from '../providers/trae/oauth.js'
import { buildChatRequest, TRAE_APP_ID, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE } from '../providers/trae/gateway.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'trae-plugin-auth.json')

const SETTINGS = {
  traeAuthBaseURL: process.env.TRAE_AUTH_BASE ?? 'https://api.trae.cn',
  traeChatBaseURL: process.env.TRAE_CHAT_BASE ?? 'https://trae-api-cn.mchost.guru',
  traeLoginHost: process.env.TRAE_LOGIN_HOST ?? 'https://www.trae.cn',
}

function mask(t) {
  return typeof t === 'string' && t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}（${t.length} 字符）` : '(none)'
}

const { readJson, writeJson } = await import('../core/json-store.js')
const oauth = createTraeOAuth({ readAuth: () => readJson(AUTH_PATH), writeAuth: (v) => writeJson(AUTH_PATH, v) })

const args = process.argv.slice(2)
const mode = args.includes('--login') ? 'login' : args.includes('--chat') ? 'chat' : args.includes('--sig') ? 'sig' : null
if (!mode) {
  console.log('用法：--login（真实登录+刷新自证）｜ --chat "文本"（真实对话，证据落盘）｜ --sig der|raw（切换签名编码）')
  process.exit(1)
}

if (mode === 'sig') {
  const fmt = args[args.indexOf('--sig') + 1]
  console.log('signatureFormat →', oauth.setSignatureFormat(fmt))
  process.exit(0)
}

if (mode === 'login') {
  const status0 = oauth.oauthStatus()
  if (status0.signedIn) {
    console.log('已有登录态：', status0.account ?? '', '令牌至', new Date(status0.accessTokenExpiresAt ?? 0).toISOString())
  }
  const { authUrl } = await oauth.startOAuth(SETTINGS)
  console.log('\n在浏览器打开并完成登录（10 分钟内有效）：\n')
  console.log(authUrl, '\n')
  process.stdout.write('等待回调')
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    process.stdout.write('.')
    const s = oauth.oauthStatus()
    if (s.signedIn) {
      console.log('\n\n登录成功 ✓  账号：', s.account ?? '(GetUserInfo 未返回昵称)')
      console.log('accessToken：', mask(readJson(AUTH_PATH).auth?.accessToken))
      console.log('refreshToken：', mask(readJson(AUTH_PATH).auth?.refreshToken))
      // 立即自证刷新链路（DeviceProof 线上验签）。
      const store = readJson(AUTH_PATH)
      store.auth.expiresAt = Date.now() - 1000 // 强制走刷新
      writeJson(AUTH_PATH, store)
      const cred = await oauth.resolveTraeCredential(SETTINGS)
      if (cred && readJson(AUTH_PATH).auth?.expiresAt > Date.now() + 60_000) {
        console.log('DeviceProof 刷新成功 ✓（自持设备密钥线上可用）新令牌：', mask(readJson(AUTH_PATH).auth.accessToken))
      } else {
        console.log('DeviceProof 刷新失败 ✗ —— 尝试 `node scripts/probe-trae-live.mjs --sig raw` 后重新 --login')
      }
      process.exit(0)
    }
    if (!s.pending && s.error) {
      console.log('\n\n登录失败：', s.error)
      process.exit(1)
    }
  }
  console.log('\n\n超时（10 分钟未完成回调）')
  process.exit(1)
}

// mode === 'chat'
const text = args[args.indexOf('--chat') + 1] ?? '你好'
const cred = await oauth.resolveTraeCredential(SETTINGS)
if (!cred) {
  console.error('未登录（先跑 --login）。')
  process.exit(1)
}
const payload = { model: process.env.TRAE_MODEL ?? 'glm-5.3', stream: true, messages: [{ role: 'user', content: text }] }
const { body: reqBody, requestId } = buildChatRequest(payload, 'probe-live')
const token = String(cred.authorization).replace(/^Cloud-IDE-JWT\s+/, '')
const authStore = readJson(AUTH_PATH)
const res = await fetch(`${SETTINGS.traeChatBaseURL}/api/agent/v3/llm_utils_chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-ide-token': token,
    'x-app-id': TRAE_APP_ID,
    'x-ide-version': TRAE_IDE_VERSION,
    'x-ide-version-code': TRAE_IDE_VERSION_CODE,
    'x-request-id': requestId,
    ...(authStore.account?.uid ? { 'x-uid': String(authStore.account.uid) } : {}),
    ...(authStore.device?.deviceId ? { 'x-device-id': authStore.device.deviceId } : {}),
    ...(authStore.device?.machineId ? { 'x-machine-id': authStore.device.machineId } : {}),
  },
  body: JSON.stringify(reqBody),
})
const raw = await res.text()
const outPath = `docs/probes/trae-chat-live-${Date.now()}.json`
mkdirSync('docs/probes', { recursive: true })
writeFileSync(outPath, JSON.stringify({
  at: new Date().toISOString(),
  request: { url: `${SETTINGS.traeChatBaseURL}/api/agent/v3/llm_utils_chat`, body: reqBody },
  response: {
    status: res.status,
    contentType: res.headers.get('content-type'),
    headers: Object.fromEntries([...res.headers].filter(([k]) => !k.includes('token') && !k.includes('authorization'))),
    bodyHead: raw.slice(0, 8000),
    bodyBytes: raw.length,
  },
}, null, 2))
console.log(`HTTP ${res.status}（${res.headers.get('content-type')}），body ${raw.length} 字节`)
console.log('证据落盘 →', outPath)
console.log('\n--- body 前 1200 字节 ---')
console.log(raw.slice(0, 1200))
