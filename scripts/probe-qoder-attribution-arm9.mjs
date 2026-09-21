// 臂 9：大额用量 + 整数计数器（addOnQuota.used 只显整数，0.002 级探测不可见）。
// A = 裸 OpenAI body ×2 大输出；B = 官方归因信封 + business/finish ×2 大输出。
// 判定：哪一组让整数计数器跳变，即哪条路径被记账。
import { readJson } from '../core/json-store.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const store = readJson(join(homedir(), '.dsh', 'qoder-plugin-auth.json'))
const { createCosyRuntime } = await import('../providers/qoder/cosy.js')
const { fetchQoderCatalog } = await import('../providers/qoder/catalog.js')
const cosy = createCosyRuntime({ wasmPath: join(ROOT, 'providers', 'qoder', 'qoder_auth.wasm') })
const cred = { accessToken: store.auth.accessToken, machineId: store.machine.machineId, uid: store.account.uid }
const INFER = 'https://gateway.qoder.com.cn'
const OPENAPI = 'https://openapi.qoder.com.cn'
const MODEL = process.env.QODER_QUOTA_MODEL ?? 'qmodel_38max'
const BIG_PROMPT = '用中文写一篇约 2500 字的科普文章，主题是"潮汐是如何形成的"，要求分段详细论述。'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evidence = { at: new Date().toISOString(), model: MODEL, arms: [] }

const addOnUsed = async () => {
  const r = await fetch(`${OPENAPI}/api/v2/quota/usage`, { headers: { Authorization: `Bearer ${cred.accessToken}` } })
  return (JSON.parse(await r.text()))?.addOnQuota?.used
}

const cat = await fetchQoderCatalog(cosy, cred, INFER)
const entry = cat.entries[MODEL]

async function bigChat(withEnvelope) {
  const base = {
    model: MODEL, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: BIG_PROMPT }],
  }
  if (withEnvelope) {
    const requestId = randomUUID(), requestSetId = randomUUID()
    Object.assign(base, {
      request_id: requestId, request_set_id: requestSetId, chat_record_id: requestId,
      session_id: randomUUID(), chat_task: 'FREE_INPUT',
      chat_context: { text: BIG_PROMPT, features: [], extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: BIG_PROMPT }, chatPrompt: '', imageUrls: null },
      is_reply: true, is_retry: false, source: 1, version: '3',
      agent_id: 'agent_common', task_id: 'common', session_type: 'qoderclicn', aliyun_user_type: '',
      model_config: {
        key: entry.key, display_name: entry.display_name, model: '', format: entry.format,
        is_vl: entry.is_vl === true, is_reasoning: entry.is_reasoning === true,
        api_key: '', url: '', source: entry.source ?? 'system', max_input_tokens: entry.max_input_tokens,
        is_free: entry.is_free === true, price_factor: entry.price_factor,
        promotion: entry.promotion, feature_switches: entry.feature_switches,
        context_config: entry.context_config, thinking_config: entry.thinking_config,
      },
      business: { product: 'cli', version: '1.1.57', type: 'agent', id: requestSetId, name: BIG_PROMPT.slice(0, 10), begin_at: Date.now(), stage: 'processing' },
    })
    base.__requestSetId = requestSetId
    base.__sessionId = base.session_id
  }
  const { __requestSetId, __sessionId, ...payload } = base
  const signed = await cosy.prepareChat(cred, { endpoint: INFER, body: JSON.stringify(payload), modelKey: MODEL, modelSource: 'system' })
  const res = await fetch(signed.url, { method: 'POST', headers: { ...signed.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: signed.body })
  const raw = await res.text()
  let usage = null, text = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    let frame; try { frame = JSON.parse(line.slice(5)) } catch { continue }
    if (typeof frame?.body !== 'string' || frame.body === '[DONE]') continue
    let chunk; try { chunk = JSON.parse(frame.body) } catch { continue }
    if (chunk.usage) usage = chunk.usage
    if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content
  }
  // 信封臂补 business/finish（与插件网关同）
  if (withEnvelope && __requestSetId) {
    const inner = { event_time: Date.now(), event_type: 'BUSINESS_FINISH', mid: cred.machineId, aid: '', rid: randomUUID(), oid: '', yid: '', uid: cred.uid, event_data: { session_id: __sessionId, business: { product: 'cli', version: '1.1.57', type: 'agent', id: __requestSetId, end_at: Date.now(), stage: 'complete', name: BIG_PROMPT.slice(0, 10) } } }
    const fin = await cosy.prepareSigned(cred, { endpoint: INFER, path: '/api/v2/service/business/finish?Encode=1', method: 'POST', mode: 'auth', body: JSON.stringify({ payload: JSON.stringify(inner), encodeVersion: '1' }) })
    await fetch(fin.url, { method: 'POST', headers: { ...fin.headers, 'Content-Type': 'application/json' }, body: fin.body }).catch(() => {})
  }
  return { status: res.status, credits: usage?.credits ?? 0, tokens: usage?.total_tokens ?? 0, textLen: text.length, usage }
}

for (const [arm, withEnvelope] of [['A-bare', false], ['B-envelope', true]]) {
  const before = await addOnUsed()
  console.log(`\n══ 臂 ${arm} ══ 开始前 addOnUsed=${before}`)
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await bigChat(withEnvelope)
    console.log(`  chat#${i + 1} HTTP ${r.status} tokens=${r.tokens} credits=${r.credits} 正文长度=${r.textLen}`)
    runs.push({ status: r.status, credits: r.credits, tokens: r.tokens })
    await sleep(2000)
  }
  await sleep(45_000)
  const after = await addOnUsed()
  console.log(`  45s 后 addOnUsed=${after} ${after !== before ? `★ 动了 ${before}→${after}` : '（不动）'}`)
  evidence.arms.push({ arm, withEnvelope, before, after, runs })
}

evidence.verdict = evidence.arms.map((a) => `${a.arm}:${a.after !== a.before ? '计数' : '不动'}`).join(' ')
console.log('\n【结论】', evidence.verdict)
mkdirSync(join(ROOT, 'docs', 'probes'), { recursive: true })
const out = join(ROOT, 'docs', 'probes', `qoder-attribution-arm9-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('证据 →', out)
process.exit(0)
