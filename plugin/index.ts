import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

import {
  blendedPrice,
  modelKey,
  parseModel,
  resolveCandidates,
  type Candidate,
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
  /** Consult budget in tokens, per session tree and per tier. `perTier` wins. */
  budget?: { tokens?: number; perTier?: Record<string, number | undefined> }
  /** Skim budget for `handoff`, kept separate so a review is never starved. */
  skim?: { tokens?: number; perTier?: Record<string, number | undefined> }
  /** Task kinds advertised to the tools. Each tier can override its policy per kind. */
  kinds?: string[]
  /** Agent id to tier, for agents whose tier cannot be read from a model list. */
  agents?: Record<string, string>
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
PROBLEM: one sentence naming the defect, then one concrete correction.`

function loadRankings() {
  for (const relative of ["./rankings.json", "../rankings.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
        rank?: Record<string, number>
      }
      if (parsed.rank && typeof parsed.rank === "object") return parsed.rank
    } catch {
      continue
    }
  }
  console.warn("tier-router: rankings.json not readable, falling back to price percentiles")
  return {} as Record<string, number>
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

    function allowance(
      spec: { tokens?: number; perTier?: Record<string, number | undefined> },
      tier: string,
    ) {
      const perTier = spec.perTier?.[tier]
      if (typeof perTier === "number") return perTier
      return spec.tokens ?? Number.POSITIVE_INFINITY
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
          price: blendedPrice(model.cost),
          released: Number(model.time?.released ?? 0),
        })
      }
      return list
    }

    /** Try each candidate in order, the way a fallback list works. */
    async function ask(tierName: string, prompt: string, anchorKey: string | undefined, kind?: string) {
      const pool = await catalogue()
      const candidates: Resolved[] = resolveCandidates(tiers[tierName] ?? {}, pool, anchorKey, rankings, kind)
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
          const result = await ctx.experimental.generate.text({ model: candidate.ref, prompt })
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

    const shared = `Tiers, low to high: ${order.join(", ")}. Budgets are tokens, shared by the whole session tree, so a worker and its conductor draw from the same allowance.`

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "consult",
        description:
          "Ask a blank-slate model at the same tier or a higher one for a decision. " +
          `${shared} Omit tier to reach one tier above your own; "same" is a clean copy of your own. ` +
          "Use it when genuinely stuck: a decision that is expensive to reverse, the same error twice, " +
          "or a check before calling risky work done. Never for a fact a worker can look up. " +
          "It shares only what you write in the brief, never the conversation.",
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
            tier: {
              type: "string",
              description: `"same", or one of: ${order.join(", ")}. Omit to reach one tier above yours.`,
            },
          },
          required: ["brief", "question"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as { brief: string; question: string; tier?: string; kind?: string }
          const brief = String(args.brief ?? "").trim()
          const question = String(args.question ?? "").trim()
          if (!brief || !question) throw new Error("consult needs both a brief and a question")

          const caller = await callerOf(context)
          const target = resolveTier((args.tier ?? "").trim().toLowerCase(), caller.tier)
          const prompt = [
            tiers[target]?.brief ?? DEFAULT_BRIEF,
            `You are the "${tiers[target]?.label ?? target}" consultant.`,
            "## Caller's brief",
            brief.slice(0, maxChars),
            "## Question",
            question,
            CONSULT_FORMAT,
          ].join("\n\n")

          const limit = allowance(budget, target)
          const reserved = estimateTokens(prompt) + 400
          const slot = await reserve(context.sessionID, "consult", target, reserved, limit)
          if (!slot.fits) {
            throw new Error(
              `consult: the "${target}" allowance for this session is ${limit} tokens and ` +
                `${slot.spent} is spent, so this ${reserved}-token call does not fit. ` +
                "Answer from what you have, or hand the lookup to a worker.",
            )
          }

          const kind = (args.kind ?? "").trim().toLowerCase() || undefined
          const answer = await ask(target, prompt, caller.base, kind)
          const charged = estimateTokens(prompt, answer.text)
          const total = slot.spent + charged
          await charge(slot.ledgerKey, slot.ledger, target, total)
          const shown = Number.isFinite(limit) ? `${total}/${limit}` : `${total}`
          return {
            content: `[${target} · ${answer.model} · ${shown} tokens]\n\n${answer.text}`,
            metadata: {
              tier: target,
              model: answer.model,
              picked: answer.note,
              callerTier: caller.tier ?? null,
              base: caller.base ?? null,
              tokens: charged,
              budget: Number.isFinite(limit) ? limit : null,
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
          const report = String(args.report ?? "").trim().slice(0, maxChars)
          if (!task || !report) throw new Error("handoff needs both the task and the report")

          const caller = await callerOf(context)
          const target = resolveTier((args.tier ?? "").trim().toLowerCase(), caller.tier)
          const kind = (args.kind ?? "").trim().toLowerCase() || "general"
          const prompt = [
            SKIM_BRIEF,
            `## Task given to the ${caller.tier ?? caller.agent} tier (kind: ${kind})`,
            task,
            "## Report it is handing back",
            report,
          ].join("\n\n")

          const limit = allowance(skim, target)
          const reserved = estimateTokens(prompt) + 200
          const slot = await reserve(context.sessionID, "skim", target, reserved, limit)
          if (!slot.fits) {
            return {
              content: `[skim skipped · ${target} allowance spent]\n\n${report}`,
              metadata: { tier: target, skim: "skipped", budget: limit },
            }
          }

          let verdict: string
          let model: string
          try {
            const answer = await ask(target, prompt, caller.base, kind === "general" ? undefined : kind)
            verdict = answer.text
            model = answer.model
          } catch (error) {
            return {
              content: `[skim failed · ${target}]\n\n${report}\n\nskimmer error: ${
                (error as Error)?.message ?? String(error)
              }`,
              metadata: { tier: target, skim: "failed" },
            }
          }

          const charged = estimateTokens(prompt, verdict)
          await charge(slot.ledgerKey, slot.ledger, target, slot.spent + charged)
          return {
            content: `[skim by ${target} · ${model}]\n${verdict}\n\n---\n\n${report}`,
            metadata: {
              tier: target,
              model,
              callerTier: caller.tier ?? null,
              skim: verdict.trim().toUpperCase().startsWith("OK") ? "ok" : "problem",
              tokens: charged,
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
