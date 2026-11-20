// check-pack is the last gate before a release: it turns a tarball listing into
// a statement about whether every export can be loaded. Test both npm output
// shapes and both failure directions.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = join(dirname(fileURLToPath(import.meta.url)), "check-pack.mjs")

const packedPaths = ["package.json", "README.md", "plugin/index.ts", "dist/gui.cjs", "agents/one.md"]

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tiers-pack-"))
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        exports: { ".": "./plugin/index.ts", "./gui": { import: "./dist/gui.cjs" } },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(dir, "README.md"), "# fixture\n")
  mkdirSync(join(dir, "plugin"))
  writeFileSync(join(dir, "plugin/index.ts"), "export default 1\n")
  mkdirSync(join(dir, "dist"))
  writeFileSync(join(dir, "dist/gui.cjs"), "module.exports = {}\n")
  mkdirSync(join(dir, "agents"))
  writeFileSync(join(dir, "agents/one.md"), "---\ndescription: one\n---\n")
  return dir
}

function pack(dir, files, shape = "object") {
  const entries = files.map((path) => ({ path, size: 10 }))
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ fixture: { files: entries, size: 100 } }))
  if (shape === "array") {
    writeFileSync(join(dir, "pack.json"), JSON.stringify([{ files: entries, size: 100 }]))
  }
}

function run(dir) {
  return spawnSync(process.execPath, [script, "pack.json"], { cwd: dir, encoding: "utf8" })
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test("a complete tarball passes, in npm's object shape", () => {
  const dir = fixture()
  try {
    pack(dir, packedPaths)
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /✓ .* packed files/)
  } finally {
    cleanup(dir)
  }
})

test("a complete tarball passes in the older array shape", () => {
  const dir = fixture()
  try {
    pack(dir, packedPaths, "array")
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    cleanup(dir)
  }
})

test("an export target missing from the tarball is named", () => {
  const dir = fixture()
  try {
    pack(dir, packedPaths.filter((path) => path !== "plugin/index.ts"))
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /plugin\/index\.ts is exported or required but not in the tarball/)
  } finally {
    cleanup(dir)
  }
})

test("a conditional export target is checked too", () => {
  const dir = fixture()
  try {
    pack(dir, packedPaths.filter((path) => path !== "dist/gui.cjs"))
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dist\/gui\.cjs is exported or required but not in the tarball/)
  } finally {
    cleanup(dir)
  }
})

test("an agent file missing from the tarball is named", () => {
  const dir = fixture()
  try {
    pack(dir, packedPaths.filter((path) => path !== "agents/one.md"))
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /agents\/one\.md is exported or required but not in the tarball/)
  } finally {
    cleanup(dir)
  }
})

test("an empty tarball is rejected", () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ fixture: { files: [], size: 0 } }))
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /tarball is empty/)
  } finally {
    cleanup(dir)
  }
})

test("a pack listing that is not JSON is reported, not thrown", () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, "pack.json"), "{not json")
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pack\.json: .*JSON/)
  } finally {
    cleanup(dir)
  }
})
