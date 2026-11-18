/**
 * Provider failures the router must act on, and the cooldown a strike writes.
 *
 * A rate limit is a window: the model answers again on its own, so the short
 * doubling backoff is right. A refusal is a state - a setting, a model the
 * provider does not serve, or an empty balance - and waiting six hours does not
 * change it. The scope follows what failed: money and credentials cover the
 * provider's free or paid half, while a model, its endpoint pool or a rate limit
 * on it belongs to that model alone. A provider that aggregates gives each model
 * its own endpoints, so one model's exclusion cannot speak for its siblings.
 */

import { modelKey, type ModelRef } from "./select.ts"

/** A refusal is a setting or an account state, not a window. Three days. */
export const REFUSAL_COOLDOWN_MS = 72 * 3_600_000
/**
 * A refusal learned only from a bare status is ambiguous: a gone model and a
 * wrong base URL look the same. Ten minutes moves the walk on without parking
 * every model for three days after a configuration mistake.
 */
export const SOFT_REFUSAL_MS = 10 * 60_000

export type RefusalKind = "rate-limit" | "refusal" | "none"
export type RefusalScope = "provider" | "model"

export type Refusal = {
  kind: RefusalKind
  /**
   * Who the failure says is out. A guardrail, an account setting or an empty
   * balance excludes every model of that class on the provider; a model id the
   * provider does not serve excludes only that model.
   */
  scope: RefusalScope
  /** The phrase that matched, so the trace can say why. */
  reason: string
  /** A cause known only from a bare status, so it gets the short wait. */
  soft?: true
}

/**
 * Account-wide causes: money and credentials. These are checked before the
 * model patterns and before the rate-limit patterns, because "insufficient
 * balance" is an account state even though some providers phrase it with the
 * word quota. Nothing about a model belongs here: a provider that aggregates
 * gives each model its own upstream pool, so one model's guardrail, data
 * policy or training terms say nothing about its siblings.
 */
const PROVIDER_REFUSAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/insufficient (?:balance|credit)/i, "insufficient balance"],
  [/payment required|billing (?:issue|problem)/i, "payment required"],
  // opencode's own budget errors. The type is exact, but the wording is also
  // matched so a proxied copy of the message is not a plain error.
  [/usage limit reached|spend limit|workspace (?:usage|spend) limit|(?:account|workspace|monthly|billing) budget[\s_.-]*(?:limit|exceeded)/i, "budget limit"],
  // OpenAI's account-wide billing exhaustion, which also contains "quota" and
  // would otherwise be mistaken for a rate limit.
  [/exceeded your (?:current )?quota|insufficient_quota/i, "insufficient quota"],
]

/**
 * Model-only causes: this model, or the endpoints it currently has. A guardrail
 * or data-policy exclusion removes this model's matching endpoints for now, and
 * a new upstream provider that satisfies the rules may appear later, so the
 * record is a cooldown on the model and never a blacklist. Sibling models have
 * their own endpoint pools and stay usable, which is why none of these may park
 * the provider.
 */
const MODEL_REFUSAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bzdr\b|zero[\s-]+data[\s-]+retention/i, "ZDR"],
  [/guardrail/i, "guardrail"],
  [/data[\s-]+polic(?:y|ies)/i, "data policy"],
  [/trains on (?:request|your) data/i, "trains on request data"],
  [/settings\/privacy/i, "privacy setting"],
  [/not enabled for this account/i, "model not enabled"],
  [/model[\s_-]*unavailable/i, "model unavailable"],
  [/not enabled for this model/i, "model not enabled"],
  [/model[\s_-]*not[\s_-]*found|no such model|does not exist/i, "model not found"],
  // `Model <id> has been deprecated` is a dead id. A parameter that is
  // deprecated for a model is not, and must not park the model for 72 h.
  [
    /model\s+\S+\s+(?:has been|is)\s+(?:deprecated|retired|sunset)|model[\s_-]+deprecated|deprecated model|(?:this|the) model (?:is|has been) (?:deprecated|retired|sunset)/i,
    "model deprecated",
  ],
  [
    /do not have access to this model|model access denied|deployment[\s_-]*not[\s_-]*found|permission denied for (?:this )?model|unauthorized to (?:use|access)(?: this)? model/i,
    "model access denied",
  ],
  [/\bno endpoints?\b|0 endpoints? out of/i, "no endpoints"],
]

/**
 * Read a provider error as one of three things. The message, the response body
 * and the error type are all inspected, because a provider puts the same fact
 * in a different place each time.
 */
export function classifyProviderError(error: unknown): Refusal {
  const record = (error ?? {}) as {
    type?: unknown
    message?: unknown
    status?: unknown
    response?: { body?: unknown }
    cause?: unknown
  }
  const body = typeof record.response?.body === "string" ? record.response.body : ""
  const cause =
    record.cause instanceof Error ? record.cause.message : typeof record.cause === "string" ? record.cause : ""
  const type = typeof record.type === "string" ? record.type : ""
  const code =
    typeof (record as { code?: unknown }).code === "string" ? String((record as { code?: unknown }).code) : ""
  const text = [record.message, body, cause, type, code, String(error ?? "")]
    .filter((part): part is string => typeof part === "string")
    .join(" ")

  // A credential that is wrong is account-wide, and the account has to change
  // it. It is soft because the fix is quick once the user makes it. "permission
  // denied for this model" is not in this branch: that is one model's access.
  if (/invalid api key|incorrect api key|authentication failed|api key not valid|missing api key/i.test(text)) {
    return { kind: "refusal", scope: "provider", reason: "authentication", soft: true }
  }

  // The exact opencode budget types carry the scope in the type, while the
  // message alone says only "limit". Handle them before the text patterns.
  if (type === "provider.model-budget-limit") {
    return { kind: "refusal", scope: "model", reason: "model budget limit" }
  }
  if (type === "provider.budget-limit") {
    return { kind: "refusal", scope: "provider", reason: "budget limit" }
  }

  for (const [pattern, reason] of PROVIDER_REFUSAL) {
    if (pattern.test(text)) return { kind: "refusal", scope: "provider", reason }
  }
  for (const [pattern, reason] of MODEL_REFUSAL) {
    if (pattern.test(text)) return { kind: "refusal", scope: "model", reason }
  }

  // A prompt that is too large is neither a rate limit nor a refusal: the
  // model is healthy and waiting will not make the request shorter. Cooling it
  // would take a working model out for a mistake the caller can fix. The
  // refusal loops run first, so an account refusal that also mentions a length
  // is still a refusal.
  if (/context[\s_-]*(?:length|window|limit|quota)|maximum context|too many tokens|prompt is too long/i.test(text)) {
    return { kind: "none", scope: "model", reason: "" }
  }

  const status = Number(record.status ?? 0)
  // A bare status still names a class. A 402 is the account's credit, a 403,
  // 404 or 410 is this model, and a 529 is the provider asking for a retry.
  if (status === 401) return { kind: "refusal", scope: "provider", reason: "authentication", soft: true }
  if (status === 402) return { kind: "refusal", scope: "provider", reason: "payment required" }
  if (status === 403 || status === 404 || status === 410) {
    return { kind: "refusal", scope: "model", reason: `http ${status}`, soft: true }
  }
  if (status === 529) return { kind: "rate-limit", scope: "model", reason: "overloaded" }
  if (
    status === 429 ||
    type === "provider.rate-limit" ||
    /429|rate.?limit|too many requests|quota|overloaded|resource[\s_-]*exhausted/i.test(text)
  ) {
    return { kind: "rate-limit", scope: "model", reason: "rate limit" }
  }
  return { kind: "none", scope: "model", reason: "" }
}

/** Free and paid are separate allowances, so they get separate cooldown keys. */
export function priceScope(price: number): "free" | "paid" {
  return price === 0 ? "free" : "paid"
}

/** The key for a provider-wide refusal, never shared across free and paid. */
export function providerKey(providerID: string, price: number): string {
  return `provider:${providerID}:${priceScope(price)}`
}

/**
 * The cooldown keys one failure writes. A model keeps its own key so a sibling
 * is unaffected, and a rate limit is always the model's own: on this machine
 * `longcat-2.5-free` answered 429 while `hy4-flash-free` and `beam-free`
 * answered normally, so a limit on one model says nothing about the others.
 * Only an account-wide refusal, money or credentials, reaches the provider key
 * for the class (free or paid) that failed.
 */
export function cooldownKeys(refusal: Refusal, model: ModelRef, price: number): string[] {
  if (refusal.kind === "none") return []
  const key = modelKey(model)
  if (refusal.kind === "rate-limit") return [key]
  // The refused model is always named, even when the whole class is out, so the
  // trace and the caller's notice point at the model that actually failed.
  return refusal.scope === "provider" ? [key, providerKey(model.providerID, price)] : [key]
}

/** Whether a model is still inside a model or provider cooldown. */
export function isCooling(
  live: Record<string, { until?: number } | undefined>,
  model: ModelRef,
  price: number,
  now = Date.now(),
): boolean {
  return (
    (live[modelKey(model)]?.until ?? 0) > now || (live[providerKey(model.providerID, price)]?.until ?? 0) > now
  )
}

/** The fixed wait a refusal uses, or nothing for a rate limit's doubling wait. */
export function cooldownFor(refusal: Refusal): number | undefined {
  if (refusal.kind !== "refusal") return undefined
  return refusal.soft ? SOFT_REFUSAL_MS : REFUSAL_COOLDOWN_MS
}

export type RetryPlan =
  | { act: false }
  | {
      act: true
      refusal: Refusal
      keys: string[]
      fixedMs: number | undefined
      retry: boolean
      delay: number
    }

/**
 * Decide whether the retry hook can fail a request over, and what to record.
 *
 * Only a child session is routed at all, because the root session keeps the
 * model the user chose. Every tier a subagent can have is included: the old
 * check named `worker` alone, which silently excluded `swarm-worker-code`
 * (mapped to `lead`), `swarm-lead` and `advisor`.
 */
export function retryPlan(input: {
  refusal: Refusal
  child: boolean
  tier: string | undefined
  knownTier: boolean
  model: ModelRef
  price: number
  attempt: number
  exhausted: boolean
}): RetryPlan {
  if (input.refusal.kind === "none") return { act: false }
  if (!input.child || !input.tier || !input.knownTier) return { act: false }
  const keys = cooldownKeys(input.refusal, input.model, input.price)
  if (keys.length === 0) return { act: false }
  return {
    act: true,
    refusal: input.refusal,
    keys,
    fixedMs: cooldownFor(input.refusal),
    retry: !input.exhausted,
    // Keep the existing fast-fail delay: the runner's own backoff is fifteen
    // minutes, which is long enough that delegating looks broken.
    delay: input.attempt <= 1 ? 1_500 : 4_000,
  }
}

/**
 * Give each remaining candidate a fair slice of the walk's budget, so one slow
 * provider cannot spend the whole deadline and leave the tail `not tried`. The
 * total is unchanged; the slices sum back to it because later candidates divide
 * only what earlier ones left. A candidate never takes more than its equal
 * share: a floor larger than the share would itself starve the tail when the
 * whole budget is short.
 */
export function sliceBudget(remainingMs: number, left: number): number {
  if (remainingMs <= 0) return 0
  if (left <= 1) return remainingMs
  return Math.max(1, Math.floor(remainingMs / left))
}
