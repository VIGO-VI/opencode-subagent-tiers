// A guard, not a unit test: selection must stay catalog-driven. A model id
// written into code is a pick that never follows a price change, a new release
// or a deprecation, and a shipped default that only works on one account.
//
// Agent files carry no model either. `scripts/models.mjs` writes a pin into the
// *installed copy* from the live catalog, so the checkout stays valid when the
// provider or the model is gone.
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Names no selector may spell out, whatever the provider prefix. */
const FAMILY =
  /\b(deepseek|claude|gemini|qwen|gpt-?\d|glm-?\d|mimo|grok|kimi|llama|mistral|sonnet|opus|haiku|perceptron|longcat|minimax)\b/i

/** `provider/model`, the shape a pinned reference takes. */
const REFERENCE = /^[a-z][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i

const NOT_A_MODEL = [
  /^(text|application|image|audio|video|multipart)\//i,
  /\.(ts|tsx|js|mjs|cjs|json|md|sh|css|html)$/i,
  /^[./]/,
  /^https?:/i,
  /[*${}]/,
]

function isModelReference(value) {
  if (!REFERENCE.test(value)) return false
  if (NOT_A_MODEL.some((pattern) => pattern.test(value))) return false
  return true
}

/** Comments are documentation and may name models; code may not. */
function stripComments(text, shell) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "")
  if (shell) {
    out = out.replace(/(^|\s)#.*$/gm, "$1")
    return out
  }
  // A `//` inside a string is not a comment, but every URL in this repository
  // sits inside a string or a comment, and neither can hold a bare model id.
  return out.replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

function literals(text) {
  const found = []
  for (const match of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return found
}

const scanned = [
  ...readdirSync(join(root, "plugin"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => join("plugin", file)),
  ...readdirSync(join(root, "scripts"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => join("scripts", file)),
  "rpc.ts",
  "gui.tsx",
  "install.sh",
  "setup.sh",
].filter((file) => existsSync(join(root, file)))

test("no source file pins a model by name", () => {
  const offences = []
  for (const file of scanned) {
    const shell = file.endsWith(".sh")
    const text = stripComments(readFileSync(join(root, file), "utf8"), shell)
    for (const literal of literals(text)) {
      if (isModelReference(literal) || FAMILY.test(literal)) {
        offences.push(`${file}: ${JSON.stringify(literal)}`)
      }
    }
  }
  assert.deepEqual(offences, [], `a model id must come from the catalog, not from source:\n${offences.join("\n")}`)
})

test("the shipped tiers resolve models instead of naming them", () => {
  const tiers = JSON.parse(readFileSync(join(root, "tiers.json"), "utf8"))
  const named = []
  for (const [name, tier] of Object.entries(tiers.tiers ?? {})) {
    if (Array.isArray(tier?.models) && tier.models.length > 0) {
      named.push(`${name}: ${tier.models.join(", ")}`)
    }
  }
  assert.deepEqual(named, [], `a shipped tier may not carry a \`models\` list:\n${named.join("\n")}`)
})

test("models.mjs resolves installed pins from the catalog", () => {
  const source = readFileSync(join(root, "scripts", "models.mjs"), "utf8")
  assert.match(source, /resolveCandidates\(/, "models.mjs must resolve through the tier policy")
  assert.match(source, /\[\s*"api",\s*"get",\s*"\/api\/model"\s*\]/, "the catalog must be read from the server")
})

test("the checkout ships no model lines in agent files", () => {
  const pinned = []
  for (const file of readdirSync(join(root, "agents")).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(root, "agents", file), "utf8")
    const pin = text.match(/^model:\s*(\S+)/m)?.[1]
    if (pin) pinned.push(`${file}: ${pin}`)
  }
  assert.deepEqual(
    pinned,
    [],
    `a model line in the checkout is a literal that outlives its provider:\n${pinned.join("\n")}`,
  )
})
