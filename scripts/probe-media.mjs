#!/usr/bin/env node
/**
 * Probe the CodeBuddy gateway's media endpoints (item 3): image generation,
 * video generation, and 3D candidates. Repeatable; every attempt is appended
 * to the output JSON with the request shape and a SANITIZED response (signed
 * COS URLs are stripped to their path — the query carries credentials).
 *
 * Usage:
 *   node scripts/probe-media.mjs [--out docs/probes/media-<ts>.json]
 *                                  [--prompt "..."] [--model hunyuan-image-v3.0-art]
 *
 * Credentials come from ~/.dsh/codebuddy-plugin.json (active api key); the
 * key is never printed or written to the output file.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const PROMPT = opt('prompt', 'a small red circle centered on a plain white background')
const IMG_MODEL = opt('model', 'hunyuan-image-v3.0-art')
const OUT = opt('out', join(ROOT, 'docs', 'probes', `media-${new Date().toISOString().slice(0, 10)}.json`))

const cfg = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codebuddy-plugin.json'), 'utf8'))
const KEY = cfg.apiKeys?.find((k) => k.name === cfg.activeApiKey)?.key
if (!KEY) { console.error('no active api key in codebuddy-plugin.json'); process.exit(1) }
const BASE = cfg.baseURL ?? 'https://copilot.tencent.com'

const CLI_HEADERS = {
  'User-Agent': 'CLI/unknown CodeBuddy/2.136.0',
  'X-IDE-Type': 'CLI',
  'X-IDE-Name': 'CLI',
  'X-Requested-With': 'XMLHttpRequest',
}

/** Strip signed-url credentials and cap long values for the sample file. */
function sanitize(value, depth = 0) {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      const [base] = value.split('?')
      return value.includes('?') ? `${base}?<signed-query-stripped>` : value
    }
    return value.length > 300 ? `${value.slice(0, 300)}…(${value.length} chars)` : value
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, depth + 1)]))
  }
  return value
}

const records = []

async function attempt(name, path, payload, { cliHeaders = true } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer <redacted-in-sample>',
    ...(cliHeaders ? CLI_HEADERS : {}),
  }
  const t0 = Date.now()
  let record
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text.slice(0, 400) }
    record = { name, path, payload, cliHeaders, status: res.status, ms: Date.now() - t0, body: sanitize(body) }
  } catch (err) {
    record = { name, path, payload, cliHeaders, ms: Date.now() - t0, error: String(err?.message ?? err) }
  }
  records.push({ ts: new Date().toISOString(), ...record })
  console.log(`${record.status ?? 'ERR'} ${String(record.ms).padStart(6)}ms  ${name}  ${JSON.stringify(record.body ?? record.error)?.slice(0, 220)}`)
  return record
}

async function main() {
  console.log(`probing ${BASE} → ${OUT}`)
  // 1. image generation, with and without the CLI-shaped UA
  await attempt('images/generations (CLI headers)', '/v2/images/generations', {
    model: IMG_MODEL, prompt: PROMPT, size: '1024x1024', n: 1,
  })
  await attempt('images/generations (plain UA)', '/v2/images/generations', {
    model: IMG_MODEL, prompt: PROMPT, size: '1024x1024', n: 1,
  }, { cliHeaders: false })
  // 2. video: the catalog lists no video model; historical probe returned
  //    14407 "route config not found" — re-confirm.
  await attempt('videos/generations', '/v2/videos/generations', {
    model: 'hunyuan-video-t2v', prompt: PROMPT,
  })
  // 3. 3D: no CLI trace, no catalog model — probe the obvious candidates.
  await attempt('3d/generations', '/v2/3d/generations', { model: 'hunyuan-3d', prompt: PROMPT })
  await attempt('agenttool 3d', '/agenttool/v1/3d', { prompt: PROMPT })

  // close the JSON array
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(records, null, 2) + '\n')
  console.log(`samples → ${OUT}`)
}

main().catch((err) => {
  console.error(`probe-media crashed: ${err.stack ?? err.message}`)
  process.exit(1)
})
