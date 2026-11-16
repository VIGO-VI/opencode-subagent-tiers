import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

import {
  applyPricing,
  budgetFor,
  blendedPrice,
  modelKey,
  parseModel,
  resolveCandidates,
  type BudgetSpec,
  type Candidate,
  type PricingTable,
  type Resolved,
  type TierSpec,
} from "./select.ts"

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
   * Where a handoff report is delivered. `parent` posts it into the parent
   * session through the session API, so delivery cannot be lost or paraphrased
   * by the child. `child` only returns it as the tool result, the old behaviour.
   */
  handoff?: { deliver?: "parent" | "child"; maxChars?: number }
  /** Agent id to tier, for agents whose tier cannot be read from a model list. */
  agents?: Record<string, string>
  /**
   * What a model actually costs this machine, when that differs from the list
   * price: a subscription, a BYOK key, or a free tier. Wildcards, `"free"` for
   * zero, most specific pattern wins.
   */
  pricing?: PricingTable
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

function loadRankings(): Rankings {
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
  console.warn("tier-router: rankings.json not readable, falling back to price percentiles")
  return { rank: {}, byKind: {} }
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
    const rankings = loadRankings()
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
      console.warn("tier-router: no tiers configured, tools disabled")
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

    /** Tokens the root session has measured so far, from its own messages. */
    async function measuredTokens(sessionID: string) {
      const root = await rootSession(sessionID)
      const messages = await ctx.session.context({ sessionID: root }).catch(() => [])
      let total = 0
      for (const message of messages) {
        const tokens = (message as { tokens?: { input?: number; output?: number; reasoning?: number } }).tokens
        if (!tokens) continue
        total += Number(tokens.input ?? 0) + Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0)
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

    async function catalogue(): Promise<Candidate[]> {
      const { data } = await ctx.model.list()
      const list: Candidate[] = []
      for (const model of data) {
        if (model.enabled === false) continue
        list.push({
          ref: { providerID: model.providerID, id: model.id },
          id: model.id,
          providerID: model.providerID,
          price: applyPricing(blendedPrice(model.cost), options.pricing, modelKey(model), model.id),
          released: Number(model.time?.released ?? 0),
        })
      }
      return list
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
      const candidates: Resolved[] = resolveCandidates(tiers[tierName] ?? {}, pool, anchorKey, table, kind)
      if (candidates.length === 0) throw new Error(`tier "${tierName}" resolved no models`)
      console.warn(
        `tier-router: ${tierName}${kind ? `/${kind}` : ""} for base ${anchorKey ?? "unknown"} -> ` +
          candidates.map((candidate) => candidate.note).join(" | "),
      )
      const available = new Set(pool.map((model) => modelKey(model)))
      const failures: string[] = []
      for (const candidate of candidates) {
        if (!available.has(modelKey(candidate.ref))) {
          failures.push(`${modelKey(candidate.ref)}: not available`)
          continue
        }
        try {
          const result = await withTimeout(
            ctx.experimental.generate.text({ model: candidate.ref, prompt }),
            budgetMs,
            `${modelKey(candidate.ref)} reply`,
          )
          const text = (result?.text ?? "").trim()
          if (!text) {
            failures.push(`${modelKey(candidate.ref)}: empty reply`)
            continue
          }
          return { text, model: modelKey(candidate.ref), note: candidate.note }
        } catch (error) {
          failures.push(`${modelKey(candidate.ref)}: ${(error as Error)?.message ?? String(error)}`)
        }
      }
      throw new Error(`every model in tier "${tierName}" failed.\n${failures.join("\n")}`)
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

    console.info(
      `tier-router: consult and handoff ready, tiers ${order.join(" < ")}` +
        ` (caller tier from the agent's model, price bands from the session's base model)`,
    )
  },
})
