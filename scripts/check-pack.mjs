#!/usr/bin/env node
// Prove that the tarball npm would publish can actually satisfy every export.
// A missing file here means a user's `package.json` points at nothing, which is
// the kind of breakage that only shows up after a release.
import { readdirSync, readFileSync } from "node:fs"

const [packFile = "pack.json"] = process.argv.slice(2)

function fail(message) {
  console.error(`✖ ${message}`)
  process.exitCode = 1
}

let pkg
let packed
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"))
  const parsed = JSON.parse(readFileSync(packFile, "utf8"))
  // npm has printed both an array and an object keyed by package name.
  packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
} catch (error) {
  fail(`${packFile}: ${error.message} (run npm pack --dry-run --json > ${packFile})`)
  process.exit()
}

const files = new Set((packed?.files ?? []).map((entry) => entry.path))
const required = new Set(["package.json", "README.md"])

// Every export target must be in the tarball, whichever export shape is used.
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const paths =
    typeof target === "string"
      ? [target]
      : ["types", "import", "require", "default"].map((key) => target?.[key]).filter(Boolean)
  if (paths.length === 0) fail(`package.json: exports["${subpath}"] has no usable target`)
  for (const path of paths) required.add(String(path).replace(/^\.\//, ""))
}

// Agents are installed from a checkout, but a tarball that omits them is still
// a lie about what the package contains.
for (const file of readdirSync("agents")) {
  if (file.endsWith(".md")) required.add(`agents/${file}`)
}

if (!Number.isFinite(packed?.size) || packed.size <= 0) fail("the tarball is empty")
for (const file of [...required].sort()) {
  if (!files.has(file)) fail(`${file} is exported or required but not in the tarball`)
}

if (process.exitCode) {
  console.error(`\n${files.size} files packed, ${required.size} required`)
} else {
  console.log(`✓ ${files.size} packed files cover ${required.size} exports and agent files`)
}
