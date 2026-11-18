import assert from "node:assert/strict"
import { test } from "node:test"

import {
  REFUSAL_COOLDOWN_MS,
  SOFT_REFUSAL_MS,
  classifyProviderError,
  cooldownFor,
  cooldownKeys,
  isCooling,
  retryPlan,
  sliceBudget,
} from "./refusal.ts"

const free = { providerID: "console-openrouter", id: "inclusionai/ling-3.2-flash:free" }
const paid = { providerID: "console-openrouter", id: "nex-agi/nex-n2.6" }

// The exact shape OpenRouter returns when the account's ZDR setting excludes
// every endpoint of a model.
const ZDR =
  "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. " +
  "We removed them for the following reasons: ZDR violation (account settings): 1 endpoint excluded; " +
  "configurable at https://openrouter.ai/settings/privacy"

test("a ZDR guardrail message is a provider refusal with a three-day wait", () => {
  const refusal = classifyProviderError({ type: "provider.error", message: ZDR })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "provider")
  assert.equal(refusal.reason, "ZDR")
  assert.equal(REFUSAL_COOLDOWN_MS, 259_200_000)
  assert.equal(cooldownFor(refusal), REFUSAL_COOLDOWN_MS)
  assert.deepEqual(cooldownKeys(refusal, paid, 5), [
    "console-openrouter/nex-agi/nex-n2.6",
    "provider:console-openrouter:paid",
  ])
})

test("a free refusal strikes only :free and leaves the paid sibling warm", () => {
  const refusal = classifyProviderError({ message: ZDR })
  const freeKeys = cooldownKeys(refusal, free, 0)
  const paidKeys = cooldownKeys(refusal, paid, 5)
  assert.deepEqual(freeKeys, [
    "console-openrouter/inclusionai/ling-3.2-flash:free",
    "provider:console-openrouter:free",
  ])
  assert.deepEqual(paidKeys, [
    "console-openrouter/nex-agi/nex-n2.6",
    "provider:console-openrouter:paid",
  ])

  const now = 1_000
  const freeOut = { [freeKeys[1]!]: { until: now + REFUSAL_COOLDOWN_MS } }
  assert.equal(isCooling(freeOut, free, 0, now), true)
  assert.equal(isCooling(freeOut, paid, 5, now), false)
})

test("a paid refusal strikes only :paid and leaves the free sibling warm", () => {
  const refusal = classifyProviderError({ message: ZDR })
  const paidKeys = cooldownKeys(refusal, paid, 5)
  const now = 1_000
  const paidOut = { [paidKeys[1]!]: { until: now + REFUSAL_COOLDOWN_MS } }
  assert.equal(isCooling(paidOut, paid, 5, now), true)
  assert.equal(isCooling(paidOut, free, 0, now), false)
})

test("an unserved model is a model refusal, but the same words with a guardrail are provider-wide", () => {
  const unavailable = classifyProviderError(new Error("Model unavailable: opencode/iceman-free"))
  assert.equal(unavailable.kind, "refusal")
  assert.equal(unavailable.scope, "model")
  assert.deepEqual(cooldownKeys(unavailable, { providerID: "opencode", id: "iceman-free" }, 0), [
    "opencode/iceman-free",
  ])

  // "no endpoints" alone names one model id that is not served. It must not
  // park every other model of the provider.
  const noEndpoints = classifyProviderError(new Error("No endpoints found for opencode/iceman-free"))
  assert.equal(noEndpoints.scope, "model")

  const guarded = classifyProviderError({ message: "0 endpoints out of 1 requested are available: guardrail" })
  assert.equal(guarded.scope, "provider")
})

test("an empty balance is a provider refusal of the paid half", () => {
  const refusal = classifyProviderError({
    status: 402,
    message:
      "Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits.",
  })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "provider")
  assert.deepEqual(cooldownKeys(refusal, { providerID: "opencode", id: "gemini-3.8-flash" }, 3), [
    "opencode/gemini-3.8-flash",
    "provider:opencode:paid",
  ])
})

test("a rate limit stays a rate limit and only a free one reaches the provider", () => {
  const limited = classifyProviderError({ status: 429, message: "429 Too Many Requests" })
  assert.equal(limited.kind, "rate-limit")
  assert.equal(cooldownFor(limited), undefined)
  assert.deepEqual(cooldownKeys(limited, free, 0), ["console-openrouter/inclusionai/ling-3.2-flash:free", "provider:console-openrouter:free"])
  assert.deepEqual(cooldownKeys(limited, paid, 5), ["console-openrouter/nex-agi/nex-n2.6"])

  const typed = classifyProviderError({ type: "provider.rate-limit", message: "slow down" })
  assert.equal(typed.kind, "rate-limit")
})

test("a guardrail message that also says quota is not mistaken for a rate limit", () => {
  const refusal = classifyProviderError({ message: "guardrail restriction: free quota exceeded for this account" })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "provider")
})

test("an ordinary provider error is not a refusal", () => {
  const refusal = classifyProviderError(new Error("upstream connect error or disconnect/reset before headers"))
  assert.equal(refusal.kind, "none")
  assert.deepEqual(cooldownKeys(refusal, paid, 5), [])
  assert.deepEqual(
    retryPlan({
      refusal,
      child: true,
      tier: "worker",
      knownTier: true,
      model: paid,
      price: 5,
      attempt: 1,
      exhausted: false,
    }),
    { act: false },
  )
})

test("a lead-tier subagent gets a retry and a strike, where the old worker-only check gave nothing", () => {
  const refusal = classifyProviderError({ message: ZDR })
  const plan = retryPlan({
    refusal,
    child: true,
    tier: "lead",
    knownTier: true,
    model: paid,
    price: 5,
    attempt: 1,
    exhausted: false,
  })
  assert.equal(plan.act, true)
  if (!plan.act) return
  assert.equal(plan.retry, true)
  assert.deepEqual(plan.keys, ["console-openrouter/nex-agi/nex-n2.6", "provider:console-openrouter:paid"])
  assert.equal(plan.fixedMs, REFUSAL_COOLDOWN_MS)
  assert.equal(plan.delay, 1_500)
})

test("every mapped tier is routed, and only a child session is", () => {
  const refusal = classifyProviderError({ message: ZDR })
  const base = { refusal, child: true, knownTier: true, model: paid, price: 5, attempt: 1, exhausted: false }
  for (const tier of ["worker", "lead", "advisor"]) {
    const plan = retryPlan({ ...base, tier })
    assert.equal(plan.act, true, `${tier} should fail over`)
  }
  assert.equal(retryPlan({ ...base, tier: "lead", child: false }).act, false)
  assert.equal(retryPlan({ ...base, tier: undefined }).act, false)
  assert.equal(retryPlan({ ...base, tier: "lead", knownTier: false }).act, false)
})

test("an exhausted session records the strike but does not retry", () => {
  const plan = retryPlan({
    refusal: classifyProviderError({ message: ZDR }),
    child: true,
    tier: "lead",
    knownTier: true,
    model: paid,
    price: 5,
    attempt: 2,
    exhausted: true,
  })
  assert.equal(plan.act, true)
  if (!plan.act) return
  assert.equal(plan.retry, false)
  assert.equal(plan.delay, 4_000)
})

test("each candidate of a walk gets a slice, so the last one is still tried", () => {
  assert.equal(sliceBudget(60_000, 3), 20_000)
  let left = 60_000
  const slices: number[] = []
  for (let remaining = 3; remaining >= 1; remaining--) {
    const slice = sliceBudget(left, remaining)
    slices.push(slice)
    left -= slice
  }
  assert.deepEqual(slices, [20_000, 20_000, 20_000])
  assert.ok(slices[2]! > 0, "the last candidate must not be 'not tried'")
  assert.equal(sliceBudget(100, 3), 33)
  assert.equal(sliceBudget(10, 20), 1)
  assert.equal(sliceBudget(0, 3), 0)
})

test("overload and access denials are classified, not left as plain errors", () => {
  assert.equal(classifyProviderError({ status: 529, message: "Overloaded" }).kind, "rate-limit")
  assert.equal(classifyProviderError({ message: "RESOURCE_EXHAUSTED: try later" }).kind, "rate-limit")

  const denied = classifyProviderError({ status: 403, message: "You do not have access to this model" })
  assert.equal(denied.kind, "refusal")
  assert.equal(denied.scope, "model")

  const openai = classifyProviderError({ message: "`gpt-4o` does not exist or you do not have access to it" })
  assert.equal(openai.kind, "refusal")
  assert.equal(openai.scope, "model")

  const billing = classifyProviderError({ status: 402, message: "Payment required" })
  assert.equal(billing.kind, "refusal")
  assert.equal(billing.scope, "provider")
})

test("an oversized prompt does not cool a healthy model", () => {
  const overflow = classifyProviderError({
    status: 400,
    message: "context quota exceeded: maximum context length is 128000 tokens",
  })
  assert.equal(overflow.kind, "none")
})

test("every phrase the old gate matched still classifies", () => {
  const cases: Array<[string, "provider" | "model"]> = [
    ["This model trains on request data", "provider"],
    ["not enabled for this account", "provider"],
    ["not enabled for this model", "model"],
    ["see settings/privacy", "provider"],
    ["Model unavailable: opencode/iceman-free", "model"],
  ]
  for (const [message, scope] of cases) {
    const refusal = classifyProviderError({ message })
    assert.equal(refusal.kind, "refusal", message)
    assert.equal(refusal.scope, scope, message)
  }
})

test("a deprecated model id is a model refusal, and its siblings stay usable", () => {
  const refusal = classifyProviderError({
    message: "Model mimo-v2.5-pro has been deprecated. Use mimo-v2.6-pro instead.",
  })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "model")
  assert.deepEqual(cooldownKeys(refusal, { providerID: "opencode-go", id: "mimo-v2.5-pro" }, 5), [
    "opencode-go/mimo-v2.5-pro",
  ])
})

test("opencode budget errors are refusals with the scope their type names", () => {
  const workspace = classifyProviderError({
    type: "provider.budget-limit",
    message: "Workspace usage limit reached. Model use is paused until the limit resets.",
  })
  assert.equal(workspace.kind, "refusal")
  assert.equal(workspace.scope, "provider")

  const perModel = classifyProviderError({
    type: "provider.model-budget-limit",
    message: "You've reached the spend limit for this model. Switch models to keep going.",
  })
  assert.equal(perModel.kind, "refusal")
  assert.equal(perModel.scope, "model")
})

test("a cause that lives only in the error type or the status still classifies", () => {
  const typed = classifyProviderError({ type: "model_not_found", message: "Not found" })
  assert.equal(typed.kind, "refusal")
  assert.equal(typed.scope, "model")

  for (const status of [403, 404, 410]) {
    const soft = classifyProviderError({ status, message: "Not Found" })
    assert.equal(soft.scope, "model")
    assert.equal(cooldownFor(soft), SOFT_REFUSAL_MS, `${status} must not park a model for three days`)
  }
  assert.equal(cooldownFor(classifyProviderError({ status: 402, message: "Payment Required" })), REFUSAL_COOLDOWN_MS)
  assert.equal(classifyProviderError({ status: 529, message: "Service Unavailable" }).kind, "rate-limit")
})

test("OpenAI's billing quota is a refusal, not a rate limit", () => {
  const refusal = classifyProviderError({
    status: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
  })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "provider")

  const gemini = classifyProviderError({ message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric" })
  assert.equal(gemini.kind, "rate-limit")
})

test("a deprecated parameter is not a deprecated model", () => {
  const refusal = classifyProviderError({
    message: "The parameter temperature is deprecated for this model",
  })
  assert.equal(refusal.kind, "none")
})

test("an ambiguous bare status or a bad credential gets the short wait", () => {
  const notFound = classifyProviderError({ status: 404 })
  assert.equal(notFound.kind, "refusal")
  assert.equal(cooldownFor(notFound), SOFT_REFUSAL_MS)

  const auth = classifyProviderError({ status: 403, message: "Invalid API key" })
  assert.equal(auth.kind, "refusal")
  assert.equal(auth.scope, "provider")
  assert.equal(cooldownFor(auth), SOFT_REFUSAL_MS)

  // The account has to fix a credential, but the fix is quick, so the provider
  // half comes back in ten minutes rather than three days.
  const hard = classifyProviderError({ message: ZDR })
  assert.equal(cooldownFor(hard), REFUSAL_COOLDOWN_MS)
})

test("a token or context budget is not an account budget", () => {
  assert.equal(classifyProviderError({ status: 400, message: "token budget limit exceeded" }).kind, "none")
  assert.equal(
    classifyProviderError({ status: 400, message: "context budget limit exceeded: 200000 tokens" }).kind,
    "none",
  )
  assert.equal(classifyProviderError({ code: "context_length_exceeded" }).kind, "none")
})

test("an id-less deprecated model still classifies", () => {
  const refusal = classifyProviderError({ message: "This model is deprecated" })
  assert.equal(refusal.kind, "refusal")
  assert.equal(refusal.scope, "model")
})

test("an account refusal wins when the body also mentions a context length", () => {
  const both = classifyProviderError({
    status: 400,
    message: "context length exceeded; 0 endpoints out of 1 requested: guardrail restrictions",
  })
  assert.equal(both.kind, "refusal")
  assert.equal(both.scope, "provider")
})

test("a model's own permission denial is model-scoped, and a bare 401 is account-wide", () => {
  const model = classifyProviderError({ message: "permission denied for model nex-agi/nex-n2.6" })
  assert.equal(model.kind, "refusal")
  assert.equal(model.scope, "model")

  const unauthorized = classifyProviderError({ message: "unauthorized to use this model" })
  assert.equal(unauthorized.scope, "model")

  const credential = classifyProviderError({ status: 401, message: "Unauthorized" })
  assert.equal(credential.kind, "refusal")
  assert.equal(credential.scope, "provider")
  assert.equal(cooldownFor(credential), SOFT_REFUSAL_MS)
})
