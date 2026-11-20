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
  kindForAgent,
  languageFor,
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
// The catalog is the only input that needs a live server. A failure here is a
// sentence, not a JSON.parse stack: the install still works with the models the
// agent files already carry, so the message has to say that and say why.
function fail(message, code = 1) {
  console.error(`models.mjs: ${message}`)
  process.exit(code)
}

/** The one failure the installer can act on, so it carries its own exit status. */
const STORAGE_MESSAGE =
  `the server cannot start because its database has no session table, so there is no catalog ` +
  `to resolve against. Agent files keep their current model and nothing was written. ` +
  `Troubleshooting in README.md explains the repair, and the installer offers it from a terminal.`

/**
 * Whether OpenCode's own database is the reason no catalog came back. Checked
 * against the file rather than the log, because the failure only arrives as a
 * line on stderr or in the server's log and the wording is not ours to trust.
 * Returns false when it cannot tell, so the caller falls back to the generic
 * message instead of claiming a cause it did not confirm.
 */
function storageIsUnmigratable() {
  try {
    const paths = execFileSync(binary, ["debug", "paths"], { encoding: "utf8" })
    const line = paths.split("\n").find((entry) => entry.trim().startsWith("db"))
    const db = line?.trim().split(/\s+/)[1]
    if (!db || !existsSync(db)) return false
    const tables = execFileSync("sqlite3", [db, ".tables"], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
    // These builds need one of these two to migrate; without either, a
    // non-empty database is refused outright.
    return tables.length > 0 && !tables.includes("session") && !tables.includes("session_v2")
  } catch {
    return false
  }
}

function readCatalog() {
  let raw
  try {
    raw = execFileSync(binary, ["api", "get", "/api/model"], {
      encoding: "utf8",
      // Without this the CLI's own failure stack is printed straight at the user,
      // which buries the one sentence that matters under nine frames.
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    // The CLI exits non-zero when the server cannot start, so the storage case
    // lands here far more often than in an empty payload.
    if (storageIsUnmigratable()) fail(STORAGE_MESSAGE, 2)
    // `error.message` is the command plus the child's whole stderr, stack
    // included. One line is enough to say what happened.
    const detail = String(error?.stderr ?? error?.message ?? error)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop()
    fail(
      `\`${binary} api get /api/model\` failed: ${detail ?? "no output"}. ` +
        `Agent files keep their current model and nothing was written.`,
    )
  }
  // `opencode api` interleaves server diagnostics with the payload on stdout, and
  // a server that failed to initialize answers with one of those lines instead of
  // JSON. Drop the diagnostics before judging what came back, so a log line is
  // never mistaken for a broken payload.
  const payload = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("[server]"))
    .join("\n")
    .trim()
  if (!payload) {
    const said = raw
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
    if (storageIsUnmigratable()) fail(STORAGE_MESSAGE, 2)
    fail(
      `\`${binary} api get /api/model\` returned no model list` +
        (said ? `; the server said ${JSON.stringify(said)}` : "") +
        `. That is a server-side problem rather than a problem in this repository, ` +
        `so check its log and its storage. Agent files keep their current model and nothing was written.`,
    )
  }
  let body
  try {
    body = JSON.parse(payload)
  } catch {
    // The payload may still be wrapped in something a log line was printed
    // beside, so look for the outermost object before giving up.
    const open = payload.indexOf("{")
    const close = payload.lastIndexOf("}")
    body = undefined
    if (open !== -1 && close > open) {
      try {
        body = JSON.parse(payload.slice(open, close + 1))
      } catch {
        body = undefined
      }
    }
    if (!Array.isArray(body?.data)) {
      fail(`the model catalog was not JSON: ${JSON.stringify(payload.slice(0, 200))}`)
    }
  }
  if (!Array.isArray(body?.data)) {
    fail(`the model catalog had no \`data\` array: ${JSON.stringify(payload.slice(0, 200))}`)
  }
  return body.data
}

const catalog = readCatalog()

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
const changed = []// Two agents on one tier share a shortlist, and a probe is a request: ask once.
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
  // An anchored tier is resolved at runtime against the caller's own model, so
  // it has no fixed model to probe for. Writing one would pin the agent to a
  // provider chosen at install time, which is the opposite of the point.
  if (tier.anchored) continue
  const path = join(root, "agents", `${agentID}.md`)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    continue
  }
  // A code agent is ranked on the coding table and carries the language
  // dimension, exactly as the model hook does at runtime.
  const kind = kindForAgent(agentID, tiers.agentKinds)
  const kindTable = kind && rankings.rankByKind?.[kind] ? { ...table, ...rankings.rankByKind[kind] } : table
  const fit = {
    language: languageFor(kind, undefined, rankings.languages ?? {}),
    languages: rankings.languages ?? {},
  }
  const candidates = resolveCandidates(tier, pool, undefined, kindTable, kind, fit)
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
