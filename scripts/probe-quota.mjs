#!/usr/bin/env node
/**
 * Quota-signal probe: what can the plugin's credentials actually learn about
 * the account's remaining quota? Probes every reachable route and records
 * the evidence (docs/probes/). Non-chat probes are free; the chat-header
 * check costs one minimal completion (max_tokens=1, deepseek-v3 ≈0.001 credit).
 *
 *   GET  /v2/accounts                        → account metadata (plan type…)
 *   POST /v2/billing/meter/get-dosage-notify → low-quota banner (the official
 *                                              CLI's BillingService source)
 *   POST /v2/chat/completions (max_tokens=1) → response headers scanned for
 *                                              quota/rate-limit fields
 *
 * Background (2026-08-18): quota is account-level and shared with WorkBuddy
 * (same Tencent-Cloud.coding-copilot auth realm; workbuddy.cn serves the
 * isomorphic device flow at /v2/plugin/auth/state). The web console's numeric
 * plan API (codebuddy.cn/profile/plan) is cookie-authed — not reachable with
 * CLI OAuth tokens or ck_ keys.
 *
 * Usage: node scripts/probe-quota.mjs [--out docs/probes/quota-YYYY-MM-DD.json]
 *        [--model deepseek-v3] [--skip-chat]
 * Credentials resolve exactly like the plugin's: active key from
 * ~/.dsh/codebuddy-plugin.json (fallback: CODEBUDDY_API_KEY / credentials file);
 * in OAuth mode the stored access token is used.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const UA = 'CLI/unknown CodeBuddy/2.136.0'
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : null
}
const MODEL = argValue('--model') ?? 'deepseek-v3'
const SKIP_CHAT = process.argv.includes('--skip-chat')

function resolveCredential() {
  try {
    const cfg = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin.json'), 'utf8'))
    if (cfg.authMode === 'oauth') {
      const auth = JSON.parse(readFileSync(join(DSH_HOME, 'codebuddy-plugin-auth.json'), 'utf8'))
      if (auth?.auth?.accessToken) return { authorization: `Bearer ${auth.auth.accessToken}`, apiKey: null }
    }
    const active = (cfg.apiKeys ?? []).find((k) => k.name === cfg.activeApiKey)
    if (active?.key) return { authorization: `Bearer ${active.key}`, apiKey: active.key }
  } catch { /* fall through */ }
  if (process.env.CODEBUDDY_API_KEY) {
    return { authorization: `Bearer ${process.env.CODEBUDDY_API_KEY}`, apiKey: process.env.CODEBUDDY_API_KEY }
  }
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return { authorization: `Bearer ${m[1]}`, apiKey: m[1] }
  }
  throw new Error('no CodeBuddy credential found')
}

async function probe(name, { method = 'GET', path, body = null, headers = {} }) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* HTML error page */ }
    return { name, method, path, status: res.status, ms: Date.now() - t0, body: json ?? text.slice(0, 200) }
  } catch (err) {
    return { name, method, path, ms: Date.now() - t0, error: String(err?.message ?? err) }
  }
}

const cred = resolveCredential()
const authHeaders = { Authorization: cred.authorization, ...(cred.apiKey ? { 'x-api-key': cred.apiKey } : {}) }

const out = { at: new Date().toISOString(), gateway: GATEWAY, results: [] }

console.log('quota probe: /v2/accounts + get-dosage-notify' + (SKIP_CHAT ? '' : ` + chat headers (${MODEL})`))

out.results.push(await probe('accounts', { path: '/v2/accounts', headers: authHeaders }))
out.results.push(await probe('dosage-notify', {
  method: 'POST',
  path: '/v2/billing/meter/get-dosage-notify',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: {},
}))

if (!SKIP_CHAT) {
  // Minimal streamed chat: capture the RESPONSE HEADERS only and look for
  // quota/rate-limit fields (the usage body is covered by the bridge meter).
  const t0 = Date.now()
  const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      model: MODEL, stream: true, stream_options: { include_usage: true }, max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const headers = {}
  res.headers.forEach((v, k) => { headers[k] = v })
  await res.text()
  const quotaish = Object.keys(headers).filter((k) => /quota|credit|limit|remain|balance|dosage/i.test(k))
  out.results.push({
    name: 'chat-response-headers',
    method: 'POST',
    path: '/v2/chat/completions',
    status: res.status,
    ms: Date.now() - t0,
    quotaRelatedHeaders: quotaish,
    quotaRelatedHeaderCount: quotaish.length,
    headers,
  })
}

for (const r of out.results) {
  const summary = r.error
    ? `error=${r.error}`
    : `http=${r.status} ${JSON.stringify(r.quotaRelatedHeaderCount !== undefined ? { quotaHeaders: r.quotaRelatedHeaderCount } : r.body).slice(0, 300)}`
  console.log(`${r.name.padEnd(22)} ${summary}`)
}

const outPath = argValue('--out')
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  if (existsSync(outPath)) appendFileSync(outPath, '\n')
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', { flag: 'a' })
  console.log(`evidence appended → ${outPath}`)
}
console.log('probe done.')
