import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { Settings } from "../rpc.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

import { createTrace, defaultTracePath } from "./trace.ts"

import {
  applyPricing,
  budgetFor,
  confidence,
  inferLocalPrice,
  inferLocalRank,
  isLocalProvider,
  blendedPrice,
  modelKey,
  parseModel,
  effectivePick,
  resolveCandidates,
  withPaidTail,
  type BudgetSpec,
  type Candidate,
  type PricingTable,
  type Resolved,
  type TierSpec,
} from "./select.ts"
import {
  classifyProviderError,
  cooldownFor,
  cooldownKeys,
  isCooling,
  providerKey,
  retryPlan,
  sliceBudget,
  type Refusal,
} from "./refusal.ts"

/**
 * Tier router for OpenCode 2.x.
 *
 * Two tools, neither of which hardcodes a model:
 *
 * - `consult` asks a blank-slate model at the same tier or a higher one for a
 *   decision. The caller's tier comes from its agent configuration, so a cheap
 *   conductor is pushed one tier up unless it asks for something explicit.
 * - `handoff` returns a finished report and has the tier above skim it first,
 *   so every hand-back to a parent gets a cheap second pair of eyes.
 *
 * A tier names models outright or describes a `pick` policy: a price band
 * relative to the session's base model, allow and deny patterns, a preference
 * for quality or cost, and an optional rank table. The band is what gives a
 * Claude user Claude-priced advisors and a cheap-model user cheap ones, and the
 * rank table is how a newer model of the same family wins without a code change.
 *
 * Both tools draw on token budgets, not call counts. The budget is keyed by the
 * root session, so a conductor and all its workers share one allowance per tier.
 */

type Options = {
  /** Low to high. Defaults to the key order of `tiers`. */
  order?: string[]
  tiers?: Record<string, TierSpec>
  /** Tier used when the caller's own tier cannot be determined. */
  fallback?: string
  /** Hard cap on a brief or report, in characters. */
  maxChars?: number
  /**
   * Per-tier spend policy. `share` is a fraction of the session's measured
   * tokens, `hardCap` is an absolute ceiling, `floor` is the base used before
   * the session has spent anything, and `bypass` lets a stated reason lift the
   * share up to the hard cap.
   */
  budget?: { floor?: number; tiers?: Record<string, BudgetSpec> }
  /**
   * The handoff skim has its own policy. `mode` is `risky` (skim only reports
   * where a wrong answer decides a change), `always`, or `off`.
   */
  skim?: BudgetSpec & {
    mode?: "risky" | "always" | "off"
    kinds?: string[]
    minChars?: number
  }
  /** Task kinds advertised to the tools. Each tier can override its policy per kind. */
  kinds?: string[]
  /** How long one consultant call may take before it is abandoned. */
  timeoutMs?: number
  /**
   * Where the `tier-router:` diagnostic lines go, on top of the console.
   * A path, or `false` for console only. Unset uses
   * `$XDG_DATA_HOME/opencode/log/tier-router.log`, beside the server's own log.
   * The file matters because a desktop-managed server runs with stdout on
   * `/dev/null`, so console output from a plugin is otherwise lost.
   */
  log?: string | false
  /**
   * Append one reminder line to the system prompt when a session has made this
   * many model requests without spawning a subagent. The line stays while the
   * session keeps working alone and disappears as soon as a subagent runs.
   * `true` or unset uses five requests, a number sets the interval, `false`
   * disables it.
   */
  nudge?: boolean | number
  /**
   * Where a handoff report is delivered. `parent` posts it into the parent
   * session through the session API, so delivery cannot be lost or paraphrased
   * by the child. `child` only returns it as the tool result, the old behaviour.
   */
  handoff?: { deliver?: "parent" | "child"; maxChars?: number }
  /**
   * Cascade gate: when a worker report scores below `minScore`, ask the next
   * tier the same question and deliver both, the way a cascade escalates when
   * the cheap answer fails its check.
   */
  cascade?: { enabled?: boolean; minScore?: number }
  /** Agent id to tier, for agents whose tier cannot be read from a model list. */
  agents?: Record<string, string>
  /**
   * What a model actually costs this machine, when that differs from the list
   * price: a subscription, a BYOK key, or a free tier. Wildcards, `"free"` for
   * zero, most specific pattern wins.
   */
  pricing?: PricingTable
  /**
   * Which models may be used at all: `hybrid` (default) both, `cloud` excludes
   * local providers, `local` excludes everything else.
   */
  mode?: "hybrid" | "cloud" | "local"
  /**
   * In hybrid, which side wins a close call. `value` (default) is price per
   * point, `local` and `cloud` bias their side. Ignored in a single-side mode.
   */
  prefer?: "value" | "local" | "cloud"
}

const DEFAULT_BRIEF = `You are a senior engineer brought in for a second opinion.

You cannot run tools, read files, or ask follow-up questions. The caller sees the
whole conversation; you see only the brief below. That is the point: a clean
context with no attachment to the caller's earlier reasoning.

Answer as the consultant, not as an assistant.`

const CONSULT_FORMAT = `Answer in this shape and nothing else:
1. Decision: one sentence.
2. Why: at most three bullets.
3. Next action: one concrete step.
If the brief is missing the fact that decides it, say "uncertain", name that fact, and stop.`

const SKIM_BRIEF = `You are checking work that a cheaper tier is about to hand back.

You get the task and the report. You do not get the conversation and you cannot
run tools. Skim, do not redo: look for a claim that does not follow, a step that
was skipped, or a result that does not match what was asked.

Reply in exactly one of these two shapes:
OK
or
PROBLEM: one sentence naming the defect, then one concrete correction.
End with a line starting "NEXT: " giving the single next action, so the caller can
continue from that line alone without re-reading the report.`

type Rankings = { rank: Record<string, number>; byKind: Record<string, Record<string, number>> }

function loadRankings(trace: ReturnType<typeof createTrace>): Rankings {
  for (const relative of ["./rankings.json", "../rankings.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
        rank?: Record<string, number>
        rankByKind?: Record<string, Record<string, number>>
      }
      if (parsed.rank && typeof parsed.rank === "object") {
        return { rank: parsed.rank, byKind: parsed.rankByKind ?? {} }
      }
    } catch {
      continue
    }
  }
  trace.line("tier-router: rankings.json not readable, falling back to price percentiles")
  return { rank: {}, byKind: {} }
}

/**
 * The mtime of this file, so the trace names the build that is actually loaded.
 * A stale plugin and a queued message look identical from a notice, and this is
 * the only way to tell them apart from the outside.
 */
function buildStamp(): string {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString()
  } catch {
    return "unknown"
  }
}

export default Plugin.define({
  id: "tier-router",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const tiers = options.tiers ?? {}
    const order = options.order ?? Object.keys(tiers)
    const maxChars = options.maxChars ?? 24_000
    const fallbackTier = options.fallback ?? order[order.length - 1] ?? "lead"
    const budget = options.budget ?? {}
    const skim = options.skim ?? {}
    const trace = createTrace(options.log ?? defaultTracePath)
    const rankings = loadRankings(trace)
    const kinds = options.kinds ?? ["general", "code", "code-go", "lookup", "review", "write"]
    const timeoutMs = options.timeoutMs ?? 60_000

    /** A provider that stops answering must not hold a tool call open forever. */
    function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
        work.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }
    const agentTiers = options.agents ?? {}

    if (order.length === 0) {
      trace.line("tier-router: no tiers configured, tools disabled")
      return
    }

    /** Tier a model reference belongs to, ignoring its variant. */
    function tierOf(model: { providerID: string; id: string } | undefined) {
      if (!model) return undefined
      const wanted = modelKey(model)
      for (const [name, tier] of Object.entries(tiers)) {
        for (const reference of tier.models ?? []) {
          if (reference.includes("~")) continue
          try {
            if (modelKey(parseModel(reference)) === wanted) return name
          } catch {
            continue
          }
        }
      }
      return undefined
    }

    function rank(name: string | undefined) {
      if (!name) return -1
      return order.indexOf(name)
    }

    function oneAbove(name: string | undefined) {
      const index = rank(name)
      if (index < 0) return fallbackTier
      return order[Math.min(order.length - 1, index + 1)] ?? fallbackTier
    }

    function resolveTier(wanted: string, callerTier: string | undefined) {
      if (!wanted) return oneAbove(callerTier)
      if (wanted === "same") return callerTier ?? fallbackTier
      if (tiers[wanted]) return wanted
      throw new Error(`${wanted} is not a tier. Use "same" or one of: ${order.join(", ")}.`)
    }

    /** Rough token count. The ledger only has to stay proportional to spend. */
    function estimateTokens(...parts: string[]) {
      let chars = 0
      for (const part of parts) chars += part.length
      return Math.ceil(chars / 4)
    }

    const roots = new Map<string, string>()

    /** Child sessions share one budget with the session that started the tree. */
    async function rootSession(sessionID: string): Promise<string> {
      const known = roots.get(sessionID)
      if (known) return known
      let current = sessionID
      for (let depth = 0; depth < 8; depth++) {
        const info = await ctx.session.get({ sessionID: current }).catch(() => undefined)
        const parent = info?.parentID
        if (!parent) break
        current = parent
      }
      roots.set(sessionID, current)
      return current
    }

    /** Cached input is billed below face value, so a budget has to weight it the same way. */
    const CACHE_READ_WEIGHT = 0.1
    const CACHE_WRITE_WEIGHT = 1.25

    /**
     * Tokens the root session has measured so far, from its own messages.
     *
     * `tokens.input` holds only the uncached part of the prompt: a live session
     * shows `{"input":1784,"cache":{"read":58496}}` on one message. Adding only
     * input, output and reasoning therefore counts a warm prefix as free, and a
     * cached session reads as a fraction of what it costs, so the allowance
     * never bites. Cached reads are billed at a tenth of the input price by
     * DeepSeek and Anthropic and at a quarter by Gemini, so they are weighted
     * rather than counted whole. A provider that reports no cache is unaffected.
     */
    async function measuredTokens(sessionID: string) {
      const root = await rootSession(sessionID)
      const messages = await ctx.session.context({ sessionID: root }).catch(() => [])
      let total = 0
      for (const message of messages) {
        const tokens = (
          message as {
            tokens?: {
              input?: number
              output?: number
              reasoning?: number
              cache?: { read?: number; write?: number }
            }
          }
        ).tokens
        if (!tokens) continue
        total +=
          Number(tokens.input ?? 0) +
          Number(tokens.output ?? 0) +
          Number(tokens.reasoning ?? 0) +
          CACHE_READ_WEIGHT * Number(tokens.cache?.read ?? 0) +
          CACHE_WRITE_WEIGHT * Number(tokens.cache?.write ?? 0)
      }
      return total
    }

    /** The policy for one tier, with the shared floor folded in. */
    function budgetSpec(tier: string): BudgetSpec {
      const spec = options.budget?.tiers?.[tier] ?? {}
      return { floor: options.budget?.floor ?? 0, ...spec }
    }

    /** Read a ledger and check the next charge fits. */
    async function reserve(sessionID: string, kind: string, tier: string, cost: number, limit: number) {
      const ledgerSession = await rootSession(sessionID)
      const ledgerKey = `${kind}/${ledgerSession}`
      const ledger = ((await ctx.storage.get(ledgerKey)) ?? {}) as Record<string, number>
      const spent = Number(ledger[tier] ?? 0)
      const fits = !Number.isFinite(limit) || spent + cost <= limit
      return { ledgerKey, ledger, spent, fits }
    }

    async function charge(ledgerKey: string, ledger: Record<string, number>, tier: string, total: number) {
      await ctx.storage.set(ledgerKey, { ...ledger, [tier]: total })
    }

    /**
     * How long a model stays out after a rate limit, mirroring the exponential
     * backoff the runner already uses for a failed request, but per model and
     * across requests. One strike is a minute, then two, four, eight, and it
     * stops doubling at ten. The wait never leaves the minutes: free tiers have
     * strict limits and a 429 says "not now", not "not today", so a flapping free
     * model must not hand the tier to a paid model for the rest of the day. A
     * success clears the strikes, so a provider that recovers is used again
     * straight away.
     */
    const COOLDOWN_BASE_MS = 60_000
    const COOLDOWN_MAX_MS = 600_000
    const COOLDOWN_FORGET_MS = 3_600_000
    /** How far above the base price a cheap tier may reach for its paid tail. */
    const PAID_TAIL_RATIO = 2

    type Cooldown = { strikes: number; until: number; at: number }

    /**
     * The remembered strikes, including those whose window has ended. A model
     * that is cooling is not retried, so the next refusal always arrives after
     * its window and looked like a first strike, which is why the wait never
     * grew past a minute. A record is forgotten an hour after its last strike.
     */
    async function cooldowns(): Promise<Record<string, Cooldown>> {
      const raw = ((await ctx.storage.get("cooldown").catch(() => undefined)) ?? {}) as Record<string, Cooldown>
      const now = Date.now()
      const live: Record<string, Cooldown> = {}
      for (const [key, value] of Object.entries(raw)) {
        const until = Number(value?.until ?? 0)
        const at = Number(value?.at ?? until)
        // A window longer than the forget period is kept until it ends, so a
        // gated model stays out for its hours instead of being pruned early.
        if (until <= now && now - at > COOLDOWN_FORGET_MS) continue
        live[key] = { strikes: Number(value?.strikes ?? 1), until, at }
      }
      return live
    }

    /**
     * Cooldown writes are a read-modify-write against one storage document.
     * Two sessions failing at the same moment used to overwrite each other's
     * key, losing the refusal that was being recorded, so the writes queue.
     * Reads stay outside the queue: a single set is atomic, so a reader sees
     * either the old document or the new one.
     */
    let coolingWrites: Promise<unknown> = Promise.resolve()
    function serialise<T>(work: () => Promise<T>): Promise<T> {
      const run = coolingWrites.then(work, work)
      coolingWrites = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    /**
     * Put a model out for a doubling wait, longer with every strike in a row.
     * A fixed wait is used for a refusal, which is a state rather than a
     * window, and the key decides whether that state covers one model or the
     * free or paid half of a provider.
     */
    async function strikeOne(key: string, fixedMs?: number) {
      const live = await cooldowns()
      const strikes = Number(live[key]?.strikes ?? 0) + 1
      // A rate limit stays in the minutes however many strikes it racks up. Free
      // tiers limit strictly, so a model that says 429 for the third time today
      // is telling the walk to look elsewhere for now, not to leave the free
      // pool for hours and make the tier pay. A refusal is the state that
      // deserves hours, and it arrives as `fixedMs`.
      const wait = fixedMs ?? Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (strikes - 1))
      const now = Date.now()
      // A window never shortens. A model that refused on a setting and later
      // answers a rate limit is still gated, so a minute must not replace the
      // hours it was already out for.
      const until = Math.max(Number(live[key]?.until ?? 0), now + wait)
      await ctx.storage.set("cooldown", { ...live, [key]: { strikes, until, at: now } })
      const kind = fixedMs === undefined ? "rate limited" : "refused"
      trace.line(`tier-router: ${key} ${kind}, out for ${Math.round((until - now) / 1000)}s (strike ${strikes})`)
    }

    /**
     * Write a failure's keys as one document, so a resolver in another session
     * cannot read the model key while the provider key that came with it is
     * still missing.
     */
    async function strikeAll(keys: string[], fixedMs?: number) {
      return serialise(async () => {
        for (const key of keys) await strikeOne(key, fixedMs)
      })
    }

    /** A reply clears the record, so a recovered model is tried at once. */
    async function forgive(key: string) {
      return serialise(async () => {
        const live = await cooldowns()
        if (!live[key]) return
        delete live[key]
        await ctx.storage.set("cooldown", live)
      })
    }

    async function catalogue(): Promise<Candidate[]> {
      const { data } = await ctx.model.list()
      const list: Candidate[] = []
      for (const model of data) {
        if (model.enabled === false) continue
        const context = Number(model.limit?.context ?? 0)
        const declared = applyPricing(blendedPrice(model.cost), options.pricing, modelKey(model), model.id)
        // A local model is compute-bound, not free. Give it a stand-in price and
        // rank so the same bands work without the user editing the tiers.
        const local = isLocalProvider(model.providerID)
        const mode = settings.mode
        if (mode === "cloud" && local) continue
        if (mode === "local" && !local) continue
        list.push({
          ref: { providerID: model.providerID, id: model.id },
          id: model.id,
          providerID: model.providerID,
          price: declared === 0 && local ? inferLocalPrice(model.id, context) : declared,
          tools: model.capabilities?.tools !== false,
          context,
          released: Number(model.time?.released ?? 0),
          ...(local ? { derivedRank: inferLocalRank(model.id, context) } : {}),
          // A preference only tilts ties; it never overrides the mode filter.
          ...(mode === "hybrid" && settings.prefer === "local" && local ? { bias: 0.7 } : {}),
          ...(mode === "hybrid" && settings.prefer === "cloud" && !local ? { bias: 0.7 } : {}),
          ...(mode === "hybrid" && settings.prefer === "cloud" && local ? { bias: 1.4 } : {}),
          ...(mode === "hybrid" && settings.prefer === "local" && !local ? { bias: 1.4 } : {}),
        })
      }
      return list
    }

    /**
     * The price that decides which half of a provider a cooldown covers. The
     * catalog is the authority; when it is empty the pricing table still says
     * whether the model is declared free, and anything else counts as paid.
     * Unknown is paid on purpose: it only widens the model cooldown, never the
     * provider one.
     */
    function priceFor(model: { providerID: string; id: string }): number {
      const found = poolCache.find((candidate) => modelKey(candidate.ref) === modelKey(model))
      if (found) return found.price
      return applyPricing(1, options.pricing, modelKey(model), model.id)
    }

    /** Try each candidate in order, the way a fallback list works. */
    async function ask(
      tierName: string,
      prompt: string,
      anchorKey: string | undefined,
      kind?: string,
      budgetMs: number = timeoutMs,
    ) {
      const pool = await catalogue()
      // A kind-specific table wins over the general one, so a model that is
      // strong at code but average overall can still lead a code consult.
      const table = kind && rankings.byKind[kind] ? { ...rankings.rank, ...rankings.byKind[kind] } : rankings.rank
      const spec = tiers[tierName] ?? {}
      // A cooling model answers with the same 429 it gave last time, so it goes
      // to the back of the walk. The list is reordered, never shortened: when
      // every model is cooling, the soonest to recover is still the best try,
      // and a paid model in the band is reached before a free one that is out.
      const live = await cooldowns()
      const now = Date.now()
      const priceOf = new Map(pool.map((model) => [modelKey(model), model.price]))
      const priceAt = (candidate: Resolved) => priceOf.get(modelKey(candidate.ref)) ?? priceFor(candidate.ref)
      const coldOf = (candidate: Resolved) => isCooling(live, candidate.ref, priceAt(candidate), now)
      // The root provider's cheapest paid model is the floor of the walk, even
      // when the band does not reach it: a consult must not end empty while the
      // session it serves is still being answered.
      const picked = spec.pick ? effectivePick(spec.pick, kind) : undefined
      const candidates: Resolved[] = withPaidTail(
        resolveCandidates(spec, pool, anchorKey, table, kind),
        { ...spec, ...(picked ? { pick: picked } : {}) },
        pool,
        anchorKey?.split("/")[0],
        (model) => !isCooling(live, model.ref, model.price, now),
      )
      if (candidates.length === 0) throw new Error(`tier "${tierName}" resolved no models`)
      trace.line(
        `tier-router: ${tierName}${kind ? `/${kind}` : ""} for base ${anchorKey ?? "unknown"} -> ` +
          candidates.map((candidate) => candidate.note).join(" | "),
      )
      const available = new Set(pool.map((model) => modelKey(model)))
      const warm = candidates.filter((candidate) => !coldOf(candidate))
      const cold = candidates.filter(coldOf)
      const walk = warm.length > 0 ? [...warm, ...cold] : cold
      const failures: string[] = []
      // The budget covers the whole walk, but each candidate gets a share of
      // what is left rather than the whole deadline. A slow second candidate
      // used to spend the lot and leave the last one "not tried"; a short list
      // now always reaches its tail.
      const deadline = Date.now() + budgetMs
      for (const [index, candidate] of walk.entries()) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          failures.push(`${modelKey(candidate.ref)}: not tried, the call budget ran out`)
          break
        }
        if (!available.has(modelKey(candidate.ref))) {
          failures.push(`${modelKey(candidate.ref)}: not available`)
          continue
        }
        const slice = sliceBudget(remaining, walk.length - index)
        try {
          const result = await withTimeout(
            ctx.experimental.generate.text({ model: candidate.ref, prompt }),
            slice,
            `${modelKey(candidate.ref)} reply`,
          )
          const text = (result?.text ?? "").trim()
          if (!text) {
            failures.push(`${modelKey(candidate.ref)}: empty reply`)
            continue
          }
          // A reply proves both the model and its provider half are usable, so
          // a cooldown that was too broad is cleared rather than left to expire.
          await forgive(modelKey(candidate.ref))
          await forgive(providerKey(candidate.ref.providerID, priceAt(candidate)))
          // Name the shift when the walk had to skip a cooling model, so the
          // caller reads the reply as a tier that moved and not as a special one.
          const lead =
            cold.length > 0
              ? `[tier-router: ${cold.map((item) => modelKey(item.ref)).join(", ")} cooling, ` +
                `served by ${modelKey(candidate.ref)}]\n`
              : ""
          return { text: lead + text, model: modelKey(candidate.ref), note: candidate.note }
        } catch (error) {
          const key = modelKey(candidate.ref)
          // The same classifier as the retry hook: a refusal is not a rate
          // limit, and a refusal is recorded even when this was the only
          // candidate or the budget ends the walk.
          const refusal: Refusal = classifyProviderError(error)
          await strikeAll(cooldownKeys(refusal, candidate.ref, priceAt(candidate)), cooldownFor(refusal))
          if (refusal.kind !== "none") {
            trace.line(`tier-router: ask ${tierName} ${key} ${refusal.kind}: ${refusal.reason}`)
          }
          failures.push(`${key}: ${(error as Error)?.message ?? String(error)}`)
        }
      }
      const coolingNote =
        cold.length > 0
          ? `\nCooling: ${cold.map((item) => modelKey(item.ref)).join(", ")}.` +
            " They recover on their own, so ask again rather than answering the question yourself."
          : ""
      throw new Error(`every model in tier "${tierName}" failed.\n${failures.join("\n")}${coolingNote}`)
    }

    async function callerOf(context: { agent: string; sessionID: string }) {
      const agent = await ctx.agent
        .get({ agentID: context.agent })
        .then((result) => result.data)
        .catch(() => undefined)
      const session = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
      const root = await rootSession(context.sessionID)
      const rootInfo =
        root === context.sessionID ? session : await ctx.session.get({ sessionID: root }).catch(() => undefined)
      // The base model is the user's own choice for the tree, so it sets the ratio.
      const base = rootInfo?.model ?? session?.model ?? agent?.model ?? undefined
      const id = agent?.id ?? context.agent
      const declared = agentTiers[id]
      const tier = declared && tiers[declared] ? declared : tierOf(agent?.model ?? undefined)
      return { agent: id, tier, base: base ? modelKey(base) : undefined }
    }

    const shares = order
      .map((tier) => {
        const spec = options.budget?.tiers?.[tier] ?? {}
        const share = spec.share === undefined ? "no share" : `${Math.round(spec.share * 100)}%`
        const cap = spec.hardCap === undefined ? "" : `, cap ${Math.round(spec.hardCap)}`
        return `${tier} ${share}${cap}`
      })
      .join("; ")
    const shared =
      `Tiers, low to high: ${order.join(", ")}. ` +
      `Budgets are shares of the session's measured tokens (${shares}), shared by the whole session tree, ` +
      "so a worker and its conductor draw from the same allowance."

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "consult",
        description:
          "Ask a blank-slate model at the same tier or a higher one for a decision. " +
          `${shared} Omit tier to reach one tier above your own; "same" is a clean copy of your own. ` +
          "Use it when genuinely stuck: a decision that is expensive to reverse, the same error twice, " +
          "or a check before calling risky work done. Never for a fact a worker can look up. " +
          "It shares only what you write in the brief, never the conversation. " +
          "Each tier may spend a share of the session's measured tokens, with a hard cap above it, " +
          "and a reason lifts the share but never the cap.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            brief: {
              type: "string",
              description:
                "Everything the consultant needs, in your own words: the task, what you tried, " +
                "the evidence, and the constraint that matters. No secrets, credentials or hostnames.",
            },
            question: { type: "string", description: "The single decision you want answered." },
            kind: {
              type: "string",
              description:
                `What kind of work this is, so the tier can pick a model that fits: ${kinds.join(", ")}. ` +
                "Defaults to general.",
            },
            reason: {
              type: "string",
              description:
                "One line saying why this call must exceed the tier's share of the session, " +
                "for example the same failure twice or a decision that is expensive to reverse. " +
                "It can never exceed the hard cap.",
            },
            tier: {
              type: "string",
              description: `"same", or one of: ${order.join(", ")}. Omit to reach one tier above yours.`,
            },
          },
          required: ["brief", "question"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { brief: string; question: string; tier?: string; kind?: string; reason?: string }
          const brief = String(args.brief ?? "").trim()
          const question = String(args.question ?? "").trim()
          if (!brief || !question) throw new Error("consult needs both a brief and a question")

          const caller = await callerOf(context)
          const target = resolveTier((args.tier ?? "").trim().toLowerCase(), caller.tier)
          const policy = budgetSpec(target)
          const prompt = [
            tiers[target]?.brief ?? DEFAULT_BRIEF,
            `You are the "${tiers[target]?.label ?? target}" consultant.`,
            "## Caller's brief",
            brief.slice(0, maxChars),
            "## Question",
            question,
            CONSULT_FORMAT,
            policy.maxReplyTokens === undefined
              ? ""
              : `Keep the whole answer under ${policy.maxReplyTokens} tokens.`,

          ].join("\n\n")

          const reserved = estimateTokens(prompt) + 400
          const slot = await reserve(context.sessionID, "consult", target, reserved, Number.POSITIVE_INFINITY)
          const sessionTokens = await measuredTokens(context.sessionID)
          const usesKey = `uses/${await rootSession(context.sessionID)}`
          const uses = ((await ctx.storage.get(usesKey)) ?? {}) as Record<string, number>
          const used = Number(uses[target] ?? 0)
          if (policy.maxUses !== undefined && used >= policy.maxUses) {
            throw new Error(
              `consult: the "${target}" tier allows ${policy.maxUses} calls per session and they are used. ` +
                "Answer from what you have.",
            )
          }
          const verdict = budgetFor(policy, sessionTokens, slot.spent, reserved, args.reason)
          if (!verdict.allowed) {
            throw new Error(
              `consult: the "${target}" tier may spend ${
                Number.isFinite(verdict.limit) ? Math.round(verdict.limit) : "any"
              } tokens ` +
                `(${verdict.bound}), the session has measured ${sessionTokens} tokens, and ` +
                `${slot.spent} is already spent, so this ${reserved}-token call does not fit. ` +
                "Pass a one-line `reason` to exceed the share up to the hard cap, " +
                "or answer from what you have.",
            )
          }

          const kind = (args.kind ?? "").trim().toLowerCase() || undefined
          const answer = await ask(target, prompt, caller.base, kind)
          const cap = policy.maxReplyTokens
          const reply =
            cap !== undefined && estimateTokens(answer.text) > cap
              ? `${answer.text.slice(0, cap * 4).trimEnd()}\n[capped at ${cap} tokens]`
              : answer.text
          const charged = estimateTokens(prompt, reply)
          const total = slot.spent + charged
          await charge(slot.ledgerKey, slot.ledger, target, total)
          await ctx.storage.set(usesKey, { ...uses, [target]: used + 1 })
          // A bypassed call is spending against the hard cap, so show that
          // ceiling rather than the share it just crossed.
          const ceiling =
            verdict.bypassed && typeof policy.hardCap === "number" ? policy.hardCap : verdict.limit
          // Never put a non-finite number in the result: the harness drops it.
          const shown = Number.isFinite(ceiling)
            ? `${total}/${Math.round(ceiling)}${verdict.bypassed ? " bypassed" : ""}`
            : `${total}`
          return {
            content: `[${target} · ${answer.model} · ${shown} tokens]\n\n${reply}`,
            metadata: {
              tier: target,
              model: answer.model,
              picked: answer.note,
              callerTier: caller.tier ?? "unknown",
              base: caller.base ?? "unknown",
              tokens: charged,
              budget: Number.isFinite(ceiling) ? Math.round(ceiling) : null,
              budgetBound: verdict.bound,
              bypassed: verdict.bypassed,
              uses: `${used + 1}${policy.maxUses === undefined ? "" : `/${policy.maxUses}`}`,
            },
          }
        },
      })

      editor.add({
        name: "handoff",
        description:
          "Finish by handing a report back, with a quick skim by the tier above before the parent sees it. " +
          `${shared} The skim has its own allowance and is short, so use this for every report you return. ` +
          "It returns the skim verdict followed by your report, so you can fix a PROBLEM before you stop.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "What was asked of you, in one or two lines. The skim checks the report against this.",
            },
            report: {
              type: "string",
              description: "Your finished report, in the shape your agent instructions ask for.",
            },
            kind: {
              type: "string",
              description: `What kind of work the report covers, so the skimmer fits: ${kinds.join(", ")}.`,
            },
            tier: {
              type: "string",
              description: `Who skims it. Defaults to one tier above yours. One of: ${order.join(", ")}.`,
            },
          },
          required: ["task", "report"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { task: string; report: string; tier?: string; kind?: string }
          const task = String(args.task ?? "").trim()

          // A top-level session has no parent to hand to, so a skim would spend
          // the advisor tier to tell the user something they already have.
          const own = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
          if (own && !own.parentID) {
            return {
              content: `[no skim · this is the top-level session]\n\n${String(args.report ?? "").trim().slice(0, maxChars)}`,
              metadata: { skim: "top-level" },
            }
          }
          const report = String(args.report ?? "").trim().slice(0, maxChars)
          if (!task || !report) throw new Error("handoff needs both the task and the report")

          // Persist before any model call, so an interrupted skim still leaves
          // the report on disk.
          let saved: string | undefined
          try {
            const dir = join(tmpdir(), "opencode-handoff")
            mkdirSync(dir, { recursive: true })
            saved = join(dir, `${context.sessionID}.md`)
            writeFileSync(saved, `# ${task}\n\n${report}\n`)
          } catch {
            saved = undefined
          }

          const caller = await callerOf(context)
          const target = resolveTier((args.tier ?? "").trim().toLowerCase(), caller.tier)
          const kind = (args.kind ?? "").trim().toLowerCase() || "general"
          const gate = confidence(report)
          let escalated: { tier: string; text: string; model: string } | undefined
          if (
            (options.cascade?.enabled ?? true) &&
            gate.score < (options.cascade?.minScore ?? 0.5) &&
            gate.missing.length > 0
          ) {
            const up = resolveTier("", caller.tier)
            const escalation =
              `A cheaper tier handed this back and it failed a check: ${gate.missing.join(", ")}.\n\n` +
              `## Task\n${task.slice(0, 1200)}\n\n## Its report\n${report.slice(0, 2500)}\n\n` +
              "Answer the task yourself, briefly, and name what the cheap report got wrong."
            const reserved = estimateTokens(escalation) + 300
            const slot = await reserve(context.sessionID, "consult", up, reserved, Number.POSITIVE_INFINITY)
            const allowed = budgetFor(budgetSpec(up), await measuredTokens(context.sessionID), slot.spent, reserved)
            if (allowed.allowed) {
              try {
                const answer = await ask(up, escalation, caller.base, kind === "general" ? undefined : kind)
                escalated = { tier: up, text: answer.text, model: answer.model }
                await charge(slot.ledgerKey, slot.ledger, up, slot.spent + estimateTokens(escalation, answer.text))
              } catch {
                escalated = undefined
              }
            }
          }

          const deliverTo = options.handoff?.deliver ?? "parent"
          const deliverLimit = options.handoff?.maxChars ?? 8000

          /** Post the report into the parent session, so the child cannot drop it. */
          async function deliver(note: string) {
            if (deliverTo !== "parent" || !own?.parentID) return false
            const body =
              report.length <= deliverLimit
                ? report
                : `${report.slice(0, deliverLimit)}\n\n[truncated at ${deliverLimit} chars, full report: ${saved ?? "not saved"}]`
            const text = [
              `[handoff · ${caller.agent} · ${note}]`,
              `Task: ${task.slice(0, 400)}`,
              "",
              body,
              escalated
                ? `\n[escalated · ${escalated.tier} · ${escalated.model}]\n${escalated.text.slice(0, 3000)}`
                : "",
              saved ? `\nSaved: ${saved}` : "",
            ].join("\n")
            try {
              await ctx.session.synthetic({ sessionID: own.parentID, text })
              return true
            } catch {
              return false
            }
          }
          const body =
            report.length <= 3000
              ? report
              : `${report.slice(0, 2000)}\n\n[... ${report.length - 3000} chars omitted ...]\n\n${report.slice(-1000)}`
          const prompt = [
            SKIM_BRIEF,
            `## Task given to the ${caller.tier ?? caller.agent} tier (kind: ${kind})`,
            task.slice(0, 1500),
            "## Report it is handing back",
            body,
          ].join("\n\n")

          const mode = skim.mode ?? "risky"
          const skimmable =
            mode === "always" ||
            (mode === "risky" &&
              (skim.kinds ?? ["code", "code-go", "review", "write"]).includes(kind) &&
              report.length >= (skim.minChars ?? 200))
          if (!skimmable) {
            const sent = await deliver(`no skim · ${kind}`)
            return {
              content: sent
                ? `[delivered to your parent · no skim · ${kind}]\n\nYour report reached the parent session; you can end with one line.`
                : `[no skim · ${target} · ${kind} report is ${report.length} chars]\n\n${report}`,
              metadata: { tier: target, skim: "not-needed", mode, delivered: sent },
            }
          }

          const reserved = estimateTokens(prompt) + 200
          const slot = await reserve(context.sessionID, "skim", target, reserved, Number.POSITIVE_INFINITY)
          const sessionTokens = await measuredTokens(context.sessionID)
          const verdictBudget = budgetFor(
            { floor: options.budget?.floor ?? 0, ...skim },
            sessionTokens,
            slot.spent,
            reserved,
          )
          if (!verdictBudget.allowed) {
            const sent = await deliver("skim skipped · allowance spent")
            return {
              content: sent
                ? `[delivered to your parent · skim skipped]\n\nYour report reached the parent session; you can end with one line.`
                : `[skim skipped · ${target} allowance ${Math.round(verdictBudget.limit)} spent]\n\n${report}`,
              metadata: { tier: target, skim: "skipped", budget: Math.round(verdictBudget.limit), delivered: sent },
            }
          }

          let verdict: string
          let model: string
          try {
            const answer = await ask(
              target,
              prompt,
              caller.base,
              kind === "general" ? undefined : kind,
              Math.min(timeoutMs, 40_000),
            )
            verdict = answer.text
            model = answer.model
          } catch (error) {
            const reason = (error as Error)?.message ?? String(error)
            const sent = await deliver(`skim failed · ${reason}`)
            return {
              content: sent
                ? `[delivered to your parent · skim failed: ${reason}]\n\nYour report reached the parent session; you can end with one line.`
                : `[skim failed · ${target}]\n\n${report}\n\nskimmer error: ${reason}`,
              metadata: { tier: target, skim: "failed", delivered: sent },
            }
          }

          const charged = estimateTokens(prompt, verdict)
          await charge(slot.ledgerKey, slot.ledger, target, slot.spent + charged)
          const clean = verdict.trim().toUpperCase().startsWith("OK")
          const sent = await deliver(`skim by ${target} · ${model} · ${clean ? "ok" : "problem"}\n${verdict.slice(0, 600)}`)
          return {
            content: sent
              ? `[delivered to your parent · skim by ${target} · ${clean ? "ok" : "problem"}]\n${verdict.slice(0, 600)}\n\n` +
                "Your report reached the parent session; end with one line."
              : `[skim by ${target} · ${model}]\n${verdict}\n\n---\n\n${report}`,
            metadata: {
              tier: target,
              model,
              callerTier: caller.tier ?? null,
              skim: clean ? "ok" : "problem",
              delivered: sent,
              tokens: charged,
              budget: Math.round(verdictBudget.limit),
            },
          }
        },
      })
    })

    // Per-request reminder. Instructions are read once and compete with the
    // model's own plan; a line in the system prompt arrives at the moment the
    // decision is made. It stops as soon as the session spawns a child, so a
    // session that delegates pays for it at most once.
    // Nudge only agents that are actually allowed to spawn, read from their
    // permissions rather than a list of names, so a renamed or user-defined
    // conductor is covered and a worker is not pestered to delegate.
    const spawnable = new Set<string>()
    try {
      const { data: agents } = await ctx.agent.list()
      for (const agent of agents) {
        const rules = agent.permissions ?? []
        // Either a specific subagent allow list, or the blanket `*: *: allow`
        // that a built-in agent like build carries.
        const can =
          rules.some((rule) => rule.action === "subagent" && rule.effect === "allow") ||
          rules.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
        if (can) spawnable.add(agent.id)
      }
    } catch {
      for (const id of Object.keys(agentTiers)) {
        if (agentTiers[id] !== "worker") spawnable.add(id)
      }
    }
    // Requests a session has made, and the request count at its last subagent
    // call. The difference is how long it has been working alone.
    const requests = new Map<string, number>()
    const spawnedAt = new Map<string, number>()
    const reminding = new Set<string>()
    // A value saved from the desktop panel wins over the config file, so the
    // setting survives a restart without editing JSON.
    const saved = ((await ctx.storage.get("settings").catch(() => undefined)) ?? {}) as {
      mode?: string
      prefer?: string
    }
    const settings = {
      mode: (saved.mode ?? options.mode ?? "hybrid") as "hybrid" | "cloud" | "local",
      prefer: (saved.prefer ?? options.prefer ?? "value") as "value" | "local" | "cloud",
    }
    try {
      // The JSON Schema literal is portable at runtime; the promise helper types
      // it as a local ValueSchema, hence the cast.
      await ctx.rpc.register(Settings as never, {
        get: async () => ({ ...settings }),
        set: async (input) => {
          const patch = input as { mode?: string; prefer?: string }
          if (patch.mode === "hybrid" || patch.mode === "cloud" || patch.mode === "local") settings.mode = patch.mode
          if (patch.prefer === "value" || patch.prefer === "local" || patch.prefer === "cloud") {
            settings.prefer = patch.prefer
          }
          await ctx.storage.set("settings", { ...settings })
          return { ...settings }
        },
      })
    } catch (error) {
      trace.line(`tier-router: settings rpc unavailable: ${(error as Error)?.message ?? error}`)
    }

    // A session that delegates once and then drifts back to doing the reading
    // itself needs the reminder again, so the interval is measured from the
    // last spawn instead of from the session start, and there is no budget.
    const nudgeEvery =
      options.nudge === false ? 0 : typeof options.nudge === "number" && options.nudge > 0 ? options.nudge : 5

    if (nudgeEvery > 0) {
      try {
        await ctx.tool.hook("execute.before", (event) => {
          if (event.tool !== "subagent") return
          const session = String(event.sessionID)
          spawnedAt.set(session, requests.get(session) ?? 0)
          reminding.delete(session)
        })
      } catch (error) {
        trace.line(`tier-router: tool hook unavailable, no nudge: ${(error as Error)?.message ?? error}`)
      }

      try {
        await ctx.session.hook("context", (event) => {
          try {
            const session = String(event.sessionID)
            const agent = String(event.agent)
            if (!spawnable.has(agent)) return
            const seen = (requests.get(session) ?? 0) + 1
            requests.set(session, seen)
            // Start on the second request, the way the vendor's own nudge waits
            // for the executor to orient before reminding it.
            if (seen < 2) return
            if (seen - (spawnedAt.get(session) ?? 0) < nudgeEvery) {
              reminding.delete(session)
              return
            }
            event.system.push({
              type: "text",
              text:
                "Delegation reminder: if this task needs more than one file read or shell call, " +
                "spawn a swarm-worker for that reading now, before you start it. Workers run on a free model.",
            })
            if (!reminding.has(session)) {
              reminding.add(session)
              trace.line(`tier-router: delegation reminder on for ${agent} after ${seen} requests without a spawn`)
            }
          } catch {
            // A reminder must never break a request.
          }
        })
      } catch (error) {
        trace.line(`tier-router: session hook unavailable, no nudge: ${(error as Error)?.message ?? error}`)
      }
    }

    // A subagent takes its model from its tier on every request instead of
    // carrying a fixed one in its own file, so a model that answers with a rate
    // limit is swapped for the next candidate rather than failing the task. The
    // agent the user chose for the session keeps the model they chose, which is
    // why this only serves sessions that have a parent.
    const pinned = new Map<string, string>()
    /** Per session, the models that have already refused, so none is asked twice. */
    const failed = new Map<string, Set<string>>()
    /** Sessions with nothing left both untried and warm. */
    const exhausted = new Set<string>()
    /** Sessions told about the current outage, so a walk of three models is one message. */
    const announced = new Set<string>()
    /** Whether the last resolve had to reach past the free models to a paid one. */
    const paidServed = new Set<string>()
    /** Sessions whose ordered candidate list has been written to the trace. */
    const orderSeen = new Set<string>()
    const parented = new Map<string, boolean>()
    let poolAt = 0
    let poolCache: Candidate[] = []

    /** The model list, shared for a minute so a per-request hook stays cheap. */
    async function pool(): Promise<Candidate[]> {
      const now = Date.now()
      if (poolCache.length > 0 && now - poolAt < 60_000) return poolCache
      const list = await catalogue().catch(() => [])
      if (list.length > 0) {
        poolCache = list
        poolAt = now
      }
      return poolCache
    }

    /** A session with a parent is a subagent. The root one is the user's own. */
    async function isChild(sessionID: string): Promise<boolean> {
      const known = parented.get(sessionID)
      if (known !== undefined) return known
      const info = await ctx.session.get({ sessionID }).catch(() => undefined)
      const child = Boolean(info?.parentID)
      parented.set(sessionID, child)
      return child
    }

    /**
     * Tell the caller that a subagent's model refused, so it does not take the
     * work over itself. One notice per caller per outage: a second refusal
     * inside the same window says nothing new, while a longer window after
     * another strike is worth saying again. The record is stored beside the
     * cooldowns it describes, so a plugin reload does not repeat a notice the
     * caller has already read.
     */
    async function inform(sessionID: string, agent: string, key: string, keys: string[], gaveUp: boolean) {
      try {
        const info = await ctx.session.get({ sessionID }).catch(() => undefined)
        const parent = info?.parentID
        if (!parent) return
        const now = Date.now()
        // Only a give-up is worth a word. While the walk is still retrying the
        // worker is alive and the caller has nothing to do, and a notice about a
        // state that has moved on by the time it is delivered is worse than none.
        if (!gaveUp) return
        if (announced.has(sessionID)) return
        announced.add(sessionID)
        const live = await cooldowns()
        // A provider-wide refusal parks every model of that class, so the
        // notice must quote the longest window among the keys that were struck.
        const until = keys.reduce(
          (latest, strikeKey) => Math.max(latest, live[strikeKey]?.until ?? 0),
          now + COOLDOWN_BASE_MS,
        )
        const told = ((await ctx.storage.get("informed").catch(() => undefined)) ?? {}) as Record<string, number>
        const slot = `${parent}|${keys.join(",")}`
        if (Number(told[slot] ?? 0) >= until) return
        const kept: Record<string, number> = {}
        for (const [name, deadline] of Object.entries(told)) {
          if (Number(deadline) > now) kept[name] = Number(deadline)
        }
        kept[slot] = until
        await ctx.storage.set("informed", kept)
        const seconds = Math.max(1, Math.round((until - now) / 1000))
        const span =
          seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`
        // The wording follows what the retry does. The first two attempts are
        // still running on another model, so the caller should wait for that
        // worker rather than start the work itself. Neutral about the cause,
        // because a rate limit and a refusal read the same from here. It does
        // not name another agent, because the one that just failed may be that
        // agent's tier: `swarm-worker-code` is a lead-tier subagent now.
        const text =
          `${agent} could not use ${key}, which is out for about ${span}, and the tier has no working model ` +
          `left. Use a different subagent or do the reading yourself.`
        await ctx.session.synthetic({
          sessionID: parent,
          description: "tier router: subagent rate limit",
          delivery: "queue",
          text,
        })
      } catch (error) {
        trace.line(`tier-router: could not tell the caller about a rate limit: ${(error as Error)?.message ?? error}`)
      }
    }

    try {
      await ctx.session.hook("experimental.model.resolve", async (event) => {
        const tierName = agentTiers[String(event.agent)]
        if (!tierName || !tiers[tierName]) return
        if (event.kind !== "primary") return
        if (!(await isChild(event.sessionID))) return
        const models = await pool()
        if (models.length === 0) return
        // Two rules decide the order. Free before paid, so a paid model is used
        // only once every free candidate has been tried or is out. Then the
        // provider already in play before the rest, so the prompt cache stays
        // warm while that provider still has something to offer. Every tier
        // also ends with a paid model on that provider, so a walk cannot end
        // empty while there is still credit there.
        //
        // The walk stays on the provider the request started on. OpenCode's
        // resolve hook cannot change provider: a model from another provider
        // comes back as `ModelUnavailableError` before the request is sent, and
        // the subagent dies on its first failover. The provider is chosen by the
        // agent's model, or by the `model` passed to the spawn, and this hook
        // only walks the models on it.
        const from = event.model.providerID
        const tier = tiers[tierName]
        const spec = tier.pick ? { ...tier, pick: { ...tier.pick, providers: [from] } } : tier
        const cheap = !spec.pick?.ratio || spec.pick.ratio[0] === 0
        // The band is priced against the session's own base model, the anchor a
        // consult already uses. Without it the ratio has nothing to compare to,
        // which left the paid tail reaching only the cheapest paid models.
        const rootID = await rootSession(event.sessionID)
        const rootInfo = await ctx.session.get({ sessionID: rootID }).catch(() => undefined)
        const anchor = rootInfo?.model ? modelKey(rootInfo.model) : undefined
        const live = await cooldowns()
        const nowMs = Date.now()
        const priceOf = new Map(models.map((model) => [modelKey(model), model.price]))
        // Every model this session has already failed on is out of the running,
        // whether or not its cooldown has ended. A tier is a list of attempts:
        // while an untried model remains, the failed one is not asked again.
        const done = failed.get(event.sessionID) ?? new Set<string>()
        failed.set(event.sessionID, done)
        // A model comes back once its window ends. A session that lives for
        // days must not remember a strike forever; the window is the authority
        // on how long the account needs.
        for (const key of [...done]) {
          if ((live[key]?.until ?? 0) <= nowMs) done.delete(key)
        }
        // The tail prefers a paid model that can answer now. When every paid
        // model of the root provider is out, the cheapest is still appended at
        // the very end, because a provider key can be broader than the model
        // the refusal was learned from.
        const usableTail = (model: Candidate) =>
          !done.has(modelKey(model.ref)) && !isCooling(live, model.ref, model.price, nowMs)
        const ordered = withPaidTail(
          resolveCandidates(spec, models, anchor, rankings.rank),
          spec,
          models,
          from,
          usableTail,
        )
        const reachable = cheap
          ? withPaidTail(
              resolveCandidates(
                { ...spec, pick: { ...spec.pick, ratio: [0, PAID_TAIL_RATIO] } },
                models,
                anchor,
                rankings.rank,
              ),
              spec,
              models,
              from,
              usableTail,
            )
          : ordered
        // Every candidate is on this provider now, so the group only separates
        // free from paid; the provider half stays for the trace's shape.
        const group = (candidate: Resolved) => ((priceOf.get(modelKey(candidate.ref)) ?? 1) === 0 ? 0 : 2)
        // The paid floor is last, as the issue asks: an in-band candidate is
        // preferred even when the floor shares the session's own provider.
        const candidates = [...reachable].sort(
          (a, b) => Number(Boolean(a.tail)) - Number(Boolean(b.tail)) || group(a) - group(b),
        )
        if (candidates.length === 0) return
        if (!orderSeen.has(event.sessionID)) {
          orderSeen.add(event.sessionID)
          trace.line(
            `tier-router: ${event.agent} order ${candidates
              .slice(0, 8)
              .map((candidate) => `${group(candidate)}:${modelKey(candidate.ref)}`)
              .join(" ")}`,
          )
        }
        // An unknown price counts as paid, so the provider rule only ever
        // widens the cooldown for models known to be free.
        const cooling = (candidate: Resolved) =>
          isCooling(live, candidate.ref, priceOf.get(modelKey(candidate.ref)) ?? 1, nowMs)
        const untried = candidates.filter((candidate) => !done.has(modelKey(candidate.ref)))
        const warm = untried.filter((candidate) => !cooling(candidate))
        if (warm.length === 0) {
          // Nothing left that is both untried and reachable now, so another
          // attempt would repeat a refusal the caller has already paid for.
          // Name what the provider boundary put out of reach: the tier may still
          // have candidates, but the hook cannot cross to them.
          const elsewhere = resolveCandidates(tier, models, anchor, rankings.rank)
            .filter((candidate) => candidate.ref.providerID !== from)
            .filter((candidate) => !done.has(modelKey(candidate.ref)))
            .filter((candidate) => !isCooling(live, candidate.ref, priceOf.get(modelKey(candidate.ref)) ?? 1, nowMs))
          if (elsewhere.length > 0) {
            trace.line(
              `tier-router: ${event.agent} has nothing left on ${from}; the model hook cannot change provider, ` +
                `so ${elsewhere
                  .slice(0, 4)
                  .map((candidate) => modelKey(candidate.ref))
                  .join(", ")} stay out of reach`,
            )
          }
          exhausted.add(event.sessionID)
          return
        }
        exhausted.delete(event.sessionID)
        // The outage that produced the last notice is over, so a later one is a
        // different outage and deserves its own word.
        announced.delete(event.sessionID)
        // Hold whatever this session was first served while it is still warm and
        // untried. Re-picking the top candidate on every request would cold-write
        // the prefix whenever the model list reorders, which is the cost prompt
        // caching exists to avoid.
        const remembered = pinned.get(event.sessionID)
        const held = remembered ? warm.find((candidate) => modelKey(candidate.ref) === remembered) : undefined
        const pick = held ?? warm[0]
        if (!pick) {
          exhausted.add(event.sessionID)
          return
        }
        const key = modelKey(pick.ref)
        if (cheap && (priceOf.get(key) ?? 0) > 0 && !paidServed.has(event.sessionID)) {
          paidServed.add(event.sessionID)
          trace.line(`tier-router: ${event.agent} had no free model left, served by paid ${key}`)
        }
        // Sessions come and go, so the memory is bounded rather than growing
        // with the life of the process.
        if (pinned.size > 1000) pinned.clear()
        pinned.set(event.sessionID, key)
        if (key !== modelKey(event.model)) {
          event.model = {
            providerID: pick.ref.providerID as typeof event.model.providerID,
            id: pick.ref.id as typeof event.model.id,
          }
          trace.line(`tier-router: ${event.agent} served by ${key} for ${tierName}`)
        }
      })
    } catch (error) {
      trace.line(
        `tier-router: model resolve hook unavailable, subagents keep the model in their file: ` +
          `${(error as Error)?.message ?? error}`,
      )
    }

    // A rate-limited worker would otherwise sit in a fifteen-minute backoff
    // with the conductor waiting behind it, which is long enough that delegating
    // looks broken. Fail the request instead: the next one picks another model.
    try {
      await ctx.session.hook("retry", async (event) => {
        // A rate limit and a refusal both deserve another model rather than
        // another attempt at the same one. The classifier owns the difference;
        // this hook supplies who failed, whether it is a routed subagent, and
        // what the resolver already knows about the walk.
        const refusal = classifyProviderError(event.error)
        if (refusal.kind === "none") return
        const sessionID = String(event.sessionID)
        const agent = String(event.agent)
        const tierName = agentTiers[agent]
        // The price decides whether a provider-wide strike covers the free or
        // the paid half, so the catalog is loaded before the plan is made.
        await pool()
        const model = { providerID: event.model.providerID, id: event.model.id }
        const plan = retryPlan({
          refusal,
          child: await isChild(sessionID),
          tier: tierName,
          knownTier: Boolean(tierName && tiers[tierName]),
          model,
          price: priceFor(model),
          attempt: event.attempt,
          exhausted: exhausted.has(sessionID),
        })
        if (!plan.act) return
        const key = modelKey(event.model)
        // Awaited, not fired and forgotten. A reload while the write is in
        // flight loses it, which showed as a strike that never reached storage
        // and a provider key that was never written.
        await strikeAll(plan.keys, plan.fixedMs)
        trace.line(
          `tier-router: ${agent} ${refusal.kind === "refusal" ? `refused (${refusal.reason})` : "rate limited"} ` +
            `on ${key}; out ${plan.keys.join(", ")}`,
        )
        // The model that just refused joins the ones this session will not ask
        // again, so the next attempt moves forward instead of circling.
        const done = failed.get(sessionID) ?? new Set<string>()
        failed.set(sessionID, done)
        done.add(key)
        // Another attempt is worth it only while the session has an untried
        // model that is reachable now, which is what the last resolve recorded.
        // Only an empty tier stops the walk. A cap on attempts used to be here, and
        // it gave up after four, which is fewer than the candidate list is long:
        // two gated models in front of a working one were enough to lose the task.
        // The failed set already limits each model to one attempt, so the walk
        // ends on its own when there is nothing untried left.
        // Decide before speaking, so the notice describes what will happen.
        await inform(sessionID, agent, key, plan.keys, !plan.retry)
        // Assign the decision rather than adjust it: a rate limit arrives with
        // retry already true and a plain provider error does not.
        event.decision = plan.retry ? { retry: true, delay: plan.delay } : { retry: false }
      })
    } catch (error) {
      trace.line(`tier-router: retry hook unavailable, no fast fail: ${(error as Error)?.message ?? error}`)
    }

    trace.line(
      `tier-router: consult and handoff ready, build ${buildStamp()}, tiers ${order.join(" < ")}` +
        ` (caller tier from the agent's model, price bands from the session's base model)` +
        (trace.path ? `; resolver trace in ${trace.path}` : ""),
    )
  },
})
