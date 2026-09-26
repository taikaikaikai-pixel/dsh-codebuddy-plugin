/**
 * providers/qoder/quota.js — Qoder CN 账户配额只读快照（设置卡用）。
 *
 * 端点：GET {qoderOpenapiBaseURL}/api/v2/quota/usage，裸 Bearer（openapi 明文面，
 * 不走 COSY 签名——签名是 infer 面与 /algo 目录面的事）。响应形态实测见
 * scripts/probe-qoder-quota.mjs 落盘（docs/probes/qoder-quota-*.json）：
 *   { userQuota:{total,used,remaining,percentage,unit},
 *     addOnQuota:{total,used,remaining,percentage,unit,detailUrl}, … }
 * addOnQuota.used 是实时配额计数器（配额扣减即时入账，臂 9 定论）。
 * 成本纪律：60s memoize（与 codebuddy quotaSnapshot 同口径）；永不 throw——
 * 失败回 { error }，调用方（设置卡）据此显示「—」，绝不编造数值。
 */

export function createQoderQuota({ settings, oauth }) {
  let cache = { at: 0, value: null }

  async function fetchSnapshot() {
    const s = settings()
    const cred = await oauth.resolveQoderCredential(s)
    if (!cred) return { error: '未登录', fetchedAt: Date.now() }
    const res = await fetch(`${s.qoderOpenapiBaseURL}/api/v2/quota/usage`, {
      headers: { Authorization: cred.authorization, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || typeof body !== 'object') {
      return { error: `http ${res.status}`, fetchedAt: Date.now() }
    }
    const pick = (q) => (q && typeof q === 'object')
      ? {
          total: typeof q.total === 'number' ? q.total : null,
          used: typeof q.used === 'number' ? q.used : null,
          remaining: typeof q.remaining === 'number' ? q.remaining : null,
          unit: typeof q.unit === 'string' ? q.unit : null,
        }
      : null
    return {
      userQuota: pick(body.userQuota),
      addOnQuota: pick(body.addOnQuota),
      isQuotaExceeded: body.isQuotaExceeded === true,
      fetchedAt: Date.now(),
    }
  }

  function snapshot() {
    if (cache.value && Date.now() - cache.at < 60_000) return Promise.resolve(cache.value)
    return fetchSnapshot()
      .catch((err) => ({ error: err?.message ?? String(err), fetchedAt: Date.now() }))
      .then((value) => {
        cache = { at: Date.now(), value }
        return value
      })
  }

  return { snapshot }
}
