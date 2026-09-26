#!/usr/bin/env node
/**
 * Quota-signal map probe (topic 4 of docs/rules/): WHICH endpoints and WHICH
 * response headers carry quota information?
 *
 * Prior inventory (AGENTS.md:26, docs/probes/quota-2026-08-18.json):
 *   - GET /v2/accounts → account metadata (plan type) in body
 *   - POST /v2/billing/meter/get-dosage-notify → low-quota banner source;
 *     healthy shape {dosageNotifyCode:0, dosageNotifyZh:"", ...}
 *   - chat response headers: 12 enumerated, ZERO quota-ish
 *   - numeric remaining quota: NO CLI/api-key reachable API
 *   - per-request usage.credit in chat SSE body
 *
 * What the inventory lacks (this probe's target): a FULL scan across every
 * reachable endpoint of BOTH response headers AND body fields for quota
 * signals, incl. agenttool bodies, error envelopes, and dosage-notify
 * parameter sensitivity.
 *
 * Pre-registered predictions (2026-08-19):
 *   P-Q1  accounts, /v3/config, dosage-notify, and a 12403 error envelope
 *         all carry ZERO quota-ish RESPONSE HEADERS (the chat scan
 *         generalizes: this gateway puts no quota in headers at all)
 *   P-Q2a agenttool search body has NO usage/credit field (the UA-probe
 *         snippet showed {query,type,provider,results} only)
 *   P-Q2b agenttool webfetch body HAS a usage field (index.js:653 records
 *         data?.usage conditionally — predicts it exists)
 *   P-Q3  dosage-notify ignores parameters: {threshold:100} returns the
 *         same healthy shape as {} (dosageNotifyCode 0, empty strings)
 *   P-Q4  the 12403 error response (v3/config with a gate-failing UA)
 *         carries zero quota-ish headers — errors don't leak quota either
 * Exploratory: GET /v2/report existence (CLI endpoint list mentions it).
 *
 * Low rate: 2s spacing, single account, read-only (search max_results=1,
 * webfetch example.com, chat max_tokens=1).
 *
 * Usage: node scripts/probe-quota2.mjs [--out docs/probes/quota-map-YYYY-MM-DD.jsonl]
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const UA = 'CLI/unknown CodeBuddy/2.136.0'
const SPACING_MS = 2000
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join('docs', 'probes', `quota-map-${new Date().toISOString().slice(0, 10)}.jsonl`)

const QUOTA_RE = /quota|credit|limit|remain|balance|dosage|usage|rate|plan/i

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
  if (process.env.CODEBUDDY_API_KEY) return { authorization: `Bearer ${process.env.CODEBUDDY_API_KEY}`, apiKey: process.env.CODEBUDDY_API_KEY }
  const credFile = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^\s*CODEBUDDY_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    if (m) return { authorization: `Bearer ${m[1]}`, apiKey: m[1] }
  }
  throw new Error('no CodeBuddy credential found')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Deep-scan a parsed body for quota-ish KEY NAMES; returns paths. */
function bodyHits(value, path = '', hits = []) {
  if (Array.isArray(value)) value.forEach((v, i) => bodyHits(v, `${path}[${i}]`, hits))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k
      if (QUOTA_RE.test(k)) hits.push(p)
      bodyHits(v, p, hits)
    }
  }
  return hits
}

const redact = (v) => typeof v === 'string'
  ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\b\d{6,}\b/g, '<redacted>')
  : v

async function probe(cred, arm) {
  const headers = { Accept: 'application/json', Authorization: cred.authorization, 'User-Agent': arm.ua ?? UA }
  if (cred.apiKey) headers['x-api-key'] = cred.apiKey
  if (arm.body) headers['Content-Type'] = 'application/json'
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}${arm.path}`, {
      method: arm.method ?? (arm.body ? 'POST' : 'GET'),
      headers,
      body: arm.body ? JSON.stringify(arm.body) : undefined,
    })
    const resHeaders = {}
    res.headers.forEach((v, k) => { resHeaders[k] = v.length > 80 ? v.slice(0, 80) + '…' : v })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* SSE or plain text */ }
    return {
      name: arm.name, path: arm.path, pred: arm.pred, note: arm.note,
      status: res.status,
      headerNames: Object.keys(resHeaders),
      quotaHeaders: Object.keys(resHeaders).filter((k) => QUOTA_RE.test(k)),
      code: json?.code ?? null,
      bodyQuotaPaths: json ? bodyHits(json) : [],
      bodySample: redact(json ? JSON.stringify(json).slice(0, 300) : text.slice(0, 200)),
      ms: Date.now() - t0,
    }
  } catch (err) {
    return { name: arm.name, path: arm.path, pred: arm.pred, note: arm.note, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

const ARMS = [
  { name: 'P-Q1a-accounts', path: '/v2/accounts', pred: 'P-Q1', note: 'zero quota-ish response headers' },
  { name: 'P-Q1b-config', path: '/v3/config', pred: 'P-Q1', note: 'zero quota-ish response headers' },
  { name: 'P-Q1c-dosage', path: '/v2/billing/meter/get-dosage-notify', body: {}, pred: 'P-Q1', note: 'zero quota-ish response headers' },
  { name: 'P-Q4-12403-headers', path: '/v3/config', ua: 'Garbage/0.0', pred: 'P-Q4', note: 'error envelope: zero quota headers' },
  { name: 'P-Q2a-search-body', path: '/agenttool/v1/search', body: { query: 'kimi', type: 'text2text', max_results: 1 }, pred: 'P-Q2a', note: 'search body has NO usage/credit field' },
  { name: 'P-Q2b-webfetch-body', path: '/agenttool/v1/webfetch', body: { url: 'https://example.com/' }, pred: 'P-Q2b', note: 'webfetch body HAS usage field' },
  { name: 'P-Q3-dosage-params', path: '/v2/billing/meter/get-dosage-notify', body: { threshold: 100, level: 'high' }, pred: 'P-Q3', note: 'params ignored: same healthy shape as {}' },
  { name: 'X-report-exists', path: '/v2/report', pred: null, note: 'exploratory: CLI endpoint existence' },
]

const cred = resolveCredential()
mkdirSync(dirname(OUT), { recursive: true })
appendFileSync(OUT, JSON.stringify({ type: 'run', at: new Date().toISOString(), gateway: GATEWAY }) + '\n')
console.log(`evidence → ${OUT}`)

for (const arm of ARMS) {
  const rec = { type: 'probe', ...await probe(cred, arm) }
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(`${arm.name.padEnd(22)} status=${rec.status ?? '-'} code=${rec.code ?? '-'} quotaHeaders=${(rec.quotaHeaders ?? []).length} bodyQuotaPaths=${JSON.stringify(rec.bodyQuotaPaths ?? [])} ${(rec.bodySample ?? rec.error ?? '').slice(0, 100)}`)
  await sleep(SPACING_MS)
}
console.log('done.')
