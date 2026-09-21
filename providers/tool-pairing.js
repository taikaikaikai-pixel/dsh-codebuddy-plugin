/**
 * providers/tool-pairing.js — 出站 messages 的 tool 配对不变量修复（两个翻译网关共用）。
 *
 * 为什么需要它（2026-09-22 Qoder 通道 `provider_error` 根因，踩坑 #39）：
 * 宿主 `@earendil-works/pi-ai` 的 `transform-messages.js` 会把 `stopReason` 为
 * `error`/`aborted` 的 assistant 消息**整条丢弃**（理由：中断轮次含半截推理/工具
 * 调用，重放会触发 API 错误），但它产出的 `toolResult` 消息照旧保留——于是
 * `convertMessages` 产出的出站序列里出现孤儿 `role:"tool"`（无前置
 * `assistant.tool_calls`）。严格上游（Qoder 的 dmodel/kmodel/mmodel 家族实测）直接
 * 400：`Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'`。触发场景一次即永久：失败的那轮 assistant 留在会话历史里，此后每次
 * 请求都带孤儿结果（读者可按"第一次报错后怎么重试都是同一个错"现场症状对照）。
 *
 * 修复纪律：只动 messages 的**结构**，不碰任何字段语义——合法历史逐字节不变。
 */

/** tool 配对修复时给"不可用"结果用的替代正文（中文，留给模型读）。 */
export const INTERRUPTED_TOOL_RESULT = '(tool result unavailable: previous attempt was interrupted)'

/**
 * 修复 OpenAI messages 的 tool 配对不变量。
 *
 * - 孤儿 `role:"tool"`（前置 assistant 里没有这条 tool_call）→ 补一条仅含该
 *   tool_call 的 assistant 桩（id 取原 tool_call_id，name 取 tool 消息的 name 或
 *   `'tool'`），再原样保留结果——比丢弃结果更保上下文（上游实测放行）；
 * - 同 id 的重复结果 → 丢弃（上游会把第二条当孤儿）；
 * - assistant 声明了却没结果的 tool_call（会话收尾 / user 插在结果前）→ 补
 *   {@link INTERRUPTED_TOOL_RESULT} 结果，保住配对。
 *
 * @param {Array} messages OpenAI 方言 messages
 * @returns {{messages: Array, repaired: {orphans: number, synthesized: number, duplicates: number}}}
 */
export function sanitizeToolPairing(messages) {
  const out = []
  const repaired = { orphans: 0, synthesized: 0, duplicates: 0 }
  let pending = null // 最近一条 assistant 声明、尚未配齐结果的 tool_call id 集合
  let resolved = new Set() // 本 assistant 段内已收到结果的 id（挡同 id 重复结果）

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
      out.push(msg)
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
        out.push(msg)
        continue
      }
      repaired.orphans++
      const callId = id || `call_orphan_${repaired.orphans}`
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: typeof msg.name === 'string' && msg.name ? msg.name : 'tool',
            arguments: '{}',
          },
        }],
      })
      out.push(id ? msg : { ...msg, tool_call_id: callId })
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
  const { orphans = 0, synthesized = 0, duplicates = 0 } = repaired
  if (!orphans && !synthesized && !duplicates) return null
  return `orphans=${orphans} synthesized=${synthesized} duplicates=${duplicates}`
}
