#!/usr/bin/env node
// Write each agent's model from its tier, resolved against the live catalog.
// The tier policy lives in tiers.json, so no agent file pins a model by hand and
// re-running install refreshes every pick. Usage:
//   node scripts/models.mjs [--dry]
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  blendedPrice,
  inferLocalPrice,
  inferLocalRank,
  isLocalProvider,
  modelKey,
  resolveCandidates,
} from "../plugin/select.ts"
import { firstAnswering, probe } from "./probe.mjs"

/** The model an agent file names now, for a message about leaving it alone. */
function currentModel(text) {
  return text.match(/^model: (.*)$/m)?.[1]
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const dry = process.argv.includes("--dry")
// Probing costs one short request per candidate. `--no-probe` keeps an offline
// install working, at the price of trusting the resolver alone.
const probing = !process.argv.includes("--no-probe") && process.env.TIER_PROBE !== "0"

const tiers = JSON.parse(readFileSync(join(root, "tiers.json"), "utf8"))
const rankings = JSON.parse(readFileSync(join(root, "rankings.json"), "utf8"))
// `opencode` is not on PATH for the desktop app, so fall back to the bundled CLI.
const binary =
  process.env.OPENCODE_BIN ??
  (existsSync("/Applications/OpenCode.app/Contents/Resources/opencode-cli")
    ? "/Applications/OpenCode.app/Contents/Resources/opencode-cli"
    : "opencode")
const catalog = JSON.parse(execFileSync(binary, ["api", "get", "/api/model"], { encoding: "utf8" })).data

const pool = catalog
  .filter((m) => m.enabled !== false)
  .map((m) => {
    const context = Number(m.limit?.context ?? 0)
    const local = isLocalProvider(m.providerID)
    const declared = blendedPrice(m.cost)
    return {
      ref: { providerID: m.providerID, id: m.id },
      id: m.id,
      providerID: m.providerID,
      price: declared === 0 && local ? inferLocalPrice(m.id, context) : declared,
      released: Number(m.time?.released ?? 0),
      tools: m.capabilities?.tools !== false,
      context,
      derivedRank: local ? inferLocalRank(m.id, context) : undefined,
    }
  })

const table = { ...(rankings.rank ?? {}) }
const changed = []
// Two agents on one tier share a shortlist, and a probe is a request: ask once.
const dead = []
const answered = new Map()
function attempt(ref) {
  const key = modelKey(ref)
  if (!answered.has(key)) answered.set(key, probe(binary, ref))
  return answered.get(key)
}

for (const [agentID, tierName] of Object.entries(tiers.agents ?? {})) {
  const tier = tiers.tiers?.[tierName]
  if (!tier) continue
  const path = join(root, "agents", `${agentID}.md`)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    continue
  }
  const candidates = resolveCandidates(tier, pool, undefined, table, "general")
  if (candidates.length === 0) continue
  const picked = probing
    ? firstAnswering(candidates, attempt, (line) => console.log(line))
    : { chosen: candidates[0], skipped: [], unverified: undefined }
  if (!picked.chosen) {
    dead.push(`${agentID} (tier ${tierName}): ${path} keeps ${currentModel(text) ?? "no model"}`)
    continue
  }
  if (picked.unverified) console.warn(`unverified pick for ${agentID}: ${picked.unverified}`)
  const first = picked.chosen
  const reference = `${first.ref.providerID}/${first.ref.id}${first.ref.variant ? `#${first.ref.variant}` : ""}`
  const next = /^model: .*$/m.test(text)
    ? text.replace(/^model: .*$/m, `model: ${reference}`)
    : text.replace(/^---\n/, `---\nmodel: ${reference}\n`)
  if (next !== text) {
    changed.push(`${agentID} -> ${reference}`)
    if (!dry) writeFileSync(path, next)
  }
}
if (dead.length) {
  console.warn(
    "no candidate answered for these agents. Their model line was left alone, so it is\n" +
      "unverified at best; the probe reason for each candidate is above:\n  " +
      dead.join("\n  "),
  )
}
console.log(changed.length ? changed.join("\n") : "models already current")
