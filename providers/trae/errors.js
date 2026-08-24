/**
 * providers/trae/errors.js — Trae 云端错误码表。
 *
 * 语义参照表，不是触发逻辑。每条以探测证据为准（2026-08-23 无凭据实测 +
 * docs/rules/trae-surface.md §2.2）：
 *   - 聊天网关（trae-api-cn.mchost.guru/api/agent/v3/*）未认证 → 401 + {code:1001}
 *   - ExchangeToken（api.trae.cn，火山系 ResponseMetadata.Error 信封）：
 *     假 ClientID → 400 code 10101 "Invalid client."；
 *     真 ClientID + 假 AuthCode → 400 code 10101 "无效参数：{__Message.field}."
 *   - cloudide 面（api.trae.cn/cloudide/…）未登录 → 401 code 20310
 */

export const TRAE_ERROR_CODES = {
  /** 聊天网关统一未认证码（mchost /api/agent/v3/*）。 */
  1001: 'chat gateway authentication failed',
  /** remote 会话（/api/remote/v1/*）：套餐/权益不足——message 为空、data.plan 携带
   *  所需档位（2026-08-24 实测：Free 账号请求 kimi-k3 命中，glm-5.3 可正常服务）。 */
  1005: 'remote session entitlement/plan gate',
  /** OAuth/ExchangeToken 面：client 或参数无效（ResponseMetadata 信封）。 */
  10101: 'oauth exchange invalid client/params',
  /** cloudide 面：未登录（GetUserInfo 等带 x-cloudide-token 的端点）。 */
  20310: 'cloudide not logged in',
}

/**
 * 把云端错误响应规范化为 { status, code, message }（信封两种：mchost 的
 * {code,message} 与火山系 ResponseMetadata.Error）。非 JSON/空体容忍为
 * "unknown"——网关层崩溃时出现过裸 500（codebuddy images 家族同款教训）。
 * message 为空时按码表回填语义（remote error 事件实测 message:"" + data.plan）。
 */
export function normalizeTraeError(status, body) {
  const withFallback = (code, message) => ({
    status,
    code: code ?? null,
    message: message || (code != null && TRAE_ERROR_CODES[code] ? TRAE_ERROR_CODES[code] : message ?? ''),
  })
  if (body && typeof body === 'object') {
    const volc = body.ResponseMetadata?.Error
    if (volc) return withFallback(volc.Code, volc.Message ?? '')
    if (body.code != null || body.message != null) {
      return withFallback(body.code ?? null, body.message ?? '')
    }
  }
  return { status, code: null, message: typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${status}` }
}

/** 凭据不可用（组合根候选为空时匹配的稳定文案）。 */
export const TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE = 'Trae 凭据不可用（先在插件配置卡的 TraeWork CN 分区登录）'
