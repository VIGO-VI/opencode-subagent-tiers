/**
 * Pure selection logic for the tier router. No plugin API, no I/O: given a
 * catalog of models and a tier spec, decide which models to try and in what
 * order. Kept separate so it can be tested directly.
 */

export type ModelRef = { providerID: string; id: string; variant?: string }

export type CostTier = { input: number; output: number }

export type Candidate = {
  ref: ModelRef
  id: string
  providerID: string
  price: number
  released: number
  /** Whether the model can call tools, which every worker needs. */
  tools?: boolean
  /** Context window in tokens, so a small local model is not handed a big job. */
  context?: number
}

export type Pick = {
  /** Allowed price as a multiple of the anchor's blended price, `[min, max]`. */
  ratio?: [number, number]
  /** Wildcards over `provider/model` and `model`. */
  allow?: string[]
  /** Wildcards over `provider/model` and `model`, applied after `allow`. */
  deny?: string[]
  /**
   * `quality` sorts by rank then recency then price, `cost` by price then rank,
   * `value` by rank per dollar, which is what a price-aware choice actually
   * wants. `value` beats `quality` when two models are close in rank and far
   * apart in price.
   */
  prefer?: "quality" | "cost" | "value"
  /** Coarse 0-100 scores keyed by wildcard. */
  rank?: Record<string, number>
  /** Provider ids to prefer, in order, when price and rank are otherwise equal. */
  providerOrder?: string[]
  /** Per-task overrides, merged over this policy. Keys are free-form task kinds. */
  byKind?: Record<string, Pick>
  /** How many free candidates to try before moving to paid ones. Defaults to 3. */
  freeSlots?: number
  /** How many candidates to keep as fallbacks. */
  limit?: number
  /** Only consider models that can call tools. */
  requireTools?: boolean
  /** Only consider models whose context window is at least this many tokens. */
  minContext?: number
}

export type TierSpec = {
  /** Ordered candidates. A `~` model id means "newest of that family". */
  models?: string[]
  /** Resolve the candidates from the catalog instead. */
  pick?: Pick
  brief?: string
  label?: string
}

export type Resolved = { ref: ModelRef; note: string }

export function parseModel(reference: string): ModelRef {
  const hash = reference.indexOf("#")
  const head = hash === -1 ? reference : reference.slice(0, hash)
  const variant = hash === -1 ? undefined : reference.slice(hash + 1)
  const slash = head.indexOf("/")
  if (slash === -1) throw new Error(`tier-router: model "${reference}" is not provider/model`)
  const providerID = head.slice(0, slash)
  const id = head.slice(slash + 1)
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

export function modelKey(ref: { providerID: string; id: string }) {
  return `${ref.providerID}/${ref.id}`
}

export function matches(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

export function matchesAny(patterns: string[] | undefined, ...values: string[]) {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => values.some((value) => matches(pattern, value)))
}

/** Blend input and output price into one number, per million tokens. */
export function blendedPrice(cost: readonly CostTier[] | undefined) {
  const tier = cost?.[0]
  if (!tier) return 0
  return Number(tier.input ?? 0) + Number(tier.output ?? 0)
}

export function medianPrice(pool: readonly Candidate[]) {
  const prices = pool
    .map((model) => model.price)
    .filter((price) => price > 0)
    .sort((a, b) => a - b)
  if (prices.length === 0) return 0
  const middle = Math.floor(prices.length / 2)
  return prices[middle] ?? prices[prices.length - 1] ?? 0
}

/** The most specific matching rank wins; longer patterns are more specific. */
export function rankFor(table: Record<string, number>, model: Candidate) {
  let best: { score: number; length: number } | undefined
  for (const [pattern, score] of Object.entries(table)) {
    if (!matchesAny([pattern], modelKey(model), model.id)) continue
    const length = pattern.replace(/[*?]/g, "").length
    if (!best || length > best.length) best = { score, length }
  }
  return best?.score
}

/** `~family` means the newest release the catalog has for that family. */
export function newestOfFamily(family: string, pool: readonly Candidate[]) {
  const wanted = family.toLowerCase()
  return [...pool]
    .filter((model) => model.id.toLowerCase().includes(wanted))
    .sort((a, b) => b.released - a.released || b.price - a.price)[0]
}

/** Merge a task-kind override over the base policy. */
export function effectivePick(pick: Pick, kind: string | undefined): Pick {
  const override = kind ? pick.byKind?.[kind] : undefined
  if (!override) return pick
  return {
    ...pick,
    ...override,
    rank: { ...(pick.rank ?? {}), ...(override.rank ?? {}) },
  }
}

export function pickCandidates(
  spec: TierSpec,
  pool: readonly Candidate[],
  anchorKey: string | undefined,
  fallbackRank: Record<string, number> = {},
  kind?: string,
): Resolved[] {
  const pick = spec.pick ? effectivePick(spec.pick, kind) : undefined
  if (!pick) return []

  const anchorPrice = (anchorKey && pool.find((model) => modelKey(model) === anchorKey)?.price) || medianPrice(pool)
  const table = { ...fallbackRank, ...(pick.rank ?? {}) }

  const allowed = pool.filter(
    (model) =>
      (!pick.allow || matchesAny(pick.allow, modelKey(model), model.id)) &&
      !matchesAny(pick.deny, modelKey(model), model.id) &&
      (!pick.requireTools || model.tools !== false) &&
      (pick.minContext === undefined || (model.context ?? Number.POSITIVE_INFINITY) >= pick.minContext),
  )

  const scored = allowed.map((model) => {
    const ratio = anchorPrice > 0 ? model.price / anchorPrice : 0
    return { model, ratio, rank: rankFor(table, model) }
  })

  const [min, max] = pick.ratio ?? [0, Number.POSITIVE_INFINITY]
  const band = scored.filter((entry) => entry.ratio >= min && entry.ratio <= max)
  const chosen = band.length > 0 ? band : scored
  if (chosen.length === 0) return []

  // An unranked model is neutral, not best. Otherwise the most expensive model
  // in the band would win by being expensive.
  const quality = (entry: (typeof chosen)[number]) => entry.rank ?? 50

  const providerOrder = pick.providerOrder ?? []
  const providerIndex = (entry: (typeof chosen)[number]) => {
    const index = providerOrder.findIndex(
      (prefix) => entry.model.providerID === prefix || entry.model.providerID.startsWith(prefix),
    )
    return index === -1 ? providerOrder.length : index
  }

  const value = (entry: (typeof chosen)[number]) => quality(entry) / (1 + entry.model.price)

  const sorted = [...chosen].sort((a, b) => {
    if (pick.prefer === "value") {
      return value(b) - value(a) || quality(b) - quality(a) || a.model.price - b.model.price
    }
    if (pick.prefer === "cost") {
      const freeA = a.model.price === 0 ? 0 : 1
      const freeB = b.model.price === 0 ? 0 : 1
      return (
        freeA - freeB ||
        providerIndex(a) - providerIndex(b) ||
        a.model.price - b.model.price ||
        quality(b) - quality(a) ||
        b.model.released - a.model.released
      )
    }
    return quality(b) - quality(a) || b.model.released - a.model.released || a.model.price - b.model.price
  })

  // Free tiers get rate limited, so spend a few slots on them, then a cheap paid
  // one, and keep further free models as a last resort. Free slots go round the
  // providers in order, so one provider's free models cannot crowd out another's.
  const freeSlots = pick.freeSlots ?? 3
  let ordered = sorted
  if (pick.prefer === "cost") {
    const free = sorted.filter((entry) => entry.model.price === 0)
    const paid = sorted.filter((entry) => entry.model.price > 0)
    const taken: typeof free = []
    const byProvider = new Map<number, typeof free>()
    for (const entry of free) {
      const index = providerIndex(entry)
      const bucket = byProvider.get(index) ?? []
      bucket.push(entry)
      byProvider.set(index, bucket)
    }
    for (let round = 0; taken.length < freeSlots; round++) {
      let added = false
      for (const index of [...byProvider.keys()].sort((a, b) => a - b)) {
        const bucket = byProvider.get(index) ?? []
        const next = bucket[round]
        if (!next) continue
        taken.push(next)
        added = true
        if (taken.length >= freeSlots) break
      }
      if (!added) break
    }
    const leftover = free.filter((entry) => !taken.includes(entry))
    ordered = [...taken, ...paid, ...leftover]
  }

  return ordered.slice(0, pick.limit ?? 3).map((entry) => ({
    ref: entry.model.ref,
    note:
      `${modelKey(entry.model)} ${entry.ratio.toFixed(2)}x rank ${quality(entry)}` +
      (entry.model.price === 0 ? " free" : ""),
  }))
}

export function resolveCandidates(
  spec: TierSpec,
  pool: readonly Candidate[],
  anchorKey: string | undefined,
  fallbackRank: Record<string, number> = {},
  kind?: string,
): Resolved[] {
  if (spec.models && spec.models.length > 0) {
    const resolved: Resolved[] = []
    for (const reference of spec.models) {
      if (!reference.includes("~")) {
        resolved.push({ ref: parseModel(reference), note: "named" })
        continue
      }
      const parsed = parseModel(reference)
      const family = parsed.id.replace("~", "")
      const newest = newestOfFamily(family, pool)
      if (newest) {
        resolved.push({
          ref: parsed.variant ? { ...newest.ref, variant: parsed.variant } : newest.ref,
          note: `newest ${family}`,
        })
      }
    }
    return resolved
  }
  return pickCandidates(spec, pool, anchorKey, fallbackRank, kind)
}

export type BudgetSpec = {
  /** Fraction of the session's measured tokens this tier may spend. */
  share?: number
  /** Absolute ceiling in tokens, whatever the session has spent. */
  hardCap?: number
  /** Token floor used as the base while the session is still small. */
  floor?: number
  /** Whether a stated justification may exceed the share, up to the hard cap. */
  bypass?: boolean
  /** Calls allowed for this tier per root session, the way `max_uses` works upstream. */
  maxUses?: number
  /** Reply length cap in tokens. Truncated as a backstop, requested in the prompt. */
  maxReplyTokens?: number
}

export type BudgetVerdict = {
  allowed: boolean
  /** The effective limit in tokens for this call. */
  limit: number
  /** Which limit bound it: the share, the hard cap, or neither. */
  bound: "share" | "hardCap" | "none"
  bypassed: boolean
}

/**
 * Decide whether one more call fits. The share is a fraction of the session's
 * measured tokens, so a busy session earns more room for the expensive tier
 * without any fixed number. A floor keeps the first calls working before the
 * session has spent anything. A justification can lift the share, never the
 * hard cap.
 */
export function budgetFor(
  spec: BudgetSpec,
  sessionTokens: number,
  spent: number,
  cost: number,
  justification?: string,
): BudgetVerdict {
  const base = Math.max(sessionTokens, spec.floor ?? 0)
  const shareLimit = spec.share === undefined ? Number.POSITIVE_INFINITY : spec.share * base
  const hardCap = spec.hardCap ?? Number.POSITIVE_INFINITY
  const limit = Math.min(shareLimit, hardCap)
  const bound = shareLimit <= hardCap ? (Number.isFinite(shareLimit) ? "share" : "none") : "hardCap"
  const wanted = spent + cost
  if (wanted <= limit) return { allowed: true, limit, bound, bypassed: false }
  const reason = (justification ?? "").trim()
  if (spec.bypass && reason.length >= 8 && wanted <= hardCap) {
    return { allowed: true, limit, bound, bypassed: true }
  }
  return { allowed: false, limit, bound, bypassed: false }
}

export type PricingTable = Record<string, number | "free">

/**
 * Replace a catalog price with what the model actually costs this machine, for
 * a subscription, a BYOK key, or a free tier that the list price does not show.
 * The most specific matching pattern wins; no match leaves the catalog price.
 */
export function applyPricing(
  price: number,
  table: PricingTable | undefined,
  ...values: string[]
): number {
  if (!table) return price
  let best: { value: number; length: number } | undefined
  for (const [pattern, value] of Object.entries(table)) {
    if (!matchesAny([pattern], ...values)) continue
    const length = pattern.replace(/[*?]/g, "").length
    if (!best || length > best.length) {
      best = { value: value === "free" ? 0 : value, length }
    }
  }
  return best ? best.value : price
}

export type Confidence = { score: number; missing: string[] }

/**
 * A cheap check on a worker report, in the spirit of a cascade gate: decide
 * whether the cheap answer is trustworthy enough to keep, or whether it should
 * be escalated. It looks for the things a verifiable report has (a citation, a
 * command and its output) and for the phrases that mean the worker gave up.
 */
export function confidence(report: string): Confidence {
  const text = report.trim()
  const missing: string[] = []
  let score = 0
  if (/\b[\w./-]+:\d+/.test(text)) score += 0.4
  else missing.push("no file:line citation")
  if (/[$>]\s*\S+.*\n/.test(text) || /exit\s*=?\s*\d/.test(text)) score += 0.3
  else missing.push("no command output")
  if (text.length >= 80) score += 0.2
  else missing.push("shorter than one sentence of substance")
  if (!/\b(uncertain|could not|not sure|unable to|cannot tell)\b/i.test(text)) score += 0.1
  else missing.push("the worker hedged")
  return { score: Math.min(1, Math.round(score * 100) / 100), missing }
}
