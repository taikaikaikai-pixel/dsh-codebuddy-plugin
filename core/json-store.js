/**
 * core/json-store.js — provider-agnostic JSON file persistence and
 * environment/credentials-file key resolution.
 *
 * Extracted from index.js during the core/providers split. Nothing in this
 * file knows anything about any specific upstream gateway.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read a JSON object file; missing/corrupt/non-object all yield {}. */
export function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Atomic file write: tmp sibling + rename, so a crash mid-write never leaves
 * a truncated file behind. Truncation is worse than a clean failure here —
 * a truncated settings.yaml often stays VALID yaml and silently drops config,
 * and a truncated JSON token store reads back as {} (tokens/keys gone).
 * Every write lands a fresh inode, so `mode` reliably applies (credentials
 * and token stores pass 0600 — same discipline as the dsh credentials file).
 */
export function writeTextAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, mode ? { mode } : undefined)
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp never created (e.g. mkdir failed) — nothing to sweep
    }
    throw err
  }
}

/**
 * Write a JSON object file (pretty, trailing newline) atomically.
 * These files carry credentials/tokens, so they are written 0600.
 */
export function writeJson(path, value) {
  writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n', 0o600)
}

/**
 * Resolve a named secret: process environment first, then a flat YAML-ish
 * credentials file (`NAME: value` per line — the ~/.dsh/.credentials.yaml
 * shape dsh uses). Returns null when neither source has it.
 *
 * The file is scanned with string operations, NOT a RegExp built from
 * `envName`: the name is settings-configurable free text, and interpolating
 * it into a pattern would let a crafted name (regex metachar payloads)
 * rewrite what the match accepts. Line-wise parsing keeps the exact
 * previous semantics: a line whose pre-colon part equals envName, with an
 * optional single quote stripped from either end of the value.
 *
 * @param {string|undefined} envName settings-configured reference name
 * @param {string} credFilePath absolute path of the credentials file
 */
export function resolveEnvKey(envName, credFilePath) {
  if (envName && process.env[envName]) return process.env[envName]
  if (envName && existsSync(credFilePath)) {
    for (const line of readFileSync(credFilePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      const colon = trimmed.indexOf(':')
      if (colon <= 0) continue
      // No trim on the name part: the old pattern required envName
      // immediately followed by ':'.
      if (trimmed.slice(0, colon) !== envName) continue
      let value = trimmed.slice(colon + 1).trim()
      // Same optional single-quote stripping the old pattern accepted
      // (asymmetric quotes included), then the same character class:
      // no whitespace, no quotes inside the value.
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) value = value.slice(1)
      if (value.length >= 1 && (value.endsWith('"') || value.endsWith("'"))) {
        value = value.slice(0, -1)
      }
      if (value && !/[\s"']/.test(value)) return value
    }
  }
  return null
}
