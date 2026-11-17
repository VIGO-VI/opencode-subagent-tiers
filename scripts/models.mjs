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
import { blendedPrice, resolveCandidates } from "../plugin/select.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const dry = process.argv.includes("--dry")

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
  .map((m) => ({
    ref: { providerID: m.providerID, id: m.id },
    id: m.id,
    providerID: m.providerID,
    price: blendedPrice(m.cost),
    released: Number(m.time?.released ?? 0),
  }))

const table = { ...(rankings.rank ?? {}) }
const changed = []
for (const [agentID, tierName] of Object.entries(tiers.agents ?? {})) {
  const tier = tiers.tiers?.[tierName]
  if (!tier) continue
  const first = resolveCandidates(tier, pool, undefined, table, "general")[0]
  if (!first) continue
  const reference = `${first.ref.providerID}/${first.ref.id}${first.ref.variant ? `#${first.ref.variant}` : ""}`
  const path = join(root, "agents", `${agentID}.md`)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    continue
  }
  const next = /^model: .*$/m.test(text)
    ? text.replace(/^model: .*$/m, `model: ${reference}`)
    : text.replace(/^---\n/, `---\nmodel: ${reference}\n`)
  if (next !== text) {
    changed.push(`${agentID} -> ${reference}`)
    if (!dry) writeFileSync(path, next)
  }
}
console.log(changed.length ? changed.join("\n") : "models already current")
