#!/bin/sh
# Install the agents and wire the plugin into the global OpenCode config.
# Idempotent: safe to re-run after an edit.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
config="$config_dir/opencode.json"

mkdir -p "$config_dir/agents"
for file in "$here"/agents/*.md; do
  cp "$file" "$config_dir/agents/$(basename "$file")"
  echo "installed agent $(basename "$file")"
done

node - "$config" "$here" <<'NODE'
const fs = require("node:fs")
const [configPath, pluginDir] = process.argv.slice(2)

let config = { $schema: "https://opencode.ai/config.json" }
if (fs.existsSync(configPath)) {
  const text = fs.readFileSync(configPath, "utf8").trim()
  if (text) config = JSON.parse(text)
}

const options = JSON.parse(fs.readFileSync(`${pluginDir}/tiers.json`, "utf8"))

config.experimental = { ...(config.experimental ?? {}), subagent_depth: 3 }

const plugins = Array.isArray(config.plugins) ? config.plugins : []
const entry = { package: pluginDir, options }
const index = plugins.findIndex((item) =>
  typeof item === "string" ? item === pluginDir : item?.package === pluginDir,
)
if (index === -1) plugins.push(entry)
else plugins[index] = entry
config.plugins = plugins

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wired ${pluginDir} into ${configPath}`)
NODE
