/**
 * providers/codebuddy/oauth.js — CodeBuddy 浏览器 OAuth 设备流。
 *
 * 流程（与官方 CLI 对齐；规则化结论见 docs/rules/oauth-handshake.md，
 * 证据 docs/probes/oauth-2026-08-19.jsonl，15 条）：
 *   POST /v2/plugin/auth/state?platform=CLI  → {state, authUrl}   （创建无认证；
 *        X-No-* 三头实测是迷信——P-O3：不携带也 200；platform 必填但任意值皆可）
 *   GET  /v2/plugin/auth/token?state=…       → 11217 pending，0 → tokens
 *        （核心否定发现：pending/bogus/过期一律 11217，三态不可区分，state TTL 不可观测）
 *   GET  /v2/plugin/login/account?state=…    → {uid, nickname, …}
 *   POST /v2/plugin/auth/token/refresh       → 刷新（bogus refresh → 401+12153）
 *
 * 实例状态（refresh 单飞锁、pending 视图）在本工厂闭包内——组合根每个插件
 * 模块实例创建一个 provider 实例，隔离语义与重构前模块全局一致。
 */

const AUTH_PENDING_CODE = 11217 // ERROR_CODES[11217]：三态同码，勿当"未完成"以外含义用
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_POLL_INTERVAL_MS = 1000

/**
 * @param {{ readAuth: () => object, writeAuth: (v: object) => void }} deps
 *   令牌存储 IO（组合根绑定到 ~/.dsh/codebuddy-plugin-auth.json；令牌永不
 *   回传浏览器——oauthStatus() 只出视图字段）。
 */
export function createOAuth({ readAuth, writeAuth }) {
  let refreshInFlight = null
  const oauthPending = { active: false, authUrl: '', error: '' }

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

  /** OAuth credential branch, shared by every outbound flavor. */
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

  async function startOAuth(baseURL) {
    if (oauthPending.active) return { started: true, authUrl: oauthPending.authUrl }
    const res = await fetch(`${baseURL}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        // X-No-* 三头：实测迷信（oauth-handshake.md P-O3，不携带也 200），
        // 为零行为变更保留，不作为能力依赖。
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

  function logout() {
    writeAuth({})
    oauthPending.active = false
    oauthPending.error = ''
  }

  return { resolveOAuthCredential, startOAuth, oauthStatus, logout }
}
