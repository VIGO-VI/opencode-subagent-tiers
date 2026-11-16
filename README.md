# opencode-subagent-tiers

Cost tiers for OpenCode subagents, plus a `consult` tool so a cheap conductor can
ask a stronger model one question, and a `handoff` tool so every report coming
back up gets a quick skim by the tier above.

No model is hardcoded in the plugin. A tier describes a price band relative to
the session's own model, a preference for quality or cost, an optional rank
table, and per-task overrides. The plugin resolves that against the live catalog
every time it asks.

## Why

OpenCode 2.x already lets each agent name its own model (`agents.<id>.model`),
nest subagents one level deep by default (`experimental.subagent_depth`), and
gate who may spawn whom (the `subagent` permission). What it does not have is a
way for a running agent to consult a stronger model mid-turn, or a notion of
cost tiers at all.

That gap is tracked upstream:

- [#63631](https://github.com/anomalyco/opencode/issues/63631), open, "Advisor
  tool, let the session model consult a second model", modelled on Claude Code's
  advisor.
- [#63637](https://github.com/anomalyco/opencode/pull/63637), open PR
  implementing it natively behind an `experimental.advisor` flag.
- [#34370](https://github.com/anomalyco/opencode/issues/34370), closed,
  "Multi-model orchestration: intent-based routing, vision delegation,
  turn-level advisor".
- [#62787](https://github.com/anomalyco/opencode/issues/62787), open, the
  `subagent` tool's description discourages passing `model`, which fights any
  routing policy kept in instructions.

This plugin does the advisor job today with the public plugin API, adds the tier
model on top, and does not need a fork.

## What the research says

- **Cascades pay.** FrugalGPT reports matching the best single model's quality
  with up to 98% lower cost, or +4% accuracy at the same cost, by trying cheap
  models first and escalating only when the answer is not good enough
  ([Chen, Zaharia, Zou, 2023](https://arxiv.org/abs/2305.05176)).
- **Routing pays.** RouteLLM trains a router between a strong and a weak model
  from preference data and reports cutting cost by more than 2x without losing
  quality, and the router transfers when the pair of models changes
  ([Ong et al., 2024](https://arxiv.org/abs/2406.18665)).
- **Orchestrator plus workers pays for breadth, not depth.** Anthropic's
  multi-agent research system gained 90.2% over a single agent on their
  research eval, and states that multi-agent systems use about 15x the tokens of
  chat, so the win has to come from parallel breadth and a small conductor
  context ([Anthropic, 2025](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Cheap workers need a check.** A weaker model is wrong more often, so a
  report is worth one skim by a stronger model before it is trusted. That is
  what `handoff` automates, and it is the same shape as the reviewer half of
  Mixture-of-Agents, where layered proposers are aggregated by a stronger model
  ([Wang et al., 2024](https://arxiv.org/abs/2406.04692)).
- **Tiers and fallbacks are the industry shape.** OpenRouter's Auto Router
  picks a model and reasoning effort per request within a cost tier, carries
  signals across turns, and lets a request list fallback models in priority
  order ([routers](https://openrouter.ai/docs/guides/routing/routers/overview),
  [fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)). The
  price bands here are the same idea, local and explicit.

## Install

```sh
~/Projects/opencode-subagent-tiers/install.sh
```

It copies the agents into `~/.config/opencode/agents/`, sets
`experimental.subagent_depth` to 3, and adds the plugin entry with the tier
options from `tiers.json` to `~/.config/opencode/opencode.json`. It preserves
every other key. Re-run it after editing `tiers.json`.

Then pick `swarm-lead` as the agent for a session, or let the main agent delegate
to it.

## Agents

| Agent | Model | Use |
| --- | --- | --- |
| `swarm-worker` | free flash | lookups, extraction, counting, cheap checks |
| `swarm-worker-code` | cheap flash | tracing code, judging a diff, why a test fails; may split its own work to `swarm-worker` |
| `swarm-lead` | cheap flash | splits work, holds at most three children, hands back with a skim |
| `advisor` | strong model | reads files itself, one decision, never edits |

The chain is three deep: the session agent hands a piece to `swarm-lead`, the
lead hands lookups to `swarm-worker-code` or `swarm-worker`, and
`swarm-worker-code` may hand its own independent lookups to `swarm-worker`. Work
comes back up one level at a time, and each level skims the report below it, so
a cheap mistake is caught before it reaches the model the user is talking to.

`subagent_depth: 3` is what allows this. With the default of 1 a subagent cannot
start another one, so the chain would stop at the first level.

## Tools

`consult` asks a blank-slate model at the same tier or a higher one. It shares
only the brief, never the conversation, and it costs one short request.

```
consult({
  brief: "Go service, one writer, many readers, both imported, queue must block when empty",
  question: "channel or mutex for the handoff queue",
  kind: "code",        // general, code, code-go, lookup, review, write
  tier: "advisor",     // optional; omit for one tier above the caller
})
```

`handoff` ends a worker's turn with a report, and has the tier above skim it
first. A `PROBLEM` verdict comes back to the worker so it can fix the report
before the conductor sees it.

Budgets are tokens, not call counts, and they are keyed by the root session, so
a conductor and every worker under it draw from the same allowance per tier:
250k for the worker tier, 120k for the lead tier, 30k for the advisor tier by
default. Small briefs leave room for several questions.

## How a tier is resolved

`tiers.json` has no model ids. Each tier is a policy:

```json
{
  "advisor": {
    "pick": {
      "ratio": [1.6, 12],
      "prefer": "quality",
      "limit": 3,
      "byKind": { "lookup": { "ratio": [0.6, 4], "prefer": "cost" } }
    }
  }
}
```

- `ratio` is the blended price (input + output, per million tokens) as a
  multiple of the session's base model. A Claude session therefore reaches for
  Claude-priced advisors, and a cheap-model session reaches for cheap ones.
- `prefer: "quality"` sorts by the rank table, then newest release, then price.
  `prefer: "cost"` tries free models first, then the configured provider order,
  then the cheapest paid model. Extra free models stay at the end as a last
  resort.
- `rank` and `byKind.<kind>.rank` are wildcard tables over model ids. A newer
  release of the same family inherits its family's score and wins on recency,
  so a 4.2 beats a 4.1 without editing code.
- `byKind` widens or narrows the band per task. `lookup` keeps the cheap band.
  `code` reaches for a stronger model, because a wrong answer there costs more
  than the tokens.
- `models` is still accepted when you want to name a list. A `~family` entry
  resolves to the newest release of that family in the catalog.

Resolution is logged by the server as `tier-router: <tier>/<kind> for base ...
-> ...` so a surprising pick is visible.

### Ranking data

`rankings.json` holds a coarse 0-100 prior per family. It is a prior, not a
measurement: the selector only needs a stable order inside a band. To replace it
with measured scores, run the fetcher with an OpenRouter key:

```sh
OPENROUTER_API_KEY=sk-or-... node scripts/rank.mjs
```

It reads OpenRouter's unified benchmarks, which aggregate Artificial Analysis,
Design Arena and OpenRouter's own GPQA, tau-bench and web-search evaluations, and
writes wildcarded family scores. Rate limit is 30 requests a minute, 500 a day.

## Cost, measured on this machine's catalog

Blended price is input + output per million tokens, from the live model list on
2026-11-16:

| Model | Blended | Tier it lands in |
| --- | --- | --- |
| `opencode-go/hy4-flash-free` | 0 | worker |
| `console-openrouter/tencent/hy4-flash` | 0.175 | worker fallback |
| `opencode-go/deepseek-v4.1-flash` | 0.75 | lead, and the base here |
| `opencode-go/deepseek-v4-pro` | 2.64 | advisor |
| `opencode-go/qwen4-max` | 6 | advisor |

One lookup consult on the free worker cost 223 tokens. One code consult on the
advisor cost 449 tokens against its 30k allowance. The same question on the
free tier would be $0, on the lead $0.0005, on the advisor about $0.002.

## Verification

```
$ npx tsc --noEmit && echo TYPECHECK OK
TYPECHECK OK

$ node --test plugin/select.test.ts
ℹ tests 17
ℹ pass 17
ℹ fail 0

$ grep "tier-router:" /tmp/tier-test/run5.err
tier-router: worker/lookup for base opencode-go/deepseek-v4.1-flash ->
  opencode-go/hy4-flash-free 0.00x rank 55 free |
  opencode-go/longcat-2.5-free 0.00x rank 50 free |
  opencode-go/muse-spark-1.3-contributor 0.40x rank 50 |
  opencode-go/muse-spark-1.2-contributor 0.40x rank 50
tier-router: advisor/code for base opencode-go/deepseek-v4.1-flash ->
  opencode-go/qwen4-max 8.00x rank 86 |
  deepseek/deepseek-v4-pro 3.52x rank 84 |
  opencode-go/deepseek-v4-pro 3.52x rank 84
tier-router: advisor/lookup for base opencode-go/deepseek-v4.1-flash ->
  opencode-go/gpt-6-luna 0.80x rank 71 |
  opencode/gpt-6-luna 0.80x rank 71 |
  opencode-go/claude-haiku-5-5 0.80x rank 70

$ tail -3 /tmp/tier-test/run5.out
1. `[worker · opencode-go/hy4-flash-free · 223/250000 tokens]`
2. `[advisor · opencode-go/qwen4-max · 449/30000 tokens]`
3. `[advisor · opencode-go/gpt-6-luna · 219/30000 tokens]`
```

The three runs show the three behaviours: free first for a lookup, the ranked
strong model for code, and a cheap model for a lookup even at the advisor tier.

A worker handing a report up, with the skim catching a real defect:

```
$ grep "tier-router:" /tmp/tier-test/run9.err
tier-router: lead/code for base opencode-go/hy4-flash-free ->
  opencode-go/qwen4-max 2.50x rank 86 |
  console-openrouter/qwen/qwen4-max 2.50x rank 86 |
  console-openrouter/openai/gpt-6.1-terra-pro 2.50x rank 85

$ tail -2 /tmp/tier-test/run9.out
PROBLEM: The report asserts specific line numbers without quoting any of the
file's actual content ... Quote line 26 of src/queue.go verbatim ... and drop
the line-32 unlock claim unless you also cite that line.
```

The free worker's report was rejected by the model one tier up, which quoted the
fix, before the conductor ever saw it.

## Limits

- OpenCode resolves an agent's model before any hook, so each agent file still
  names a model. The plugin cannot change what a subagent *runs on* without the
  experimental `experimental.model.resolve` session hook, which is the natural
  next step.
- The skim is one short prompt with no tools. It catches a report that
  contradicts its own evidence, not a subtly wrong claim that reads well.
- Budgets are estimates from character counts, charged per call. They are for
  keeping spend bounded, not for accounting.
- `subagent_depth` is experimental. A future release can change its name.
- The tier ladder is per tier, not per agent instance. Two agents mapped to the
  same tier consult the same level above.

## Licence

MIT.
