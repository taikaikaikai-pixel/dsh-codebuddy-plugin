/**
 * providers/trae/gateway.js — OpenAI ↔ Trae 翻译网关（Trae 聊天桥）。
 *
 * 与 core/bridge.js 的分工：core 桥是"透传代理"（上游说 OpenAI 方言，只做
 * 头注入/SSE 聚合）；本网关是"协议翻译器"——Trae 云端说私有方言
 * （/api/agent/v3/*，SSE 事件非 OpenAI 形态），请求与响应都要改写，因此
 * 独立成 Trae 适配器文件而不是给 core/ 加钩子（core 的 30 项回归语义不动）。
 * 复用 core 的原语：SessionLimiter（会话并发闸）与 usage-meter（计量）。
 *
 * 出站协议（证据与置信度，docs/reverse/trae-cloud-api.md 为裁判）：
 *   POST {chatBaseURL}/api/agent/v3/llm_utils_chat   —— 置信度：中
 *     请求信封字段名来自 harness.dll serde 结构提取（role/content/messages/
 *     model_name/is_custom_model/conversation_id/session_id/scene_params/
 *     request_seq）；**未经带凭据联调**，live probe（scripts/probe-trae-live.mjs）
 *     负责校准——发现偏差只改 buildChatRequest 一处。
 *   认证：Authorization: Cloud-IDE-JWT <token> + x-cloudide-token（双头形态，
 *   traework-cn.md §7）+ 设备头组（harness 二进制提取）。
 *   流式：SSE，事件语法未知 → parseTraeEvent 用"容错字段发现"提取
 *     文本增量/用量/结束/错误（候选字段名并集），同样由 live probe 校准。
 *
 * 生命周期纪律（踩坑 #17）：listen 失败绝不抛出——降级为 runtime.lastError，
 * 插件其余功能不受影响。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

import { SessionLimiter } from '../../core/bridge.js'
import { normalizeTraeError, TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE } from './errors.js'

/** Trae 出站静态头组（设备/版本标识；harness.dll strings 提取的字段名）。 */
function traeOutboundHeaders(device) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream,application/json',
    'X-User-Region': 'CN',
    'x-ide-version': '0.1.52',
    'x-app-version-code': '0.1.52',
  }
  if (device?.deviceId) h['x-device-id'] = device.deviceId
  if (device?.machineId) h['x-machine-id'] = device.machineId
  if (device?.deviceBrand) h['x-device-brand'] = device.deviceBrand
  if (device?.deviceCpu) h['x-device-cpu'] = device.deviceCpu
  if (device?.osVersion) h['x-os-version'] = device.osVersion
  return h
}

/**
 * OpenAI messages → Trae llm_utils_chat 请求信封。
 *
 * 置信度中：字段名来自二进制提取。系统消息保留 role:system（结构体 role 为
 * 自由字符串）。多模态 content 数组折叠为纯文本（Trae 走 multi_media 字段，
 * 未接）。stream 由本网关强制（Trae 端点行为未证，保守直发）。
 */
export function buildChatRequest(payload, conversationId) {
  const messages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
          : ''
      return { role: String(m.role ?? 'user'), content }
    })
  return {
    conversation_id: conversationId,
    session_id: conversationId,
    messages,
    model_name: typeof payload.model === 'string' ? payload.model : '',
    is_custom_model: false,
    scene_params: {},
    request_seq: 1,
  }
}

/**
 * 容错解析一个 Trae SSE data JSON → {text?, usage?, finish?, error?}。
 * 事件语法未经联调，按候选字段并集提取；全部未命中返回空对象（跳过）。
 */
export function parseTraeEvent(chunk, eventName) {
  if (chunk == null || typeof chunk !== 'object') return {}
  const out = {}

  // 错误：code !== 0 的信封（mchost 形态）或显式 error 字段。
  if (chunk.error != null || (chunk.code != null && chunk.code !== 0)) {
    out.error = normalizeTraeError(200, chunk)
    return out
  }

  // 文本增量：候选字段按优先级。
  const candidates = [
    chunk.delta, chunk.text, chunk.content, chunk.message?.content,
    chunk.data?.delta, chunk.data?.content, chunk.data?.text,
    Array.isArray(chunk.choices) ? chunk.choices[0]?.delta?.content : null,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) { out.text = c; break }
  }

  // 用量：usage 形态归一为 OpenAI 计数（缺字段的留给计量层兜底）。
  const u = chunk.usage ?? chunk.Usage ?? chunk.data?.usage
  if (u && typeof u === 'object') {
    out.usage = {
      prompt_tokens: u.prompt_tokens ?? u.promptTokens ?? null,
      completion_tokens: u.completion_tokens ?? u.completionTokens ?? null,
      total_tokens: u.total_tokens ?? u.totalTokens ?? null,
    }
  }

  // 结束：显式事件名或布尔/枚举字段。
  const finishFlag = chunk.is_end ?? chunk.isEnd ?? chunk.finished ?? chunk.done
  if (finishFlag === true || ['finish', 'done', 'end', 'message_end'].includes(String(eventName ?? ''))) {
    out.finish = typeof chunk.finish_reason === 'string' ? chunk.finish_reason : 'stop'
  }
  return out
}

/** OpenAI chunk 形态工厂。 */
function oaiChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  }
}

/**
 * @param {{
 *   settings: () => object,            // 需要 traeChatBaseURL / maxConcurrentPerSession
 *   withCredentials: (attempt: (cred) => Promise<Response>) => Promise<{cred,res,err}>,
 *   readAuthDevice: () => object|null, // 设备身份（出站设备头组）
 *   meter: { record: Function },
 *   runtime: { running, port, lastError },
 *   forensics?: { logPath: () => string|undefined },
 *   getCatalogIds: () => string[],     // 已同步目录 id（/models 用）
 * }} deps
 */
export function createTraeGateway(deps) {
  const limiter = new SessionLimiter()
  const logPrefix = '[dsh-codebuddy-plugin/trae]'

  function gwLog(record) {
    const path = deps.forensics?.logPath?.()
    if (!path) return
    try {
      appendFileSync(path, JSON.stringify({ gw: 'trae', ...record }) + '\n')
    } catch { /* best-effort */ }
  }

  /** 提取会话 id（与 core 桥同源的候选序）。 */
  function extractSessionId(headers, payload) {
    for (const c of [headers['x-conversation-id'], headers['x-session-id'], headers['session_id'], payload?.conversation_id, payload?.session_id]) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return null
  }

  async function handleChat(req, res, rawBody) {
    const s = deps.settings()
    let payload = null
    try { payload = JSON.parse(rawBody) } catch { payload = null }
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid chat payload' } }))
      return
    }
    const model = typeof payload.model === 'string' ? payload.model : ''
    const wantStream = payload.stream === true
    const sessionId = extractSessionId(req.headers, payload)
    const conversationId = sessionId ?? randomUUID()
    const t0 = Date.now()

    const release = await limiter.acquire(sessionId, s.maxConcurrentPerSession ?? 4)
    try {
      const { cred, res: upstream0, err } = await deps.withCredentials((c) => {
        const headers = {
          ...traeOutboundHeaders(deps.readAuthDevice()),
          Authorization: c.authorization,
          ...Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, v])),
        }
        return fetch(`${s.traeChatBaseURL}/api/agent/v3/llm_utils_chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildChatRequest(payload, conversationId)),
        })
      })
      if (!cred || err) {
        const isCred = err?.credentialUnavailable === true
        res.writeHead(isCred ? 503 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: isCred ? TRAE_CREDENTIAL_UNAVAILABLE_MESSAGE : `trae upstream unreachable: ${err?.message ?? 'unknown'}` } }))
        return
      }
      const upstream = upstream0
      if (!upstream.ok) {
        const parsed = normalizeTraeError(upstream.status, await upstream.json().catch(() => null))
        res.writeHead(upstream.status === 401 ? 401 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `trae ${parsed.code ?? ''} ${parsed.message}`.trim(), code: parsed.code } }))
        gwLog({ dir: 'err', status: upstream.status, code: parsed.code, model, ms: Date.now() - t0 })
        return
      }

      // 翻译转发：Trae SSE → OpenAI SSE（流式）或聚合（非流式）。
      const id = `trae-gateway-${randomUUID().slice(0, 8)}`
      let content = ''
      let usage = null
      let finishReason = null
      if (wantStream) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let lastEventName = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) { lastEventName = null; continue }
          if (line.startsWith('event:')) { lastEventName = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { finishReason = finishReason ?? 'stop'; continue }
          let chunk = null
          try { chunk = JSON.parse(data) } catch { continue }
          const ev = parseTraeEvent(chunk, lastEventName)
          if (ev.error) {
            if (wantStream && !res.headersSent) { /* fallthrough to error emit below */ }
            const msg = `trae ${ev.error.code ?? ''} ${ev.error.message}`.trim()
            if (wantStream) {
              res.write(`data: ${JSON.stringify({ error: { message: msg, code: ev.error.code } })}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            } else {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: { message: msg, code: ev.error.code } }))
            }
            gwLog({ dir: 'err', model, ms: Date.now() - t0, code: ev.error.code })
            return
          }
          if (ev.text) {
            content += ev.text
            if (wantStream) res.write(`data: ${JSON.stringify(oaiChunk(id, model, { content: ev.text }))}\n\n`)
          }
          if (ev.usage) usage = ev.usage
          if (ev.finish) finishReason = ev.finish
        }
      }
      if (finishReason == null) finishReason = 'stop'
      if (wantStream) {
        const final = oaiChunk(id, model, {}, finishReason)
        if (usage) final.usage = usage
        res.write(`data: ${JSON.stringify(final)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
          usage: usage ?? {},
        }))
      }
      if (usage) deps.meter.record({ ts: t0, kind: 'chat', model: model || null, usage })
      gwLog({ dir: 'out', model, ms: Date.now() - t0, bytes: content.length, usage, finishReason })
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { message: `trae gateway error: ${err?.message ?? err}` } }))
    } finally {
      release()
    }
  }

  function listen(port) {
    const server = createServer((req, res) => {
      let rawBody = ''
      req.on('data', (c) => {
        rawBody += c
        if (rawBody.length > 32 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        const path = req.url?.split('?')[0] ?? ''
        try {
          if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
            handleChat(req, res, rawBody).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end() } })
            return
          }
          if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              object: 'list',
              data: (deps.getCatalogIds() ?? []).map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000) })),
            }))
            return
          }
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${path}` } }))
        } catch (err) {
          if (!res.headersSent) res.writeHead(500)
          res.end(String(err?.message ?? err))
        }
      })
    })
    server.on('error', (err) => {
      deps.runtime.running = false
      deps.runtime.lastError = err?.code ?? String(err?.message ?? err)
      process.stderr.write(`${logPrefix} gateway :${port} unavailable: ${deps.runtime.lastError}（Trae 分区其余功能不受影响）\n`)
    })
    server.on('listening', () => {
      // port=0（临时端口，测试用）时回填实际端口。
      deps.runtime.port = server.address()?.port ?? port
      deps.runtime.running = true
      deps.runtime.lastError = null
    })
    server.listen(port, '127.0.0.1')
    return () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { listen, handleChat }
}
