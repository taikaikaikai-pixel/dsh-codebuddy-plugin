// 臂 8：model_config 携带完整定价元数据（price_factor/promotion/is_free/feature_switches…）
// 假设：服务端计费归并要求请求侧 model_config 带价格因子（官方客户端从目录投影全带）。
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
const MODEL = 'qmodel_38max'
const PROMPT = '只回复两个字：收到'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cat = await fetchQoderCatalog(cosy, cred, INFER)
const entry = cat.entries[MODEL]
// 官方归一化形态（bundle 实证字段）：目录条目定价/能力元数据全带
const modelConfig = {
  key: entry.key, display_name: entry.display_name, model: '', format: entry.format,
  is_vl: entry.is_vl === true, is_reasoning: entry.is_reasoning === true,
  api_key: '', url: '', source: entry.source ?? 'system',
  max_input_tokens: entry.max_input_tokens,
  is_default: entry.is_default === true, is_new: entry.is_new === true,
  is_free: entry.is_free === true,
  price_factor: entry.price_factor, original_price_factor: entry.original_price_factor,
  promotion: entry.promotion, feature_switches: entry.feature_switches,
  context_config: entry.context_config, thinking_config: entry.thinking_config,
}

const addOnUsed = async () => {
  const r = await fetch(`${OPENAPI}/api/v2/quota/usage`, { headers: { Authorization: `Bearer ${cred.accessToken}` } })
  return (JSON.parse(await r.text()))?.addOnQuota?.used
}
const evidence = { at: new Date().toISOString(), model: MODEL, modelConfig }
const before = await addOnUsed()
console.log('addOnUsed before:', before)

const requestId = randomUUID(), requestSetId = randomUUID(), sessionId = randomUUID()
const body = JSON.stringify({
  model: MODEL, stream: true, stream_options: { include_usage: true },
  messages: [{ role: 'user', content: PROMPT }],
  request_id: requestId, request_set_id: requestSetId, chat_record_id: requestId,
  session_id: sessionId, chat_task: 'FREE_INPUT',
  chat_context: { text: PROMPT, features: [], extra: { context: [], modelConfig: { key: MODEL, is_reasoning: true }, originalContent: PROMPT }, chatPrompt: '', imageUrls: null },
  is_reply: true, is_retry: false, source: 1, version: '3',
  agent_id: 'agent_common', task_id: 'common', session_type: 'qoderclicn', aliyun_user_type: '',
  model_config: modelConfig,
  business: { product: 'cli', version: '1.1.57', type: 'agent', id: requestSetId, name: PROMPT.slice(0, 10), begin_at: Date.now(), stage: 'processing' },
})
const signed = await cosy.prepareChat(cred, { endpoint: INFER, body, modelKey: MODEL, modelSource: 'system' })
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
console.log('chat HTTP', res.status, 'text=', JSON.stringify(text.slice(0, 20)))
console.log('usage 帧全文:', JSON.stringify(usage))
evidence.chat = { status: res.status, usage, text: text.slice(0, 100), raw: raw.slice(0, 12_000) }

// business/finish 收尾（与前臂同）
const inner = { event_time: Date.now(), event_type: 'BUSINESS_FINISH', mid: cred.machineId, aid: '', rid: randomUUID(), oid: '', yid: '', uid: cred.uid, event_data: { session_id: sessionId, business: { product: 'cli', version: '1.1.57', type: 'agent', id: requestSetId, end_at: Date.now(), stage: 'complete', name: PROMPT.slice(0, 10) } } }
const fin = await cosy.prepareSigned(cred, { endpoint: INFER, path: '/api/v2/service/business/finish?Encode=1', method: 'POST', mode: 'auth', body: JSON.stringify({ payload: JSON.stringify(inner), encodeVersion: '1' }) })
const finRes = await fetch(fin.url, { method: 'POST', headers: { ...fin.headers, 'Content-Type': 'application/json' }, body: fin.body })
console.log('business/finish HTTP', finRes.status, (await finRes.text()).slice(0, 80))

// 官方实测计数器 ~1 分钟内动（06:28 官方聊天 06:29 即 +5）：盯 90s，每 15s 一拍
for (const wait of [15, 15, 15, 15, 30]) {
  await sleep(wait * 1000)
  const now = await addOnUsed()
  console.log(`+${wait}s addOnUsed:`, now, now !== before ? '★ 动了！' : '')
  if (now !== before) { evidence.counterMoved = true; break }
}
evidence.before = before
evidence.after = await addOnUsed()
mkdirSync(join(ROOT, 'docs', 'probes'), { recursive: true })
const out = join(ROOT, 'docs', 'probes', `qoder-attribution-arm8-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(evidence, null, 2))
console.log('证据 →', out)
process.exit(0)
