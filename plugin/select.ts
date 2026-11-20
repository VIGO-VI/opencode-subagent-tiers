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
  /** Rank derived for a local model when no measured score covers it. */
  derivedRank?: number
  /** Soft bias for the placement preference, below 1 favours this candidate. */
  bias?: number
}

export type Weights = {
  /** Quality per dollar: measured rank divided by the price ratio. */
  value: number
  /** Measured rank for the task kind, regardless of price. */
  quality: number
  /** Raw cheapness inside the band. */
  price: number
  /** Fit for the task's programming language, from the `languages` table. */
  language: number
  /** Room for the job, with diminishing returns past what it needs. */
  context: number
  /** How recently the model shipped. */
  recency: number
  /** Provider order and the hybrid placement bias. */
  preference: number
}

export const WEIGHT_PRESETS: Record<"quality" | "cost" | "value", Weights> = {
  // Quality per dollar leads, quality sits close behind so a cheap model cannot
  // win by falling off a quality cliff, and raw price only breaks near-ties.
  value: { value: 0.4, quality: 0.35, price: 0.1, language: 0.05, context: 0.05, recency: 0.03, preference: 0.02 },
  // Rank first. Value and price still separate models that are close in rank.
  quality: { value: 0.1, quality: 0.55, price: 0.05, language: 0.1, context: 0.08, recency: 0.06, preference: 0.06 },
  // Price first, for the cheapest tier. Rank keeps a free model from being
  // chosen when it is far below the band's quality. Provider affinity is
  // deliberately strong here: switching provider loses the prompt cache, and a
  // subagent cannot switch at all, so it outranks a small price difference.
  cost: { value: 0.15, quality: 0.1, price: 0.25, language: 0.02, context: 0.05, recency: 0.03, preference: 0.4 },
}

/**
 * Language strengths, as `language -> pattern -> 0..100`, the same shape as the
 * rank table. Absent data scores neutral, so the language dimension never
 * distorts a choice on a catalog that has no per-language measurements.
 */
export type LanguageFit = Record<string, Record<string, number>>

/** The language a kind implies, then the one a brief reveals. */
export function languageFor(kind: string | undefined, text: string | undefined, fit?: LanguageFit) {  const byKind: Record<string, string> = { "code-go": "go", "code-rs": "rust", "code-py": "python", "code-ts": "typescript" }
  const fromKind = kind ? byKind[kind] : undefined
  if (fromKind && (!fit || fit[fromKind])) return fromKind
  const brief = text ?? ""
  const fence = brief.match(/```\s*([a-z0-9+#-]+)/i)?.[1]?.toLowerCase()
  if (fence && (!fit || fit[fence])) return fence
  if (/\.go\b|\bgo\.mod\b|\bpackage\s+main\b/i.test(brief)) return "go"
  if (/\.rs\b|\bcargo\.toml\b/i.test(brief)) return "rust"
  if (/\.py\b|\bimport\s+\w+\s*$/im.test(brief)) return "python"
  if (/\.tsx?\b|\btsconfig\.json\b/i.test(brief)) return "typescript"
  return fromKind
}

export type Fit = { language?: string | undefined; languages?: LanguageFit | undefined }

/**
 * The task kind for an agent that was not spawned by `consult`. The name is the
 * only signal the model hook has: the spawn prompt is not part of the resolve
 * event. An explicit mapping wins over the name.
 */
export function kindForAgent(agent: string, explicit?: Record<string, string>): string | undefined {
  const chosen = explicit?.[agent]
  if (chosen) return chosen
  const name = agent.toLowerCase()
  if (/(^|[-_])go($|[-_])|golang/.test(name)) return "code-go"
  if (/code|dev|impl/.test(name)) return "code"
  if (/review|critic/.test(name)) return "review"
  if (/writ|doc/.test(name)) return "write"
  if (/explor|search|lookup|research/.test(name)) return "lookup"
  return undefined
}

export type Pick = {
  /** Allowed price as a multiple of the anchor's blended price, `[min, max]`. */
  ratio?: [number, number]
  /** Wildcards over `provider/model` and `model`. */
  allow?: string[]
  /** Wildcards over `provider/model` and `model`, applied after `allow`. */
  deny?: string[]
  /**
   * A named weighting preset for the composite score. Every preset still mixes
   * all of the dimensions; the name only moves the emphasis.
   *
   * - `value` (default) leads with quality per dollar, keeps quality as a
   *   near-equal backstop against a quality cliff, and lets raw price break
   *   ties. This is the RouteLLM cost-threshold shape, `(1-lambda)Q - lambda C`,
   *   at roughly an even split, and the same "medium" trade OpenRouter's auto
   *   router defaults to.
   * - `quality` leans on measured rank, with value and price as tie-breaks.
   * - `cost` leans on price, for a tier whose job is to be cheap.
   */
  prefer?: "quality" | "cost" | "value"
  /**
   * Per-dimension weights for the composite score, merged over the `prefer`
   * preset. Add to 1; a dimension left out keeps its preset weight.
   */
  weigh?: Partial<Weights>
  /** Force the language used for the language-fit dimension. */
  language?: string
  /** Coarse 0-100 scores keyed by wildcard. */
  rank?: Record<string, number>
  /** Provider ids to prefer, in order, when price and rank are otherwise equal. */
  providerOrder?: string[]
  /**
   * Only consider models on these providers, in every part of the walk including
   * the paid tail. A session's model hook can only swap a model for one on the
   * provider the request started on, so a subagent's walk is narrowed to that
   * provider rather than reaching across providers and failing.
   */
  providers?: string[]
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
  /**
   * Keep one copy of a model per failure domain: the cheapest cloud copy and,
   * separately, the local copy. Two clouds serving the same model are one
   * fallback between them, not two.
   */
  dedupe?: boolean
}

export type TierSpec = {
  /** Ordered candidates. A `~` model id means "newest of that family". */
  models?: string[]
  /** Resolve the candidates from the catalog instead. */
  pick?: Pick
  brief?: string
  label?: string
}

export type Resolved = { ref: ModelRef; note: string; /** The paid floor, kept last in a walk. */ tail?: true }

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
    weigh: { ...(pick.weigh ?? {}), ...(override.weigh ?? {}) },
  }
}

export function pickCandidates(
  spec: TierSpec,
  pool: readonly Candidate[],
  anchorKey: string | undefined,
  fallbackRank: Record<string, number> = {},
  kind?: string,
  fit?: Fit,
): Resolved[] {
  const pick = spec.pick ? effectivePick(spec.pick, kind) : undefined
  if (!pick) return []

  const anchorPrice = (anchorKey && pool.find((model) => modelKey(model) === anchorKey)?.price) || medianPrice(pool)
  const table = { ...fallbackRank, ...(pick.rank ?? {}) }

  const allowed = pool.filter(
    (model) =>
      (!pick.allow || matchesAny(pick.allow, modelKey(model), model.id)) &&
      (!pick.providers || pick.providers.includes(model.providerID)) &&
      !matchesAny(pick.deny, modelKey(model), model.id) &&
      (!pick.requireTools || model.tools !== false) &&
      (pick.minContext === undefined || (model.context ?? Number.POSITIVE_INFINITY) >= pick.minContext),
  )

  // A model with no measurement has no quality, and therefore no value: the
  // price is known but the numerator is not. Scoring it at a neutral 50 would
  // invent a rank and let a cheap unknown outrank a measured model, so drop the
  // unranked ones while any measured candidate remains. If the table covers
  // nothing at all (rankings.json missing, or a catalog of brand-new models),
  // keep the pool rather than resolve no tier at all.
  const measured = allowed.filter((model) => (rankFor(table, model) ?? model.derivedRank) !== undefined)
  const pool2 = measured.length > 0 ? measured : allowed

  const scored = pool2.map((model) => {
    const ratio = anchorPrice > 0 ? model.price / anchorPrice : 0
    return { model, ratio, rank: rankFor(table, model) ?? model.derivedRank }
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

  // Every dimension is normalised to [0,1] across the band before it is
  // weighted, so a weight means what it says. Keeping raw units would let the
  // largest-numbered dimension swamp the rest: rank is ~50 while quality per
  // dollar is ~0.1, so a "35% quality" weight would still be 99% of the score.
  const rawValue = (entry: (typeof chosen)[number]) => quality(entry) / 100 / (1 + entry.ratio)
  const bestValue = Math.max(...chosen.map(rawValue)) || 1
  const need = pick.minContext ?? 32_000
  const rawContext = (entry: (typeof chosen)[number]) => {
    const size = entry.model.context ?? need
    return size / (size + need)
  }
  const bestContext = Math.max(...chosen.map(rawContext)) || 1
  const releases = chosen.map((entry) => entry.model.released)
  const oldest = Math.min(...releases)
  const recencySpan = Math.max(...releases) - oldest
  const rawPreference = (entry: (typeof chosen)[number]) => {
    const ordered = providerOrder.length === 0 ? 0.5 : 1 - providerIndex(entry) / providerOrder.length
    // A bias below 1 is the hybrid placement preference; it only tilts.
    return (ordered + 1 / (entry.model.bias ?? 1)) / 2
  }
  const bestPreference = Math.max(...chosen.map(rawPreference)) || 1

  const weigh = { ...WEIGHT_PRESETS[pick.prefer ?? "value"], ...(pick.weigh ?? {}) }
  const language = pick.language ?? fit?.language ?? languageFor(kind, spec.brief, fit?.languages)
  const languageScore = (entry: (typeof chosen)[number]) => {
    const table = language ? fit?.languages?.[language] : undefined
    // No measurement for this language is neutral, not disqualifying.
    return table ? (rankFor(table, entry.model) ?? 50) / 100 : 0.5
  }

  const score = (entry: (typeof chosen)[number]) =>
    weigh.value * (rawValue(entry) / bestValue) +
    weigh.quality * (quality(entry) / 100) +
    weigh.price * (1 / (1 + entry.ratio)) +
    weigh.language * languageScore(entry) +
    weigh.context * (rawContext(entry) / bestContext) +
    weigh.recency * (recencySpan > 0 ? (entry.model.released - oldest) / recencySpan : 0.5) +
    weigh.preference * (rawPreference(entry) / bestPreference)

  const sorted = [...chosen].sort(
    (a, b) =>
      score(b) - score(a) ||
      quality(b) - quality(a) ||
      rawValue(b) - rawValue(a) ||
      a.model.price - b.model.price ||
      modelKey(a.model).localeCompare(modelKey(b.model)),
  )

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

  // The same model often appears on several providers, sometimes at different
  // prices and sometimes once locally. The cheaper cloud copy wins; the local
  // copy stays because it fails differently from a cloud one.
  let final = ordered
  if (pick.dedupe !== false) {
    const seen = new Set<string>()
    final = ordered.filter((entry) => {
      const key = `${entry.model.id}|${isLocalProvider(entry.model.providerID) ? "local" : "cloud"}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return final.slice(0, pick.limit ?? 3).map((entry) => ({
    ref: entry.model.ref,
    note:
      `${modelKey(entry.model)} ${entry.ratio.toFixed(2)}x rank ${quality(entry)} ` +
      `score ${score(entry).toFixed(3)}` +
      (entry.model.price === 0 ? " free" : ""),
  }))
}

export function resolveCandidates(
  spec: TierSpec,
  pool: readonly Candidate[],
  anchorKey: string | undefined,
  fallbackRank: Record<string, number> = {},
  kind?: string,
  fit?: Fit,
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
  return pickCandidates(spec, pool, anchorKey, fallbackRank, kind, fit)
}

/**
 * Append a provider's cheapest paid, tool-capable model when the tier's own
 * band did not reach it.
 *
 * A tier is a fallback list, and a free model that is out of allowance must not
 * end it while there is still credit on the provider the request runs on. For a
 * consult that provider is the session's base one; for a subagent's model
 * resolve it is the provider the request started on, because the hook cannot
 * change provider at all.
 *
 * This only ever adds a paid model: it never drops a free one, so the free and
 * paid halves stay separate. `allow`, `deny`, `providers` and `minContext` still
 * apply: a tier narrowed to chosen providers must not reach outside them for its
 * floor.
 *
 * `usable` prefers a model that is not cooling or already failed. When none is,
 * the cheapest one is still appended at the end of the walk, because a provider
 * key can be broader than the model it was learned from. `ask()` keeps cold
 * candidates and reaches it; the resolver serves only warm ones.
 */
export function withPaidTail(
  candidates: readonly Resolved[],
  spec: TierSpec,
  pool: readonly Candidate[],
  providerID: string | undefined,
  usable?: (model: Candidate) => boolean,
): Resolved[] {
  const copy = [...candidates]
  const pick = spec.pick
  if (!providerID || !pick) return copy
  const have = new Set(copy.map((candidate) => modelKey(candidate.ref)))
  const paid = pool
    .filter((model) => model.providerID === providerID)
    .filter((model) => !pick.providers || pick.providers.includes(model.providerID))
    .filter((model) => model.price > 0 && model.tools !== false)
    .filter((model) => !pick.allow || matchesAny(pick.allow, modelKey(model), model.id))
    .filter((model) => !matchesAny(pick.deny, modelKey(model), model.id))
    .filter((model) => pick.minContext === undefined || (model.context ?? Number.POSITIVE_INFINITY) >= pick.minContext)
    .filter((model) => !have.has(modelKey(model)))
    .sort((a, b) => a.price - b.price || b.released - a.released)
  const tail = (usable ? paid.find(usable) : paid[0]) ?? paid[0]
  if (!tail) return copy
  copy.push({ ref: tail.ref, note: `${modelKey(tail)} ${tail.price} paid tail`, tail: true })
  return copy
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

/** Providers that serve models from the machine rather than a billing API. */
export function isLocalProvider(providerID: string) {
  return /(ollama|lm-?studio|llama|vllm|localai|local)/i.test(providerID)
}

/** Parameter count in billions, read from an id like `llama-3.1-70b`. */
export function params(id: string) {
  const match = id.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i)
  const value = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * A stand-in price for a local model, so the price bands keep their meaning.
 * Bigger models and bigger contexts occupy the machine longer. This is a
 * heuristic, not a measurement: override it in `pricing` when it is wrong.
 */
export function inferLocalPrice(id: string, context = 0) {
  const size = params(id)
  if (size !== undefined) return Math.min(20, Math.round(size * 0.04 * 100) / 100)
  return Math.min(20, Math.max(0.1, Math.round((context / 32000) * 0.5 * 100) / 100))
}

/** A capability stand-in on the same 0-100 scale as the measured table. */
export function inferLocalRank(id: string, context = 0) {
  const size = params(id)
  if (size !== undefined) return Math.round(Math.min(85, 40 + size / 2))
  return Math.round(Math.min(70, Math.max(30, 30 + context / 8000)))
}
