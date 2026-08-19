/**
 * core/json-store.js — provider-agnostic JSON file persistence and
 * environment/credentials-file key resolution.
 *
 * Extracted from index.js during the core/providers split. Nothing in this
 * file knows anything about any specific upstream gateway.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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

/** Write a JSON object file (pretty, trailing newline), creating parents. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Resolve a named secret: process environment first, then a flat YAML-ish
 * credentials file (`NAME: value` per line — the ~/.dsh/.credentials.yaml
 * shape dsh uses). Returns null when neither source has it.
 *
 * @param {string|undefined} envName settings-configured reference name
 * @param {string} credFilePath absolute path of the credentials file
 */
export function resolveEnvKey(envName, credFilePath) {
  if (envName && process.env[envName]) return process.env[envName]
  if (envName && existsSync(credFilePath)) {
    const m = readFileSync(credFilePath, 'utf8').match(
      new RegExp(`^\\s*${envName}:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'),
    )
    if (m) return m[1]
  }
  return null
}
