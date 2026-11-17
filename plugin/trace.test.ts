import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTrace, defaultTracePath } from "./trace.ts"

/** Keep the test output clean; `line` is documented to warn as well as write. */
function quietly(run: () => void) {
  const original = console.warn
  console.warn = () => {}
  try {
    run()
  } finally {
    console.warn = original
  }
}

test("writes one timestamped line and creates the directory", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-"))
  const path = join(root, "nested", "tier-router.log")
  const trace = createTrace(path)
  assert.equal(trace.path, path)

  quietly(() => {
    trace.line("tier-router: worker/lookup for base x -> y")
    trace.line("tier-router: advisor/code for base x -> z")
  })

  const lines = readFileSync(path, "utf8").trimEnd().split("\n")
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z tier-router: worker\/lookup for base x -> y$/)
  assert.ok(lines[1]?.endsWith("tier-router: advisor/code for base x -> z"))
})

test("false keeps everything off disk", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-"))
  const trace = createTrace(false)
  assert.equal(trace.path, false)
  quietly(() => trace.line("tier-router: nowhere"))
  assert.deepEqual(readdirSync(root), [])
})

test("keeps the file bounded and the newest lines", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-"))
  const path = join(root, "tier-router.log")
  writeFileSync(path, "old\n".repeat(100_000))
  const trace = createTrace(path)

  quietly(() => trace.line("tier-router: the line that must survive"))

  const size = statSync(path).size
  const text = readFileSync(path, "utf8")
  assert.ok(size <= 128_000 + 128, `file is ${size} bytes`)
  assert.ok(text.endsWith("tier-router: the line that must survive\n"))
  assert.ok(!text.startsWith("old"), "the oldest bytes are the ones dropped")
})

test("a target that cannot be written does not throw", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-"))
  const asDirectory = join(root, "is-a-directory")
  mkdirSync(asDirectory)
  const trace = createTrace(asDirectory)

  assert.doesNotThrow(() => quietly(() => trace.line("tier-router: unreadable target")))
})

test("the default path sits in the server's own log directory", () => {
  assert.match(defaultTracePath, /opencode\/log\/tier-router\.log$/)
})
