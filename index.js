/**
 * dsh-codebuddy-plugin
 *
 * Three layers:
 *
 * 1. cordis.patch.yml — static config: the codebuddy provider route on the
 *    `llm-pi-ai` row (pointed at the loopback bridge below, so the main
 *    chat path shares this module's credential resolution), the default
 *    model on `agent-default-model`, the provider pins on the `web` row,
 *    and the entry-list `insert` that makes the loader run this module at all.
 * 2. This module — runtime registration: backs dsh's stock `web_search` /
 *    `web_fetch` tools with the CodeBuddy gateway's own /agenttool endpoints,
 *    and runs a loopback stream bridge for tools that need classic
 *    non-streaming OpenAI JSON (the gateway is stream-only, error 11101).
 *    The bridge owns ALL credential resolution (OAuth or API key) — callers
 *    (llm-pi-ai's chat path included) send a sentinel Authorization the
 *    bridge replaces per request. It also meters every billed request
 *    (`usage.credit` + cache counters → ~/.dsh/codebuddy-plugin-usage.json)
 *    for the settings card's live usage section.
 * 3. lib/client.js — browser half: a settings card in Settings → 插件配置.
 *
 * Config surface (Settings → 插件配置 → CodeBuddy, file-backed in
 * ~/.dsh/codebuddy-plugin.json): login mode (multiple API keys with an
 * active selection, or CodeBuddy browser OAuth), gateway baseURL, search
 * and fetch knobs, and the stream bridge switch/port. Values apply live.
 *
 * Credentials:
 * - api-key mode: the active entry of `apiKeys` (fallback: the legacy
 *   `apiKeyEnv` env/credentials.yaml reference).
 * - oauth mode: tokens from the browser handshake (state → login → token
 *   polling → account), stored separately in ~/.dsh/codebuddy-plugin-auth.json
 *   so the settings GET never carries secrets; access tokens auto-refresh
 *   via the refresh token with a single-flight lock.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-codebuddy-plugin'

/** web providers via ctx.web; the settings route rides ctx.webServer when present. */
export const inject = ['web']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const SETTINGS_PATH = join(DSH_HOME, 'codebuddy-plugin.json')
export const AUTH_PATH = join(DSH_HOME, 'codebuddy-plugin-auth.json')
const DSH_SETTINGS_PATH = join(DSH_HOME, 'settings.yaml')
const PATCH_FILE = join(dirname(fileURLToPath(import.meta.url)), 'cordis.patch.yml')

/**
 * Optional settings. Schema defaults apply when neither the composition
 * entry nor the settings file sets a field.
 */
export const Config = z.object({
  authMode: z.union([z.const('api-key'), z.const('oauth')]).default('api-key'),
  apiKeyEnv: z.string().role('credential-ref').default('CODEBUDDY_API_KEY'),
  apiKeys: z.array(z.object({
    name: z.string(),
    key: z.string().role('secret'),
  })).default([]),
  activeApiKey: z.string(),
  searchEnabled: z.boolean().default(true),
  baseURL: z.string().default('https://copilot.tencent.com'),
  searchMaxResults: z.number().step(1).min(1).max(20).default(5),
  fetchBodyCap: z.number().step(1000).min(1000).default(200000),
  bridgeEnabled: z.boolean().default(true),
  bridgePort: z.number().step(1).min(1).max(65535).default(3901),
  sessionHeadersEnabled: z.boolean().default(true),
  sessionHeaderFormat: z.union([z.const('openai'), z.const('openrouter')]).default('openai'),
  maxConcurrentPerSession: z.number().step(1).min(1).max(100).default(4),
  imageGenEnabled: z.boolean().default(true),
  imageGenModel: z.string().default('hunyuan-image-v3.0-art'),
  keyCooldownMs: z.number().step(100).min(100).default(60000),
})

/** Field metadata the settings card renders (labels live client-side). */
export const SETTINGS_FIELDS = [
  { key: 'authMode', kind: 'select' },
  { key: 'apiKeyEnv', kind: 'text' },
  { key: 'apiKeys', kind: 'keys' },
  { key: 'activeApiKey', kind: 'text' },
  { key: 'searchEnabled', kind: 'boolean' },
  { key: 'baseURL', kind: 'text' },
  { key: 'searchMaxResults', kind: 'number' },
  { key: 'fetchBodyCap', kind: 'number' },
  { key: 'bridgeEnabled', kind: 'boolean' },
  { key: 'bridgePort', kind: 'number' },
  { key: 'sessionHeadersEnabled', kind: 'boolean' },
  { key: 'sessionHeaderFormat', kind: 'select' },
  { key: 'maxConcurrentPerSession', kind: 'number' },
  { key: 'imageGenEnabled', kind: 'boolean' },
  { key: 'imageGenModel', kind: 'text' },
  { key: 'keyCooldownMs', kind: 'number' },
]

/** Validate a baseURL candidate before it can reach a provider. */
function validateBaseURL(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('baseURL 必须是绝对 http(s) 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseURL 必须使用 http 或 https')
  }
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

const readFileLayer = () => readJson(SETTINGS_PATH)
const writeFileLayer = (section) => writeJson(SETTINGS_PATH, section)
const readAuth = () => readJson(AUTH_PATH)
const writeAuth = (v) => writeJson(AUTH_PATH, v)

// ---------------------------------------------------------------------------
// Model management: the patch supplies a static 18-model base; the user's
// enable/disable state (and catalog additions) live in the settings file as
// `modelState`, and the effective list is mirrored into ~/.dsh/settings.yaml
// under llm-pi-ai.providers.codebuddy.models — the settings-driven override
// the model picker honors on the next request (no restart).
// ---------------------------------------------------------------------------

/** Parse the static model profiles from cordis.patch.yml (single source of truth). */
function readStaticModels() {
  try {
    const rows = YAML.parse(readFileSync(PATCH_FILE, 'utf8'))
    const row = Array.isArray(rows) ? rows.find((r) => r?.id === 'llm-pi-ai') : null
    const models = row?.config?.providers?.codebuddy?.models
    return Array.isArray(models) ? models.filter((m) => typeof m?.id === 'string') : []
  } catch {
    return []
  }
}

function readModelState() {
  const layer = readFileLayer()
  const state = layer.modelState
  if (!state || typeof state !== 'object') return { disabled: {}, extra: {} }
  return {
    disabled: state.disabled && typeof state.disabled === 'object' && !Array.isArray(state.disabled)
      ? state.disabled : {},
    extra: state.extra && typeof state.extra === 'object' && !Array.isArray(state.extra)
      ? state.extra : {},
  }
}

/** Effective models = static base + enabled catalog extras − disabled ids. */
export function computeEffectiveModels() {
  const { disabled, extra } = readModelState()
  const ids = new Set()
  const list = []
  for (const m of readStaticModels()) {
    if (disabled[m.id]) continue
    ids.add(m.id)
    list.push(m)
  }
  for (const [id, profile] of Object.entries(extra)) {
    if (disabled[id] || ids.has(id) || !profile?.id) continue
    ids.add(id)
    list.push({ ...profile, id })
  }
  return list
}

/**
 * Mirror the effective model list into ~/.dsh/settings.yaml under
 * llm-pi-ai.providers.codebuddy.models (the settings-driven override over the
 * patch layer). Uses a comment-preserving YAML document edit. When the state
 * is pristine (nothing disabled, no extras) the override is REMOVED instead —
 * a stale settings list would shadow future patch updates.
 */
export function syncModelsToDshSettings() {
  let doc
  try {
    doc = YAML.parseDocument(readFileSync(DSH_SETTINGS_PATH, 'utf8'))
  } catch {
    doc = new YAML.Document()
  }
  const state = readModelState()
  const pristine = Object.keys(state.disabled).length === 0
    && Object.keys(state.extra).length === 0
  const path = ['llm-pi-ai', 'providers', 'codebuddy', 'models']
  if (pristine) {
    if (!doc.getIn(path)) return false
    doc.deleteIn(path)
    writeFileSync(DSH_SETTINGS_PATH, String(doc))
    return true
  }
  const next = YAML.parse(YAML.stringify(computeEffectiveModels()))
  const current = doc.getIn(path)
  if (YAML.stringify(current ?? null) === YAML.stringify(next)) return false
  doc.setIn(path, next)
  writeFileSync(DSH_SETTINGS_PATH, String(doc))
  return true
}

/** Apply one enable/disable toggle and sync the effective list. */
function setModelEnabled({ id, enabled, profile }) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('modelSetEnabled 需要 id')
  const layer = readFileLayer()
  const state = readModelState()
  const isStatic = readStaticModels().some((m) => m.id === id)
  if (enabled) {
    delete state.disabled[id]
    if (!isStatic) {
      if (!profile || typeof profile !== 'object') {
        throw new Error('启用目录新增模型需要 profile（来自模型列表条目）')
      }
      state.extra[id] = profile
    }
  } else {
    // Static ids need an explicit disabled mark; a catalog extra simply
    // drops out of the extras map — marking it disabled would keep the
    // state non-pristine (and the settings override) forever.
    if (isStatic) state.disabled[id] = true
    delete state.extra[id]
  }
  layer.modelState = state
  writeFileLayer(layer)
  syncModelsToDshSettings()
  return state
}

// ---------------------------------------------------------------------------
// Credential resolution: api-key list > legacy env ref, or OAuth with refresh.
// ---------------------------------------------------------------------------

/** Legacy single-key path: process env, then ~/.dsh/.credentials.yaml. */
function resolveEnvKey(envName) {
  if (envName && process.env[envName]) return process.env[envName]
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (envName && existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(
      new RegExp(`^\\s*${envName}:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'),
    )
    if (m) return m[1]
  }
  return null
}

let refreshInFlight = null

/**
 * Exchange the refresh token for a fresh access token (single-flight).
 * Mirrors the official CLI: Bearer <old access>, X-Refresh-Token, plus the
 * identity headers. Returns the updated auth store or undefined on refusal.
 */
async function refreshOAuth(baseURL, auth) {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
        'X-Domain': auth.domain ?? '',
        'X-Refresh-Token': auth.refreshToken ?? '',
      }
      if (auth.uid) headers['X-User-Id'] = auth.uid
      if (auth.enterpriseId) headers['X-Enterprise-Id'] = auth.enterpriseId
      const res = await fetch(`${baseURL}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers,
      })
      if (!res.ok) return undefined
      const body = await res.json().catch(() => null)
      if (!body || body.code !== 0 || !body.data?.accessToken) return undefined
      const store = readAuth()
      store.auth = {
        accessToken: body.data.accessToken,
        expiresAt: Date.now() + (body.data.expiresIn ?? 3600) * 1000,
        refreshToken: body.data.refreshToken ?? auth.refreshToken,
        refreshExpiresAt: body.data.refreshExpiresAt != null
          ? Date.now() + body.data.refreshExpiresAt * 1000
          : auth.refreshExpiresAt,
        domain: body.data.domain ?? auth.domain,
      }
      writeAuth(store)
      return store.auth
    } catch {
      return undefined
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/** OAuth branch, extracted so both resolution flavors share it. */
async function resolveOAuthCredential(s) {
  const store = readAuth()
  const auth = store.auth
  if (!auth?.accessToken) return null
  let current = auth
  if (auth.expiresAt && auth.expiresAt - Date.now() < 60_000) {
    const refreshed = await refreshOAuth(s.baseURL, auth)
    if (!refreshed) return null
    current = refreshed
  }
  const headers = { 'X-Domain': current.domain ?? '' }
  if (store.account?.uid) headers['X-User-Id'] = store.account.uid
  if (store.account?.enterpriseId) headers['X-Enterprise-Id'] = store.account.enterpriseId
  return { authorization: `Bearer ${current.accessToken}`, headers }
}

/**
 * Resolve the credential every outbound call should use.
 * @returns {Promise<{authorization: string, headers: Record<string,string>} | null>}
 */
async function resolveCredential(settings) {
  const s = settings()
  if (s.authMode === 'oauth') return resolveOAuthCredential(s)
  // api-key mode: the active list entry wins, legacy env ref is the fallback.
  const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
  const key = active?.key ?? resolveEnvKey(s.apiKeyEnv)
  if (!key) return null
  return { authorization: `Bearer ${key}`, headers: {} }
}

// ---------------------------------------------------------------------------
// Multi-key rotation (api-key mode only; the OAuth path is never rotated):
// requests round-robin across apiKeys, a key that answers 401/403/429/5xx or
// drops the connection is cooled for keyCooldownMs, then rejoins on its own.
// ---------------------------------------------------------------------------

/** keyName → cooldown-until epoch ms. */
const keyCooldowns = new Map()
/** Round-robin cursor over the apiKeys list (advanced once per request). */
let keyCursor = 0

function markKeyCooling(name, cooldownMs) {
  keyCooldowns.set(name, Date.now() + cooldownMs)
}

/** Statuses that fail a request over to the next key. */
function isKeyFailoverStatus(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

/**
 * Credential candidates for one outbound call, in try order.
 * OAuth: zero or one candidate (rotation deliberately not applied).
 * api-key: 0 keys → the legacy env ref (single candidate); 1 key → that key;
 * ≥2 keys → every key exactly once, non-cooling first in round-robin order,
 * cooling keys appended as last resort.
 * @returns {Promise<Array<{authorization: string, headers: Record<string,string>, keyName: string|null}>>}
 */
async function resolveCredentialCandidates(settings) {
  const s = settings()
  if (s.authMode === 'oauth') {
    const single = await resolveOAuthCredential(s)
    return single ? [{ ...single, keyName: null }] : []
  }
  const keys = (s.apiKeys ?? []).filter((k) => typeof k?.key === 'string' && k.key.length > 0)
  if (keys.length === 0) {
    const env = resolveEnvKey(s.apiKeyEnv)
    return env ? [{ authorization: `Bearer ${env}`, headers: {}, keyName: null }] : []
  }
  if (keys.length === 1) {
    return [{ authorization: `Bearer ${keys[0].key}`, headers: {}, keyName: keys[0].name }]
  }
  const now = Date.now()
  const n = keys.length
  const start = keyCursor % n
  keyCursor = (keyCursor + 1) % n
  const ordered = Array.from({ length: n }, (_, i) => keys[(start + i) % n])
  const fresh = ordered.filter((k) => (keyCooldowns.get(k.name) ?? 0) <= now)
  const cooling = ordered.filter((k) => (keyCooldowns.get(k.name) ?? 0) > now)
  return [...fresh, ...cooling].map((k) => ({
    authorization: `Bearer ${k.key}`,
    headers: {},
    keyName: k.name,
  }))
}

/**
 * Run `attempt(cred)` over the rotation candidates with failover: a key that
 * throws a network error or answers a failover status is cooled and the next
 * candidate takes over. The LAST candidate's response/error is returned
 * as-is (no retry). `attempt(cred)` must return the fetch Response (body
 * unconsumed on error statuses — the helper cancels it before failing over)
 * or throw. Resolves { cred, res, err }: exactly one of res/err is set.
 */
async function withKeyRotation(settings, attempt) {
  const candidates = await resolveCredentialCandidates(settings)
  if (candidates.length === 0) return { cred: null, res: null, err: new Error('CodeBuddy 凭据不可用（检查插件配置卡的登录设置）') }
  const cooldownMs = settings().keyCooldownMs
  let lastErr = null
  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i]
    const isLast = i === candidates.length - 1
    let res
    try {
      res = await attempt(cred)
    } catch (err) {
      // Caller-side aborts are not the key's fault: no cooldown, no failover.
      if (err?.name === 'AbortError') return { cred, res: null, err }
      // Network-layer failure: cool the key and fail over (unless last).
      if (cred.keyName) markKeyCooling(cred.keyName, cooldownMs)
      lastErr = err
      if (isLast) return { cred, res: null, err }
      continue
    }
    if (!isLast && isKeyFailoverStatus(res.status)) {
      if (cred.keyName) markKeyCooling(cred.keyName, cooldownMs)
      await res.body?.cancel().catch(() => {})
      lastErr = null
      continue
    }
    return { cred, res, err: null }
  }
  return { cred: null, res: null, err: lastErr }
}

// ---------------------------------------------------------------------------
// Browser-OAuth handshake (flow verified against the official CLI):
//   POST /v2/plugin/auth/state?platform=CLI  → {state, authUrl}
//   GET  /v2/plugin/auth/token?state=…       → code 11217 pending, 0 → tokens
//   GET  /v2/plugin/login/account?state=…    → {uid, nickname, …}
// ---------------------------------------------------------------------------

const AUTH_PENDING_CODE = 11217
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_POLL_INTERVAL_MS = 1000

const oauthPending = { active: false, authUrl: '', error: '' }

async function startOAuth(baseURL) {
  if (oauthPending.active) return { started: true, authUrl: oauthPending.authUrl }
  const res = await fetch(`${baseURL}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    },
  })
  if (!res.ok) throw new Error(`auth state HTTP ${res.status}`)
  const body = await res.json()
  if (body.code !== 0 || !body.data?.state) {
    throw new Error(`auth state error: ${body.code} ${body.msg ?? ''}`)
  }
  const { state, authUrl } = body.data
  oauthPending.active = true
  oauthPending.authUrl = authUrl
  oauthPending.error = ''

  const poll = async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS))
        let response
        try {
          response = await fetch(`${baseURL}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
            headers: { Accept: 'application/json', 'X-No-Authorization': 'true' },
          })
        } catch {
          continue
        }
        if (!response.ok) continue
        const body = await response.json().catch(() => null)
        if (!body) continue
        if (body.code === AUTH_PENDING_CODE) continue
        if (body.code !== 0 || !body.data?.accessToken) {
          oauthPending.error = `登录失败：${body.code} ${body.msg ?? ''}`
          return
        }
        const token = body.data
        // Fetch the account facts before persisting.
        let account = {}
        try {
          const accRes = await fetch(`${baseURL}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token.accessToken}`,
              'X-No-User-Id': 'true',
              'X-No-Enterprise-Id': 'true',
              'X-Domain': token.domain ?? '',
            },
          })
          const accBody = await accRes.json().catch(() => null)
          if (accBody?.code === 0 && accBody.data) account = accBody.data
        } catch {
          // account facts are best-effort; tokens alone still work
        }
        writeAuth({
          auth: {
            accessToken: token.accessToken,
            expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
            refreshToken: token.refreshToken,
            refreshExpiresAt: token.refreshExpiresAt != null
              ? Date.now() + token.refreshExpiresAt * 1000
              : undefined,
            domain: token.domain,
          },
          account,
        })
        return
      }
      oauthPending.error = '登录超时（10 分钟未完成）'
    } finally {
      oauthPending.active = false
    }
  }
  poll()
  return { started: true, authUrl }
}

/** OAuth view for the card — tokens never leave the host. */
function oauthStatus() {
  const store = readAuth()
  const auth = store.auth
  return {
    pending: oauthPending.active,
    authUrl: oauthPending.active ? oauthPending.authUrl : '',
    error: oauthPending.error,
    signedIn: Boolean(auth?.accessToken),
    account: store.account?.nickname ? {
      nickname: store.account.nickname,
      uid: store.account.uid,
      enterpriseName: store.account.enterpriseName ?? '',
    } : null,
    accessTokenExpiresAt: auth?.expiresAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// Gateway clients: agenttool providers + the stream bridge.
// ---------------------------------------------------------------------------

// /agenttool rejected the /v2 client UA with error 12403 ("check ua"); it
// expects the CLI's own UA shape (verified from @tencent-ai/codebuddy-code).
const USER_AGENT = 'CLI/unknown CodeBuddy/2.136.0'
const CLIENT_HEADERS = {
  'User-Agent': USER_AGENT,
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': '2.133.1',
  'X-Product-Version': '2.133.1',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Private-Data': 'false',
}

async function callAgentTool(settings, path, payload, signal) {
  const { res, err } = await withKeyRotation(settings, (cred) => fetch(`${settings().baseURL}${path}`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: cred.authorization,
      ...cred.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(payload),
  }))
  if (err) {
    if (err.message === 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）') throw err
    if (signal?.aborted) throw err
    // undici hides the real reason in err.cause (ECONNRESET, terminated,
    // certificate errors …) — a bare "fetch failed" is undebuggable.
    const causes = []
    for (let e = err; e; e = e.cause) causes.push(e.code ?? e.message ?? String(e))
    throw new Error(`CodeBuddy agenttool ${path} network error: ${causes.join(' ← ')}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // The gateway answers errors as JSON with code/msg — surface both.
    let codeMsg = ''
    try { const j = JSON.parse(body); if (j?.code != null) codeMsg = ` code ${j.code}: ${j.msg ?? ''}` } catch { /* not JSON */ }
    throw new Error(`CodeBuddy agenttool ${path} HTTP ${res.status}${codeMsg || ` ${body.slice(0, 160)}`}`)
  }
  const data = await res.json().catch(() => null)
  if (data && data.code != null && data.code !== 0) {
    throw new Error(`CodeBuddy agenttool ${path} error ${data.code}: ${data.msg ?? ''}`)
  }
  return data
}

/** Search backend: POST /agenttool/v1/search {query, type, max_results}. */
export function makeSearchProvider(settings) {
  return {
    id: 'codebuddy',
    available() {
      return true // cheap check only; real failures surface per request
    },
    async search(request, signal) {
      const s = settings()
      const data = await callAgentTool(
        settings,
        '/agenttool/v1/search',
        {
          query: request.query,
          type: 'text2text',
          max_results: request.maxResults ?? s.searchMaxResults,
        },
        signal,
      )
      if (data?.usage) recordUsage({ ts: Date.now(), kind: 'search', model: null, usage: data.usage })
      const results = Array.isArray(data?.results) ? data.results : []
      return {
        sources: results
          .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
          .map((r) => ({
            url: r.url,
            ...(typeof r.title === 'string' && r.title.length > 0 ? { title: r.title } : {}),
            ...(typeof r.snippet === 'string' && r.snippet.length > 0 ? { snippet: r.snippet } : {}),
          })),
        // The seam itself truncates to maxResults; we already passed it
        // through as max_results, so nothing extra was cut here.
        truncated: false,
      }
    },
  }
}

/**
 * Fetch backend: POST /agenttool/v1/webfetch {url} → {url, title, content}.
 * The endpoint answers with decoded content or a JSON error, never the
 * target page's HTTP status, so a successful call reports statusCode 200
 * and the body is classified as text.
 */
export function makeFetchProvider(settings) {
  return {
    id: 'codebuddy',
    available() {
      return true
    },
    async fetch(request, signal) {
      const s = settings()
      const data = await callAgentTool(settings, '/agenttool/v1/webfetch', { url: request.url }, signal)
      if (data?.usage) recordUsage({ ts: Date.now(), kind: 'fetch', model: null, usage: data.usage })
      const content = typeof data?.content === 'string' ? data.content : ''
      const cap = s.fetchBodyCap
      return {
        url: typeof data?.url === 'string' && data.url.length > 0 ? data.url : request.url,
        statusCode: 200,
        body: { kind: 'text', content: content.slice(0, cap) },
        truncated: content.length > cap,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Image generation tool: registers dsh-native `image_generate` on the tools
// seam, backed by the gateway's POST /v2/images/generations (probed working
// 2026-08-17 with hunyuan-image-v3.0-art, ~22s/image; samples in
// docs/probes/). The gateway has a /v2/3d/generations route shape but no 3D
// model is routed for this account (14407 "route config not found") — 3D is
// documented as unavailable, not integrated.
// ---------------------------------------------------------------------------

/** Where generated images land: the session workspace when the agent loop
 * exposes one, else ~/.dsh/generated-images. */
function resolveImageSaveDir(exec) {
  const a = exec?.agent
  const dir = a?.workspaceDir ?? a?.workDir ?? a?.cwd ?? a?.workspace?.dir ?? null
  return dir && typeof dir === 'string'
    ? join(dir, 'generated-images')
    : join(DSH_HOME, 'generated-images')
}

/** dsh tool definition for `image_generate` (plain object — the plugin must
 * not import @deepseek-ai/*; the registry accepts the structural shape). */
export function makeImageGenTool(settings) {
  return {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt (CodeBuddy hunyuan-image backend). ' +
      'Returns the local file path of the saved image and its source URL. ' +
      'Takes ~20s per image; one image per call.',
    // Schemas here are FINAL JSON Schema (the registry's defineTool shorthand
    // converter is not importable from a plugin — see AGENTS.md 踩坑 #9).
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What to draw; be concrete about subject, style, and colors.' },
        size: { type: 'string', description: 'WxH pixels, e.g. "1024x1024" (default), "768x768", "1280x720".' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          url: { type: 'string' },
          model: { type: 'string' },
          ms: { type: 'number' },
        },
        required: ['path', 'model', 'ms'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `image generated (${value.model}, ${(value.ms / 1000).toFixed(1)}s)\nsaved: ${value.path}\nsource: ${value.url ?? 'n/a'}`,
      }],
    },
    // Generation measured at ~22s end-to-end; keep headroom for slow runs.
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) throw new Error('image_generate: prompt 不能为空')
      const size = typeof args?.size === 'string' && /^\d{3,4}x\d{3,4}$/.test(args.size)
        ? args.size : '1024x1024'
      const s = settings()
      const t0 = Date.now()
      const { res, err } = await withKeyRotation(settings, (cred) => fetch(`${s.baseURL}/v2/images/generations`, {
        method: 'POST',
        signal: exec?.signal,
        headers: {
          Authorization: cred.authorization,
          ...cred.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ model: s.imageGenModel, prompt, size, n: 1 }),
      }))
      if (err) {
        if (err.message === 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）') throw err
        if (exec?.signal?.aborted) throw err
        const causes = []
        for (let e = err; e; e = e.cause) causes.push(e.code ?? e.message ?? String(e))
        throw new Error(`image_generate network error: ${causes.join(' ← ')}`)
      }
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(`image_generate HTTP ${res.status}${body?.code != null ? ` code ${body.code}: ${body.msg ?? ''}` : ''}`)
      }
      if (!body || body.code !== 0) {
        throw new Error(`image_generate error ${body?.code ?? '?'}: ${body?.msg ?? 'empty or malformed response'}`)
      }
      if (body.data?.usage) recordUsage({ ts: t0, kind: 'image', model: s.imageGenModel, usage: body.data.usage })
      const item = body.data?.data?.[0]
      const url = typeof item?.url === 'string' ? item.url : null
      const b64 = typeof item?.b64_json === 'string' ? item.b64_json : null
      if (!url && !b64) throw new Error('image_generate: 响应既无 url 也无 b64_json')
      const dir = resolveImageSaveDir(exec)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `image-${t0}.png`)
      if (url) {
        const img = await fetch(url, { signal: exec?.signal })
        if (!img.ok) throw new Error(`image_generate: 下载图片失败 HTTP ${img.status}`)
        writeFileSync(file, Buffer.from(await img.arrayBuffer()))
      } else {
        writeFileSync(file, Buffer.from(b64, 'base64'))
      }
      return { path: file, url: url ?? undefined, model: s.imageGenModel, ms: Date.now() - t0 }
    },
  }
}

// ---------------------------------------------------------------------------
// Optional request forensics: point CODEBUDDY_BRIDGE_LOG at a JSONL path and
// the bridge records every inbound request (body/header hashes, header traits,
// prompt markers) and its outcome (status, queue wait, timings, upstream usage
// incl. the gateway's cache counters). Off by default. Payload text is never
// logged — only hashes and a short preview, enough to classify duplicates.
// Diagnostics must never break the bridge: every failure is swallowed.
// ---------------------------------------------------------------------------

let bridgeLogSeq = 0
let bridgeDumpSeq = 0

function bridgeLog(record) {
  const path = process.env.CODEBUDDY_BRIDGE_LOG
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify(record) + '\n')
  } catch {
    // logging is best-effort
  }
}

/** Full-body dump for cache/prompt forensics: CODEBUDDY_BRIDGE_DUMP=<dir>
 * writes every inbound chat body verbatim (req-NNNN-<ts>.json). Unlike the
 * hash-only log this is plaintext by design — local-only, opt-in. */
function bridgeDump(rawBody) {
  const dir = process.env.CODEBUDDY_BRIDGE_DUMP
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `req-${String(++bridgeDumpSeq).padStart(4, '0')}-${Date.now()}.json`), rawBody)
  } catch {
    // dump is best-effort
  }
}

// ---------------------------------------------------------------------------
// Usage metering. The gateway reports per-request billing (`usage.credit`)
// plus cache counters on every chat SSE stream; the bridge scans for it
// ALWAYS (not only under CODEBUDDY_BRIDGE_LOG) and accumulates into
// ~/.dsh/codebuddy-plugin-usage.json so the settings card can show live
// consumption. Tokens/credits only — never message content. Metering must
// never break the data path: every failure is swallowed, writes debounced.
// ---------------------------------------------------------------------------

const USAGE_PATH = join(DSH_HOME, 'codebuddy-plugin-usage.json')
const USAGE_RECENT_CAP = 100
const USAGE_DAYS_CAP = 31
const USAGE_FLUSH_MS = 5000
/** Two requests further apart than this belong to different (approximate) turns. */
const TURN_GAP_MS = 45_000

/** Local-day key (YYYY-MM-DD) — the display groups by the user's day. */
function dayKey(ts) {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function normalizeUsageStore(raw) {
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  store.since = typeof store.since === 'number' ? store.since : Date.now()
  store.totalCredit = typeof store.totalCredit === 'number' ? store.totalCredit : 0
  store.totalRequests = typeof store.totalRequests === 'number' ? store.totalRequests : 0
  store.days = store.days && typeof store.days === 'object' && !Array.isArray(store.days) ? store.days : {}
  store.recent = Array.isArray(store.recent) ? store.recent.slice(-USAGE_RECENT_CAP) : []
  return store
}

const usageStore = normalizeUsageStore(readJson(USAGE_PATH))
let usageFlushTimer = null

function flushUsage() {
  try {
    writeJson(USAGE_PATH, usageStore)
  } catch {
    // persistence is best-effort
  }
}

/** Debounced: a tool-loop burst produces one write, not one per request. */
function scheduleUsageFlush() {
  if (usageFlushTimer) return
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null
    flushUsage()
  }, USAGE_FLUSH_MS)
  usageFlushTimer.unref?.()
}

const roundCredit = (n) => Math.round(n * 10000) / 10000

/**
 * Record one billed request. `usage` is the gateway's SSE usage object; only
 * requests that actually produced one are recorded (failed/error responses
 * carry no billing signal). kind: chat | title | compaction | image | search | fetch.
 */
function recordUsage({ ts, kind, model, usage }) {
  if (!usage || typeof usage !== 'object') return
  try {
    const credit = typeof usage.credit === 'number' && Number.isFinite(usage.credit) ? usage.credit : 0
    const entry = {
      ts,
      kind,
      model: typeof model === 'string' ? model : null,
      prompt: usage.prompt_tokens ?? 0,
      hit: usage.prompt_cache_hit_tokens ?? 0,
      miss: usage.prompt_cache_miss_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      credit,
    }
    usageStore.totalCredit = roundCredit(usageStore.totalCredit + credit)
    usageStore.totalRequests += 1
    const day = dayKey(ts)
    const bucket = usageStore.days[day] ?? { credit: 0, requests: 0 }
    bucket.credit = roundCredit(bucket.credit + credit)
    bucket.requests += 1
    usageStore.days[day] = bucket
    const dayKeys = Object.keys(usageStore.days).sort()
    while (dayKeys.length > USAGE_DAYS_CAP) delete usageStore.days[dayKeys.shift()]
    usageStore.recent.push(entry)
    if (usageStore.recent.length > USAGE_RECENT_CAP) {
      usageStore.recent = usageStore.recent.slice(-USAGE_RECENT_CAP)
    }
    scheduleUsageFlush()
  } catch {
    // metering is best-effort
  }
}

/**
 * Group recent requests into approximate turns: entries closer than
 * TURN_GAP_MS merge into one row (a title call lands in the turn that
 * triggered it; tool-loop steps are seconds apart by construction). The
 * bridge cannot see dsh's turn boundaries (no session ids on the wire), so
 * this is a disclosed approximation.
 */
function groupTurns(recent) {
  const turns = []
  for (const r of recent) {
    const last = turns[turns.length - 1]
    if (last && r.ts - last.end <= TURN_GAP_MS) {
      last.end = r.ts
      last.requests += 1
      last.credit = roundCredit(last.credit + r.credit)
      last.prompt += r.prompt
      last.hit += r.hit
      last.miss += r.miss
      if (r.model && !last.models.includes(r.model)) last.models.push(r.model)
      if (!last.kinds.includes(r.kind)) last.kinds.push(r.kind)
    } else {
      turns.push({
        start: r.ts,
        end: r.ts,
        requests: 1,
        credit: r.credit,
        prompt: r.prompt,
        hit: r.hit,
        miss: r.miss,
        models: r.model ? [r.model] : [],
        kinds: [r.kind],
      })
    }
  }
  return turns
}

/** The action:'usage' payload: totals + approximate turns + exact recent rows. */
function buildUsageView() {
  const today = usageStore.days[dayKey(Date.now())] ?? { credit: 0, requests: 0 }
  return {
    since: usageStore.since,
    totalCredit: usageStore.totalCredit,
    totalRequests: usageStore.totalRequests,
    today: { day: dayKey(Date.now()), credit: today.credit, requests: today.requests },
    recent: usageStore.recent.slice(-20).reverse(),
    turns: groupTurns(usageStore.recent).slice(-10).reverse(),
    turnGapMs: TURN_GAP_MS,
  }
}

const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Headers worth forensically recording; authorization is classified, never logged. */
const LOG_HEADER_NAMES = [
  'user-agent', 'content-type',
  'x-conversation-id', 'x-session-id', 'session_id', 'x-client-request-id', 'x-session-affinity',
  'x-ide-type', 'x-ide-name', 'x-ide-version', 'x-product-version',
  'x-requested-with', 'x-private-data',
]

function pickLogHeaders(headers) {
  const out = {}
  for (const name of LOG_HEADER_NAMES) {
    const value = headers[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  const auth = headers.authorization
  if (typeof auth === 'string' && auth.length > 0) {
    out.authorization = auth === 'Bearer dsh-codebuddy-bridge' ? 'sentinel' : 'caller-set'
  }
  return out
}

/** Text of one chat message, whether content is a string or typed parts. */
function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
}

/**
 * Classify a chat payload by its prompt shape — dsh's auxiliary LLM calls
 * (session title, compaction) reuse the main route and are recognizable only
 * by their prompt text (verified against dsh-session-title-llm /
 * dsh-compaction-basic sources).
 */
function detectPayloadMarker(messages) {
  const first = messages[0]
  if (first?.role === 'system'
    && messageText(first).startsWith('Create a concise title for an AI coding-assistant session')) {
    return 'session-title'
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    if (messageText(messages[i]).startsWith('You are now acting as a compaction engine')) {
      return 'compaction'
    }
    break
  }
  return null
}

/** Metering kind for a parsed chat payload: dsh's auxiliary calls (title,
 * compaction) get their own kinds so the usage view can tell them apart. */
function chatUsageKind(payload) {
  const marker = detectPayloadMarker(Array.isArray(payload?.messages) ? payload.messages : [])
  return marker === 'session-title' ? 'title' : marker === 'compaction' ? 'compaction' : 'chat'
}

/** Hash-and-shape summary of a parsed chat payload (no message text logged). */
function summarizeChatPayload(rawBody, payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const sysText = messages[0]?.role === 'system' ? messageText(messages[0]) : ''
  let lastUserText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserText = messageText(messages[i])
      break
    }
  }
  return {
    model: typeof payload.model === 'string' ? payload.model : null,
    stream: payload.stream === true,
    msgs: messages.length,
    bytes: rawBody.length,
    bodySha: sha16(rawBody),
    msgsSha: sha16(JSON.stringify(payload.messages ?? null)),
    sysSha: sysText.length > 0 ? sha16(sysText) : null,
    sysBytes: sysText.length,
    lastUserSha: lastUserText.length > 0 ? sha16(lastUserText) : null,
    lastUserPreview: lastUserText.replace(/\s+/g, ' ').slice(0, 60),
    marker: detectPayloadMarker(messages),
    maxTokens: payload.max_tokens ?? payload.max_completion_tokens ?? null,
    reasoningEffort: payload.reasoning_effort ?? null,
    tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
    promptCacheKey: typeof payload.prompt_cache_key === 'string' ? payload.prompt_cache_key : null,
  }
}

// ---------------------------------------------------------------------------
// Stream bridge = a smart loopback proxy and the single credential owner:
// llm-pi-ai's codebuddy route points here (cordis.patch.yml), so the main
// chat path crosses it too. It passes any request path through to the
// gateway, and on POST /chat/completions it can (a) inject the gateway's
// session-attribution headers from the incoming session id, (b) cap
// concurrent in-flight requests per session id (excess queue, FIFO), and
// (c) aggregate the stream into classic JSON for non-streaming callers.
// ---------------------------------------------------------------------------

const SESSION_HEADER_SETS = {
  openai: ['session_id', 'x-client-request-id', 'x-session-affinity'],
  openrouter: ['x-session-id'],
}

/** Extract the session id from headers or a body hint, in precedence order. */
function extractSessionId(headers, payload) {
  const candidates = [
    headers['x-conversation-id'],
    headers['x-session-id'],
    headers['session_id'],
    headers['x-client-request-id'],
    headers['x-session-affinity'],
    payload?.conversation_id,
    payload?.session_id,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return null
}

/**
 * Per-session concurrency governor: per-id in-flight counters with FIFO
 * waiting queues. acquire() resolves once this call may proceed.
 */
class SessionLimiter {
  constructor() {
    this.inflight = new Map()
    this.queues = new Map()
  }
  acquire(id, limit) {
    if (id === null) return Promise.resolve(() => {})
    const running = this.inflight.get(id) ?? 0
    if (running < limit) {
      this.inflight.set(id, running + 1)
      return Promise.resolve(() => this.release(id))
    }
    return new Promise((resolve) => {
      const q = this.queues.get(id) ?? []
      q.push(() => resolve(() => this.release(id)))
      this.queues.set(id, q)
    })
  }
  release(id) {
    const running = (this.inflight.get(id) ?? 0) - 1
    const q = this.queues.get(id) ?? []
    // One release frees exactly one slot; hand it to the oldest waiter.
    // The woken call inherits the slot, so the in-flight count is restored
    // BEFORE its callback runs (it will release again when done).
    const next = q.shift()
    if (next !== undefined) {
      this.inflight.set(id, running + 1)
      next()
    } else if (running <= 0) {
      this.inflight.delete(id)
    } else {
      this.inflight.set(id, running)
    }
    if (q.length === 0) this.queues.delete(id)
  }
}

const limiter = new SessionLimiter()

/**
 * Aggregate one streamed upstream chat completion into a classic
 * chat.completion JSON for non-streaming callers (describe-image et al.).
 * The gateway is stream-only (error 11101), so the bridge always speaks
 * SSE upstream and translates back here.
 */
async function aggregateChatCompletion(upstream, res, model, tap = null) {
  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '')
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
    res.end(errBody)
    return
  }
  let content = ''
  let finishReason = null
  let buf = ''
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const chunk = JSON.parse(data)
        if (tap && chunk.usage) tap.usage = chunk.usage
        if (chunk.error || (chunk.code != null && chunk.code !== 0)) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(data)
          return
        }
        const choice = chunk.choices?.[0]
        if (choice?.delta?.content) content += choice.delta.content
        if (choice?.finish_reason) finishReason = choice.finish_reason
      } catch {
        // incomplete JSON inside a complete SSE line — skip
      }
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'codebuddy-stream-bridge',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason ?? 'stop',
        },
      ],
      usage: {},
    }),
  )
}

/**
 * Proxy one request upstream. Passes through non-chat paths verbatim; on
 * POST /chat/completions injects session headers (from the incoming session
 * id, unless the caller already set one) and gates per-session concurrency.
 * Inbound stream:true gets the SSE passed through; anything else (classic
 * non-streaming callers) gets the stream aggregated into a chat.completion
 * JSON. Credentials are always resolved host-side (withKeyRotation — api-key
 * mode rotates over apiKeys with failover; OAuth stays single-credential);
 * the caller's Authorization is never forwarded.
 */
async function proxyUpstream(settings, req, res, rawBody) {
  const s = settings()
  const isChat = req.url?.endsWith('/chat/completions') === true
  const logId = process.env.CODEBUDDY_BRIDGE_LOG ? ++bridgeLogSeq : 0
  const t0 = Date.now()

  // Parse the body only for chat (the session hint may live there); other
  // paths pass the bytes through untouched.
  let payload = null
  if (isChat && rawBody.length > 0) {
    try { payload = JSON.parse(rawBody) } catch { payload = null }
  }

  const sessionId = isChat ? extractSessionId(req.headers, payload) : null
  if (logId) {
    bridgeLog({
      seq: logId,
      dir: 'in',
      ts: t0,
      method: req.method,
      path: req.url,
      hdr: pickLogHeaders(req.headers),
      chat: payload ? summarizeChatPayload(rawBody, payload) : null,
      bytes: payload ? undefined : rawBody.length,
      bodySha: payload ? undefined : sha16(rawBody),
      sessionIn: sessionId,
    })
  }
  if (isChat && payload !== null) bridgeDump(rawBody)
  const outHeaders = {
    'Content-Type': 'application/json',
    ...CLIENT_HEADERS,
  }
  // Session attribution: per header, a value the caller already set wins;
  // missing headers are filled with the extracted session id. (The bridge
  // rebuilds the header set from scratch — an all-or-nothing "preserve"
  // would silently DROP the caller's headers instead of forwarding them.)
  const sessionOut = {}
  if (isChat && s.sessionHeadersEnabled === true && sessionId !== null) {
    const names = SESSION_HEADER_SETS[s.sessionHeaderFormat] ?? SESSION_HEADER_SETS.openai
    for (const name of names) {
      const existing = req.headers[name]
      outHeaders[name] = typeof existing === 'string' && existing.length > 0 ? existing : sessionId
      sessionOut[name] = outHeaders[name]
    }
  }

  // Credentials resolve per request; with ≥2 api keys the candidates rotate
  // (round-robin + cooldown failover), OAuth stays a single candidate.
  let body = rawBody
  // Only an explicit stream:true passes SSE through; classic non-streaming
  // callers (stream:false or absent — the OpenAI default) get aggregation.
  const aggregate = isChat && payload !== null && payload.stream !== true
  if (isChat && payload !== null) {
    payload.stream = true
    // pi-ai serializes the system prompt as role "developer" for reasoning
    // models (openai-completions.js: useDeveloperRole = model.reasoning &&
    // compat.supportsDeveloperRole). Since 2026-08-18 ~16:24 UTC the
    // gateway's content moderation rejects any chat payload containing a
    // developer-role message with finish_reason=content_filter, while the
    // byte-identical payload with role "system" passes (bisected against a
    // CODEBUDDY_BRIDGE_DUMP capture). Rewrite developer -> system on the way
    // out; the gateway treats them equivalently for instruction purposes.
    if (Array.isArray(payload.messages)) {
      for (const m of payload.messages) {
        if (m?.role === 'developer') m.role = 'system'
      }
    }
    body = JSON.stringify(payload)
  }

  /** Outcome record shared by every exit path below. */
  const logOut = (extra) => {
    if (!logId) return
    bridgeLog({
      seq: logId,
      dir: 'out',
      ts: Date.now(),
      ms: Date.now() - t0,
      ...(Object.keys(sessionOut).length > 0 ? { sessionOut } : {}),
      ...extra,
    })
  }

  // Concurrency gate only applies to chat (LLM calls).
  const release = isChat ? await limiter.acquire(sessionId, s.maxConcurrentPerSession) : () => {}
  const waitMs = Date.now() - t0
  try {
    const { cred, res: upstream0, err } = await withKeyRotation(settings, (c) => {
      outHeaders.Authorization = c.authorization
      for (const name of Object.keys(outHeaders)) {
        // OAuth identity headers ride cred.headers; stale ones from a prior
        // candidate must not leak across attempts.
        if (name.startsWith('X-User-Id') || name.startsWith('X-Enterprise-Id') || name === 'X-Domain') delete outHeaders[name]
      }
      Object.assign(outHeaders, c.headers)
      return fetch(`${s.baseURL}${req.url}`, {
        method: req.method,
        headers: outHeaders,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      })
    })
    if (!cred || err) {
      // No credential at all (503) or every candidate failed at the network
      // layer (502) — the caller gets a classic JSON error either way.
      const isCred = err?.message === 'CodeBuddy 凭据不可用（检查插件配置卡的登录设置）'
      const status = isCred ? 503 : 502
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: isCred ? 'codebuddy credential unavailable' : `upstream unreachable: ${err?.message ?? 'unknown'}` } }))
      logOut({ status, waitMs, err: err?.message ?? 'credential unavailable' })
      return
    }
    const upstream = upstream0
    const ttfbMs = Date.now() - t0
    if (aggregate) {
      const tap = { usage: null }
      await aggregateChatCompletion(upstream, res, payload.model, tap)
      if (tap.usage) recordUsage({ ts: t0, kind: chatUsageKind(payload), model: payload.model ?? null, usage: tap.usage })
      logOut({ status: upstream.status, waitMs, ttfbMs, aggregated: true, usage: tap?.usage ?? null, keyName: cred.keyName ?? undefined })
      return
    }
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
    if (upstream.body === null) {
      res.end()
      logOut({ status: upstream.status, waitMs, ttfbMs })
      return
    }
    // Tee chat SSE bytes through a line scanner that keeps the last usage
    // object (the gateway repeats usage on every chunk). Always on for chat:
    // the usage meter feeds the settings card; the forensic log reuses the
    // same scan when CODEBUDDY_BRIDGE_LOG is set.
    const reader = upstream.body.getReader()
    const decoder = isChat ? new TextDecoder() : null
    let scanBuf = ''
    let usage = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (decoder) {
        scanBuf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = scanBuf.indexOf('\n')) >= 0) {
          const line = scanBuf.slice(0, nl).trim()
          scanBuf = scanBuf.slice(nl + 1)
          if (!line.startsWith('data:') || !line.includes('"usage"')) continue
          try {
            const chunk = JSON.parse(line.slice(5).trim())
            if (chunk.usage) usage = chunk.usage
          } catch {
            // incomplete JSON inside a complete SSE line — skip
          }
        }
      }
      if (!res.write(value)) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
    if (usage && isChat && payload) {
      recordUsage({ ts: t0, kind: chatUsageKind(payload), model: payload.model ?? null, usage })
    }
    logOut({ status: upstream.status, waitMs, ttfbMs, usage })
  } catch (err) {
    logOut({ err: String(err?.message ?? err) })
    throw err
  } finally {
    release()
  }
}

/**
 * Bridge runtime state for the settings view. `lastError` records a listen
 * failure (typically EADDRINUSE — another dsh instance already holds the
 * port; its bridge still serves this instance's traffic, since the route in
 * cordis.patch.yml points at the port, not the process). A listen failure
 * must NEVER crash the host: an unhandled 'error' event on the server used
 * to take the whole dsh process down (even `dsh web --help` loads plugins).
 */
const bridgeRuntime = { running: false, port: null, lastError: null }

/**
 * The bridge listens on 127.0.0.1 only. Passes any path through; POST
 * /chat/completions gets session-header injection and per-session concurrency
 * gating on top of the credential resolution. Managed by syncBridge():
 * restarted when bridgePort or bridgeEnabled moves.
 */
function startBridge(settings, port) {
  const server = createServer((req, res) => {
    let rawBody = ''
    req.on('data', (c) => {
      rawBody += c
      if (rawBody.length > 32 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      proxyUpstream(settings, req, res, rawBody).catch((err) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(`stream bridge error: ${err.message}`)
      })
    })
  })
  server.on('error', (err) => {
    bridgeRuntime.running = false
    bridgeRuntime.lastError = err?.code ?? String(err?.message ?? err)
    process.stderr.write(`[dsh-codebuddy-plugin] bridge :${port} unavailable: ${bridgeRuntime.lastError}（插件其余功能不受影响；若占用者是另一个 dsh 实例，其桥仍会代管本实例流量）\n`)
  })
  server.on('listening', () => {
    bridgeRuntime.running = true
    bridgeRuntime.lastError = null
  })
  server.listen(port, '127.0.0.1')
  return () =>
    new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
}

// ---------------------------------------------------------------------------
// Settings route consumed by the Web UI card.
// ---------------------------------------------------------------------------

/**
 * Fetch the gateway's own model catalog (GET /v3/config). Same dialect the
 * official CLI uses: the UA must match the CLI shape (a /v2 client UA is
 * rejected with 12403) and API keys ride the x-api-key header.
 */
async function fetchModelCatalog(settings) {
  const s = settings()
  const cred = await resolveCredential(settings)
  if (!cred) throw new Error('凭据不可用：请先在登录区配置 API Key 或完成 OAuth 登录')
  const headers = {
    Accept: 'application/json',
    Authorization: cred.authorization,
    'User-Agent': USER_AGENT,
    'X-Product': 'SaaS',
  }
  // api-key mode additionally carries the raw key in x-api-key, which the
  // catalog endpoint expects; OAuth tokens work through Authorization.
  const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
  if (s.authMode !== 'oauth' && active?.key) headers['x-api-key'] = active.key
  else if (s.authMode !== 'oauth') {
    const env = resolveEnvKey(s.apiKeyEnv)
    if (env) headers['x-api-key'] = env
  }
  const res = await fetch(`${s.baseURL}/v3/config`, { headers })
  if (!res.ok) throw new Error(`模型目录 HTTP ${res.status}`)
  const body = await res.json()
  if (body?.code !== 0) throw new Error(`模型目录错误：${body?.code} ${body?.msg ?? ''}`)
  const data = body.data ?? {}
  const cliEnabled = new Set(
    (data.agents ?? []).find((a) => a.name === 'cli')?.models ?? [],
  )
  const models = (data.models ?? [])
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      maxInputTokens: m.maxInputTokens ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      images: m.supportsImages === true,
      cli: cliEnabled.has(m.id),
      reasoning: m.reasoning?.effort != null,
      // The catalog declares the model's default effort (e.g. "high"), not a
      // tier list — surface it so the card can show it on catalog-only rows.
      reasoningEffort: typeof m.reasoning?.effort === 'string' ? m.reasoning.effort : null,
    }))
  return { models, fetchedAt: Date.now() }
}

/**
 * Quota-side signals the plugin credentials can actually reach (probed
 * 2026-08-18, scripts/probe-quota.mjs): GET /v2/accounts (account metadata —
 * plan type, enterprise) and POST /v2/billing/meter/get-dosage-notify (the
 * official CLI's low-quota banner source; empty while healthy). There is NO
 * numeric remaining-quota API on the CLI/api-key surface — response headers
 * carry none, and the web console's plan API is cookie-authed. Quota is
 * account-level and shared with WorkBuddy (same Tencent-Cloud.coding-copilot
 * auth realm), so these signals already reflect WorkBuddy consumption.
 * Cached 60s; never throws.
 */
let quotaCache = { at: 0, value: null }

async function fetchQuotaSnapshot(settings) {
  const s = settings()
  const cred = await resolveCredential(settings)
  if (!cred) return { error: '凭据不可用：请先配置 API Key 或完成 OAuth 登录' }
  const headers = {
    Accept: 'application/json',
    Authorization: cred.authorization,
    ...cred.headers,
    'User-Agent': USER_AGENT,
    'X-Product': 'SaaS',
  }
  // Same dialect as fetchModelCatalog: api-key mode also carries the raw key
  // in x-api-key (the gateway authenticates these routes by it).
  const active = s.apiKeys.find((k) => k.name === s.activeApiKey)
  if (s.authMode !== 'oauth') {
    const raw = active?.key ?? resolveEnvKey(s.apiKeyEnv)
    if (raw) headers['x-api-key'] = raw
  }
  const readJsonBody = (r) => r.json().catch(() => null)
  const [accBody, dosageBody] = await Promise.all([
    fetch(`${s.baseURL}/v2/accounts`, { headers }).then(readJsonBody, () => null),
    fetch(`${s.baseURL}/v2/billing/meter/get-dosage-notify`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    }).then(readJsonBody, () => null),
  ])
  const accounts = accBody?.code === 0 ? accBody.data?.accounts ?? [] : null
  // The "current" account is the one flagged lastLogin (observed live), else first.
  const current = accounts?.find((a) => a?.lastLogin === true) ?? accounts?.[0] ?? null
  const dosage = dosageBody?.code === 0 ? dosageBody.data ?? null : null
  return {
    account: current ? {
      nickname: current.nickname ?? '',
      type: current.type ?? '',
      enterpriseName: current.enterpriseName ?? '',
      pluginEnabled: current.pluginEnabled === true,
    } : null,
    accountsError: accBody?.code === 0 ? null : `code ${accBody?.code ?? 'http'}`,
    dosage: dosage ? {
      code: dosage.dosageNotifyCode ?? 0,
      text: dosage.dosageNotifyZh || dosage.dosageNotifyEn || '',
      skipUrl: dosage.skipUrl ?? '',
    } : null,
    dosageError: dosageBody?.code === 0 ? null : `code ${dosageBody?.code ?? 'http'}`,
    fetchedAt: Date.now(),
  }
}

function quotaSnapshot(settings) {
  if (quotaCache.value && Date.now() - quotaCache.at < 60_000) {
    return Promise.resolve(quotaCache.value)
  }
  return fetchQuotaSnapshot(settings)
    .catch((err) => ({ error: err?.message ?? String(err) }))
    .then((value) => {
      quotaCache = { at: Date.now(), value }
      return value
    })
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Only same-origin writes: POST mutates settings or credentials. */
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Mask a key for display: first 4 and last 4 characters. */
function maskKey(key) {
  if (typeof key !== 'string' || key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** The GET view: resolved settings with secrets masked, plus OAuth status. */
function settingsView(resolveNow) {
  const s = resolveNow()
  const user = readFileLayer()
  const state = readModelState()
  return {
    value: {
      ...s,
      apiKeys: (s.apiKeys ?? []).map((k) => ({ name: k.name, masked: maskKey(k.key) })),
    },
    user,
    fields: SETTINGS_FIELDS,
    oauth: oauthStatus(),
    bridge: {
      running: bridgeRuntime.running,
      port: bridgeRuntime.port,
      lastError: bridgeRuntime.lastError,
    },
    models: {
      staticIds: readStaticModels().map((m) => m.id),
      disabled: Object.keys(state.disabled),
      extraIds: Object.keys(state.extra),
      effectiveCount: computeEffectiveModels().length,
    },
  }
}

/**
 * Route contract:
 *   GET                                                    → settingsView
 *   POST {patch: {...}}                                     → merge & apply
 *   POST {action:'oauth-start'}                             → {authUrl}
 *   POST {action:'oauth-status'}                            → oauthStatus()
 *   POST {action:'oauth-logout'}                            → clears tokens
 *   POST {action:'model-list'}                              → gateway catalog
 *   POST {action:'usage'}                                   → usage meter + bridge state + quota snapshot
 */
function registerSettingsRoute(ctx, entryConfig, resolveNow, applyLive) {
  ctx.inject(['webServer'], (wsctx) => {
    wsctx.webServer.register({
      kind: 'exact',
      path: '/dsh-codebuddy-plugin/settings',
      handler: (request, response) => {
        if (request.method === 'GET') {
          sendJSON(response, 200, settingsView(resolveNow))
          return
        }
        if (request.method !== 'POST' || !sameOrigin(request)) {
          sendJSON(response, request.method === 'POST' ? 403 : 405, { ok: false })
          return
        }
        let raw = ''
        request.on('data', (c) => {
          raw += c
        })
        request.on('end', () => {
          try {
            const body = JSON.parse(raw)
            if (body?.action === 'oauth-start') {
              startOAuth(resolveNow().baseURL)
                .then((r) => sendJSON(response, 200, { ok: true, authUrl: r.authUrl }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'oauth-status') {
              sendJSON(response, 200, { ok: true, oauth: oauthStatus() })
              return
            }
            if (body?.action === 'model-list') {
              fetchModelCatalog(resolveNow)
                .then((catalog) => sendJSON(response, 200, {
                  ok: true,
                  catalog,
                  staticIds: readStaticModels().map((m) => m.id),
                  // id → reasoning tier keys from cordis.patch.yml (e.g.
                  // ["off","low","medium","high","max"]); the card renders
                  // these on static rows.
                  staticEfforts: Object.fromEntries(
                    readStaticModels()
                      .filter((m) => m.reasoningEfforts && typeof m.reasoningEfforts === 'object')
                      .map((m) => [m.id, Object.keys(m.reasoningEfforts)]),
                  ),
                  state: readModelState(),
                }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            if (body?.action === 'oauth-logout') {
              writeAuth({})
              oauthPending.active = false
              oauthPending.error = ''
              sendJSON(response, 200, { ok: true, oauth: oauthStatus() })
              return
            }
            if (body?.action === 'usage') {
              quotaSnapshot(resolveNow)
                .then((quota) => sendJSON(response, 200, {
                  ok: true,
                  usage: buildUsageView(),
                  bridge: {
                    enabled: resolveNow().bridgeEnabled === true,
                    running: bridgeRuntime.running,
                    port: bridgeRuntime.port,
                    lastError: bridgeRuntime.lastError,
                  },
                  quota,
                }))
                .catch((err) => sendJSON(response, 502, { ok: false, error: err.message }))
              return
            }
            const patch = body?.patch
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              throw new Error('body must be {patch} or {action}')
            }
            const nextUser = { ...readFileLayer() }
            // Key-list operations run against the stored raw list — the card
            // only ever sees masked keys, so adds/removes must resolve here.
            if (patch.apiKeysAdd !== undefined) {
              const entry = patch.apiKeysAdd
              if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string'
                || typeof entry.key !== 'string' || !entry.name.trim() || !entry.key.trim()) {
                throw new Error('apiKeysAdd 需要 {name, key}')
              }
              const name = entry.name.trim()
              const key = entry.key.trim()
              const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
              nextUser.apiKeys = list.filter((k) => k?.name !== name).concat([{ name, key }])
              if (!nextUser.activeApiKey) nextUser.activeApiKey = name
            }
            if (patch.apiKeysRemove !== undefined) {
              if (typeof patch.apiKeysRemove !== 'string') throw new Error('apiKeysRemove 需要名称字符串')
              const list = Array.isArray(nextUser.apiKeys) ? nextUser.apiKeys : []
              nextUser.apiKeys = list.filter((k) => k?.name !== patch.apiKeysRemove)
              if (nextUser.activeApiKey === patch.apiKeysRemove) delete nextUser.activeApiKey
            }
            if (patch.modelSetEnabled !== undefined) {
              // Runs against modelState inside setModelEnabled; re-read the
              // layer afterwards so apiKeys edits above are not clobbered.
              const withKeys = { ...nextUser }
              setModelEnabled(patch.modelSetEnabled)
              const after = readFileLayer()
              delete withKeys.modelState
              Object.assign(after, { apiKeys: withKeys.apiKeys, activeApiKey: withKeys.activeApiKey })
              writeFileLayer(after)
              sendJSON(response, 200, {
                ok: true,
                value: settingsView(resolveNow).value,
                user: after,
                models: settingsView(resolveNow).models,
              })
              applyLive()
              return
            }
            for (const [key, value] of Object.entries(patch)) {
              if (key === 'apiKeysAdd' || key === 'apiKeysRemove') continue
              // Whitelist by SETTINGS_FIELDS, not Config({}) keys: fields
              // without a schema default (activeApiKey) vanish from a bare
              // Config({}) resolution and were silently dropped here.
              if (!SETTINGS_FIELDS.some((f) => f.key === key)) continue
              if (value === null) delete nextUser[key]
              else nextUser[key] = value
            }
            // Validate through the schema before persisting.
            validateBaseURL(Config({ ...entryConfig, ...nextUser }).baseURL)
            const resolved = Config({ ...entryConfig, ...nextUser })
            if (resolved.activeApiKey && !resolved.apiKeys.some((k) => k.name === resolved.activeApiKey)) {
              throw new Error('activeApiKey 不在 apiKeys 列表中')
            }
            writeFileLayer(nextUser)
            applyLive()
            sendJSON(response, 200, { ok: true, value: settingsView(resolveNow).value, user: nextUser })
          } catch (err) {
            sendJSON(response, 400, { ok: false, error: err.message })
          }
        })
      },
    })
  })
}

export function apply(ctx, config = {}) {
  // entry < file; schema defaults fill the rest. Live-resolved per read.
  const resolveNow = () => Config({ ...config, ...readFileLayer() })

  // Web providers ride the searchEnabled switch: disposing unregisters from
  // ctx.web, re-enabling registers fresh instances. While disabled the
  // seam's pinned id (patch: web.searchProvider=codebuddy) reports
  // CONFIGURED_MISSING — intended: the switch means "this feature is off".
  let disposeSearch = null
  let disposeFetch = null
  const syncProviders = () => {
    const enabled = resolveNow().searchEnabled === true
    if (!enabled) {
      if (disposeSearch) { disposeSearch(); disposeSearch = null }
      if (disposeFetch) { disposeFetch(); disposeFetch = null }
      return
    }
    if (disposeSearch && disposeFetch) return
    disposeSearch = ctx.web.registerSearchProvider(makeSearchProvider(resolveNow))
    disposeFetch = ctx.web.registerFetchProvider(makeFetchProvider(resolveNow))
  }

  // Image generation tool on the tools seam: registered while
  // imageGenEnabled, disposed when switched off. `tools` resolves lazily via
  // ctx.inject (same pattern as the webServer route) so the plugin still
  // loads in compositions without the tools service.
  let toolsCtx = null
  let disposeImageTool = null
  const syncImageTool = () => {
    if (!toolsCtx) return
    const enabled = resolveNow().imageGenEnabled === true
    if (!enabled) {
      if (disposeImageTool) { disposeImageTool(); disposeImageTool = null }
      return
    }
    if (disposeImageTool) return
    try {
      disposeImageTool = toolsCtx.tools.register(makeImageGenTool(resolveNow))
      process.stderr.write('[dsh-codebuddy-plugin] image_generate tool registered\n')
    } catch (err) {
      disposeImageTool = null
      process.stderr.write(`[dsh-codebuddy-plugin] image_generate register failed: ${err?.message ?? err}\n`)
    }
  }
  ctx.inject(['tools'], (tctx) => { toolsCtx = tctx; syncImageTool() })

  // Settings namespace claim for Settings → 插件配置: dsh ≥ 0.1.0-rc.7
  // dispatches `settings.plugin.item` cards keyed by a namespace the Host
  // serves (api-proxy `settings.describe`, allowlist removed in rc.7), so the
  // browser-half card (registered under the same key) only renders when this
  // registration lands. Reads/writes still go through our own webServer route
  // + file layer — the seam is only the dispatch claim. Lazy inject:
  // compositions without the settings service skip it (rc.6 dispatched cards
  // unconditionally, so the card still renders there). Registration is an
  // effect on this fiber — plugin dispose unregisters the namespace.
  ctx.inject(['settings'], (sctx) => {
    try {
      sctx.settings.register('dsh-codebuddy-plugin', Config)
    } catch (err) {
      process.stderr.write(`[dsh-codebuddy-plugin] settings namespace register failed: ${err?.message ?? err}\n`)
    }
  })

  // Bridge lifecycle: running state keyed by the port it listens on.
  // bridgeRuntime mirrors reality for the settings view (listen is async —
  // `running` flips on the server's 'listening' event, failures land in
  // lastError via its 'error' event instead of crashing the process).
  let stopBridge = null
  let runningPort = null
  const syncBridge = () => {
    const s = resolveNow()
    if (s.bridgeEnabled !== true) {
      if (stopBridge) {
        stopBridge()
        stopBridge = null
        runningPort = null
      }
      bridgeRuntime.running = false
      bridgeRuntime.port = null
      bridgeRuntime.lastError = null
      return
    }
    if (stopBridge && runningPort === s.bridgePort) return
    if (stopBridge) stopBridge()
    runningPort = s.bridgePort
    bridgeRuntime.running = false
    bridgeRuntime.port = s.bridgePort
    bridgeRuntime.lastError = null
    stopBridge = startBridge(resolveNow, runningPort)
  }
  const applyLive = () => {
    syncProviders()
    syncImageTool()
    syncBridge()
  }

  applyLive()
  registerSettingsRoute(ctx, config, resolveNow, applyLive)
  // Keep the settings.yaml model mirror in step with modelState across
  // restarts (no-op when the feature was never used).
  const state = readModelState()
  if (Object.keys(state.disabled).length > 0 || Object.keys(state.extra).length > 0) {
    syncModelsToDshSettings()
  }
  ctx.on('dispose', () => {
    if (stopBridge) stopBridge()
    if (disposeSearch) disposeSearch()
    if (disposeFetch) disposeFetch()
    if (disposeImageTool) disposeImageTool()
    if (usageFlushTimer) {
      clearTimeout(usageFlushTimer)
      usageFlushTimer = null
    }
    flushUsage()
  })
}
