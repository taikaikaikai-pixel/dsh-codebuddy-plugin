#!/usr/bin/env node
/**
 * Qoder CN — assistant.content 形态单变量差分（provider_error 真根因定位）
 *
 * 背景：踩坑 #39 把报错归因到"孤儿 tool 消息"，但网关侧 sanitizeToolPairing
 * 上线后同一报错仍在。本探针只动一个变量——assistant 消息的 content 取值
 * （null / "" / 文本 / 缺键），其余逐字段相同，打真实上游逐模型家族对比。
 *
 * 用法：
 *   node scripts/probe-qoder-null-content.mjs                 # 默认 dmodel
 *   node scripts/probe-qoder-null-content.mjs --models dmodel,kmodel,mmodel,qmodel,auto
 *   node scripts/probe-qoder-null-content.mjs --gw            # 叠加"经生产网关"对照
 * 证据落 docs/probes/qoder-null-content-<ts>.json
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
const GW_PORT = Number(process.env.QODER_GW_PORT ?? 3903)
const GAP = Number(process.env.QODER_GAP_MS ?? 1200)

const argv = process.argv.slice(2)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const MODELS = (val('--models', 'dmodel')).split(',').map((s) => s.trim()).filter(Boolean)
const WITH_GW = argv.includes('--gw')
// --gw-local：用**当前工作区代码**起一个临时网关（而非 :3903 上正在跑的旧进程），
// 用来验证"修复后的网关出站体"在真实上游是否放行（前后对比）。
const LOCAL_GW = argv.includes('--gw-local')

const { readJson } = await import('../core/json-store.js')
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const store = readJson(AUTH_PATH)
const cred = { accessToken: store?.auth?.accessToken, machineId: store?.machine?.machineId, uid: store?.account?.uid }
if (!cred.accessToken) { console.error('未登录：先跑 probe-qoder-live.mjs --login'); process.exit(1) }

const TOOLS = [{ type: 'function', function: { name: 'get_time', description: '查询时间', parameters: { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] } } }]
const call = (id) => [{ id, type: 'function', function: { name: 'get_time', arguments: '{"tz":"Asia/Shanghai"}' } }]
const result = (id) => ({ role: 'tool', tool_call_id: id, content: '2026-09-22 09:00:00 +08:00' })
const sysHead = { role: 'system', content: '你是助手' }
const u = (t) => ({ role: 'user', content: t })

/** 形态库：每个只动一个变量。 */
const SHAPES = {
  // —— content 单变量（其余完全一致的合法工具环）——
  'A_call_content_null': [sysHead, u('几点'), { role: 'assistant', content: null, tool_calls: call('call_a1') }, result('call_a1'), u('谢谢，直接回答')],
  'A_call_content_empty': [sysHead, u('几点'), { role: 'assistant', content: '', tool_calls: call('call_a1') }, result('call_a1'), u('谢谢，直接回答')],
  'A_call_content_text': [sysHead, u('几点'), { role: 'assistant', content: '我查一下', tool_calls: call('call_a1') }, result('call_a1'), u('谢谢，直接回答')],
  'A_call_content_absent': [sysHead, u('几点'), { role: 'assistant', tool_calls: call('call_a1') }, result('call_a1'), u('谢谢，直接回答')],
  // —— 孤儿 tool（#39 形态）：无前置 assistant ——
  'B_orphan_plain': [sysHead, u('几点'), result('call_b1'), u('谢谢')],
  // —— 修复桩形态（sanitizeToolPairing 实际产出）：补的 assistant content:null ——
  'B_orphan_stub_null': [sysHead, u('几点'), { role: 'assistant', content: null, tool_calls: call('call_b1') }, result('call_b1'), u('谢谢')],
  'B_orphan_stub_empty': [sysHead, u('几点'), { role: 'assistant', content: '', tool_calls: call('call_b1') }, result('call_b1'), u('谢谢')],
  // —— tool 消息本身 content 单变量 ——
  'C_tool_content_null': [sysHead, u('几点'), { role: 'assistant', content: '', tool_calls: call('call_c1') }, { role: 'tool', tool_call_id: 'call_c1', content: null }, u('谢谢')],
  'C_tool_content_empty': [sysHead, u('几点'), { role: 'assistant', content: '', tool_calls: call('call_c1') }, { role: 'tool', tool_call_id: 'call_c1', content: '' }, u('谢谢')],
  // —— 不带 tools 数组的合法环（另一个候选变量）——
  'D_pair_without_tools': [sysHead, u('几点'), { role: 'assistant', content: '', tool_calls: call('call_d1') }, result('call_d1'), u('谢谢')],
  // —— 纯文本对照（无工具，确认通道本身健康）——
  'E_plain_chat': [sysHead, u('只回复两个字：收到')],
}

// --only A,B：只跑名字前缀匹配的形态（省额度）
const ONLY = (val('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const wantShape = (name) => !ONLY.length || ONLY.some((p) => name.startsWith(p))

const evidence = { ts: new Date().toISOString(), infer: INFER, models: MODELS, gw: LOCAL_GW ? 'local(fixed code)' : `${GW_PORT}(running process)`, shapes: {}, results: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function verdictOf(raw) {
  const flat = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const env = flat.match(/\{"code":"provider_error".*?"details":"(.*?)"\}/)
  if (env) {
    let inner = env[1]
    try { inner = JSON.parse(`"${env[1]}"`).message ?? env[1] } catch { try { inner = JSON.parse(JSON.parse(`"${env[1]}"`)).error.message } catch {} }
    return { kind: 'PROVIDER_ERROR', text: String(inner).replace(/\s+/g, ' ').slice(0, 300) }
  }
  const fail = flat.match(/\{"code":"[^"]*","message":"(\[FAIL\][^"]{0,200})/)
  if (fail) return { kind: 'NODE_FAIL', text: fail[1] }
  const text = (flat.match(/"content":"((?:[^"\\]|\\.)*)"/) ?? [])[1]
  const done = raw.includes('[DONE]')
  return { kind: text ? 'OK_TEXT' : (done ? 'OK_EMPTY' : 'NO_SIGNAL'), text: (text ?? '').slice(0, 120) }
}

async function direct(model, messages, withTools = true) {
  const body = { model, stream: true, stream_options: { include_usage: true }, messages, ...(withTools ? { tools: TOOLS, tool_choice: 'auto' } : {}) }
  const signed = await cosy.prepareChat(cred, { endpoint: INFER, body: JSON.stringify(body), modelKey: model, modelSource: 'system' })
  const r = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: signed.body })
  const raw = await r.text()
  const v = verdictOf(raw)
  return { via: 'direct', model, httpStatus: r.status, ...v, requestShapes: messages.map((m) => `${m.role}${m.tool_calls ? '+tc' : ''}${'content' in m ? `:content=${JSON.stringify(m.content)?.slice(0, 12) ?? 'undef'}` : ':no-content-key'}`) }
}

// 本地临时网关（当前工作区代码）——验证修复后的出站体
let gwBase = `http://127.0.0.1:${GW_PORT}`
let stopLocalGw = null
if (LOCAL_GW) {
  const { createQoderGateway } = await import('../providers/qoder/gateway.js')
  const runtime = { running: false, port: null, lastError: null }
  const localGw = createQoderGateway({
    settings: () => ({ qoderInferBaseURL: INFER, maxConcurrentPerSession: 2, upstreamFirstByteTimeoutMs: 90_000 }),
    resolveCredential: async () => ({ authorization: `Bearer ${cred.accessToken}`, machineId: cred.machineId, uid: cred.uid }),
    cosy, meter: { record() {} }, runtime, forensics: { logPath: () => undefined },
    getCatalogProfiles: () => [], getCatalogEntry: () => null,
    getModelSource: () => 'system', getModelPrefs: () => ({}),
  })
  stopLocalGw = localGw.listen(0)
  for (let i = 0; i < 100 && !runtime.running; i++) await sleep(50)
  if (!runtime.running) { console.error('本地网关起不来：', runtime.lastError); process.exit(1) }
  gwBase = `http://127.0.0.1:${runtime.port}`
}

async function viaGw(model, messages, withTools = true) {
  const body = { model, stream: true, stream_options: { include_usage: true }, messages, ...(withTools ? { tools: TOOLS, tool_choice: 'auto' } : {}) }
  const r = await fetch(`${gwBase}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const raw = await r.text()
  return { via: `gw:${new URL(gwBase).port}`, model, httpStatus: r.status, ...verdictOf(raw) }
}

console.log(`真实上游差分：models=${MODELS.join(',')}  形态=${Object.keys(SHAPES).length}${WITH_GW ? '  +生产网关对照' : ''}\n`)
for (const [name, messages] of Object.entries(SHAPES)) {
  evidence.shapes[name] = messages
  for (const model of MODELS) {
    const withTools = !name.startsWith('D_')
    const r = await direct(model, structuredClone(messages), withTools)
    r.shape = name
    evidence.results.push(r)
    console.log(`  ${name.padEnd(22)} ${model.padEnd(8)} ${r.kind.padEnd(14)} ${r.kind === 'OK_TEXT' ? `"${r.text}"` : r.text.slice(0, 150)}`)
    await sleep(GAP)
  }
  if ((WITH_GW || LOCAL_GW) && /^(A_call_content_null|B_orphan_plain|B_orphan_stub_null|C_tool_content_null)$/.test(name)) {
    for (const model of MODELS) {
      const r = await viaGw(model, structuredClone(messages))
      r.shape = `${name} (gateway)`
      evidence.results.push(r)
      console.log(`  ${`${name} [GW]`.padEnd(22)} ${model.padEnd(8)} ${r.kind.padEnd(14)} ${r.kind === 'OK_TEXT' ? `"${r.text}"` : r.text.slice(0, 150)}`)
      await sleep(GAP)
    }
  }
}

mkdirSync(PROBES_DIR, { recursive: true })
const out = join(PROBES_DIR, `qoder-null-content-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('\n证据 →', out)
process.exit(0)
