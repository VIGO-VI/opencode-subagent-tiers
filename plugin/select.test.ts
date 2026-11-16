import assert from "node:assert/strict"
import { test } from "node:test"

import {
  blendedPrice,
  matches,
  modelKey,
  newestOfFamily,
  parseModel,
  pickCandidates,
  rankFor,
  resolveCandidates,
  type Candidate,
  type TierSpec,
} from "./select.ts"

function candidate(id: string, price: number, released: number, providerID = "test"): Candidate {
  return { ref: { providerID, id }, id, providerID, price, released }
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

test("newestOfFamily returns undefined when the family is absent", () => {
  assert.equal(newestOfFamily("nope", pool), undefined)
})
