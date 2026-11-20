#!/bin/sh
# Install the agents and wire the plugin into the global OpenCode config.
# Idempotent: safe to re-run after an edit.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# Default target is this user's OpenCode config. Point it elsewhere for a second
# install, for example a container's config directory:
#   OPENCODE_CONFIG_DIR=~/.local/share/vigo-agent/.config/opencode ./install.sh
config_dir="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
config="$config_dir/opencode.json"

# Resolve each agent's model from the live catalog before copying, so no agent
# file carries a hand-pinned model that can go stale.
if command -v node >/dev/null 2>&1; then
  node "$here/scripts/models.mjs" || echo "model refresh skipped, agent files keep their last model"
else
  echo "node not found: agent models were not refreshed"
fi
# An agent without a model inherits the conductor's, which is the opposite of
# the point — except for an anchored tier, which asks for exactly that and then
# lets the router re-pick within the caller's own price band. Say so loudly for
# everything else rather than install quietly.
anchored=$(node - "$here/tiers.json" <<'NODE' 2>/dev/null
const fs = require("node:fs")
const tiers = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const spec = tiers.tiers ?? {}
console.log(
  Object.entries(tiers.agents ?? {})
    .filter(([, name]) => spec[name] && spec[name].anchored)
    .map(([agent]) => `${agent}.md`)
    .join(" "),
)
NODE
)
for file in "$here"/agents/*.md; do
  base=$(basename "$file")
  case " $anchored " in
    *" $base "*) continue ;;
  esac
  if ! grep -q "^model:" "$file"; then
    echo "WARNING: $base has no model. Run node scripts/models.mjs with a server running."
  fi
done

mkdir -p "$config_dir/agents"
for file in "$here"/agents/*.md; do
  cp "$file" "$config_dir/agents/$(basename "$file")"
  echo "installed agent $(basename "$file")"
done

node - "$config" "$here" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const [configPath, projectDir] = process.argv.slice(2)

let config = { $schema: "https://opencode.ai/config.json" }
if (fs.existsSync(configPath)) {
  const text = fs.readFileSync(configPath, "utf8").trim()
  if (text) config = JSON.parse(text)
}

// --- derive the delegation depth from the permission graph -----------------
// Depth is not a number to guess: it is the longest chain of `subagent` allow
// rules across the agents. Editing which agent may spawn which changes it.
const agentsDir = path.join(projectDir, "agents")
const graph = new Map()
for (const name of fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"))) {
  const id = name.replace(/\.md$/, "")
  const text = fs.readFileSync(path.join(agentsDir, name), "utf8")
  const front = text.split("---")[1] ?? ""
  const allowed = new Set()
  let rule
  for (const line of front.split("\n")) {
    const trimmed = line.trim()
    const act = trimmed.match(/^-\s*action:\s*(.+)$/)
    if (act) {
      rule = { action: act[1].trim(), resource: undefined, effect: undefined }
      continue
    }
    if (!rule) continue
    const res = trimmed.match(/^resource:\s*(.+)$/)
    if (res) {
      rule.resource = res[1].trim()
      continue
    }
    const eff = trimmed.match(/^effect:\s*(.+)$/)
    if (eff) {
      rule.effect = eff[1].trim()
      if (rule.action === "subagent" && rule.effect === "allow" && rule.resource !== "*") {
        allowed.add(rule.resource)
      }
      rule = undefined
    }
  }
  graph.set(id, [...allowed])
}

function longest(from, seen = new Set()) {
  if (seen.has(from)) return 0
  const next = graph.get(from) ?? []
  if (next.length === 0) return 0
  const guard = new Set(seen).add(from)
  return 1 + Math.max(...next.map((child) => longest(child, guard)))
}

// One level of nesting is the main agent plus one child, so edges + 1.
const graphDepth = 1 + Math.max(0, ...graph.keys().map((id) => longest(id)))
// The runtime cap is a ceiling, not a target: permissions still decide which
// agent may spawn which, so the effective chain can be shorter than this.
const depth = Number(process.env.SUBAGENT_DEPTH ?? 3)
console.log(
  `permission graph depth: ${graphDepth}; runtime ceiling subagent_depth: ${depth}` +
    (graphDepth > depth ? " (graph is deeper than the ceiling, raise SUBAGENT_DEPTH)" : ""),
)

const options = JSON.parse(fs.readFileSync(path.join(projectDir, "tiers.json"), "utf8"))

config.experimental = { ...(config.experimental ?? {}), subagent_depth: depth }

// Run new sessions as the conductor and hand every session the delegation rules,
// so a fresh session uses the workers without being told each time. The README
// names the same agent in "What makes an agent actually delegate"; if this value
// changes, that list changes with it.
config.default_agent = "swarm-lead"
const rules = `${projectDir}/AGENTS.md`
const instructions = Array.isArray(config.instructions) ? config.instructions : []
if (!instructions.includes(rules)) instructions.push(rules)
config.instructions = instructions

const plugins = Array.isArray(config.plugins) ? config.plugins : []
const entry = { package: projectDir, options }
const index = plugins.findIndex((item) =>
  typeof item === "string" ? item === projectDir : item?.package === projectDir,
)
if (index === -1) plugins.push(entry)
else plugins[index] = entry
config.plugins = plugins

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wired ${projectDir} into ${configPath}`)
const reminder =
  options.nudge === false ? 0 : typeof options.nudge === "number" && options.nudge > 0 ? options.nudge : 5
console.log(
  reminder > 0
    ? `delegation reminder: on, after ${reminder} requests without a spawn`
    : "delegation reminder: off",
)
NODE
