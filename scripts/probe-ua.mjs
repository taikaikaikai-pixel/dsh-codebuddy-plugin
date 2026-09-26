#!/usr/bin/env node
/**
 * UA-validation probe (topic 1 of docs/rules/): which UA fields does the
 * gateway actually check, and what is the minimal mutation that triggers
 * error 12403 ("check ua")?
 *
 * Hypotheses under test (formed 2026-08-19 from the upstream spell "UA 必须
 * 是 CLI/unknown CodeBuddy/2.136.0，CodeBuddyCode/1.0 被拒 12403"):
 *   H1  the validator parses UA into `<name>/<version>` tokens and requires
 *       a product token `CodeBuddy/<x.y.z>`; other tokens are decorative
 *   H2  the version value itself is not validated (any semver passes)
 *   H3  `CodeBuddyCode/1.0` is rejected because the product NAME differs,
 *       not because of the version or the missing CLI prefix
 *   H4  companion headers (X-Product, X-IDE-*) are not checked on /v3/config
 *   H5  /v2/chat/completions does not validate UA at all (real-byte evidence
 *       already: docs/probes/bridge-flash-ab-2026-08-18.jsonl shows a
 *       deepseek-harness/0.1.0-rc.6 UA succeeding)
 *
 * Method: GET /v3/config (free, non-chat) with one mutated UA per request,
 * 1.5s spacing, single account, read-only. Chat phase costs one max_tokens=1
 * completion per arm (≈0.001 credit each) — disable with --skip-chat.
 *
 * Baseline UA strings come from shipped code / real captures, not from
 * hand reconstruction: the CLI shape is what index.js sends (USER_AGENT),
 * the /v2 baseline is what the bridge dump recorded on the wire.
 *
 * Usage: node scripts/probe-ua.mjs [--only name1,name2] [--skip-chat]
 *        [--out docs/probes/ua-YYYY-MM-DD.jsonl]
 * Prediction round: edit the PREDICT_VARIANTS block after analysing the
 * matrix, then run `node scripts/probe-ua.mjs --set predict`.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const GATEWAY = 'https://copilot.tencent.com'
const BASELINE_UA = 'CLI/unknown CodeBuddy/2.136.0' // index.js USER_AGENT
const SPACING_MS = 1500

const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : null
}
const ONLY = argValue('--only')?.split(',') ?? null
const SET = argValue('--set') ?? 'matrix' // matrix | predict | all
const SKIP_CHAT = process.argv.includes('--skip-chat')
const OUT = argValue('--out')
  ?? join('docs', 'probes', `ua-${new Date().toISOString().slice(0, 10)}.jsonl`)

// --- credential resolution: identical to the plugin's (api-key mode) -------
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

// --- variant table -----------------------------------------------------------
// ua: null → omit the User-Agent header entirely; headers: extra/drop marks.
// dropXProduct removes the X-Product: SaaS header the catalog call normally
// carries (fetchModelCatalog dialect).
const MATRIX_VARIANTS = [
  // group 0 — controls
  { name: 'control-baseline',   ua: BASELINE_UA,                    note: 'shipped UA, expect 200' },
  { name: 'spell-rejected',     ua: 'CodeBuddyCode/1.0',            note: 'the spell says 12403' },
  // group 1 — product token (H1/H3)
  { name: 'product-only',       ua: 'CodeBuddy/2.136.0',            note: 'no CLI prefix at all' },
  { name: 'product-other',      ua: 'CLI/unknown OtherBuddy/2.136.0', note: 'same shape, wrong product' },
  { name: 'cli-only',           ua: 'CLI/unknown',                  note: 'no product token' },
  // group 2 — version value (H2)
  { name: 'version-major-bump', ua: 'CLI/unknown CodeBuddy/9.9.9',  note: 'absurd future version' },
  { name: 'version-patch-bump', ua: 'CLI/unknown CodeBuddy/2.136.1', note: 'patch +1' },
  { name: 'version-low',        ua: 'CLI/unknown CodeBuddy/0.0.1',  note: 'ancient version' },
  { name: 'version-two-part',   ua: 'CLI/unknown CodeBuddy/2.136',  note: 'not full semver' },
  { name: 'version-nonnumeric', ua: 'CLI/unknown CodeBuddy/abc',    note: 'not a number' },
  // group 3 — prefix token shape
  { name: 'ide-ver-filled',     ua: 'CLI/1.0 CodeBuddy/2.136.0',    note: 'unknown → 1.0' },
  { name: 'ide-other',          ua: 'VSC/unknown CodeBuddy/2.136.0', note: 'CLI → VSC' },
  // group 4 — extra tokens / case
  { name: 'suffix-added',       ua: 'CLI/unknown CodeBuddy/2.136.0 Extra/1.0', note: 'trailing token' },
  { name: 'case-cli-lower',     ua: 'cli/unknown CodeBuddy/2.136.0', note: 'lowercase cli' },
  { name: 'case-product-lower', ua: 'CLI/unknown codebuddy/2.136.0', note: 'lowercase product' },
  // group 5 — companion headers (H4)
  { name: 'no-xproduct',        ua: BASELINE_UA, dropXProduct: true, note: 'baseline UA, X-Product dropped' },
  { name: 'no-ua-header',       ua: null,                           note: 'User-Agent omitted entirely' },
]

// Pre-registered predictions, derived from the matrix results (2026-08-19).
// Rule candidate after the matrix: "the UA must contain the substring
// `codebuddy/` (case-insensitive); every other field is decorative".
//   Evidence: product-only passed (no CLI prefix needed), CodeBuddy/abc and
//   CodeBuddy/9.9.9 passed (no version check), codebuddy/2.136.0 passed
//   (case-insensitive), CodeBuddyCode/1.0 FAILED though it contains
//   `codebuddy` → the trailing slash must be part of the match.
// Discriminators:
//   - notcodebuddy: substring rule → 200; token-exact-name rule → 12403
//   - bare-product: substring-with-slash rule → 12403; substring-without-slash
//     rule (`codebuddy` anywhere) → 200
const PREDICT_VARIANTS = [
  { name: 'predict-notcodebuddy', ua: 'NotCodeBuddy/1.0', expect: 200,   rule: 'R1', note: 'substring rule predicts pass' },
  { name: 'predict-bare-product', ua: 'CodeBuddy',        expect: 12403, rule: 'R1', note: 'no slash → substring absent' },
  { name: 'predict-uppercase',    ua: 'X/y CODEBUDDY/1',  expect: 200,   rule: 'R1', note: 'uppercase token, minimal version' },
]

// Round 2 (2026-08-19): predict-uppercase MISSED (12403) while matrix
// `codebuddy/2.136.0` passed and `CodeBuddy/abc` passed — so neither full
// case-insensitivity nor a version-shape rule explains it. Refined rule
// R1′: the UA must contain one of the exact-case substrings `CodeBuddy/` or
// `codebuddy/` (the casings the official CLI / IDE plugins actually send).
// Pre-registered discriminators:
//   - mixedcase-lowb / caps-b: R1′ → 12403; full-CI rule → 200
//   - uppercase-fullver: isolates casing from the version `1` used in the
//     missed arm — R1′ → 12403 even with the known-good version string
const PREDICT_VARIANTS_R2 = [
  { name: 'predict-mixedcase-lowb',  ua: 'Codebuddy/1.0',            expect: 12403, rule: 'R1′', note: 'lowercase b is not whitelisted' },
  { name: 'predict-caps-b',          ua: 'codeBuddy/1.0',            expect: 12403, rule: 'R1′', note: 'capital B only is not whitelisted' },
  { name: 'predict-uppercase-fullver', ua: 'X/y CODEBUDDY/2.136.0',  expect: 12403, rule: 'R1′', note: 'case isolated from version shape' },
]

// Round 3 (2026-08-19): all R1′ predictions MISSED — Codebuddy/1.0,
// codeBuddy/1.0, CODEBUDDY/2.136.0 (with the X/y prefix!) all PASSED.
// Casing and prefix are therefore irrelevant. The only remaining difference
// in the failed arm `X/y CODEBUDDY/1` is the one-character version `1`.
// Matrix cross-check: CodeBuddy/abc (3) ✓, CodeBuddy/1.0 (3) ✓,
// CodeBuddy/2.136 (5) ✓, CodeBuddy/ (0, matrix product-only… no — bare
// `CodeBuddy` without slash failed). Candidate rule R2:
//   UA must match /codebuddy\/\S{2,}/i — product token + version ≥ 2 chars.
// Pre-registered discriminators:
//   - verlen1 vs verlen2: isolates the boundary exactly
//   - verlen1-space: tokenized parser (\S) → 12403; raw substring (.) → 200
const PREDICT_VARIANTS_R3 = [
  { name: 'predict-verlen1',        ua: 'CodeBuddy/a',   expect: 12403, rule: 'R2', note: 'version length 1 → reject' },
  { name: 'predict-verlen2',        ua: 'CodeBuddy/ab',  expect: 200,   rule: 'R2', note: 'version length 2 → pass' },
  { name: 'predict-verlen1-space',  ua: 'CodeBuddy/1 ',  expect: 12403, rule: 'R2', note: 'trailing space: \\S rule rejects, . rule passes' },
]

// Round 4 (2026-08-19): verlen1 (12403 HIT) and verlen1-space (12403 HIT)
// confirmed the lower boundary; verlen2 MISSED — `ab` (2 chars) was also
// rejected while matrix `abc` (3 chars) passed. Candidate rule R3:
//   UA must match /codebuddy\/\S{3,}/i — version part ≥ 3 non-space chars.
// Pre-registered discriminators:
//   - verlen3-digit: all-digit 3-char version → R3 says pass
//   - verlen4: sanity confirm above the boundary
//   - verlen2-trailspace: \S-rule → 12403; any-char(.{3,}) rule → 200
const PREDICT_VARIANTS_R4 = [
  { name: 'predict-verlen3-digit',     ua: 'CodeBuddy/111',  expect: 200,   rule: 'R3', note: '3-char numeric version passes' },
  { name: 'predict-verlen4',           ua: 'CodeBuddy/abcd', expect: 200,   rule: 'R3', note: '4-char version passes' },
  { name: 'predict-verlen2-trailspace', ua: 'CodeBuddy/ab ', expect: 12403, rule: 'R3', note: 'space does not count toward the 3 chars' },
]

// Round 5 (2026-08-19): R3 collapsed — CodeBuddy/111 (3 chars) and
// CodeBuddy/abcd (4 chars) were BOTH rejected while matrix
// `CLI/unknown CodeBuddy/abc` passed. Re-tabulating all 28 observations
// yields a disjunctive rule R6 that fits every one:
//   R6: UA passes iff it matches /cli\/\S+\s+codebuddy\/\S+/i   (CLI form —
//       any version string) OR /codebuddy\/\d+\.\d+/i (any UA carrying a
//       semver-looking CodeBuddy/x.y token, dot required)
// Key fits: CLI/unknown CodeBuddy/abc ✓ (CLI form, version-free),
// CodeBuddy/abcd ✗ (no dot, no CLI prefix), X/y CODEBUDDY/1 ✗ (prefix not
// "cli", version has no dot), NotCodeBuddy/1.0 ✓ (substring match, token
// start not anchored).
// Pre-registered discriminators:
//   - cli-anyver: CLI form frees the version grammar → 200 (a "version
//     grammar" rule would say 12403 — standalone abcd failed)
//   - cli-minimal: both \S+ slots minimal → 200
//   - semver2-standalone: 2-part semver WITHOUT the CLI prefix (unobserved:
//     matrix only tried 2.136 inside the CLI form) → 200
//   - noncli-anyver: prefix word must be exactly CLI → 12403
//   - cli-noslash: "CLI" without its slash breaks the CLI form → 12403
const PREDICT_VARIANTS_R5 = [
  { name: 'predict-cli-anyver',        ua: 'CLI/unknown CodeBuddy/abcd', expect: 200,   rule: 'R6', note: 'CLI form frees version grammar' },
  { name: 'predict-cli-minimal',       ua: 'CLI/x CodeBuddy/z',          expect: 200,   rule: 'R6', note: 'minimal CLI form' },
  { name: 'predict-semver2-standalone', ua: 'CodeBuddy/2.136',           expect: 200,   rule: 'R6', note: '2-part semver, no CLI prefix' },
  { name: 'predict-noncli-anyver',     ua: 'Wat/unknown CodeBuddy/zzz',  expect: 12403, rule: 'R6', note: 'prefix must be CLI, version grammar not freed' },
  { name: 'predict-cli-noslash',       ua: 'CLI CodeBuddy/abcd',         expect: 12403, rule: 'R6', note: 'CLI without slash is not the CLI form' },
]

// agenttool scope round: the matrix showed /agenttool accepts even
// `CodeBuddy/ab` (predict-agenttool-bad-ua MISS) — the 12403 UA gate does
// NOT fire there for api-key auth, contradicting the spell. Re-test with
// the exact spell-rejected UA and a totally alien one.
// Round 6 (2026-08-19): R6's CLI-form disjunct collapsed (cli-anyver and
// cli-minimal both MISSED) while semver2-standalone / noncli-anyver /
// cli-noslash all HIT. The surviving rule R7 explains 37/38 observations:
//   R7: UA passes iff it contains a substring matching /codebuddy\/\d+\.\d+/i
//       (product token + at least x.y numeric version, dot mandatory)
// Sole contradiction: matrix `CLI/unknown CodeBuddy/abc` PASSED (R7 says
// reject). Retest it both ways; if it rejects now, the matrix row was an
// anomaly. Also probe the grammar edges: digit must follow the slash
// immediately (v-prefix), digit must follow the dot (1.x), and the token
// may sit anywhere in the UA.
const PREDICT_VARIANTS_R6 = [
  { name: 'retest-cli-abc',        ua: 'CLI/unknown CodeBuddy/abc', expect: 12403, rule: 'R7', note: 'matrix anomaly retest, CLI form' },
  { name: 'retest-standalone-abc', ua: 'CodeBuddy/abc',             expect: 12403, rule: 'R7', note: 'matrix anomaly retest, standalone' },
  { name: 'predict-vprefix',       ua: 'CodeBuddy/v1.2',            expect: 12403, rule: 'R7', note: 'digit must immediately follow the slash' },
  { name: 'predict-dot-nondigit',  ua: 'CodeBuddy/1.x',             expect: 12403, rule: 'R7', note: 'digit must immediately follow the dot' },
  { name: 'predict-embedded',      ua: 'MyApp CodeBuddy/3.14 xyz',  expect: 200,   rule: 'R7', note: 'token may sit anywhere in the UA' },
  { name: 'predict-zerozero',      ua: 'CodeBuddy/0.0',             expect: 200,   rule: 'R7', note: 'minimal semver token' },
]

// Round 7 (2026-08-19): five HITs, one MISS — CodeBuddy/1.x PASSED, so the
// character after the dot is unconstrained. Rule R8:
//   R8: UA passes iff it contains /codebuddy\/\d+\./i
//       (product token, ≥1 digit, a literal dot; nothing after the dot is
//       checked; token position and casing unconstrained)
// The earlier `CLI/unknown CodeBuddy/abc` matrix pass did NOT reproduce in
// either retest (12403 both ways) — recorded as a transient anomaly, not
// part of the rule.
// Final boundary confirmations: is anything at all required after the dot,
// and may the version start with a dot?
const PREDICT_VARIANTS_R7 = [
  { name: 'predict-dot-terminal',   ua: 'CodeBuddy/1.',   expect: 200,   rule: 'R8', note: 'nothing needed after the dot' },
  { name: 'predict-dot-first',      ua: 'CodeBuddy/.5',   expect: 12403, rule: 'R8', note: 'version must start with a digit' },
  { name: 'predict-multidigit-dot', ua: 'CodeBuddy/12.',  expect: 200,   rule: 'R8', note: 'multi-digit major, terminal dot' },
]

// Round 8 (2026-08-19): dot-terminal and multidigit-dot HIT, but dot-first
// (.5) MISSED my rejection prediction — a version may START with a dot.
// Combined with v1.2 (reject: dot exists but first char is `v`) and 111
// (reject: digits but no dot), the rule that fits all 41 observations:
//   R9: UA passes iff it contains /codebuddy\/[\d.]*\./i
//       i.e. immediately after the slash: a run of digits/dots containing
//       at least one literal dot; anything may follow; token position and
//       casing unconstrained.
// Pre-registered final discriminators:
//   - baredot / doubledot: absurd per semver intuition, R9 says pass
//   - xdot: dot present but first char outside [\d.] → reject (separates
//     "starts with [\d.]" from "contains a dot anywhere")
//   - dashdot: first char `-` → reject
const PREDICT_VARIANTS_R8 = [
  { name: 'predict-baredot',   ua: 'CodeBuddy/.',    expect: 200,   rule: 'R9', note: 'a lone dot is a valid version' },
  { name: 'predict-doubledot', ua: 'CodeBuddy/..',   expect: 200,   rule: 'R9', note: 'two dots also valid' },
  { name: 'predict-xdot',      ua: 'CodeBuddy/x.',   expect: 12403, rule: 'R9', note: 'dot present but first char not in [\\d.]' },
  { name: 'predict-dashdot',   ua: 'CodeBuddy/-.5',  expect: 12403, rule: 'R9', note: 'first char `-` breaks the class' },
]

// Round 9 (2026-08-19): baredot/doubledot/xdot all HIT; dashdot MISSED my
// rejection prediction — `-` is accepted, pointing at the semver character
// class. Rule R10:
//   R10: UA passes iff it contains /codebuddy\/[\d.-]*\./i
//        (a run of SEMVER chars — digits, dots, hyphens — containing at
//        least one dot, immediately after the product token)
// Pre-registered class boundary: `+` (build metadata) and `_` outside the
// class → reject; `1-2.3` inside → pass; dashdot retest guards against
// another abc-style transient.
const PREDICT_VARIANTS_R9 = [
  { name: 'predict-plusdot',      ua: 'CodeBuddy/+.5',  expect: 12403, rule: 'R10', note: '+ is not a semver version char here' },
  { name: 'predict-underscoredot', ua: 'CodeBuddy/_.5', expect: 12403, rule: 'R10', note: '_ outside the class' },
  { name: 'predict-hyphen-mid',   ua: 'CodeBuddy/1-2.3', expect: 200,  rule: 'R10', note: 'hyphen inside the run, dot present' },
  { name: 'retest-dashdot',       ua: 'CodeBuddy/-.5',  expect: 200,   rule: 'R10', note: 'stability retest after the abc anomaly' },
]

// Round 10 (2026-08-19): plusdot and underscoredot both MISSED (passed),
// hyphen-mid and the dashdot retest HIT. The accepted pre-dot character
// class is wider than semver: every non-letter works, every ASCII letter
// fails. Rule R11, fitting all 45 observations:
//   R11: UA passes iff it contains /codebuddy\/[^a-z\s]*\./i
//        after the product token, a run of NON-ASCII-letter, non-space
//        chars containing at least one literal dot; anything may follow
//        (1.x passed); token position and casing unconstrained.
// Final discriminators: letter AFTER the dot is fine; letter BEFORE the
// dot fails; CJK separates "ASCII-letter class" from Unicode letters;
// a space before the dot breaks the run.
const PREDICT_VARIANTS_R10 = [
  { name: 'predict-symbol-letter-dot', ua: 'CodeBuddy/-.x',  expect: 200,   rule: 'R11', note: 'letter after the dot is unconstrained' },
  { name: 'predict-letter-before-dot', ua: 'CodeBuddy/a.1',  expect: 12403, rule: 'R11', note: 'letter before the dot breaks the run' },
  { name: 'predict-cjk',              ua: 'CodeBuddy/汉.5',  expect: 200,   rule: 'R11', note: 'CJK is outside the ASCII-letter class' },
  { name: 'predict-space-before-dot', ua: 'CodeBuddy/ .',    expect: 12403, rule: 'R11', note: 'space breaks the run' },
]

// Round 11 (2026-08-19): symbol-letter-dot and space-before-dot HIT; the CJK
// arm is untestable (HTTP headers are ByteString — recorded as n/a); and
// letter-before-dot MISSED: `a.1` PASSED while matrix `v1.2` and `x.`
// FAILED. All three are "letter before a dot", so the run-class theory is
// dead. Fit across all 48 observations — R12:
//   R12: the version after codebuddy/ must contain a dot AND satisfy one of
//        (a) first char is not an ASCII letter        (1.x, -.5, ., 12.)
//        (b) it starts with <single letter>.<digit>    (a.1)
//   v1.2 fails (letter then digit before the dot), x. fails (letter, dot,
//   no digit after), abcd/111/abc fail (no dot at all).
// Pre-registered discriminators over the before-dot grammar:
const PREDICT_VARIANTS_R11 = [
  { name: 'predict-two-letters-dot', ua: 'CodeBuddy/ab.1', expect: 12403, rule: 'R12', note: 'two letters before dot → reject' },
  { name: 'predict-letter-digit-dot', ua: 'CodeBuddy/a1.2', expect: 12403, rule: 'R12', note: 'letter+digit before dot → reject (v1.2 pattern)' },
  { name: 'predict-digit-letter-dot', ua: 'CodeBuddy/1a.2', expect: 200,   rule: 'R12', note: 'digit first → (a) applies' },
  { name: 'predict-v-dot',           ua: 'CodeBuddy/v.2',   expect: 200,   rule: 'R12', note: 'v alone before dot matches (b)' },
  { name: 'predict-x-dot-digit',     ua: 'CodeBuddy/x.5',   expect: 200,   rule: 'R12', note: 'x. failed only because nothing followed the dot' },
  { name: 'predict-upper-dot-digit', ua: 'CodeBuddy/Z.9',   expect: 200,   rule: 'R12', note: 'uppercase letter also matches (b)' },
]

// Round 12 (2026-08-19): ab.1 and a1.2 HIT; 1a.2, v.2, x.5, Z.9 all MISSED
// (rejected). So EVERY letter-before-dot version rejects — except the
// one-off `a.1` pass, which now looks like the second anomaly of the same
// kind as the matrix `abc` pass (both reproduced as 12403 on retest).
// Hypothesis: the gateway fronts MULTIPLE validator builds; a minority node
// intermittently accepts looser UAs. Final flapping test: repeat `a.1`
// four times spaced 2s — mixed results confirm multi-validator flapping;
// uniform 12403 means the earlier pass was a transient; uniform 200 would
// force yet another rule revision (not expected).
const PREDICT_VARIANTS_R12 = [
  { name: 'flap-a1-1',      ua: 'CodeBuddy/a.1',   expect: 12403, rule: 'R13', note: 'flapping test 1/4' },
  { name: 'flap-a1-2',      ua: 'CodeBuddy/a.1',   expect: 12403, rule: 'R13', note: 'flapping test 2/4' },
  { name: 'flap-a1-3',      ua: 'CodeBuddy/a.1',   expect: 12403, rule: 'R13', note: 'flapping test 3/4' },
  { name: 'flap-a1-4',      ua: 'CodeBuddy/a.1',   expect: 12403, rule: 'R13', note: 'flapping test 4/4' },
  { name: 'control-good',   ua: 'CodeBuddy/1.0',   expect: 200,   rule: 'R13', note: 'known-good control' },
  { name: 'retest-abc-final', ua: 'CodeBuddy/abc', expect: 12403, rule: 'R13', note: 'second anomaly confirmation' },
]

// agenttool scope round: the matrix showed /agenttool accepts even
// `CodeBuddy/ab` (predict-agenttool-bad-ua MISS) — the 12403 UA gate does
// NOT fire there for api-key auth, contradicting the spell. Re-test with
// the exact spell-rejected UA and a totally alien one.
const AGENTTOOL_ARMS_R2 = [
  { name: 'predict-agenttool-spell-ua', ua: 'CodeBuddyCode/1.0', expect: 200, rule: 'R-scope', note: 'spell claims 12403 on /agenttool; probe predicts the gate is absent' },
  { name: 'predict-agenttool-garbage',  ua: 'Garbage/0.0',       expect: 200, rule: 'R-scope', note: 'alien UA still passes /agenttool' },
]

// Endpoint-scope arms: does /agenttool share the /v3/config UA validator?
// bad-ua arm runs first — if the gate fires (12403) no search is executed.
const AGENTTOOL_ARMS = [
  { name: 'predict-agenttool-bad-ua',  ua: 'CodeBuddy/ab',            expect: 12403, rule: 'R3', note: 'same validator → 12403 before any search work' },
  { name: 'agenttool-baseline',        ua: BASELINE_UA,               expect: 0,     rule: null, note: 'control: real tiny search through the shipped UA' },
]

const CHAT_ARMS = [
  { name: 'chat-garbage-ua', ua: 'Garbage/0.0',  note: 'H5: /v2 ignores UA, expect 200' },
  { name: 'chat-cli-ua',     ua: BASELINE_UA,    note: 'control, expect 200' },
]

const CHAT_ARMS_PREDICT = [
  // 11101 on the matrix run proved garbage UA passes the /v2 UA gate (it
  // failed only on stream:false). This arm completes H5 with a real 200.
  { name: 'predict-chat-stream-garbage-ua', ua: 'Garbage/0.0', stream: true, expect: 0, rule: 'R2', note: 'stream:true + garbage UA → 200/code 0' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function redact(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>')
    .replace(/\b\d{6,}\b/g, '<redacted>')
}

async function probeConfig(cred, v) {
  const headers = { Accept: 'application/json', Authorization: cred.authorization }
  if (cred.apiKey) headers['x-api-key'] = cred.apiKey
  if (!v.dropXProduct) headers['X-Product'] = 'SaaS'
  if (v.ua !== null) headers['User-Agent'] = v.ua
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}/v3/config`, { headers })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    return {
      name: v.name, ua: v.ua, note: v.note, expect: v.expect,
      status: res.status, code: json?.code ?? null,
      msg: redact(json?.msg ?? text.slice(0, 120)), ms: Date.now() - t0,
    }
  } catch (err) {
    return { name: v.name, ua: v.ua, note: v.note, expect: v.expect, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

async function probeChat(cred, arm) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: cred.authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': arm.ua,
      },
      body: JSON.stringify({
        model: 'deepseek-v3', stream: arm.stream === true, max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    if (arm.stream === true) {
      // SSE: we only need the HTTP status — UA rejection (12403) would arrive
      // as a JSON error body instead of an event stream.
      const snippet = await res.text()
      return {
        name: arm.name, ua: arm.ua, note: arm.note, expect: arm.expect,
        status: res.status, code: res.status === 200 ? 0 : null,
        msg: redact(snippet.slice(0, 120)), ms: Date.now() - t0,
      }
    }
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* stream or non-JSON */ }
    return {
      name: arm.name, ua: arm.ua, note: arm.note, expect: arm.expect,
      status: res.status, code: json?.code ?? null,
      msg: redact(json?.msg ?? json?.error?.message ?? text.slice(0, 120)),
      ms: Date.now() - t0,
    }
  } catch (err) {
    return { name: arm.name, ua: arm.ua, note: arm.note, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

async function probeAgentTool(cred, arm) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${GATEWAY}/agenttool/v1/search`, {
      method: 'POST',
      headers: {
        Authorization: cred.authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': arm.ua,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ query: 'kimi', type: 'text2text', max_results: 1 }),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    return {
      name: arm.name, ua: arm.ua, note: arm.note, expect: arm.expect,
      status: res.status, code: json?.code ?? null,
      msg: redact(json?.msg ?? text.slice(0, 120)), ms: Date.now() - t0,
    }
  } catch (err) {
    return { name: arm.name, ua: arm.ua, note: arm.note, expect: arm.expect, error: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

// --- driver ------------------------------------------------------------------
const cred = resolveCredential()
mkdirSync(dirname(OUT), { recursive: true })
const stamp = new Date().toISOString()
appendFileSync(OUT, JSON.stringify({ type: 'run', at: stamp, set: SET, only: ONLY, gateway: GATEWAY }) + '\n')
console.log(`evidence → ${OUT}`)

const variants = SET === 'predict' ? PREDICT_VARIANTS
  : SET === 'predict2' ? PREDICT_VARIANTS_R2
  : SET === 'predict3' ? PREDICT_VARIANTS_R3
  : SET === 'predict4' ? PREDICT_VARIANTS_R4
  : SET === 'predict5' ? PREDICT_VARIANTS_R5
  : SET === 'predict6' ? PREDICT_VARIANTS_R6
  : SET === 'predict7' ? PREDICT_VARIANTS_R7
  : SET === 'predict8' ? PREDICT_VARIANTS_R8
  : SET === 'predict9' ? PREDICT_VARIANTS_R9
  : SET === 'predict10' ? PREDICT_VARIANTS_R10
  : SET === 'predict11' ? PREDICT_VARIANTS_R11
  : SET === 'predict12' ? PREDICT_VARIANTS_R12
  : SET === 'all' ? [...MATRIX_VARIANTS, ...PREDICT_VARIANTS, ...PREDICT_VARIANTS_R2, ...PREDICT_VARIANTS_R3, ...PREDICT_VARIANTS_R4, ...PREDICT_VARIANTS_R5, ...PREDICT_VARIANTS_R6]
  : MATRIX_VARIANTS
const picked = ONLY ? variants.filter((v) => ONLY.includes(v.name)) : variants

// expect 200 = the request passed the UA gate (HTTP 200; body shape differs
// per endpoint: /v3/config wraps code:0, /agenttool returns bare results).
// expect 12403 = rejected at the UA gate with that error code.
function judge(rec) {
  if (rec.expect == null) return ''
  const pass = rec.expect === 200 ? rec.status === 200 : rec.code === rec.expect
  return pass ? ' HIT' : ' MISS'
}

if (picked.length === 0 && SET !== 'predict') console.log('no variants selected')
for (const v of picked) {
  const rec = { type: 'probe', endpoint: '/v3/config', ...await probeConfig(cred, v) }
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(`${v.name.padEnd(20)} status=${rec.status ?? '-'} code=${rec.code ?? '-'} msg=${rec.msg ?? rec.error ?? ''}${judge(rec)}`)
  await sleep(SPACING_MS)
}

if (!SKIP_CHAT) {
  const chatArms = SET === 'predict' ? CHAT_ARMS_PREDICT : SET === 'matrix' ? CHAT_ARMS : []
  for (const arm of chatArms) {
    const rec = { type: 'probe', endpoint: '/v2/chat/completions', ...await probeChat(cred, arm) }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(`${arm.name.padEnd(20)} status=${rec.status ?? '-'} code=${rec.code ?? '-'} msg=${rec.msg ?? rec.error ?? ''}${judge(rec)}`)
    await sleep(SPACING_MS)
  }
}

if (SET === 'predict4' || SET === 'predict5') {
  const arms = SET === 'predict4' ? AGENTTOOL_ARMS : AGENTTOOL_ARMS_R2
  for (const arm of arms) {
    const rec = { type: 'probe', endpoint: '/agenttool/v1/search', ...await probeAgentTool(cred, arm) }
    appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(`${arm.name.padEnd(28)} status=${rec.status ?? '-'} code=${rec.code ?? '-'} msg=${rec.msg ?? rec.error ?? ''}${judge(rec)}`)
    await sleep(SPACING_MS)
  }
}
console.log('done.')
