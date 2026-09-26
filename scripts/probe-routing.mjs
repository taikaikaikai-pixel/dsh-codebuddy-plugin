#!/usr/bin/env node
/**
 * Route-allocation probe (topic 3 of docs/rules/): what dimensions does the
 * gateway allocate routes by, i.e. what exactly does 14407 "route config not
 * found" key on?
 *
 * Spell under test (AGENTS.md:24): "`/v2/videos/generations`、`/v2/3d/generations`
 * 路由存在但当前账号一律 14407 route config not found（无可用模型）"。
 *
 * Anchor evidence (docs/probes/media-2026-08-17.json): 14407 messages embed
 * the MODEL name — "Video model [hunyuan-video-t2v] route config not found" —
 * so 14407 is a per-(endpoint-family, model) lookup failure, not a 404.
 *
 * /v3/config (fetched live in this script) lists 24 models for this account
 * incl. hunyuan-image-v3.0-art and NO video/3d models — but deepseek-v3,
 * which routes fine on chat, is NOT among them, so "catalog membership" is
 * not the route table. The route table is its own per-(family, model) map.
 *
 * Pre-registered predictions (2026-08-19):
 *   P1  chat + bogus model → 14407, message echoes the model name verbatim
 *   P2  images + bogus model → 14407 with "image model" wording
 *   P3  images + glm-5.2 (a chat-family model that IS in the catalog)
 *       → 14407 (route configs are family-scoped, catalog membership does
 *       not cross families)
 *   P4  chat + hunyuan-image-v3.0-art (image model) → 14407
 *   P5  chat + glm-5.0 (catalog-listed, NOT in the cli agents list)
 *       → 200 (route config exists; the cli list gates CLI display, not
 *       routing)  [costs one max_tokens=1 completion if it passes]
 *   P6  unknown family /v2/foo/generations → 404 "Route Not Found"
 *       (path routing is a layer separate from model routing)
 * Exploratory (no firm prediction): videos + omitted model field.
 *
 * Low rate: 2s spacing, single account; all arms are designed to fail at
 * the route layer (zero generation cost) except P5's tiny completion.
 *
 * Usage: node scripts/probe-routing.mjs [--out docs/probes/routing-YYYY-MM-DD.jsonl]
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const OUT = process.argv[process.argv.indexOf('--out') + 1] && process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join('docs', 'probes', `routing-${new Date().toISOString().slice(0, 10)}.jsonl`)
const SPACING_MS = 2000

function resolveKey() {
  try {
    const cfg = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin.json'), 'utf8'))
    const active = (cfg.apiKeys ?? []).find((k) => k.name === cfg.activeApiKey)
    if (active?.key) return active.key
  } catch { /* fall through */ }
  if (process.env.CODEBUDDY_API_KEY) return process.env.CODEBUDDY_API_KEY
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return m[1]
  }
  throw new Error('no CodeBuddy credential found')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

const HEADERS = (key) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Authorization: `Bearer ${key}`,
  'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
})

const ARMS = [
  { name: 'P1-chat-bogus-model', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'no-such-model-xyz', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { code: 14407 }, note: 'message echoes model name verbatim' },
  { name: 'P2-images-bogus-model', method: 'POST', path: '/v2/images/generations',
    body: { model: 'no-such-image-model', prompt: 'x', size: '1024x1024', n: 1 },
    expect: { code: 14407 }, note: '"image model" wording' },
  { name: 'P3-images-chat-model', method: 'POST', path: '/v2/images/generations',
    body: { model: 'glm-5.2', prompt: 'x', size: '1024x1024', n: 1 },
    expect: { code: 14407 }, note: 'catalog chat model does not cross into the image family' },
  { name: 'P4-chat-image-model', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'hunyuan-image-v3.0-art', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { code: 14407 }, note: 'image model has no chat route' },
  { name: 'P5-chat-catalog-noncli', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'glm-5.0', stream: true, stream_options: { include_usage: true }, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { status: 200 }, note: 'catalog-listed but not cli-enabled still routes' },
  { name: 'P6-unknown-family', method: 'POST', path: '/v2/foo/generations',
    body: { model: 'x' },
    expect: { status: 404 }, note: 'path routing layer is separate from model routing' },
  { name: 'X1-videos-no-model', method: 'POST', path: '/v2/videos/generations',
    body: { prompt: 'x' },
    expect: null, note: 'exploratory: error shape when model field omitted' },
]

// Round 2 (2026-08-19): the matrix refuted the naive "14407 = (family,model)"
// picture and revealed a THREE-LAYER structure. Revised rules under test:
//   R-R2  media-family registry miss → family-specific code + verbatim echo:
//         image → 14401, video/3d → 14407 ("<Family> model [<echo>] route
//         config not found"); the miss means "model unknown in that family",
//         a GLOBALLY known model passes lookup and fails later at dispatch
//         (P3: images+glm-5.2 → bare 500; P4: chat+image-model → 500/11103)
//   R-R3  chat-family registry miss → 11102 "model [echo] service info not
//         found"; the chat registry is independent of /v3/config AND of the
//         cli-enabled list (kimi-k2.5 routes fine though not cli-listed;
//         glm-5.0 is catalog-listed yet 11102)
//   R-R4  model known but backend unsupported in context → HTTP 500, either
//         bare (image family) or 11103 "Backend [x] is not supported" (chat)
// Pre-registered confirmations (unobserved cases):
const ARMS_R2 = [
  { name: 'C1-images-no-model', method: 'POST', path: '/v2/images/generations',
    body: { prompt: 'x', size: '1024x1024', n: 1 },
    expect: { code: 14401 }, note: 'image family echoes empty model like video X1' },
  { name: 'C2-video-fresh-bogus', method: 'POST', path: '/v2/videos/generations',
    body: { model: 'no-such-video-model', prompt: 'x' },
    expect: { code: 14407 }, note: 'verbatim echo of a fresh unobserved name' },
  { name: 'C3-3d-no-model', method: 'POST', path: '/v2/3d/generations',
    body: { prompt: 'x' },
    expect: { code: 14407 }, note: '3d family echoes empty model' },
  { name: 'C4-chat-fresh-bogus', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'no-such-model-abc', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { code: 11102 }, note: 'chat registry miss wording is stable' },
  { name: 'C5-chat-notcli-k25', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'kimi-k2.5', stream: true, stream_options: { include_usage: true }, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { status: 200 }, note: 'cli list does not gate routing (k2.5 not cli-listed)' },
  { name: 'C6-chat-volc-alias', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'deepseek-v3-2-volc', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { code: 11102 }, note: 'registry keyed by public ids; catalog-internal volc id unknown' },
  { name: 'C7-chat-hunyuan-chat', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'hunyuan-chat', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { code: 11103 }, note: 'catalog chat-branded model resolves but its backend unsupported' },
  { name: 'C8-3d-known-image-model', method: 'POST', path: '/v2/3d/generations',
    body: { model: 'hunyuan-image-v3.0-art', prompt: 'x' },
    expect: { status: 500 }, note: 'globally-known model passes 3d lookup, dies at dispatch — NOT 14407' },
]

// Round 3 (2026-08-19): C1–C5 HIT confirmed R-R2/R-R3; C6/C7 MISS showed the
// chat registry also resolves catalog-internal aliases (deepseek-v3-2-volc
// → 200) and more backends (hunyuan-chat → 200). C8 refined R-R4: known
// model + unsupported family → 11103 "Backend [aiart] is not supported for
// 3d generation" — but with HTTP 400 (3d), not the 500 seen on chat (P4)
// and bare 500 on images (P3). R-R4 final form under test: the dispatch
// failure is 11103 with a per-family envelope: 3d/video → HTTP 400 with
// "...for <family> generation", chat → HTTP 500 bare wording, images →
// HTTP 500 with no JSON envelope at all.
const ARMS_R3 = [
  { name: 'D1-video-known-chat-model', method: 'POST', path: '/v2/videos/generations',
    body: { model: 'glm-5.2', prompt: 'x' },
    expect: { status: 400, code: 11103 }, note: '11103 with "for video generation" wording, mirroring C8' },
  { name: 'D2-images-known-chat-model', method: 'POST', path: '/v2/images/generations',
    body: { model: 'kimi-k2.6', prompt: 'x', size: '1024x1024', n: 1 },
    expect: { status: 500, code: null }, note: 'images family envelope is a bare 500 (P3 replication with a fresh model)' },
  { name: 'D3-chat-image-model-retest', method: 'POST', path: '/v2/chat/completions',
    body: { model: 'hunyuan-image-v3.0-art', stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: { status: 500, code: 11103 }, note: 'P4 envelope stability retest' },
]

// Round 4 (2026-08-19): D1 MISS refined the video family — 14407 is its
// CATCH-ALL code, not only "route config not found": a globally known chat
// model on /v2/videos got 400/14407 "unsupported video params". D2/D3 HIT
// confirmed the images bare-500 and chat 500/11103 envelopes. Final R-R4
// prediction: a SECOND unobserved chat model on video repeats the catch-all.
const ARMS_R4 = [
  { name: 'E1-video-chat-model-2', method: 'POST', path: '/v2/videos/generations',
    body: { model: 'kimi-k2.6', prompt: 'x' },
    expect: { status: 400, code: 14407 }, note: 'video catch-all: 14407 "unsupported video params" for any known non-video model' },
]

async function probe(key, arm) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}${arm.path}`, {
      method: arm.method,
      headers: HEADERS(key),
      body: JSON.stringify(arm.body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* SSE stream or HTML */ }
    return {
      name: arm.name, path: arm.path, model: arm.body?.model ?? null, expect: arm.expect, note: arm.note,
      status: res.status, code: json?.code ?? null,
      msg: redact(json?.msg ?? json?.error_msg ?? (json ? JSON.stringify(json).slice(0, 160) : text.slice(0, 160))),
      ms: Date.now() - t0,
    }
  } catch (err) {
    return { name: arm.name, path: arm.path, model: arm.body?.model ?? null, expect: arm.expect, note: arm.note, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

function judge(rec) {
  if (!rec.expect) return ''
  const okStatus = rec.expect.status == null || rec.status === rec.expect.status
  const okCode = rec.expect.code == null || rec.code === rec.expect.code
  return okStatus && okCode ? ' HIT' : ' MISS'
}

const key = resolveKey()
mkdirSync(dirname(OUT), { recursive: true })
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), gateway: GATEWAY }) + '\n')
console.log(`evidence → ${OUT}`)

const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'matrix'
const arms = SET === 'r2' ? ARMS_R2 : SET === 'r3' ? ARMS_R3 : SET === 'r4' ? ARMS_R4 : ARMS

// anchor: the account's catalog (proves which families are entitled)
const catRes = await fetch(`${GATEWAY}/v3/config`, { headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'x-api-key': key, 'User-Agent': 'CLI/unknown CodeBuddy/2.136.0', 'X-Product': 'SaaS' } })
const cat = await catRes.json().catch(() => null)
const models = (cat?.data?.models ?? []).map((m) => m.id)
const cliModels = (cat?.data?.agents ?? []).find((a) => a.name === 'cli')?.models ?? []
appendFileSync(OUT, JSON.stringify({ type: 'catalog', at: new Date().toISOString(), models, cliModels }) + '\n')
console.log(`catalog: ${models.length} models, cli-enabled: ${cliModels.length}`)
await sleep(SPACING_MS)

for (const arm of arms) {
  const rec = { type: 'probe', ...await probe(key, arm) }
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(`${arm.name.padEnd(24)} status=${rec.status ?? '-'} code=${rec.code ?? '-'} msg=${(rec.msg ?? rec.error ?? '').slice(0, 110)}${judge(rec)}`)
  await sleep(SPACING_MS)
}
console.log('done.')
