#!/usr/bin/env node
// Checks every input this repo hands to a script, without needing a server.
//
// The rule behind each check: a file that is read by install.sh, models.mjs or
// the plugin at startup must fail here rather than at a user's install. JSON is
// parsed, the tier graph is walked in both directions, and agent frontmatter is
// read with the same shape the installer uses.
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Validate a checkout and return every problem found, without printing or
 * exiting, so the same rules can be exercised by tests against broken fixtures.
 *
 * @param {string} root - The repository root to read.
 * @returns {{ problems: string[], tiers: number, agents: number, files: number }}
 */
export function validate(root) {
  const problems = []
  const fail = (message) => problems.push(message)

  function read(file) {
    try {
      // A Windows checkout (or an editor) can add CRLF and a BOM. Both are valid
      // text and neither changes the meaning, so normalise before checking.
      return readFileSync(join(root, file), "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
    } catch (error) {
      fail(`${file}: ${error.message}`)
      return undefined
    }
  }

  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

  function json(file) {
    const text = read(file)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text)
    } catch (error) {
      fail(`${file}: ${error.message}`)
      return undefined
    }
  }

  // --- JSON documents ------------------------------------------------------
  // package-lock is included: a truncated lock breaks `npm ci` in this same job.
  for (const file of [
    "package.json",
    "package-lock.json",
    "tiers.json",
    "rankings.json",
    "tsconfig.json",
    "tsconfig.gui.json",
  ]) {
    json(file)
  }

  const tiersJson = json("tiers.json")
  if (tiersJson !== undefined && !isObject(tiersJson)) fail("tiers.json: must be an object")
  const tiers = isObject(tiersJson) ? tiersJson : {}

  const rankingsJson = json("rankings.json")
  if (rankingsJson !== undefined && !isObject(rankingsJson)) fail("rankings.json: must be an object")
  const rankings = isObject(rankingsJson) ? rankingsJson : {}

  if (tiers.tiers !== undefined && !isObject(tiers.tiers)) fail("tiers.json: tiers must be an object")
  const spec = isObject(tiers.tiers) ? tiers.tiers : {}
  // When tiers.json did not parse, every agent would report as unmapped and bury
  // the one problem that matters. The graph checks wait until it is readable.
  const graphUsable = Object.keys(spec).length > 0

  if (tiers.kinds !== undefined && !Array.isArray(tiers.kinds)) fail("tiers.json: kinds must be an array")
  const kinds = new Set(Array.isArray(tiers.kinds) ? tiers.kinds : [])
  if (tiers.order !== undefined && !Array.isArray(tiers.order)) fail("tiers.json: order must be an array")
  const order = Array.isArray(tiers.order) ? tiers.order : []

  const isBand = (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)

  // --- the tier graph ------------------------------------------------------
  if (Object.keys(spec).length === 0) fail("tiers.json: no tiers defined")

  for (const [name, tier] of Object.entries(spec)) {
    const at = `tiers.json: tiers.${name}`
    // A null or scalar tier used to crash the walker instead of naming the file.
    if (!isObject(tier)) {
      fail(`${at}: must be an object`)
      continue
    }
    if (typeof tier.label !== "string" || tier.label.trim() === "") fail(`${at}: missing label`)
    const pick = tier.pick
    if (!isObject(pick)) {
      fail(`${at}: missing pick, so nothing can be resolved from it`)
      continue
    }
    if (pick.ratio !== undefined && !isBand(pick.ratio)) {
      fail(`${at}.pick.ratio: expected [low, high], got ${JSON.stringify(pick.ratio)}`)
    } else if (isBand(pick.ratio) && pick.ratio[0] > pick.ratio[1]) {
      fail(`${at}.pick.ratio: low ${pick.ratio[0]} is above high ${pick.ratio[1]}`)
    }
    if (pick.byKind !== undefined && !isObject(pick.byKind)) {
      fail(`${at}.pick.byKind: expected an object of kind -> overrides, got ${JSON.stringify(pick.byKind)}`)
    }
    for (const [kind, over] of Object.entries(isObject(pick.byKind) ? pick.byKind : {})) {
      if (kinds.size > 0 && !kinds.has(kind)) fail(`${at}.pick.byKind.${kind}: not in tiers.kinds`)
      // A null override used to throw on `.ratio` rather than report the tier.
      if (!isObject(over)) {
        fail(`${at}.pick.byKind.${kind}: expected an object`)
        continue
      }
      if (over.ratio !== undefined && !isBand(over.ratio)) {
        fail(`${at}.pick.byKind.${kind}.ratio: expected [low, high], got ${JSON.stringify(over.ratio)}`)
      } else if (isBand(over.ratio) && over.ratio[0] > over.ratio[1]) {
        fail(`${at}.pick.byKind.${kind}.ratio: low is above high`)
      }
    }
    // A provider rule that is not an array resolves to nothing, which reads as an
    // empty tier at runtime rather than an error.
    if (pick.providers !== undefined && !Array.isArray(pick.providers)) fail(`${at}.pick.providers: expected an array`)
    if (tier.anchored !== undefined && typeof tier.anchored !== "boolean") fail(`${at}.anchored: expected a boolean`)
  }

  // The consult ladder walks `order` upward, so every name in it must be a tier,
  // and the fallback must resolve to one too.
  for (const name of order) {
    if (!spec[name]) fail(`tiers.json: order names "${name}", which is not a tier`)
  }
  if (tiers.fallback !== undefined && !spec[tiers.fallback]) {
    fail(`tiers.json: fallback "${tiers.fallback}" is not a tier`)
  }

  if (rankings.rank !== undefined && !isObject(rankings.rank)) {
    fail("rankings.json: rank must be an object of model key -> score")
  }

  // --- agents --------------------------------------------------------------
  if (tiers.agents !== undefined && !isObject(tiers.agents)) fail("tiers.json: agents must be an object")
  const agents = isObject(tiers.agents) ? tiers.agents : {}
  for (const [agent, tier] of Object.entries(agents)) {
    if (!spec[tier]) fail(`tiers.json: agents.${agent} points at "${tier}", which is not a tier`)
  }

  let files = []
  try {
    files = readdirSync(join(root, "agents")).filter((file) => file.endsWith(".md"))
  } catch (error) {
    fail(`agents/: ${error.message}`)
  }

  for (const file of files) {
    const id = file.replace(/\.md$/, "")
    const text = read(`agents/${file}`)
    if (text === undefined) continue
    const at = `agents/${file}`

    if (!text.startsWith("---\n")) fail(`${at}: must open with a --- frontmatter block`)
    const end = text.indexOf("\n---", 4)
    if (end === -1) fail(`${at}: frontmatter is not closed with ---`)
    const front = end === -1 ? "" : text.slice(4, end)

    if (!/^description:\s*\S/m.test(front)) fail(`${at}: frontmatter needs a description`)
    const mode = front.match(/^mode:\s*(.+)$/m)?.[1]?.trim()
    // `all` is legitimate here: swarm-lead is the default agent and a conductor at
    // once, so it has to be selectable at top level as well as by a parent.
    if (mode !== "subagent" && mode !== "all") {
      fail(`${at}: mode must be subagent or all, got ${JSON.stringify(mode)}`)
    }

    // The invariant the installer relies on: a model is optional only when the
    // tier is anchored, because an anchored tier resolves the model at runtime
    // and a model line would pin it to a provider chosen at install time.
    const tierName = agents[id]
    if (!graphUsable) continue
    if (!tierName) {
      fail(`${at}: not listed in tiers.json agents, so it never gets a model and is never routed`)
      continue
    }
    const anchored = spec[tierName]?.anchored === true
    const hasModel = /^model:\s*\S/m.test(front)
    if (anchored && hasModel) {
      fail(`${at}: tier "${tierName}" is anchored, so it must not carry a model line`)
    }
    if (!anchored && !hasModel) {
      fail(`${at}: tier "${tierName}" is not anchored, so it needs a model line (run scripts/models.mjs)`)
    }
  }

  return { problems, tiers: Object.keys(spec).length, agents: Object.keys(agents).length, files: files.length }
}

// --- report ----------------------------------------------------------------
const invokedDirectly =
  typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  // No argument checks this checkout; an argument lets a test (or a user)
  // point the same rules at another copy.
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : join(dirname(fileURLToPath(import.meta.url)), "..")
  const { problems, tiers, agents, files } = validate(root)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`)
    console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} found`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${tiers} tiers, ${agents} agent mappings, ${files} agent files`)
  }
}
