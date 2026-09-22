/**
 * host-config.js — dsh 宿主配置层的读写通道（按宿主能力选路）。
 *
 * 为什么需要这一层（dsh 0.1.7-alpha.2 实测，2026-09-23）：
 * 上游把「用户配置文档」整体换成了「profile 的 volatile 配置表单」——
 *   - `@deepseek-ai/dsh-settings-file` 被删除（npm 上 0.1.7-alpha.2 已 404），
 *     `settings` 服务改由 `@deepseek-ai/dsh-settings` 提供；
 *   - `~/.dsh/settings.yaml` 降级为 legacy：Loader 稳定后**一次性导入** profile
 *     patch，随即改名 `settings.yaml.imported`（实测真实 web profile 下
 *     `llm-pi-ai` 段导入成功，profile patch 1.6KB → 12KB）；
 *   - `ctx.settings.register(ns, schema)` **已不存在**（调用即 TypeError），
 *     取而代之的是 `configure({auto}, fiber)`（页面策略）+
 *     `describe/update/replace/mutate(ns=profile entry id, …, expectedRevision)`；
 *   - 写入由 `dsh-config-editor` 落到 profile 的 `cordis.patch.yml`，立即生效；
 *   - 只有 `.volatile()` 字段可表单编辑——`llm-pi-ai` 的 `providers` 在 0.1.7
 *     正是 volatile，所以本插件的模型镜像/路由存在性管理能平移过去。
 *
 * 本模块把两代宿主的差异收在一处：上层只产出 ops（set/unset 一条路径），
 * 由这里决定走新 seam 还是旧的 settings.yaml 文档编辑。写入**永不 reject**
 * （踩坑 #33：fire-and-forget 必须落地）——失败记在 lastError 并回传结果对象。
 */

import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { writeTextAtomic } from './core/json-store.js'

/** llm-pi-ai 在 profile 里的 entry id（也是新 seam 的命名空间）。 */
const NS = 'llm-pi-ai'

/** 按路径取值；任一段缺失返回 undefined（用于"该路径当前有没有东西"的判定）。 */
function getPath(root, path) {
  let cur = root
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 稳定序列化：键排序后 JSON，用于同值比对（避免每次重铺都判为"变了"）。 */
function stable(value) {
  try {
    return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o }, {})
      : v)) ?? 'null'
  } catch {
    return String(value)
  }
}

export function createHostConfigLayer({ settingsPath, schema, legacyNamespace = 'dsh-tap', log = () => {} }) {
  let settingsCtx = null
  let service = null
  let fiber = null
  let disposeConfigure = null
  let revision = null
  let lastError = null
  let attachError = null

  /**
   * 活取 settings 服务。宿主每次写入都会重载 profile patch，Settings 服务实例
   * **可能被替换**（上游 README：a late-loading or replaced Settings service
   * picks the policy up）——缓存的实例引用会带着陈旧 revision，写必撞
   * SETTINGS_CONFLICT 且重试无效（实测：expected revision 5, now 6，三次全败）。
   * cordis 的 ctx.<service> 是实时 getter，故一律经子上下文现取。
   */
  function svc() {
    const live = settingsCtx ? settingsCtx.settings : null
    return live ?? service
  }

  /** 旧宿主路径：注释保留的 settings.yaml 文档编辑。 */
  function legacyDoc() {
    try {
      return YAML.parseDocument(readFileSync(settingsPath, 'utf8'))
    } catch {
      return new YAML.Document()
    }
  }

  function legacyApply(ops) {
    const doc = legacyDoc()
    let changed = false
    for (const op of ops) {
      const path = [NS, ...op.path]
      if (op.op === 'unset') {
        if (doc.getIn(path)) { doc.deleteIn(path); changed = true }
      } else {
        const next = YAML.parse(YAML.stringify(op.value ?? null))
        if (YAML.stringify(doc.getIn(path) ?? null) !== YAML.stringify(next)) {
          doc.setIn(path, next)
          changed = true
        }
      }
    }
    if (changed) writeTextAtomic(settingsPath, String(doc))
    return { ok: true, mode: 'legacy', changed }
  }

  /** 新宿主路径：Settings forms seam（写落 profile patch，立即生效）。 */
  function formsAvailable() {
    const s = svc()
    return !!s && typeof s.mutate === 'function'
  }

  function describeEntry() {
    const s = svc()
    if (!s || typeof s.describe !== 'function') return null
    try {
      const list = s.describe() ?? []
      const hit = list.find((d) => d && d.ns === NS) ?? null
      if (hit) revision = hit.revision
      return hit
    } catch (err) {
      attachError = `describe failed: ${err?.message ?? err}`
      return null
    }
  }

  async function formsApply(ops) {
    const s0 = svc()
    if (s0 && s0.writable === false) {
      return { ok: false, mode: 'forms', error: 'SETTINGS_NOT_WRITABLE（当前 profile 不接受表单写入）' }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      // 每轮都重新活取服务 + 重读 revision：宿主可能在我们两次调用之间
      // 重载 profile 并替换 Settings 实例（见 svc() 注释）。
      const s = svc()
      if (!s || typeof s.mutate !== 'function') {
        return { ok: false, mode: 'forms', error: 'SETTINGS_SERVICE_GONE（宿主重载后 settings 服务不可用）' }
      }
      const entry = describeEntry()
      const expected = entry?.revision ?? revision ?? undefined
      // 写前比对：同值不写。重复写会白涨 revision 并触发一次 profile 重载，
      // 目录轮询/启动重铺这类高频路径上会抖成 reload 风暴。
      const pending = ops.filter((op) => {
        const cur = getPath(entry?.value, op.path)
        if (op.op === 'unset') return cur !== undefined
        return stable(cur) !== stable(op.value ?? null)
      })
      if (pending.length === 0) return { ok: true, mode: 'forms', changed: false, revision: entry?.revision ?? null }
      try {
        await s.mutate(NS, pending, expected)
        const after = describeEntry()
        return { ok: true, mode: 'forms', changed: true, revision: after?.revision ?? null }
      } catch (err) {
        const code = err?.code
        if (code === 'SETTINGS_CONFLICT' && attempt < 3) continue // revision 过期 → 重取服务重读重试
        return { ok: false, mode: 'forms', error: `${code ?? 'ERR'}: ${err?.message ?? err}` }
      }
    }
    return { ok: false, mode: 'forms', error: 'SETTINGS_CONFLICT: 四次重试仍未拿到最新 revision' }
  }

  return {
    /**
     * 挂到宿主：注入 settings 服务，并按能力声明页面策略。
     * 0.1.7+：configure({auto:false}) —— 本插件自带设置卡，不要让宿主按
     *          Config schema 自动生成一个页面（pi-ai 自己也这么做）。
     * ≤0.1.6：register(ns, schema) —— 旧 `settings.plugin.item` 卡片派发靠这个
     *          命名空间声明（宿主 api-proxy `settings.describe` 出清单）。
     */
    attach(ctx) {
      ctx.inject(['settings'], (sctx) => {
        settingsCtx = sctx ?? null
        service = sctx?.settings ?? null
        fiber = ctx.fiber ?? null
        const s = svc()
        if (!s) { attachError = 'settings service unavailable'; return }
        if (typeof s.configure === 'function') {
          try {
            disposeConfigure = s.configure({ auto: false }, fiber) ?? null
          } catch (err) {
            attachError = `configure failed: ${err?.message ?? err}`
            log(`[dsh-tap] settings configure(auto:false) failed: ${err?.message ?? err}`)
          }
        } else if (typeof s.register === 'function' && schema) {
          try {
            s.register(legacyNamespace, schema)
          } catch (err) {
            attachError = `register failed: ${err?.message ?? err}`
            log(`[dsh-tap] settings namespace register failed: ${err?.message ?? err}`)
          }
        } else {
          attachError = 'settings service exposes neither configure() nor register()'
        }
      })
    },

    dispose() {
      if (disposeConfigure) { try { disposeConfigure() } catch {} disposeConfigure = null }
      settingsCtx = null
      service = null
    },

    /** 当前选路：'forms'（dsh 0.1.7+）/ 'legacy'（≤0.1.6 或无 settings 服务）。 */
    mode() {
      return formsAvailable() ? 'forms' : 'legacy'
    },

    /** 宿主 settings 服务是否挂上（与 mode 分开报：无服务时仍走 legacy 文件层）。 */
    servicePresent() {
      return !!svc()
    },

    get lastError() { return lastError },
    get attachError() { return attachError },

    /** 诊断：新 seam 到底给了什么（升级排查用，经设置路由 ?probe=host-config 暴露）。 */
    probe() {
      const s = svc()
      const entry = describeEntry()
      const api = s ? Object.getOwnPropertyNames(Object.getPrototypeOf(s)) : []
      return {
        mode: this.mode(),
        servicePresent: !!s,
        formsWritable: formsAvailable(),
        api: api.filter((n) => !n.startsWith('_') && n !== 'constructor'),
        writable: s?.writable ?? null,
        documentPath: (() => { try { return s?.documentPath ?? null } catch { return null } })(),
        entryFound: !!entry,
        entryNs: entry?.ns ?? null,
        entryRevision: entry?.revision ?? null,
        autoGenerate: entry?.autoGenerate ?? null,
        applies: entry?.applies ?? null,
        valueKeys: entry && entry.value && typeof entry.value === 'object' ? Object.keys(entry.value) : null,
        providerIds: entry?.value?.providers && typeof entry.value.providers === 'object'
          ? Object.keys(entry.value.providers)
          : null,
        schemaKeys: entry?.schema && typeof entry.schema === 'object' ? Object.keys(entry.schema).slice(0, 12) : null,
        describeCount: (() => { try { return (s?.describe?.() ?? []).length } catch { return null } })(),
        allNamespaces: (() => {
          try { return (s?.describe?.() ?? []).map((d) => d?.ns).filter(Boolean) } catch { return null }
        })(),
        attachError,
        lastError,
        legacySettingsPath: settingsPath,
        legacyExists: (() => { try { readFileSync(settingsPath, 'utf8'); return true } catch { return false } })(),
      }
    },

    /**
     * 有效 providers 视图（对账/去重判定用）。
     * forms：读 describe 的 live value（含 patch 层与 profile 覆盖的合成结果）；
     * legacy：解析 settings.yaml 的 llm-pi-ai.providers。
     */
    readProviders() {
      if (formsAvailable()) {
        const entry = describeEntry()
        const p = entry?.value?.providers
        if (p && typeof p === 'object') return p
        return {}
      }
      try {
        return YAML.parse(readFileSync(settingsPath, 'utf8'))?.[NS]?.providers ?? {}
      } catch {
        return {}
      }
    },

    /**
     * 应用一组 ops（path 相对 llm-pi-ai 配置根，例如 ['providers','trae']）。
     * 永不 reject：失败落 lastError 并在结果对象里带 error。
     */
    async applyOps(ops) {
      if (!Array.isArray(ops) || ops.length === 0) return { ok: true, mode: this.mode(), changed: false }
      let res
      try {
        res = formsAvailable() ? await formsApply(ops) : legacyApply(ops)
      } catch (err) {
        res = { ok: false, mode: this.mode(), error: `${err?.message ?? err}` }
      }
      if (!res.ok) {
        lastError = res.error
        log(`[dsh-tap] host config write failed (${res.mode}): ${res.error}`)
      } else if (lastError) {
        lastError = null
      }
      return res
    },
  }
}
