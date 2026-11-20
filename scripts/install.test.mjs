// install.sh is the only path a user runs, and it writes into their real
// OpenCode config. This drives it end to end against a throwaway config
// directory and a fake `opencode` CLI, so the model refresh, the config merge
// and every repeated run are proven rather than assumed.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const catalog = {
  data: [
    {
      providerID: "opencode",
      id: "free-small",
      enabled: true,
      cost: [{ input: 0, output: 0 }],
      capabilities: { tools: true },
      limit: { context: 32_000 },
      time: { released: 5 },
    },
    {
      providerID: "opencode-go",
      id: "cheap-small",
      enabled: true,
      cost: [{ input: 0.2, output: 0 }],
      capabilities: { tools: true },
      limit: { context: 32_000 },
      time: { released: 4 },
    },
    {
      providerID: "opencode-go",
      id: "mid-model",
      enabled: true,
      cost: [{ input: 1, output: 0 }],
      capabilities: { tools: true },
      limit: { context: 64_000 },
      time: { released: 3 },
    },
    {
      providerID: "opencode-go",
      id: "pricey-model",
      enabled: true,
      cost: [{ input: 10, output: 0 }],
      capabilities: { tools: true },
      limit: { context: 200_000 },
      time: { released: 2 },
    },
  ],
}

/** A throwaway copy of the checkout, a fake CLI and an empty config directory. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tiers-install-"))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, "plugin"), { recursive: true })
  for (const file of ["install.sh", "AGENTS.md", "tiers.json", "rankings.json"]) {
    cpSync(join(repoRoot, file), join(repo, file))
  }
  cpSync(join(repoRoot, "scripts"), join(repo, "scripts"), { recursive: true })
  cpSync(join(repoRoot, "agents"), join(repo, "agents"), { recursive: true })
  // models.mjs imports the resolver directly; it needs no node_modules.
  cpSync(join(repoRoot, "plugin/select.ts"), join(repo, "plugin/select.ts"))

  const bin = join(dir, "bin")
  mkdirSync(bin)
  const cli = join(bin, "opencode")
  writeFileSync(
    cli,
    `#!/bin/sh
case "$*" in
  *"api get /api/model"*) cat "$FAKE_CATALOG" ;;
  *) echo "fake opencode: unsupported command: $*" >&2; exit 1 ;;
esac
`,
  )
  chmodSync(cli, 0o755)

  const catalogPath = join(dir, "catalog.json")
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`)

  return { dir, repo, bin, catalog: catalogPath, config: join(dir, "config") }
}

function install(fixture, env = {}) {
  return spawnSync("sh", [join(fixture.repo, "install.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      FAKE_CATALOG: fixture.catalog,
      OPENCODE_CONFIG_DIR: fixture.config,
      // Probe would issue a real request; the resolver is what this test covers.
      TIER_PROBE: "0",
      ...env,
    },
  })
}

function readConfig(fixture) {
  return JSON.parse(readFileSync(join(fixture.config, "opencode.json"), "utf8"))
}

function agentText(fixture, name) {
  return readFileSync(join(fixture.config, "agents", name), "utf8")
}

function agentModel(fixture, name) {
  return agentText(fixture, name).match(/^model:\s*(.+)$/m)?.[1]?.trim()
}

function cleanup(fixture) {
  rmSync(fixture.dir, { recursive: true, force: true })
}

test("a fresh install copies every agent and writes a wired config", () => {
  const fixture = setup()
  try {
    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /installed agent advisor\.md/)

    // Every source agent reaches the user's config directory.
    const source = readdirSync(join(fixture.repo, "agents")).sort()
    const copied = readdirSync(join(fixture.config, "agents")).sort()
    assert.deepEqual(copied, source)

    // The model refresh ran against the catalog, so no agent keeps a stale pin.
    assert.equal(agentModel(fixture, "swarm-worker.md"), "opencode/free-small")
    assert.equal(agentModel(fixture, "swarm-lead.md"), "opencode-go/mid-model")
    assert.equal(agentModel(fixture, "advisor.md"), "opencode-go/pricey-model")
    // An anchored tier resolves at runtime and must stay unpinned.
    assert.equal(agentModel(fixture, "swarm-peer.md"), undefined)

    const config = readConfig(fixture)
    assert.equal(config.experimental.subagent_depth, 3)
    assert.equal(config.default_agent, "swarm-lead")
    assert.deepEqual(config.instructions, [join(fixture.repo, "AGENTS.md")])

    const tiers = JSON.parse(readFileSync(join(fixture.repo, "tiers.json"), "utf8"))
    assert.equal(config.plugins.length, 1)
    assert.equal(config.plugins[0].package, fixture.repo)
    assert.deepEqual(config.plugins[0].options, tiers)
    assert.match(result.stdout, /permission graph depth: 3/)
    assert.match(result.stdout, /delegation reminder: on, after 5 requests/)
  } finally {
    cleanup(fixture)
  }
})

/** Rewrite the fixture's nudge setting, so the printed reminder can be checked. */
function setNudge(fixture, value) {
  const path = join(fixture.repo, "tiers.json")
  const tiers = JSON.parse(readFileSync(path, "utf8"))
  tiers.nudge = value
  writeFileSync(path, `${JSON.stringify(tiers, null, 2)}\n`)
}

test("a nudge of zero turns the reminder off rather than becoming five", () => {
  const fixture = setup()
  try {
    setNudge(fixture, 0)
    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /delegation reminder: off/)
    assert.doesNotMatch(result.stdout, /after 5 requests/)
  } finally {
    cleanup(fixture)
  }
})

test("a nudge of three is taken literally", () => {
  const fixture = setup()
  try {
    setNudge(fixture, 3)
    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /delegation reminder: on, after 3 requests/)
  } finally {
    cleanup(fixture)
  }
})

test("a second install is idempotent", () => {
  const fixture = setup()
  try {
    assert.equal(install(fixture).status, 0)
    const first = readConfig(fixture)
    const firstAgent = agentText(fixture, "swarm-worker.md")

    const again = install(fixture)
    assert.equal(again.status, 0, again.stderr)
    const second = readConfig(fixture)

    assert.equal(second.plugins.length, 1)
    assert.equal(second.instructions.length, 1)
    assert.deepEqual(second, first)
    assert.equal(agentText(fixture, "swarm-worker.md"), firstAgent)
  } finally {
    cleanup(fixture)
  }
})

test("existing settings and other plugins survive, and a string entry is upgraded", () => {
  const fixture = setup()
  try {
    const existing = {
      $schema: "https://opencode.ai/config.json",
      theme: "night",
      model: "keep/me",
      experimental: { other_flag: true },
      instructions: ["/somewhere/else/AGENTS.md"],
      plugins: ["another-plugin", fixture.repo],
    }
    mkdirSync(fixture.config, { recursive: true })
    writeFileSync(join(fixture.config, "opencode.json"), `${JSON.stringify(existing)}\n`)

    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    const config = readConfig(fixture)

    assert.equal(config.theme, "night")
    assert.equal(config.model, "keep/me")
    assert.equal(config.experimental.other_flag, true)
    assert.equal(config.experimental.subagent_depth, 3)
    assert.deepEqual(config.instructions, ["/somewhere/else/AGENTS.md", join(fixture.repo, "AGENTS.md")])
    // The unrelated plugin is kept, and this checkout appears exactly once as an
    // object now that it carries options.
    assert.equal(config.plugins.length, 2)
    assert.equal(config.plugins[0], "another-plugin")
    assert.equal(config.plugins[1].package, fixture.repo)
  } finally {
    cleanup(fixture)
  }
})

test("SUBAGENT_DEPTH overrides the derived ceiling", () => {
  const fixture = setup()
  try {
    const result = install(fixture, { SUBAGENT_DEPTH: "6" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readConfig(fixture).experimental.subagent_depth, 6)
    assert.match(result.stdout, /runtime ceiling subagent_depth: 6/)
  } finally {
    cleanup(fixture)
  }
})

test("an unreachable catalog skips the refresh and still installs", () => {
  const fixture = setup()
  try {
    writeFileSync(fixture.catalog, "")
    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /model refresh skipped/)
    // The checked-in models are what the user gets when the catalog is offline.
    assert.ok(agentModel(fixture, "swarm-worker.md"))
    assert.equal(readConfig(fixture).default_agent, "swarm-lead")
  } finally {
    cleanup(fixture)
  }
})

test("a non-anchored agent without a model is called out at install time", () => {
  const fixture = setup()
  try {
    const path = join(fixture.repo, "agents", "swarm-worker.md")
    writeFileSync(path, readFileSync(path, "utf8").replace(/^model: .*\n/m, ""))
    writeFileSync(fixture.catalog, "")
    const result = install(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /WARNING: swarm-worker\.md has no model/)
  } finally {
    cleanup(fixture)
  }
})

test("a config file that is not JSON stops the install loudly", () => {
  const fixture = setup()
  try {
    mkdirSync(fixture.config, { recursive: true })
    writeFileSync(join(fixture.config, "opencode.json"), "{not json")
    const result = install(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /JSON|Unexpected token|SyntaxError/)
  } finally {
    cleanup(fixture)
  }
})

test("a top-level config array is refused instead of silently emptied", () => {
  const fixture = setup()
  try {
    mkdirSync(fixture.config, { recursive: true })
    const path = join(fixture.config, "opencode.json")
    writeFileSync(path, "[]\n")
    const result = install(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must contain a JSON object at the top level/)
    // The failed run must not have written a half-built config over it.
    assert.equal(readFileSync(path, "utf8"), "[]\n")
  } finally {
    cleanup(fixture)
  }
})

test("a non-object experimental block is refused", () => {
  const fixture = setup()
  try {
    mkdirSync(fixture.config, { recursive: true })
    writeFileSync(join(fixture.config, "opencode.json"), '{"experimental":"deep"}\n')
    const result = install(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /experimental must be a JSON object/)
  } finally {
    cleanup(fixture)
  }
})

for (const supplied of ["abc", "-2", "0", "2.5", ""]) {
  test(`SUBAGENT_DEPTH=${JSON.stringify(supplied)} falls back to 3, not to null`, () => {
    const fixture = setup()
    try {
      const result = install(fixture, { SUBAGENT_DEPTH: supplied })
      assert.equal(result.status, 0, result.stderr)
      const config = readConfig(fixture)
      assert.equal(config.experimental.subagent_depth, 3)
      assert.match(result.stderr, /not a positive integer; using 3/)
      assert.match(result.stdout, /runtime ceiling subagent_depth: 3/)
    } finally {
      cleanup(fixture)
    }
  })
}

test("a padded positive SUBAGENT_DEPTH is accepted", () => {
  const fixture = setup()
  try {
    const result = install(fixture, { SUBAGENT_DEPTH: " 4 " })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readConfig(fixture).experimental.subagent_depth, 4)
    assert.doesNotMatch(result.stderr, /not a positive integer/)
  } finally {
    cleanup(fixture)
  }
})
