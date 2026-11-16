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
}

export type Pick = {
  /** Allowed price as a multiple of the anchor's blended price, `[min, max]`. */
  ratio?: [number, number]
  /** Wildcards over `provider/model` and `model`. */
  allow?: string[]
  /** Wildcards over `provider/model` and `model`, applied after `allow`. */
  deny?: string[]
  /** `quality` sorts by rank then recency then price, `cost` sorts by price then rank. */
  prefer?: "quality" | "cost"
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
      !matchesAny(pick.deny, modelKey(model), model.id),
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

  const sorted = [...chosen].sort((a, b) => {
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

  // Free tiers get rate limited, so spend a few slots on them, then cheap paid
  // ones, and keep any further free models as a last resort.
  const freeSlots = pick.freeSlots ?? 3
  let ordered = sorted
  if (pick.prefer === "cost") {
    const free = sorted.filter((entry) => entry.model.price === 0)
    const paid = sorted.filter((entry) => entry.model.price > 0)
    ordered = [...free.slice(0, freeSlots), ...paid, ...free.slice(freeSlots)]
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
