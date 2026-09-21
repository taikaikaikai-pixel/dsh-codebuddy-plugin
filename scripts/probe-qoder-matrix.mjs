#!/usr/bin/env node
/**
 * Qoder CN — 差分矩阵探测（真实账号，只读对话）。
 *
 * 目的：把"上游报错"的触发条件逐变量隔离——同一请求体，只改一个字段，
 * 看上游是成功回文本还是回业务错误信封。用于回答两个悬案：
 *   1) Qwen3.8-Flash（qfmodel）为什么报
 *      {"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}
 *      ——而 Qoder 客户端里能用？（变量：reasoning_effort / max_completion_tokens /
 *      tools / modelSource / 多轮）
 *   2) "Messages with role 'tool' must be a response to a preceding message with
 *      'tool_calls'" 的触发形态（工具回灌序列）。
 *
 * 用法：
 *   node scripts/probe-qoder-matrix.mjs --suite flash      # qfmodel 变量矩阵
 *   node scripts/probe-qoder-matrix.mjs --suite tools      # 工具回灌形态矩阵
 *   node scripts/probe-qoder-matrix.mjs --suite all
 *   node scripts/probe-qoder-matrix.mjs --suite flash --only baseline,max_tokens
 * 证据落 docs/probes/qoder-matrix-<ts>.json（含请求体明文与 SSE 原始响应）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUTH_PATH = join(DSH_HOME, 'qoder-plugin-auth.json')
const PROBES_DIR = join(ROOT, 'docs', 'probes')
const INFER = process.env.QODER_INFER ?? 'https://gateway.qoder.com.cn'
const GAP_MS = Number(process.env.QODER_GAP_MS ?? 1500)

const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cred() {
  const store = readJson(AUTH_PATH)
  const accessToken = store?.auth?.accessToken
  if (!accessToken) { console.error('未登录：先跑 scripts/probe-qoder-live.mjs --login'); process.exit(1) }
  return { cred: { accessToken, machineId: store.machine?.machineId, uid: store.account?.uid }, store }
}

/** SSE 信封 → 结构化结论。 */
function dissect(raw) {
  const out = { text: '', reasoning: '', toolCalls: [], finish: null, usage: null, errorObjects: [], frames: 0, done: false, eventErrors: [] }
  let lastEvent = null
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) { lastEvent = null; continue }
    if (t.startsWith('event:')) { lastEvent = t.slice(6).trim(); continue }
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (lastEvent === 'error') { out.eventErrors.push(payload.slice(0, 500)); continue }
    let frame
    try { frame = JSON.parse(payload) } catch { continue }
    if (typeof frame?.body !== 'string') continue
    if (frame.body === '[DONE]') { out.done = true; continue }
    out.frames++
    let chunk
    try { chunk = JSON.parse(frame.body) } catch { out.errorObjects.push({ raw: frame.body.slice(0, 300) }); continue }
    if (chunk.code !== undefined || (typeof chunk.message === 'string' && !Array.isArray(chunk.choices))) {
      out.errorObjects.push({ code: chunk.code ?? null, message: chunk.message ?? null, statusCodeValue: frame.statusCodeValue ?? null })
      continue
    }
    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) out.text += delta.content
    if (delta?.reasoning_content) out.reasoning += delta.reasoning_content
    for (const tc of delta?.tool_calls ?? []) out.toolCalls.push(tc)
    if (chunk.choices?.[0]?.finish_reason) out.finish = chunk.choices[0].finish_reason
    if (chunk.usage) out.usage = chunk.usage
  }
  return out
}

const WASM_PATH = join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm')
const cosy = createCosyRuntime({ wasmPath: WASM_PATH })

const evidence = { ts: new Date().toISOString(), infer: INFER, cases: [] }

async function chat(label, bodyObj, { modelSource = 'system', modelKey = bodyObj.model, note } = {}) {
  const body = JSON.stringify(bodyObj)
  const signed = await cosy.prepareChat(cred().cred, { endpoint: INFER, body, modelKey, modelSource })
  let status = 0, raw = '', netErr = null
  try {
    const r = await fetch(signed.url, {
      method: 'POST',
      headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: signed.body,
    })
    status = r.status
    raw = await r.text()
  } catch (e) { netErr = String(e?.message ?? e) }
  const d = dissect(raw)
  const verdict = d.errorObjects.length || d.eventErrors.length || status !== 200
    ? `ERROR ${d.errorObjects[0]?.message ?? d.eventErrors[0] ?? `HTTP ${status}`}`
    : (d.text.trim() ? `OK "${d.text.trim().slice(0, 60)}"` : (d.toolCalls.length ? `OK tools=${d.toolCalls.length}` : 'OK 空文本'))
  console.log(`\n== ${label}${note ? `（${note}）` : ''}\n   HTTP ${status}${netErr ? ` netErr=${netErr}` : ''} frames=${d.frames} → ${verdict}`)
  if (d.toolCalls.length) console.log('   tool_calls:', JSON.stringify(d.toolCalls).slice(0, 200))
  if (d.usage) console.log('   usage:', JSON.stringify(d.usage))
  evidence.cases.push({ label, note, modelKey, modelSource, request: bodyObj, status, netErr, dissect: { ...d, text: d.text.slice(0, 2000), reasoning: d.reasoning.slice(0, 2000) }, raw: raw.slice(0, 60_000) })
  await sleep(GAP_MS)
  return d
}

const SUITES = {
  /** qfmodel 变量矩阵：每例只动一个字段。 */
  async flash() {
    const base = { model: 'qfmodel', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: '只回复两个字：收到' }] }
    await chat('baseline', base, { note: '最小体（对照）' })
    await chat('regression_max', { ...base, model: 'qmodel_38max' }, { note: '同账号回归对照：38max' })
    await chat('effort_medium', { ...base, reasoning_effort: 'medium' })
    await chat('effort_max', { ...base, reasoning_effort: 'max' }, { note: '设置卡里 qfmodel 的现存值' })
    await chat('max_tokens_default', { ...base, max_completion_tokens: 32768 }, { note: '镜像默认输出上限' })
    await chat('max_tokens_2048', { ...base, max_completion_tokens: 2048 })
    await chat('tools_only', { ...base, tools: [{ type: 'function', function: { name: 'get_time', description: '取当前时间', parameters: { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] } } }], tool_choice: 'auto' })
    await chat('multi_turn', { ...base, messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '我叫小明' }, { role: 'assistant', content: '好的' }, { role: 'user', content: '我叫什么' }] })
    await chat('source_user', base, { modelSource: 'user', note: 'X-Model-Source 变量' })
    await chat('source_unknown', base, { modelSource: 'zzz', note: '未知 source 是否被静默改派' })
  },

  /** 工具拒绝面是否按模型家族分裂：同一坏体打多个模型。 */
  async reject() {
    const bad = (model) => ({
      model, stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '查询时间' },
        { role: 'tool', tool_call_id: 'call_probe_missing', content: '2026-09-22 05:00:00 +08:00' },
      ],
    })
    for (const m of ['auto', 'qmodel_38max', 'qmodel', 'dmodel', 'gmodel', 'kmodel', 'mmodel']) {
      await chat(`orphan_tool@${m}`, bad(m), { note: '孤儿 tool 消息（无前置 tool_calls）' })
    }
    await chat('mismatch_id@qmodel', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_aaa', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] },
        { role: 'tool', tool_call_id: 'call_bbb', content: '2026-09-22 05:00:00 +08:00' },
      ],
    }, { note: 'tool_call_id 与前置 tool_calls.id 不匹配' })
    await chat('partial_results@qmodel', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询' },
        {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'call_aaa', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } },
            { id: 'call_bbb', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"UTC"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_aaa', content: '2026-09-22 05:00:00 +08:00' },
      ],
    }, { note: '双 tool_calls 只回一个结果' })
  },

  /** 修复策略验证：孤儿 tool / 缺结果的 tool_calls 的替代形态能不能过上游。 */
  async repair() {
    const tools = [{ type: 'function', function: { name: 'get_current_time', description: '查询当前时间', parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] } } }]
    const mk = (messages) => ({ model: 'qmodel', stream: true, stream_options: { include_usage: true }, messages, tools, tool_choice: 'auto' })
    const plain = { role: 'user', content: '你好，请只回复两个字：收到' }

    await chat('drop_orphan_tool', mk([
      plain,
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc123', content: '(tool result unavailable: previous attempt was interrupted)' },
    ]), { note: 'R1：孤儿 tool 直接丢弃后，工具调用已从历史消失' })

    await chat('synthesize_missing_tool_result', mk([
      plain,
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc123', content: '(tool result unavailable: previous attempt was interrupted)' },
      { role: 'user', content: '算了，直接说你好' },
    ]), { note: 'R2：合成缺失的 tool 结果，保住 assistant.tool_calls 配对' })

    await chat('pure_orphan_without_toolcalls', mk([
      plain,
      { role: 'tool', tool_call_id: 'call_zzz', content: '(unavailable)' },
    ]), { note: 'R3：既无 tool_calls 也无助手消息的纯孤儿 tool' })

    await chat('duplicate_assistant_tool_calls', mk([
      plain,
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc123', content: '2026-09-22 05:00:00 +08:00' },
    ]), { note: 'R4：重复 assistant（同 id）' })
  },

  /** 工具回灌形态矩阵：定位 tool 角色报错的触发序列。 */
  async tools() {
    const tools = [{ type: 'function', function: { name: 'get_current_time', description: '查询当前时间', parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] } } }]
    const first = await chat('tool_call_gen', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '现在几点？必须调用工具查询，时区用 Asia/Shanghai。' }],
      tools, tool_choice: 'auto',
    }, { note: '先让模型产 tool_calls（reasoning 模型 qmodel）' })

    const tc = first.toolCalls[0]
    const callId = tc?.id ?? 'call_probe_1'
    const name = tc?.function?.name ?? 'get_current_time'
    const args = '{"timezone":"Asia/Shanghai"}'
    console.log(`   → 取出 callId=${callId} name=${name} args=${args}`)

    await chat('tool_result_openai_shape', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询，时区用 Asia/Shanghai。' },
        { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }] },
        { role: 'tool', tool_call_id: callId, content: '2026-09-22 05:00:00 +08:00' },
      ],
      tools, tool_choice: 'auto',
    }, { note: '标准 OpenAI 工具回灌（content:null）' })

    await chat('tool_result_assistant_empty_string', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询，时区用 Asia/Shanghai。' },
        { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }] },
        { role: 'tool', tool_call_id: callId, content: '2026-09-22 05:00:00 +08:00' },
      ],
      tools, tool_choice: 'auto',
    }, { note: 'assistant content:""（pi-ai 非 reasoning 路径形态）' })

    await chat('tool_result_reasoning_content', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询，时区用 Asia/Shanghai。' },
        { role: 'assistant', content: null, reasoning_content: '用户想知道现在几点，我需要调用工具。', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }] },
        { role: 'tool', tool_call_id: callId, content: '2026-09-22 05:00:00 +08:00' },
      ],
      tools, tool_choice: 'auto',
    }, { note: 'assistant 带 reasoning_content + tool_calls（pi-ai reasoning 路径形态）' })

    await chat('tool_result_assistant_text', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '现在几点？必须调用工具查询，时区用 Asia/Shanghai。' },
        { role: 'assistant', content: '我来查一下。', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }] },
        { role: 'tool', tool_call_id: callId, content: '2026-09-22 05:00:00 +08:00' },
      ],
      tools, tool_choice: 'auto',
    }, { note: 'assistant 带正文 + tool_calls' })

    await chat('tool_no_preceding_assistant', {
      model: 'qmodel', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: '查询时间' },
        { role: 'tool', tool_call_id: callId, content: '2026-09-22 05:00:00 +08:00' },
      ],
      tools, tool_choice: 'auto',
    }, { note: '故意坏体：tool 无前置 tool_calls（阳性对照）' })
  },
}

const args = process.argv.slice(2)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const has = (f) => args.includes(f)
const suite = val('--suite') ?? 'all'

mkdirSync(PROBES_DIR, { recursive: true })
const names = suite === 'all' ? ['reject', 'flash', 'tools'] : [suite]

for (const n of names) {
  if (!SUITES[n]) { console.error(`未知 suite: ${n}（可用：flash / tools / all）`); process.exit(1) }
  console.log(`\n──────── suite: ${n} ────────`)
  await SUITES[n]()
}

const out = join(PROBES_DIR, `qoder-matrix-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('\n证据 →', out)
