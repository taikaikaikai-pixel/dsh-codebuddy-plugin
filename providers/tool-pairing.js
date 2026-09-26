/**
 * providers/tool-pairing.js — 出站 messages 的 tool 配对/可见性不变量修复（两个翻译网关共用）。
 *
 * 为什么需要它（2026-09-22 实测根因，踩坑 #39 + #41）：
 *
 * A. 孤儿 tool（#39）：宿主 `@earendil-works/pi-ai` 的 `transform-messages.js` 会把
 *    `stopReason` 为 `error`/`aborted` 的 assistant 消息**整条丢弃**（理由：中断轮次含
 *    半截推理/工具调用，重放会触发 API 错误），但它产出的 `toolResult` 消息照旧保留——
 *    于是出站序列里出现孤儿 `role:"tool"`（无前置 `assistant.tool_calls`）。
 *
 * B. 不可见 content（#41，真主因）：严格上游（Qoder 的 dmodel/kmodel/mmodel 家族）的
 *    配对校验器**把 `content` 为 `null`/缺键的消息整条当不存在**——`content:null` 的
 *    assistant.tool_calls 声明不再算"preceding message with tool_calls"，`content:null`
 *    的 tool 结果也不再算"responding to tool_call_id"。而 pi-ai 在
 *    `compat.requiresAssistantAfterToolResult === false`（provider 非 deepseek/moonshot/
 *    nvidia… 时的探测默认）下，**每个纯工具轮的 assistant 都是 `content: null`**
 *    （openai-completions.js:961），于是每一个正常工具轮都必 400。修复 A 补的桩若也用
 *    `content: null`，同样被判孤儿（实测同一条 400 文案）。
 *
 * 症状（两因同果）：`provider_error` + details 内层
 *   `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`
 *   （dmodel）/ `Invalid request: tool_call_id is not found`（kmodel）/
 *   `invalid params, tool result's tool id(…) not found (2013)`（mmodel）。
 * 触发一次即永久：失败那轮写进历史后，此后每次请求都带同一坏体（"怎么重试都是同一个错"）。
 *
 * 修复纪律：只补**结构**与**内容可见性**（null↔'' 在 OpenAI 方言里语义等价），
 * 不碰任何字段取值语义——合法非空历史逐字节不变。
 */

/** tool 配对修复时给"不可用"结果用的替代正文（留给模型读）。 */
export const INTERRUPTED_TOOL_RESULT = '(tool result unavailable: previous attempt was interrupted)'

/** assistant / tool 消息 content 为 null/缺失时的替代正文（语义等价，且严格上游认它）。 */
export const EMPTY_CONTENT = ''

/**
 * 修复 OpenAI messages 的 tool 配对 + 内容可见性不变量。
 *
 * - `content` 为 `null`/缺键的 assistant / tool 消息 → 补成 `''`（规则 B）；
 * - 孤儿 `role:"tool"`（前置 assistant 里没有这条 tool_call）→ 补一条仅含该
 *   tool_call 的 assistant 桩（id 取原 tool_call_id，name 取 tool 消息的 name 或
 *   `'tool'`，content 用 `''`），结果原样保留——比丢弃结果更保上下文；
 * - 同 id 的重复结果 → 丢弃（上游会把第二条当孤儿）；
 * - assistant 声明了却没结果的 tool_call（会话收尾 / user 插在结果前）→ 补
 *   {@link INTERRUPTED_TOOL_RESULT} 结果，保住配对。
 *
 * @param {Array} messages OpenAI 方言 messages
 * @returns {{messages: Array, repaired: {orphans: number, synthesized: number, duplicates: number, invisible: number}}}
 */
export function sanitizeToolPairing(messages) {
  const out = []
  const repaired = { orphans: 0, synthesized: 0, duplicates: 0, invisible: 0 }
  let pending = null // 最近一条 assistant 声明、尚未配齐结果的 tool_call id 集合
  let resolved = new Set() // 本 assistant 段内已收到结果的 id（挡同 id 重复结果）

  /** 可见性归一：null/缺失 content → ''（严格上游的配对校验器不认 null 载体）。 */
  const visible = (msg) => {
    if (msg.content !== null && msg.content !== undefined) return msg
    repaired.invisible++
    return { ...msg, content: EMPTY_CONTENT }
  }

  /** 给所有未回结果的 tool_call 补"不可用"结果。 */
  const flushPending = () => {
    if (!pending || !pending.size) return
    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_RESULT })
      repaired.synthesized++
    }
    pending = null
  }

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'assistant') {
      flushPending()
      resolved = new Set()
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      const ids = calls.map((tc) => (typeof tc?.id === 'string' && tc.id ? tc.id : null)).filter(Boolean)
      pending = ids.length ? new Set(ids) : null
      out.push(visible(msg))
      continue
    }
    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      if (id && resolved.has(id)) {
        repaired.duplicates++
        continue
      }
      if (pending && id && pending.has(id)) {
        pending.delete(id)
        resolved.add(id)
        out.push(visible(msg))
        continue
      }
      repaired.orphans++
      const callId = id || `call_orphan_${repaired.orphans}`
      out.push(visible({
        role: 'assistant',
        content: EMPTY_CONTENT,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: typeof msg.name === 'string' && msg.name ? msg.name : 'tool',
            arguments: '{}',
          },
        }],
      }))
      out.push(visible(id ? msg : { ...msg, tool_call_id: callId }))
      if (id) resolved.add(id)
      continue
    }
    // user / system 插在结果之前：补齐未回结果的 tool_call
    flushPending()
    out.push(msg)
  }
  // 会话以未回结果的 tool_call 收尾：同样补齐
  flushPending()
  return { messages: out, repaired }
}

/** 取证日志用的单行摘要（无修复时返回 null）。 */
export function describeRepair(repaired) {
  if (!repaired) return null
  const { orphans = 0, synthesized = 0, duplicates = 0, invisible = 0 } = repaired
  if (!orphans && !synthesized && !duplicates && !invisible) return null
  return `orphans=${orphans} synthesized=${synthesized} duplicates=${duplicates} invisible=${invisible}`
}
