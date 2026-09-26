/**
 * providers/qoder/index.js — Qoder CN（qoder.cn）薄适配器工厂。
 *
 * 与 providers/trae/ 同构：本目录收敛全部 Qoder 上游事实——
 *   oauth.js    设备流（PKCE S256，poll 404=未完成，refresh drt- 前缀）
 *   cosy.js     COSY WASM 签名运行时（手写胶水 + 官方 wasm 字节）
 *   catalog.js  /algo/api/v2/model/list 目录（签名 GET，明文/密文两态）
 *   gateway.js  OpenAI ↔ COSY SSE 翻译网关（:3903 默认）
 *
 * 规则/证据文档：docs/goals/qoder-cn-provider-design.md（2026-09-20 修订：
 * 聊天面 = prepareInferRequest → agent_chat_generation，OpenAI 面
 * api2-v2.qoder.sh 对本账号 401 不可用，不要再走）。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createQoderOAuth } from './oauth.js'
import { createCosyRuntime } from './cosy.js'
import { fetchQoderCatalog } from './catalog.js'
import { createQoderGateway } from './gateway.js'
import { createQoderQuota } from './quota.js'

export const QODER_PROVIDER_ID = 'qoder'

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'qoder_auth.wasm')

/**
 * @param {{
 *   readAuth: () => object,
 *   writeAuth: (v: object) => void,
 *   settings: () => object,
 *   meter: { record: Function },
 *   runtime: { running: boolean, port: number|null, lastError: string|null },
 *   forensics?: { logPath: () => string|undefined },
 *   getModelPrefs?: () => object,  // { [id]: { effort?, contextVariant? } } 出站补默认
 * }} deps
 */
export function createQoderProvider(deps) {
  const oauth = createQoderOAuth({ readAuth: deps.readAuth, writeAuth: deps.writeAuth })
  const cosy = createCosyRuntime({ wasmPath: WASM_PATH })

  // 目录实例状态（模块作用域每插件实例一份，踩坑 #20 纪律）。
  let catalogState = null // { profiles, sources, variants, fetchedAt }

  const provider = {
    id: QODER_PROVIDER_ID,
    oauth,
    cosy,

    /**
     * 从网关同步目录（单飞在调用侧不强制——syncCatalog 幂等可重入）。
     * 返回 {ok, count|error, kept}；未登录时报 ok:false 且不清旧目录。
     */
    async syncCatalog() {
      const s = deps.settings()
      let cred
      try {
        cred = await oauth.resolveQoderCredential(s)
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err), kept: catalogState != null }
      }
      if (!cred) return { ok: false, error: '未登录（先完成 Qoder 浏览器授权）', kept: catalogState != null }
      try {
        const accessToken = String(cred.authorization).replace(/^Bearer\s+/, '')
        const result = await fetchQoderCatalog(cosy, { accessToken, machineId: cred.machineId, uid: cred.uid }, s.qoderInferBaseURL)
        catalogState = { profiles: result.profiles, sources: result.sources, variants: result.variants, entries: result.entries, fetchedAt: Date.now() }
        return { ok: true, count: result.profiles.length, fetchedAt: catalogState.fetchedAt }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err), kept: catalogState != null }
      }
    },

    catalogView() {
      return catalogState
        ? { at: catalogState.fetchedAt, count: catalogState.profiles.length, profiles: catalogState.profiles, variants: catalogState.variants }
        : null
    },

    /** 凭据视图（设置卡）。 */
    credentialView() {
      return oauth.oauthStatus()
    },

    /** 账户配额只读快照（60s memoize，永不 throw）。 */
    quota: createQoderQuota({ settings: deps.settings, oauth }),
  }

  const gateway = createQoderGateway({
    settings: deps.settings,
    resolveCredential: (s) => oauth.resolveQoderCredential(s),
    cosy,
    meter: deps.meter,
    runtime: deps.runtime,
    forensics: deps.forensics,
    getCatalogProfiles: () => catalogState?.profiles ?? null,
    getCatalogEntry: (id) => catalogState?.entries?.[id] ?? null,
    getModelSource: (id) => catalogState?.sources?.[id] ?? 'system',
    getModelPrefs: deps.getModelPrefs ?? (() => ({})),
  })
  provider.gateway = gateway

  return provider
}
