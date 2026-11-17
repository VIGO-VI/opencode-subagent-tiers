import { test } from "node:test"
import assert from "node:assert/strict"

import { classify, firstAnswering, summarize } from "./probe.mjs"

const candidate = (providerID, id) => ({ ref: { providerID, id }, note: `${providerID}/${id}` })

test("a refusal that will not change is unavailable", () => {
  const zdr =
    "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. " +
    "We removed them for the following reasons:\nZDR violation (account settings)"
  assert.equal(classify(zdr), "unavailable")
  assert.equal(classify('{"_tag":"UnsupportedModelError"}'), "unavailable")
  assert.equal(classify("model_not_found"), "unavailable")
})

test("a rate limit or a timeout says nothing about the model", () => {
  assert.equal(classify("ProviderRequestError rate_limit exceeded"), "transient")
  assert.equal(classify("HTTP 429 Too Many Requests"), "transient")
  assert.equal(classify("socket hang up"), "transient")
  assert.equal(classify("something nobody classified"), "transient")
})

test("the first candidate that answers wins and the rest are not tried", () => {
  const tried = []
  const list = [candidate("a", "one"), candidate("b", "two"), candidate("c", "three")]
  const picked = firstAnswering(list, (ref) => {
    tried.push(ref.id)
    return ref.id === "two" ? { status: "ok" } : { status: "unavailable", reason: "ZDR" }
  })

  assert.equal(picked.chosen.ref.id, "two")
  assert.deepEqual(tried, ["one", "two"])
  assert.equal(picked.skipped.length, 1)
  assert.equal(picked.skipped[0].ref.id, "one")
  assert.equal(picked.unverified, undefined)
})

test("an unavailable first pick is skipped and reported", () => {
  const notes = []
  const picked = firstAnswering(
    [candidate("console-openrouter", "motif-3"), candidate("opencode-go", "flash")],
    (ref) => (ref.id === "motif-3" ? { status: "unavailable", reason: "ZDR violation" } : { status: "ok" }),
    (line) => notes.push(line),
  )

  assert.equal(picked.chosen.ref.id, "flash")
  assert.equal(notes.length, 1)
  assert.match(notes[0], /skipping console-openrouter\/motif-3: ZDR violation/)
})

test("a rate limit keeps the pick and marks it unverified", () => {
  const picked = firstAnswering([candidate("a", "free")], () => ({ status: "transient", reason: "429" }))
  assert.equal(picked.chosen.ref.id, "free")
  assert.equal(picked.unverified, "429")
})

test("a thrown attempt does not lose the pick", () => {
  const picked = firstAnswering([candidate("a", "one")], () => {
    throw new Error("spawn opencode ENOENT")
  })
  assert.equal(picked.chosen.ref.id, "one")
  assert.match(picked.unverified, /ENOENT/)
})

test("nothing answers means nothing is chosen", () => {
  const picked = firstAnswering([candidate("a", "one")], () => ({ status: "unavailable", reason: "gone" }))
  assert.equal(picked.chosen, undefined)
  assert.equal(picked.skipped.length, 1)
})

test("a summary is one line and drops the transport noise", () => {
  const text = '{"_tag":"ProviderRequestError","message":"nope"}\nHTTP 502 Bad Gateway'
  assert.equal(summarize(text), "nope")
  assert.ok(summarize("x".repeat(500)).length <= 200)
})

test("a provider that calls a 402 a rate limit is still unavailable", () => {
  const text =
    '{"_tag":"ProviderRequestError","providerID":"opencode","reason":"rate_limit",' +
    '"message":"Insufficient balance. This request is pay-as-you-go.","status":402}\nHTTP 502 Bad Gateway'
  assert.equal(classify(text), "unavailable")
  assert.match(summarize(text), /Insufficient balance/)
})

test("a real rate limit inside a JSON body stays transient", () => {
  const text = '{"_tag":"ProviderRequestError","reason":"rate_limit","message":"Too many requests","status":429}'
  assert.equal(classify(text), "transient")
})
