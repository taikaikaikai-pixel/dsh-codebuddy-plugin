#!/usr/bin/env node
/**
 * probe-codebuddy-efforts.mjs — CodeBuddy 通道「模型思考强度」现状探测。
 *
 * 目的：cordis.patch.yml 的 `reasoningEfforts` 档位表是静态清单的一部分
 * （网关 /v3/config 只给**默认档位**不给档位清单），所以要更新档位表只能实测。
 * 本脚本一次跑完两件事：
 *
 *   1) catalog 面：GET /v3/config，逐模型打印网关自述的 reasoning 声明
 *      （`reasoning.effort` 默认档 + 是否有该键），作为"档位表该不该有"的
 *      第一手依据。
 *   2) chat 面：对每个目标模型逐档发一次流式请求（omit/off/low/medium/high/max），
 *      记录 HTTP 结果、reasoning_content 字符数、content 字符数、finish_reason、
 *      响应回显 model 与 usage。判据：
 *        - 某档 HTTP 报错 / 带内错误帧 → 该档**网关不接受**（档位表不应含它）；
 *        - omit（不传参）就有 reasoning_content → 模型"无参也会想"，
 *          档位表不该给 `off`；
 *        - omit 无 reasoning_content 而 off 也无 → `off` = 省略参数语义成立；
 *        - 各档长度**非单调**属正常（推理长度自适应，见 patch 头注释）。
 *
 * 证据落盘：docs/probes/codebuddy-efforts-<YYYY-MM-DD>.json（预注册 expect 一并写入）。
 *
 * 用法：
 *   node scripts/probe-codebuddy-efforts.mjs --catalog         # 只打目录面（快）
 *   node scripts/probe-codebuddy-efforts.mjs                   # 目录 + 全档矩阵
 *   node scripts/probe-codebuddy-efforts.mjs --models glm-5.3,kimi-k2.8-preview
 *   node scripts/probe-codebuddy-efforts.mjs --levels omit,off,high
 *   node scripts/probe-codebuddy-efforts.mjs --interval 800    # 每发间隔 ms（默认 600）
 *
 * 凭据：CODEBUDDY_API_KEY（env）或 ~/.dsh/.credentials.yaml（与插件同解析顺序）。
 * 红线：单账号、只读优先、发问间隔 ≥600ms（STATE.md「探测纪律」）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = 'https://copilot.tencent.com'
const PATCH_FILE = join(ROOT, 'cordis.patch.yml')

// 目录面方言（catalog.js / verify-models 同款）：CLI 形态 UA + x-api-key。
const CATALOG_HEADERS = (key) => ({
  accept: 'application/json',
  'x-api-key': key,
  'user-agent': 'CLI/unknown CodeBuddy/2.136.0',
  'x-product': 'SaaS',
})

// 聊天面方言：与 cordis.patch.yml 的 codebuddy provider 头一致（不含 Authorization，
// 由 probe 逐请求拼 ck_ key）。
const CHAT_HEADERS = {
  'User-Agent': 'CodeBuddyCode/1.0',
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-IDE-Version': '2.133.1',
  'X-Product-Version': '2.133.1',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Private-Data': 'false',
  'Content-Type': 'application/json',
}

/**
 * 档位 → 线值；omit = 不传 reasoning_effort（基线段）；off = 插件现行语义
 * （off 的线值是 null ⇒ 省略参数）。offwire/alias 臂用来判定"目录声明
 * canDisableThinking 的模型到底该发什么线值才能真的关思考"。
 */
const LEVEL_WIRE = {
  omit: undefined,
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  // 别名/关闭思考候选拼写（判定用，不是候选档位表的默认成员）
  offwire: 'off',
  none: 'none',
  minimal: 'minimal',
  disabled: 'disabled',
  auto: 'auto',
  xhigh: 'xhigh',
}

const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const CATALOG_ONLY = argv.includes('--catalog')
const INTERVAL = Number(argValue('--interval') ?? 600)
const REPEAT = Math.max(1, Number(argValue('--repeat') ?? 1))
const SUMMARY = argValue('--summarize')
const OUT = argValue('--out') ?? join(ROOT, 'docs', 'probes', `codebuddy-efforts-${new Date().toISOString().slice(0, 10)}.json`)

/** 预注册预期（跑前写死，跑后逐条判定命中/推翻）。 */
const EXPECT = {
  P1: '无参（omit）就产 reasoning_content 的模型：kimi-k2.7/k3/k3-1/minimax-m2.7 —— 这四家档位表不含 off',
  P2: 'off/low/medium/high/max 五种拼写对思考型模型全部 HTTP 200 可接受（不出现 400/11102 类拒绝）',
  P3: '目录新 CLI 模型（glm-5.3 / glm-5.3-flash / kimi-k2.8-preview / hy3-x / hy4-preview / deepseek-v4.1-flash）同样接受五档拼写',
  P4: '各档 reasoning 长度自适应、非严格单调（off < max 不必然成立）',
  P5: '目录 reasoning 只给默认档，不含档位清单（即档位表无法从目录派生）——2026-09-22 复查已被推翻：新模型带 supportedEfforts/canDisableThinking/defaultEffort',
}

function loadApiKey() {
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY
  const credFile = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return m[1]
  }
  return null
}

/** patch 静态清单的 id 顺序（YAML 行扫描，布局变了就要改这里）。 */
function parsePatchIds() {
  const ids = []
  let inModels = false
  for (const line of readFileSync(PATCH_FILE, 'utf8').split('\n')) {
    if (/^\s*models:\s*$/.test(line)) { inModels = true; continue }
    if (!inModels) continue
    const m = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
    if (m) { ids.push(m[1]); continue }
    if (/^\s{0,10}\S/.test(line) && !/^\s{10,}/.test(line) && line.trim()) break
  }
  return ids
}

async function fetchCatalog(key) {
  const res = await fetch(`${BASE}/v3/config`, { headers: CATALOG_HEADERS(key) })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.code !== 0) {
    throw new Error(`catalog HTTP ${res.status} code=${body?.code} ${body?.msg ?? ''}`)
  }
  const data = body.data ?? {}
  const cliEnabled = new Set((data.agents ?? []).find((a) => a.name === 'cli')?.models ?? [])
  return {
    fetchedAt: new Date().toISOString(),
    models: (data.models ?? [])
      .filter((m) => typeof m?.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        maxInputTokens: m.maxInputTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        images: m.supportsImages === true,
        cli: cliEnabled.has(m.id),
        reasoning: m.reasoning ?? null,
      })),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 单档单发：流式聚合 reasoning/content 长度 + 响应回显 model + usage。 */
async function probeArm(id, level, key) {
  const started = Date.now()
  const body = {
    model: id,
    messages: [{ role: 'user', content: '9.11和9.9哪个大？先想清楚再给一句话结论。' }],
    max_tokens: 400,
    stream: true,
  }
  const wire = LEVEL_WIRE[level]
  if (wire) body.reasoning_effort = wire
  let res
  try {
    res = await fetch(`${BASE}/v2/chat/completions`, {
      method: 'POST',
      headers: { ...CHAT_HEADERS, Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { level, error: `network: ${err.message}`, ms: Date.now() - started }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { level, http: res.status, error: text.slice(0, 200), ms: Date.now() - started }
  }
  let buf = ''
  let reasonChars = 0
  let contentChars = 0
  let finish = null
  let echoModel = null
  let usage = null
  let streamErr = null
  let chunks = 0
  const dec = new TextDecoder()
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let j
        try { j = JSON.parse(payload) } catch { continue }
        chunks++
        if (j.error || (j.code != null && j.code !== 0)) streamErr = payload.slice(0, 200)
        if (typeof j.model === 'string') echoModel = j.model
        if (j.usage) usage = j.usage
        const ch = j.choices?.[0]
        if (ch?.delta?.reasoning_content) reasonChars += ch.delta.reasoning_content.length
        if (ch?.delta?.content) contentChars += ch.delta.content.length
        if (ch?.finish_reason) finish = ch.finish_reason
      }
      if (reasonChars + contentChars > 4000) break
    }
  } catch {
    // 部分流也是证据
  }
  return {
    level,
    http: res.status,
    reasonChars,
    contentChars,
    finish,
    echoModel,
    streamErr,
    chunks,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    ms: Date.now() - started,
  }
}

/**
 * 证据 → 档位表决策（--summarize <evidence.json>）。
 *
 * 判据（与 patch 头注释同一套）：
 *  1. 全臂 11102 → 目录里有、/v2 不可路由 → **不进静态清单**（routing.md R-R3）；
 *  2. 某档 HTTP/带内报错 → 该档不进表（11150 = invalid_reasoning_effort）；
 *  3. off 当且仅当**省略参数**（omit/off 两臂，等价请求）实测不产
 *     reasoning_content —— 否则目录/宿主选择器上的 "Off" 就是个假开关；
 *  4. 其余实测可接受档位全部进表（顺序按 EFFORT_TIER_ORDER）。
 */
if (SUMMARY) {
  const ev = JSON.parse(readFileSync(SUMMARY, 'utf8'))
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : null
  }
  const byModel = new Map()
  for (const arm of ev.arms) {
    if (!byModel.has(arm.id)) byModel.set(arm.id, [])
    byModel.get(arm.id).push(arm)
  }
  const TARGET_LEVELS = ['low', 'medium', 'high', 'max']
  console.log(`# ${SUMMARY}`)
  console.log(`# catalog fetchedAt=${ev.catalog?.fetchedAt ?? '?'}`)
  console.log('')
  for (const [id, arms] of byModel) {
    const errors = arms.filter((a) => a.error)
    const codes = [...new Set(errors.map((a) => (/"(?:code)":\s*(\d+)/.exec(a.error ?? '') ?? [])[1]).filter(Boolean))]
    const notRouted = errors.length === arms.length && codes.includes('11102')
    const omitArms = arms.filter((a) => (a.level === 'omit' || a.level === 'off') && !a.error && !a.streamErr)
    const baseline = omitArms.length ? median(omitArms.map((a) => a.reasonChars)) : null
    const detail = arms
      .filter((a) => a.level !== 'omit' && a.level !== 'off')
      .map((a) => `${a.level}=${a.error ? `ERR${(/"(?:code)":\s*(\d+)/.exec(a.error) ?? [])[1] ?? '?'}` : a.reasonChars}`)
      .join(' ')
    if (notRouted) {
      console.log(`${id.padEnd(20)} omit=${baseline ?? '-'} ${detail}`)
      console.log(`${' '.repeat(20)} → 不可路由（11102）：不进静态清单`)
      continue
    }
    const accepted = TARGET_LEVELS.filter((level) => arms.some((a) => a.level === level && !a.error && !a.streamErr))
    const rejected = TARGET_LEVELS.filter((level) => !accepted.includes(level))
    const tiers = [...(baseline === 0 ? ['off'] : []), ...accepted]
    console.log(`${id.padEnd(20)} omit=${baseline ?? '-'} ${detail}`)
    console.log(`${' '.repeat(20)} → 档位表 ${JSON.stringify(tiers)}${baseline === 0 ? '' : `（省略参数会思考 → 不给 off）`}${rejected.length ? `｜拒绝档位 ${rejected.join('/')}` : ''}`)
  }
  process.exit(0)
}

const key = loadApiKey()
if (!key) {
  console.error('CODEBUDDY_API_KEY not found (env or ~/.dsh/.credentials.yaml)')
  process.exit(1)
}

console.log('== catalog 面：GET /v3/config ==')
const catalog = await fetchCatalog(key)
console.log(`fetchedAt=${catalog.fetchedAt} models=${catalog.models.length}`)
console.log('id'.padEnd(26), 'cli', 'ctx/max'.padEnd(18), 'reasoning')
for (const m of catalog.models) {
  console.log(
    m.id.padEnd(26),
    (m.cli ? ' ✓ ' : '   '),
    `${m.maxInputTokens ?? '-'}/${m.maxOutputTokens ?? '-'}`.padEnd(18),
    m.reasoning ? JSON.stringify(m.reasoning) : '(none)',
  )
}
const withReasoning = catalog.models.filter((m) => m.reasoning)
console.log(`\nreasoning 键存在：${withReasoning.length}/${catalog.models.length}`)
const effortValues = [...new Set(withReasoning.map((m) => JSON.stringify(m.reasoning?.effort ?? m.reasoning?.defaultEffort ?? null)))]
console.log(`reasoning 默认档取值集合：${effortValues.join(', ')}`)
const tierListLike = withReasoning.filter((m) => Array.isArray(m.reasoning?.supportedEfforts) || Array.isArray(m.reasoning?.efforts) || Array.isArray(m.reasoning?.levels))
console.log(`目录带档位清单的模型：${tierListLike.length}${tierListLike.length ? ' → ' + tierListLike.map((m) => `${m.id}=${JSON.stringify(m.reasoning.supportedEfforts ?? m.reasoning.efforts ?? m.reasoning.levels)}`).join(' ') : ''}（P5 判定依据）`)
const disableLike = withReasoning.filter((m) => 'canDisableThinking' in (m.reasoning ?? {}))
console.log(`目录带 canDisableThinking 的模型：${disableLike.length}${disableLike.length ? ' → ' + disableLike.map((m) => `${m.id}=${m.reasoning.canDisableThinking}`).join(' ') : ''}`)

if (CATALOG_ONLY && !SUMMARY) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({ expect: EXPECT, catalog, arms: [] }, null, 2))
  console.log(`\n证据落盘：${OUT}`)
  process.exit(0)
}

const patchIds = parsePatchIds()
const explicit = argValue('--models')
const targets = explicit
  ? explicit.split(',').map((s) => s.trim()).filter(Boolean)
  : [...new Set([...patchIds, ...catalog.models.filter((m) => m.cli).map((m) => m.id)])]
const levels = (argValue('--levels') ?? 'omit,off,low,medium,high,max').split(',').map((s) => s.trim()).filter(Boolean)
for (const l of levels) {
  if (!(l in LEVEL_WIRE)) {
    console.error(`未知档位 ${l}（可选 ${Object.keys(LEVEL_WIRE).join('/')}）`)
    process.exit(1)
  }
}

console.log(`\n== chat 面：${targets.length} 模型 × ${levels.length} 档（间隔 ${INTERVAL}ms）==`)
const arms = []
for (const id of targets) {
  console.log(`\n${id}`)
  const catalogEntry = catalog.models.find((m) => m.id === id) ?? null
  for (const level of levels) {
    for (let rep = 0; rep < REPEAT; rep++) {
      const label = REPEAT > 1 ? `${level}#${rep + 1}` : level
      process.stdout.write(`  ${label.padEnd(10)}`)
      const r = await probeArm(id, level, key)
      if (r.error) console.log(` ✗ ${r.error}`)
      else {
        const sentinel = r.echoModel && r.echoModel !== id ? ` ⚠echo=${r.echoModel}` : ''
        console.log(
          ` reason=${String(r.reasonChars).padStart(5)} content=${String(r.contentChars).padStart(4)}` +
          ` finish=${(r.finish ?? '-').padEnd(14)} ${String(r.ms).padStart(6)}ms${r.streamErr ? ` ⚠${r.streamErr}` : ''}${sentinel}`,
        )
      }
      arms.push({ id, catalogReasoning: catalogEntry?.reasoning ?? null, cli: catalogEntry?.cli ?? null, rep: rep + 1, ...r })
      await sleep(INTERVAL)
    }
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ expect: EXPECT, catalog, arms }, null, 2))
console.log(`\n证据落盘：${OUT}（${arms.length} 臂）`)
