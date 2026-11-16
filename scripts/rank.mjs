#!/usr/bin/env node
// Refresh rankings.json from OpenRouter's unified benchmarks endpoint, which
// aggregates Artificial Analysis, Design Arena and OpenRouter's own GPQA,
// tau-bench and web-search evals.
//
// Usage:
//   node scripts/rank.mjs [--key-file ~/.config/openrouter/key] [--task-type code] [--dry]
//
// The key comes from OPENROUTER_API_KEY or from a file, never from the command
// line, so it stays out of shell history and out of anything shared. The file
// should be readable by you alone (chmod 600).
//
// Without a key this exits non-zero and leaves the vendored prior in place.
// The rate limits are from the endpoint's documentation, not measured here:
// https://openrouter.ai/docs/client-sdks/typescript/sdks/benchmarks/README.md

import { writeFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, "..", "rankings.json")

const keyIndex = process.argv.indexOf("--key-file")
const keyFile = keyIndex === -1 ? undefined : process.argv[keyIndex + 1]
const key =
  process.env.OPENROUTER_API_KEY ??
  (keyFile ? readFileSync(keyFile.replace(/^~/, process.env.HOME ?? ""), "utf8").trim() : undefined)
if (!key) {
  console.error("rank: set OPENROUTER_API_KEY or pass --key-file <path>")
  process.exit(2)
}

const dry = process.argv.includes("--dry")
const taskIndex = process.argv.indexOf("--task-type")
const taskType = taskIndex === -1 ? undefined : process.argv[taskIndex + 1]

const url = new URL("https://openrouter.ai/api/v1/benchmarks")
if (taskType) url.searchParams.set("task_type", taskType)

const response = await fetch(url, {
  headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
})
if (!response.ok) {
  console.error(`rank: ${response.status} ${response.statusText}`)
  console.error((await response.text()).slice(0, 500))
  process.exit(1)
}

const body = await response.json()
const rows = Array.isArray(body?.data) ? body.data : []

// Strip the provider and a trailing revision date, so one family is one key.
function family(slug) {
  const bare = String(slug).split("/").pop() ?? String(slug)
  return bare.replace(/-\d{4,8}$/, "").replace(/-(preview|latest|free)$/, "")
}

// A normalised score on 0-100. Artificial Analysis publishes one directly;
// OpenRouter's own evals publish a 0-1 score; Design Arena publishes Elo.
// Artificial Analysis publishes two absolute 0-100 indices that measure
// different things. Both are kept, in separate tables: `intelligence_index`
// for the general table and `coding_index` for code kinds. They are never
// averaged together, because a model that is strong at code and average
// elsewhere should lead on code and not on everything.
const priority = { "artificial-analysis": 0 }
const general = new Map()
const code = new Map()

for (const row of rows) {
  if (row.source !== "artificial-analysis" || !row?.model_permaslug) continue
  const key = family(row.model_permaslug)
  const put = (table, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return
    const current = table.get(key)
    if (!current || value > current) table.set(key, value)
  }
  put(general, row.intelligence_index)
  put(code, row.coding_index)
}

if (general.size === 0 && code.size === 0) {
  console.error("rank: no model scores found in the response, leaving the file untouched")
  process.exit(1)
}

// A `?` matches any single character, so one pattern covers `v4.1` and `v4-1`,
// and a future release of the family inherits the place until it has its own.
function table(entries) {
  const out = {}
  for (const [key, value] of [...entries.entries()].sort((a, b) => b[1] - a[1])) {
    out[`*${key.replace(/[-.]/g, "?")}*`] = Math.round(value * 10) / 10
  }
  return out
}

const rank = table(general)
const rankByKind = code.size > 0 ? { code: table(code), "code-go": table(code), review: table(code) } : {}

const existing = JSON.parse(readFileSync(target, "utf8"))
const merged = { ...(existing.rank ?? {}), ...rank }
const mergedByKind = {}
for (const [kind, entries] of Object.entries(rankByKind)) {
  mergedByKind[kind] = { ...(existing.rankByKind?.[kind] ?? {}), ...entries }
}
const updated = Object.keys(rank).length
const kept = Object.keys(merged).length - updated
const updatedCode = Object.keys(rankByKind.code ?? {}).length
const result = {
  ...existing,
  _note:
    "Artificial Analysis indices where measured, the hand-set prior elsewhere. `rank` is " +
    "intelligence_index, `rankByKind.code` is coding_index. They are kept apart on purpose: an " +
    "eval score from another source is a different ruler, and averaging rulers reorders models.",
  rank: merged,
  ...(Object.keys(mergedByKind).length > 0 ? { rankByKind: mergedByKind } : {}),
}

if (dry) {
  console.log(JSON.stringify(result, null, 2))
  console.error(`rank: ${updated} general measured, ${updatedCode} code measured, ${kept} prior kept`)
} else {
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`rank: ${updated} general measured, ${updatedCode} code measured, ${kept} prior kept, written to ${target}`)
}
