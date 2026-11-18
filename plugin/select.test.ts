import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyPricing,
  inferLocalPrice,
  inferLocalRank,
  isLocalProvider,
  budgetFor,
  confidence,
  blendedPrice,
  matches,
  modelKey,
  newestOfFamily,
  parseModel,
  pickCandidates,
  rankFor,
  resolveCandidates,
  withPaidTail,
  type Candidate,
  type TierSpec,
} from "./select.ts"

function candidate(
  id: string,
  price: number,
  released: number,
  providerID = "test",
  extra: Partial<Candidate> = {},
): Candidate {
  return { ref: { providerID, id }, id, providerID, price, released, ...extra }
}

// A catalog shaped like this machine's: a free flash model, cheap flash models,
// the working model, and expensive ones. Prices are blended input+output.
const pool: Candidate[] = [
  candidate("hy4-flash-free", 0, 400),
  candidate("tencent/hy4-flash", 0.175, 350, "router"),
  candidate("mimo-v2.6-flash", 0.42, 360),
  candidate("deepseek-v4.1-flash", 0.75, 380),
  candidate("deepseek-v4-pro", 2.64, 370),
  candidate("glm-5.3", 5.8, 365),
  candidate("qwen3.8-max", 8, 390),
  candidate("grok-4.7", 8, 375),
  candidate("router/pareto-26.10", 4, 395),
]

const rank: Record<string, number> = {
  "*deepseek-v4-pro*": 84,
  "*deepseek-v4.1-flash*": 72,
  "*qwen3.8-max*": 82,
  "*grok-4.7*": 80,
  "*glm-5.3*": 78,
  "*hy4-flash*": 55,
  "*mimo*": 52,
}

const base = "test/deepseek-v4.1-flash"

test("parseModel splits provider, model and variant", () => {
  assert.deepEqual(parseModel("a/b#high"), { providerID: "a", id: "b", variant: "high" })
  assert.deepEqual(parseModel("a/b"), { providerID: "a", id: "b" })
  assert.throws(() => parseModel("nope"))
})

test("blendedPrice adds input and output, missing cost is zero", () => {
  assert.equal(blendedPrice([{ input: 0.15, output: 0.6 }]), 0.75)
  assert.equal(blendedPrice(undefined), 0)
})

test("wildcards match whole values only", () => {
  assert.equal(matches("*flash*", "test/hy4-flash-free"), true)
  assert.equal(matches("test/*", "test/hy4-flash"), true)
  assert.equal(matches("flash", "test/hy4-flash"), false)
})

test("rankFor picks the most specific pattern", () => {
  const model = candidate("deepseek-v4-pro", 2.64, 1)
  const table = { "*deepseek*": 10, "*deepseek-v4-pro*": 84 }
  assert.equal(rankFor(table, model), 84)
})

test("cost preference takes the free model first in the worker band", () => {
  const spec: TierSpec = { pick: { ratio: [0, 0.6], prefer: "cost", limit: 3 } }
  const picked = pickCandidates(spec, pool, base, rank)
  assert.equal(picked.length, 3)
  assert.equal(modelKey(picked[0]!.ref), "test/hy4-flash-free")
  assert.equal(modelKey(picked[1]!.ref), "router/tencent/hy4-flash")
  assert.equal(modelKey(picked[2]!.ref), "test/mimo-v2.6-flash")
})

test("quality preference takes the best ranked model inside the lead band", () => {
  const spec: TierSpec = { pick: { ratio: [0.5, 1.4], prefer: "quality", limit: 3 } }
  const picked = pickCandidates(spec, pool, base, rank)
  assert.equal(modelKey(picked[0]!.ref), "test/deepseek-v4.1-flash")
})

test("quality preference rejects a pricier but lower ranked model", () => {
  const spec: TierSpec = { pick: { ratio: [1.6, 12], prefer: "quality", limit: 3, deny: ["*router*"] } }
  const picked = pickCandidates(spec, pool, base, rank)
  assert.deepEqual(
    picked.map((entry) => entry.ref.id),
    ["deepseek-v4-pro", "qwen3.8-max", "grok-4.7"],
  )
})

test("a newer release of the same family wins a tie", () => {
  const twins: Candidate[] = [
    candidate("deepseek-v4.1-flash", 0.75, 100),
    candidate("deepseek-v4.2-flash", 0.75, 200),
  ]
  const table = { "*deepseek-v4*flash*": 72 }
  const spec: TierSpec = { pick: { ratio: [0.5, 1.4], prefer: "quality", limit: 1 } }
  const picked = pickCandidates(spec, twins, base, table)
  assert.equal(picked[0]!.ref.id, "deepseek-v4.2-flash")
})

test("the ratio follows the base model, so an expensive base lifts every tier", () => {
  const spec: TierSpec = { pick: { ratio: [1.6, 12], prefer: "quality", limit: 1 } }
  const cheapBase = pickCandidates(spec, pool, "test/deepseek-v4.1-flash", rank)
  const expensiveBase = pickCandidates(spec, pool, "test/qwen3.8-max", rank)
  assert.equal(cheapBase[0]!.ref.id, "deepseek-v4-pro")
  // Against an 8-dollar base, 1.6x-12x starts at 12.8, so nothing fits the band
  // and the pool is used as-is: the highest ranked model still wins.
  assert.equal(expensiveBase[0]!.ref.id, "deepseek-v4-pro")
})

test("a zero-price base falls back to the median price anchor", () => {
  const spec: TierSpec = { pick: { ratio: [1.6, 12], prefer: "quality", limit: 1 } }
  const picked = pickCandidates(spec, pool, "test/hy4-flash-free", rank)
  assert.ok(picked.length === 1)
})

test("a named list still resolves and a family alias takes the newest release", () => {
  const spec: TierSpec = { models: ["test/deepseek-v4.1-flash#high", "test/~hy4-flash"] }
  const picked = resolveCandidates(spec, pool, base)
  assert.deepEqual(picked[0], {
    ref: { providerID: "test", id: "deepseek-v4.1-flash", variant: "high" },
    note: "named",
  })
  assert.equal(picked[1]!.ref.id, "hy4-flash-free")
})

test("free tiers come first, opencode before the router, then a cheap paid model", () => {
  const mixed: Candidate[] = [
    candidate("tencent/hy4-flash", 0.175, 350, "console-openrouter"),
    candidate("hy4-flash-free", 0, 400, "opencode-go"),
    candidate("particle-1:free", 0, 390, "console-openrouter"),
    candidate("deepseek-v4.1-flash", 0.75, 380, "opencode-go"),
  ]
  const spec: TierSpec = {
    pick: { ratio: [0, 1.5], prefer: "cost", limit: 4, providerOrder: ["opencode-go", "console-openrouter"] },
  }
  const picked = pickCandidates(spec, mixed, base, rank)
  assert.deepEqual(
    picked.map((entry) => `${entry.ref.providerID}:${entry.ref.id}`),
    [
      "opencode-go:hy4-flash-free",
      "console-openrouter:particle-1:free",
      "opencode-go:deepseek-v4.1-flash",
      "console-openrouter:tencent/hy4-flash",
    ],
  )
})

test("a task kind overrides the rank table", () => {
  const spec: TierSpec = {
    pick: {
      ratio: [1.6, 12],
      prefer: "quality",
      limit: 1,
      byKind: { "code-go": { rank: { "*grok-4.7*": 95 } } },
    },
  }
  const general = pickCandidates(spec, pool, base, rank)
  const coding = pickCandidates(spec, pool, base, rank, "code-go")
  assert.equal(general[0]!.ref.id, "deepseek-v4-pro")
  assert.equal(coding[0]!.ref.id, "grok-4.7")
})

test("a lookup kind can prefer cost over quality", () => {
  const spec: TierSpec = {
    pick: {
      ratio: [0.5, 12],
      prefer: "quality",
      limit: 1,
      byKind: { lookup: { prefer: "cost", ratio: [0, 2] } },
    },
  }
  const picked = pickCandidates(spec, pool, base, rank, "lookup")
  assert.equal(picked[0]!.ref.id, "hy4-flash-free")
})

test("an unranked model is neutral rather than best", () => {
  const mixed: Candidate[] = [
    candidate("known", 8, 100),
    candidate("unknown", 8, 90),
  ]
  const table = { known: 70 }
  const spec: TierSpec = { pick: { ratio: [0, 20], prefer: "quality", limit: 2 } }
  const picked = pickCandidates(spec, mixed, base, table)
  assert.equal(picked[0]!.ref.id, "known")
})

test("free slots cap how many free candidates are tried before paid ones", () => {
  const frees: Candidate[] = [
    candidate("a-free", 0, 400),
    candidate("b-free", 0, 390),
    candidate("c-free", 0, 380),
    candidate("tencent", 0.175, 350, "router"),
    candidate("deepseek-v4.1-flash", 0.75, 385),
  ]
  const spec: TierSpec = { pick: { ratio: [0, 0.6], prefer: "cost", limit: 3, freeSlots: 1 } }
  const picked = pickCandidates(spec, frees, base, rank)
  assert.deepEqual(
    picked.map((entry) => entry.ref.id),
    ["a-free", "tencent", "b-free"],
  )
})

test("free slots go round the providers before one crowds the others out", () => {
  const mixed: Candidate[] = [
    candidate("a-free", 0, 400, "opencode-go"),
    candidate("b-free", 0, 390, "opencode-go"),
    candidate("c-free", 0, 380, "opencode-go"),
    candidate("d-free", 0, 370, "console-openrouter"),
    candidate("e-free", 0, 360, "console-openrouter"),
    candidate("paid", 0.2, 350, "opencode-go"),
    candidate("deepseek-v4.1-flash", 0.75, 340, "opencode-go"),
  ]
  const spec: TierSpec = {
    pick: {
      ratio: [0, 1.5],
      prefer: "cost",
      limit: 3,
      freeSlots: 3,
      providerOrder: ["opencode-go", "console-openrouter"],
    },
  }
  const picked = pickCandidates(spec, mixed, "opencode-go/deepseek-v4.1-flash", rank)
  assert.deepEqual(
    picked.map((entry) => entry.ref.id),
    ["a-free", "d-free", "b-free"],
  )
})

test("newestOfFamily returns undefined when the family is absent", () => {
  assert.equal(newestOfFamily("nope", pool), undefined)
})

test("a share budget grows with the session and is capped hard", () => {
  const spec = { share: 0.05, hardCap: 20_000, floor: 40_000 }
  // 5% of 40k floor = 2000, so the first 1900 tokens fit
  assert.equal(budgetFor(spec, 0, 0, 1900).allowed, true)
  assert.equal(budgetFor(spec, 0, 0, 2100).allowed, false)
  // 5% of 200k = 10k
  assert.equal(budgetFor(spec, 200_000, 0, 9_000).allowed, true)
  // 5% of 1M = 50k, but the hard cap is 20k
  const capped = budgetFor(spec, 1_000_000, 0, 25_000)
  assert.equal(capped.allowed, false)
  assert.equal(capped.bound, "hardCap")
  assert.equal(capped.limit, 20_000)
})

test("a justification lifts the share but never the hard cap", () => {
  const spec = { share: 0.01, hardCap: 20_000, floor: 0, bypass: true }
  const refused = budgetFor(spec, 100_000, 900, 500)
  assert.equal(refused.allowed, false)
  const allowed = budgetFor(spec, 100_000, 900, 500, "the same test failed twice and the answer decides the design")
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.bypassed, true)
  const tooShort = budgetFor(spec, 100_000, 900, 500, "stuck")
  assert.equal(tooShort.allowed, false)
  const overCap = budgetFor({ ...spec, hardCap: 1_000 }, 100_000, 900, 500, "a long enough justification here")
  assert.equal(overCap.allowed, false)
})

test("a declared price replaces the catalog price, most specific first", () => {
  assert.equal(applyPricing(0.75, undefined, "opencode-go/x"), 0.75)
  assert.equal(applyPricing(0.75, { "anthropic/*": "free" }, "anthropic/x"), 0)
  assert.equal(applyPricing(0.75, { "*": 0.01, "opencode-go/*": 0.2 }, "opencode-go/x"), 0.2)
  assert.equal(applyPricing(0.75, { "opencode-go/*": 0.2, "*": 0.01 }, "other/x"), 0.01)
})

test("value preference buys rank per dollar", () => {
  const pool2: Candidate[] = [
    candidate("expensive-strong", 8, 100),
    candidate("cheap-good", 0.8, 90),
    candidate("free-weak", 0, 40),
  ]
  const table = { "expensive-strong": 90, "cheap-good": 85, "free-weak": 40 }
  const spec: TierSpec = { pick: { ratio: [0, 20], prefer: "value", limit: 1 } }
  const picked = pickCandidates(spec, pool2, "test/cheap-good", table)
  // 85 / 1.8 beats 90 / 9 and beats 40 / 1
  assert.equal(picked[0]!.ref.id, "cheap-good")
})

test("a report with evidence and no hedging scores high", () => {
  const good = confidence(
    "Answer: Pop unlocks at line 32.\nEvidence: queue.go:32 quotes q.mu.Unlock(), and the suite ran:\n$ go test ./...\nok  queue 0.02s\nGaps: none.",
  )
  assert.equal(good.score, 1)
  assert.deepEqual(good.missing, [])
})

test("a hedging report without evidence scores low and names what is missing", () => {
  const weak = confidence("Uncertain, I could not find it.")
  assert.ok(weak.score < 0.2)
  assert.ok(weak.missing.includes("no file:line citation"))
  assert.ok(weak.missing.includes("the worker hedged"))
})

test("a model without tools, or with too small a context, is not a candidate", () => {
  const mixed: Candidate[] = [
    candidate("no-tools", 0.1, 400, "local", { tools: false, context: 128000 }),
    candidate("small", 0.1, 390, "local", { tools: true, context: 4096 }),
    candidate("good", 0.1, 380, "local", { tools: true, context: 32000 }),
  ]
  const spec: TierSpec = {
    pick: { ratio: [0, 10], prefer: "cost", requireTools: true, minContext: 8000, limit: 3 },
  }
  const picked = pickCandidates(spec, mixed, "local/good", {})
  assert.deepEqual(picked.map((entry) => entry.ref.id), ["good"])
})

test("the cheapest cloud copy of a model wins, and the local copy is kept", () => {
  const mixed: Candidate[] = [
    candidate("same-model", 0.9, 400, "cloud-a", { tools: true, context: 128000 }),
    candidate("same-model", 0.3, 390, "cloud-b", { tools: true, context: 128000 }),
    candidate("same-model", 0.5, 380, "ollama", { tools: true, context: 128000, derivedRank: 60 }),
  ]
  const spec: TierSpec = { pick: { ratio: [0, 10], prefer: "cost", limit: 3, requireTools: true } }
  const picked = pickCandidates(spec, mixed, "cloud-b/same-model", {})
  const providers = picked.map((entry) => entry.ref.providerID)
  assert.deepEqual(providers.sort(), ["cloud-b", "ollama"])
})

test("a local provider is recognised and given stand-in scores", () => {
  assert.equal(isLocalProvider("ollama"), true)
  assert.equal(isLocalProvider("lmstudio"), true)
  assert.equal(isLocalProvider("opencode-go"), false)
  assert.equal(inferLocalPrice("llama-3.1-70b", 128000), 2.8)
  assert.ok(inferLocalPrice("mystery", 128000) > 0.1)
  assert.ok(inferLocalRank("llama-3.1-70b") > inferLocalRank("qwen2.5-7b"))
})

test("a local model without a rank entry uses its derived rank", () => {
  const local: Candidate[] = [
    candidate("big-70b", 0, 400, "ollama", { tools: true, context: 32000, derivedRank: 75 }),
    candidate("small-7b", 0, 390, "ollama", { tools: true, context: 32000, derivedRank: 43 }),
  ]
  const spec: TierSpec = { pick: { ratio: [0, 10], prefer: "quality", limit: 1, requireTools: true } }
  const picked = pickCandidates(spec, local, "ollama/big-70b", {})
  assert.equal(picked[0]!.ref.id, "big-70b")
})

test("a tier with no share and no cap is unbounded", () => {
  const verdict = budgetFor({}, 100_000, 0, 50_000)
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.bound, "none")
  assert.equal(Number.isFinite(verdict.limit), false)
})

// A root provider with free models, the root's own base, and paid models at
// several prices. The tail must reach the root provider's cheapest paid model
// even when the tier's band stops at the free ones, and must never cross to
// another provider.
const tailPool: Candidate[] = [
  candidate("free-a", 0, 100, "root"),
  candidate("free-b", 0, 90, "root"),
  candidate("paid-embed", 0.2, 40, "root"),
  candidate("paid-no-tools", 0.5, 50, "root", { tools: false }),
  candidate("paid-small", 1, 60, "root", { context: 4_000 }),
  candidate("paid-floor", 8, 80, "root"),
  candidate("paid-big", 9, 70, "root", { context: 32_000 }),
  candidate("other-cheap", 0.1, 110, "other"),
]

const workerPick: TierSpec = {
  pick: { ratio: [0, 0.6], prefer: "cost", limit: 2, freeSlots: 3, deny: ["*embed*"], requireTools: true },
}

test("the paid tail is the root provider's cheapest usable paid model, outside the band", () => {
  const picked = withPaidTail(
    resolveCandidates(workerPick, tailPool, "root/base", rank),
    workerPick,
    tailPool,
    "root",
  )
  assert.deepEqual(
    picked.map((entry) => entry.ref.id),
    ["free-a", "free-b", "paid-small"],
  )
  // A cheaper paid model on another provider is not the session's floor.
  assert.equal(picked.some((entry) => entry.ref.id === "other-cheap"), false)
})

test("a tier whose free candidates are all out still returns the paid tail", () => {
  const picked = withPaidTail(
    resolveCandidates(workerPick, tailPool, "root/base", rank),
    workerPick,
    tailPool,
    "root",
  )
  // This is what the resolver's cooling filter leaves behind when every free
  // candidate has been struck.
  const free = new Set(["free-a", "free-b"])
  const warm = picked.filter((entry) => !free.has(entry.ref.id))
  assert.deepEqual(
    warm.map((entry) => entry.ref.id),
    ["paid-small"],
  )
})

test("the paid tail respects deny, tools and context, and never duplicates a candidate", () => {
  // paid-embed is cheaper but denied by the tier's pattern.
  const defaultTail = withPaidTail([], workerPick, tailPool, "root")
  assert.deepEqual(
    defaultTail.map((entry) => entry.ref.id),
    ["paid-small"],
  )

  // paid-no-tools is cheaper than paid-small but cannot call tools, so the
  // assertion above also proves the tool-capable filter.
  const noDeny: TierSpec = { pick: { ...workerPick.pick, deny: [] } }
  const embed = withPaidTail([], noDeny, tailPool, "root")
  assert.deepEqual(
    embed.map((entry) => entry.ref.id),
    ["paid-embed"],
  )

  const bigContext: TierSpec = { pick: { ...workerPick.pick, minContext: 16_000 } }
  const big = withPaidTail([], bigContext, tailPool, "root")
  assert.deepEqual(
    big.map((entry) => entry.ref.id),
    ["paid-floor"],
  )

  const twice = withPaidTail(embed, noDeny, tailPool, "root")
  assert.equal(new Set(twice.map((entry) => entry.ref.id)).size, twice.length)
})

test("the paid tail prefers a usable model and falls back to the cheapest", () => {
  // paid-small is the cheapest, but it is cooling or already failed.
  const next = withPaidTail([], workerPick, tailPool, "root", (model) => model.id !== "paid-small")
  assert.deepEqual(
    next.map((entry) => entry.ref.id),
    ["paid-floor"],
  )
  // When the whole provider half is out, the cheapest is still the last try.
  const fallback = withPaidTail([], workerPick, tailPool, "root", () => false)
  assert.deepEqual(
    fallback.map((entry) => entry.ref.id),
    ["paid-small"],
  )
})

test("no root provider, or a named model list, is left as it is", () => {
  const named: TierSpec = { models: ["root/paid-floor"] }
  const resolved = resolveCandidates(named, tailPool, "root/base", rank)
  assert.deepEqual(withPaidTail(resolved, named, tailPool, "root"), resolved)
  assert.deepEqual(withPaidTail(resolved, named, tailPool, undefined), resolved)
  assert.deepEqual(withPaidTail([], workerPick, tailPool, undefined), [])
})

test("the paid tail respects a tier's allow list", () => {
  const elsewhere: TierSpec = { pick: { ...workerPick.pick, allow: ["other/*"] } }
  assert.deepEqual(withPaidTail([], elsewhere, tailPool, "root"), [])

  const rootOnly: TierSpec = { pick: { ...workerPick.pick, allow: ["root/*"] } }
  assert.deepEqual(
    withPaidTail([], rootOnly, tailPool, "root").map((entry) => entry.ref.id),
    ["paid-small"],
  )
})
