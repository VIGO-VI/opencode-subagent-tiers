// The validator is the gate between a broken checkout and a user's install, so
// it is tested against fixtures that are broken in exactly one way. A check that
// silently stops firing would otherwise look like a passing CI run.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { validate } from "./validate.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

function writeJson(dir, file, value) {
  writeText(dir, file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(dir, file, text) {
  const path = join(dir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function validTiers() {
  return {
    order: ["worker", "advisor"],
    fallback: "advisor",
    kinds: ["general", "code", "lookup"],
    tiers: {
      worker: {
        label: "worker",
        pick: { ratio: [0, 1], prefer: "cost", byKind: { lookup: { prefer: "cost" } } },
      },
      advisor: { label: "advisor", pick: { ratio: [1, 4], prefer: "quality" } },
    },
    agents: { one: "worker", two: "advisor" },
  }
}

function agent({ description = "an agent", mode = "subagent", model = null } = {}) {
  const line = model === null ? "" : `model: ${model}\n`
  return `---\ndescription: ${description}\nmode: ${mode}\n${line}---\n\nBody.\n`
}

/** A complete, valid checkout, small enough to break one field at a time. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tiers-validate-"))
  writeJson(dir, "package.json", { name: "fixture" })
  writeJson(dir, "package-lock.json", { lockfileVersion: 3, packages: {} })
  writeJson(dir, "rankings.json", { rank: { "p/m": 50 } })
  writeJson(dir, "tsconfig.json", {})
  writeJson(dir, "tsconfig.gui.json", {})
  writeJson(dir, "tiers.json", validTiers())
  writeText(dir, "agents/one.md", agent())
  writeText(dir, "agents/two.md", agent())
  return dir
}

function editTiers(dir, mutate) {
  const tiers = validTiers()
  mutate(tiers)
  writeJson(dir, "tiers.json", tiers)
}

/** Assert that a single edit produces a problem matching `pattern`. */
function expectProblem(name, mutate, pattern) {
  test(name, () => {
    const dir = fixture()
    try {
      mutate(dir)
      const { problems } = validate(dir)
      assert.ok(
        problems.some((problem) => pattern.test(problem)),
        `expected a problem matching ${pattern}, got:\n${problems.join("\n") || "(none)"}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("the real checkout passes every rule", () => {
  const result = validate(repoRoot)
  assert.deepEqual(result.problems, [])
  assert.ok(result.tiers > 0)
  assert.ok(result.files > 0)
})

test("a complete fixture passes, so each broken test isolates one edit", () => {
  const dir = fixture()
  try {
    assert.deepEqual(validate(dir).problems, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

expectProblem(
  "a truncated JSON document is reported by file",
  (dir) => writeText(dir, "tiers.json", "{"),
  /tiers\.json: .*JSON/,
)

expectProblem(
  "a truncated lockfile is reported, because npm ci would break too",
  (dir) => writeText(dir, "package-lock.json", '{"lockfileVersion":'),
  /package-lock\.json: .*JSON/,
)

expectProblem(
  "a tier without a label is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      delete tiers.tiers.worker.label
    }),
  /tiers\.worker: missing label/,
)

expectProblem(
  "an inverted ratio band is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.ratio = [2, 1]
    }),
  /low 2 is above high 1/,
)

expectProblem(
  "a byKind that is not a declared kind is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.byKind.hacking = { prefer: "cost" }
    }),
  /byKind\.hacking: not in tiers\.kinds/,
)

expectProblem(
  "an inverted byKind ratio is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.byKind.code = { ratio: [2, 1] }
    }),
  /byKind\.code\.ratio: low is above high/,
)

expectProblem(
  "a provider rule that is not an array is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.providers = "opencode"
    }),
  /pick\.providers: expected an array/,
)

expectProblem(
  "the consult order must name real tiers",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.order.push("ghost")
    }),
  /order names "ghost"/,
)

expectProblem(
  "the fallback must name a real tier",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.fallback = "ghost"
    }),
  /fallback "ghost" is not a tier/,
)

expectProblem(
  "an agent mapped to a missing tier is rejected",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.agents.one = "ghost"
    }),
  /agents\.one points at "ghost"/,
)

expectProblem(
  "an agent file that is not mapped is rejected",
  (dir) => writeText(dir, "agents/three.md", agent()),
  /three\.md: not listed in tiers\.json agents/,
)

expectProblem(
  "an agent needs a description",
  (dir) => writeText(dir, "agents/one.md", "---\nmode: subagent\nmodel: p/m\n---\n"),
  /needs a description/,
)

expectProblem(
  "an agent mode must be subagent or all",
  (dir) => writeText(dir, "agents/one.md", agent({ mode: "primary" })),
  /mode must be subagent or all/,
)

expectProblem(
  "frontmatter must be closed",
  (dir) => writeText(dir, "agents/one.md", "---\ndescription: one\nmode: subagent\nmodel: p/m\n"),
  /frontmatter is not closed/,
)

expectProblem(
  "an agent that names a model is rejected",
  (dir) => writeText(dir, "agents/one.md", agent({ model: "p/m" })),
  /must not name a model/,
)

expectProblem(
  "a rank table that is not an object is rejected",
  (dir) => writeJson(dir, "rankings.json", { rank: [1, 2] }),
  /rank must be an object/,
)

expectProblem(
  "a missing agents directory is reported instead of skipped",
  (dir) => rmSync(join(dir, "agents"), { recursive: true, force: true }),
  /agents\/: .*ENOENT/,
)

test("validate returns the counts the success line prints", () => {
  const dir = fixture()
  try {
    assert.deepEqual(validate(dir), { problems: [], tiers: 2, agents: 2, files: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- counterexamples -------------------------------------------------------
// Each of these was accepted or crashed before it was reported. They are kept
// because a validator whose failure mode is a stack trace is not a gate.

expectProblem(
  "a tier file that is not an object is rejected",
  (dir) => writeJson(dir, "tiers.json", []),
  /tiers\.json: must be an object/,
)

expectProblem(
  "a null tier is reported instead of crashing the walker",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker = null
    }),
  /tiers\.worker: must be an object/,
)

expectProblem(
  "a pick that is an array is not mistaken for a resolver",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick = []
    }),
  /tiers\.worker: missing pick/,
)

expectProblem(
  "byKind must be an object, not a list",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.byKind = []
    }),
  /pick\.byKind: expected an object/,
)

expectProblem(
  "a null byKind override is reported instead of throwing",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.pick.byKind.code = null
    }),
  /byKind\.code: expected an object/,
)

expectProblem(
  "kinds must be an array",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.kinds = "general"
    }),
  /kinds must be an array/,
)

expectProblem(
  "order must be an array",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.order = 5
    }),
  /order must be an array/,
)

expectProblem(
  "agents must be a mapping, not a list",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.agents = []
    }),
  /agents must be an object/,
)

expectProblem(
  "a null rank table is rejected, not treated as an object",
  (dir) => writeJson(dir, "rankings.json", { rank: null }),
  /rank must be an object/,
)

expectProblem(
  "a whitespace-only label does not count as a label",
  (dir) =>
    editTiers(dir, (tiers) => {
      tiers.tiers.worker.label = "   "
    }),
  /tiers\.worker: missing label/,
)

// --- false positives -------------------------------------------------------
// The checks must permit everything the repository actually says is valid.

function expectValid(name, mutate) {
  test(name, () => {
    const dir = fixture()
    try {
      mutate(dir)
      assert.deepEqual(validate(dir).problems, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

expectValid("an anchored tier with no model line is valid", (dir) => {
  editTiers(dir, (tiers) => {
    tiers.tiers.advisor.anchored = true
  })
  writeText(dir, "agents/two.md", agent({ model: null }))
})

expectValid("a CRLF checkout is valid", (dir) => {
  writeText(dir, "agents/one.md", agent().replace(/\n/g, "\r\n"))
  writeText(dir, "agents/two.md", agent().replace(/\n/g, "\r\n"))
})

expectValid("a UTF-8 BOM does not break the frontmatter check", (dir) => {
  writeText(dir, "agents/one.md", `\uFEFF${agent()}`)
})

expectValid("mode all is valid for a conductor", (dir) => {
  writeText(dir, "agents/one.md", agent({ mode: "all" }))
})

test("the CLI exits non-zero and prints each problem", () => {
  const dir = fixture()
  try {
    writeText(dir, "tiers.json", "{")
    const result = spawnSync(process.execPath, [join(repoRoot, "scripts/validate.mjs"), dir], {
      encoding: "utf8",
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /✖ tiers\.json: /)
    assert.match(result.stderr, /\d+ problems? found/)
    assert.equal(result.stdout, "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the CLI accepts a healthy checkout and prints the counts", () => {
  const dir = fixture()
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, "scripts/validate.mjs"), dir], {
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /✓ 2 tiers, 2 agent mappings, 2 agent files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
