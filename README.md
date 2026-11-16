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
gate who may spawn whom (the `subagent` permission). All three are documented at
[opencode.ai/docs/agents](https://opencode.ai/docs/agents) and
[opencode.ai/docs/config](https://opencode.ai/docs/config). What it does not
have is a way for a running agent to consult a stronger model mid-turn, or a
notion of cost tiers at all.

That gap is tracked upstream:

- [#63631](https://github.com/anomalyco/opencode/issues/63631), open, "Advisor
  tool, let the session model consult a second model". The issue says Claude
  Code has an advisor of that shape; that claim is the issue author's, not
  checked against Anthropic's docs here.
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
- **Layered reading helps.** Mixture-of-Agents stacks layers where each agent
  reads every output of the previous layer, and its open-source ensemble led
  AlpacaEval 2.0 at 65.1% against 57.5% for GPT-4 Omni
  ([Wang et al., 2024](https://arxiv.org/abs/2406.04692)). `handoff` borrows the
  layered shape at one agent per layer. The paper does not test a cheaper
  checker, so the skim's value here is a design choice, not a result.
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

The runtime cap is a ceiling, not a target. The chain that actually happens is
the permission graph: an agent can only spawn the agents its `subagent` rules
allow. `install.sh` prints that graph's depth and sets the ceiling to 3, which
is the whole chain this layout defines. Override with
`SUBAGENT_DEPTH=n ./install.sh`. The graph is in
`agents/swarm-lead.md` and `agents/swarm-worker-code.md`, one `subagent` allow
rule per child.

Two subagent levels is the working maximum, and one is the common case. Past
that the tiers are running on models too weak to judge the work below them, so
a deeper chain adds cost without adding an answer.

Then pick `swarm-lead` as the agent for a session, or let the main agent delegate
to it.

## Agents

| Agent | Model | Use |
| --- | --- | --- |
| `swarm-worker` | free flash | lookups, extraction, counting, cheap checks |
| `swarm-worker-code` | cheap flash | tracing code, judging a diff, why a test fails; may split its own work to `swarm-worker` |
| `swarm-lead` | cheap flash | splits work, holds at most three children, hands back with a skim |
| `advisor` | strong model | reads files itself, one decision, never edits |

The chain is up to three deep: the session agent hands a piece to `swarm-lead`,
the lead hands lookups to `swarm-worker-code` or `swarm-worker`, and
`swarm-worker-code` may hand its own independent lookups to `swarm-worker`. Work
comes back up one level at a time, and each level skims the report below it, so
a cheap mistake is caught before it reaches the model the user is talking to.

Depth follows the profile, not a number. A one-line lookup goes to
`swarm-worker`, which cannot spawn anything, so that branch ends immediately. A
harder piece goes to `swarm-worker-code`, which may split once. A whole subtask
goes to `swarm-lead`, which may split again. Choosing the profile by complexity
is how the chain gets shorter or longer.

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

The skim is skipped by default (`mode: "risky"`) unless the work is a code,
review or write task and the report is at least 200 characters. A lookup whose
answer is one quoted line is not worth a second model reading it, and with many
workers the skips matter more than the skims.

Budgeting follows the one vendor that documents an advisor, rather than a
number invented here. Anthropic's advisor tool exposes two cost controls: a
count of advisor calls per turn (`max_uses`, unlimited by default, shown as 5 in
their example) and an output cap (`max_tokens`, minimum 1024, shown as 2048).
For a conversation-level ceiling their guidance is to count calls in the client
and stop offering the tool at the cap. They also say to enable caching only when
three or more advisor calls are expected
([advisor tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)).

This plugin maps that onto the tiers:

| Anthropic's control | Here |
| --- | --- |
| `max_uses` per turn | `maxUses` per root session: 5 advisor, 12 lead, 40 worker |
| `max_tokens` on the advisor | `maxReplyTokens`: 700 advisor and lead, 600 worker, 300 skim |
| count calls client-side, then remove the tool | the same counters in plugin storage, checked before each call |

`maxUses` is stricter than the vendor's because a turn boundary is not visible
from a tool call, and a session can hold several turns.

On top of that sits a share of the session's measured tokens: 5% for the advisor
tier with a 60k hard cap, 25% for the lead tier with a 200k cap, 90% for the
worker tier with a 400k cap, over a 40k floor. That one is this plugin's
addition, not vendor guidance, and it exists because advisor calls are made from
child sessions where a per-turn counter cannot see the parent's spend. The base
is measured: the plugin sums the token counts OpenCode records on the root
session's messages, so a long session earns more room. Worker sessions are
excluded from that sum, which makes the ceiling stricter than it looks, never
looser.

Both sets of numbers live in `tiers.json` under `budget` and `skim`, and
`install.sh` copies them into the plugin entry in `opencode.json`.

The share is soft and the hard cap is not. A caller that states a `reason` can
cross the share up to the cap, and the call is marked `bypassed` in its
metadata. After a `handoff`, the skim ends with a `NEXT:` line, so a follow-up
consult can carry that one line and nothing else.

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

### Free fallback across providers

Every free model the catalog offers is a candidate, whatever its provider. On
2026-11-16 this machine's catalog had 35 of them across `opencode-go`, `opencode`
and `console-openrouter`, counted with:

```sh
opencode api get /api/model | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
print(sum(1 for m in d if m.get('cost') and m['cost'][0]['input']==0 and m['cost'][0]['output']==0))"
```

`freeSlots` caps how many free candidates are tried before a paid one, and the
free slots go round `providerOrder`, so one provider's free models cannot crowd
out another's. Then a cheap paid model is tried, and any free model left over
stays at the end as a last resort. A run from this machine:

```
tier-router: worker/lookup for base opencode-go/deepseek-v4.1-flash ->
  opencode-go/hy4-flash-free 0.00x rank 55 free |
  opencode/deepseek-v4.1-flash-free 0.00x rank 72 free |
  console-openrouter/inclusionai/ling-3.2-flash:free 0.00x rank 50 free |
  opencode-go/muse-spark-1.3-contributor 0.40x rank 40
```

A new provider needs no code: it becomes eligible when its models appear in the
catalog, and it gets a turn in the free rotation by being added to
`providerOrder`. `allow` and `deny` patterns can scope a tier to particular
providers or model families.

### When list price is not your price

The catalog price is the published rate. What a model costs this machine can be
different: a subscription includes its models, a BYOK key can be cheaper than
the list, and some plans cover a provider outright. `pricing` in `tiers.json`
declares that difference, and the selector uses the declared number everywhere,
including the free group:

```json
"pricing": { "anthropic/*": "free", "console-openrouter/*:free": "free" }
```

Patterns are wildcards over `provider/model`, the most specific match wins, and
`"free"` means zero. That is how adding a connection feeds the free rotation: the
models appear in the catalog, and one line here declares them free for you. The
plugin cannot read your contract or your plan, so this part is declared, not
inferred.

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

## How much of this is evidence, and how much is judgement

The rule this README follows: a number is either measured here with the command
that produced it, arithmetic from numbers stated here with the formula, or
cited with a link. Anything else is written as a judgement. The plugin's own
token figures are labelled as its estimate, because it counts characters, not
provider usage.

Measured in public work, and safe to rely on:

- Cascading cheap to expensive pays when you can tell a good answer from a bad
  one. FrugalGPT and RouteLLM both measure it.
- Routing between a strong and a weak model can cut cost by more than 2x with no
  quality loss, and the router survives a change of models.
- Multi-agent beats single-agent on breadth-first research, and it does so by
  spending more tokens, not fewer. Anthropic measured 90.2% better on their
  research eval and about 15x the tokens of chat, with token usage alone
  explaining 80% of the variance.

Judgement, not measured here:

- That a cheap tier plus a skim matches a strong model on *cost at equal
  quality*. Nobody has run that eval on this setup. The citations support the
  direction, not this number.
- That delegation helps for code work. Anthropic's own post warns the opposite
  is often true: most coding tasks have fewer truly parallelisable subtasks, and
  agents are not yet good at delegating in real time. Our answer is to delegate
  bulk reading, keep judgement with the conductor, and skim every hand-back. It
  is a design bet.
- That three levels help. The same post runs one layer of subagents. Our ceiling
  is three because the permission graph allows it, and two is the realistic
  maximum before the tiers are too weak to judge the work below them.

If you want the claim to be more than a design bet, run the same task with and
without the chain on your own repository and compare cost and accepted diffs.
The resolver log and the token counters in each tool result are there to make
that measurable.

### Why the skim does not balloon the strong model's context

A skim sends the report, not the conversation and not the source files. So the
strong tier's extra input per handback is the report, which is the same text the
conductor has to read anyway. The cost of checking k reports is therefore
bounded by k times the report size at the next tier's price, and it is the
source reading that got cheaper: a worker may read 5k tokens of code for free
and return 300 tokens.

Concretely, from the price table below, a 300-token report skimmed at the lead
tier costs `300 * 0.75 / 1e6` = $0.0002. The same 300-token report skimmed at
the advisor tier (`qwen4-max`, $6 per million blended) is `300 * 6 / 1e6` =
$0.0018. Ten of those is under two cents.

The risk the question raises is real in one case: many workers, each returning a
long confused report, all skimmed by the expensive tier. That is why the default
is risky-only, with a 2% share and a 20k cap on skims, and why the report is
capped by `maxChars`. Past that, the arithmetic above is the argument, not a
measurement: nobody has run the comparison on this stack.

## Cost, measured on this machine's catalog

Blended price is input + output per million tokens, read from this machine's
catalog on 2026-11-16 with:

```sh
opencode api get /api/model | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    c=m['cost'][0]
    print(f\"{m['providerID']}/{m['id']} in {c['input']} out {c['output']}\")"
```

Those rows are reproduced here:

| Model | Blended | Tier it lands in |
| --- | --- | --- |
| `opencode-go/hy4-flash-free` | 0 | worker |
| `console-openrouter/tencent/hy4-flash` | 0.175 | worker fallback |
| `opencode-go/deepseek-v4.1-flash` | 0.75 | lead, and the base here |
| `opencode-go/deepseek-v4-pro` | 2.64 | advisor |
| `opencode-go/qwen4-max` | 6 | advisor |

The tool reports what it charged, and that number is the plugin's own estimate
of `(prompt + reply characters) / 4`, not the provider's token count. From
`run5.out`, a lookup on the free worker charged 223 estimated tokens, a code
consult on the advisor charged 449, and a lookup on the advisor charged 219.
Those runs used a fixed allowance; the current default is the share and cap
described above.

Arithmetic from those charges and the price column, with no other assumption:
cost is between `tokens * input / 1e6` and `tokens * output / 1e6`, so 223
tokens on the free model is $0, and 449 tokens on `qwen4-max` is between
$0.0007 and $0.002 depending on how the input/output split fell. The plugin does
not record that split, so a single exact figure would be invented.

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

A run that spends on the lead tier, from a worker asking one tier up to `lead`:

```
$ grep "tier-router:" /tmp/tier-test/lead.err
tier-router: lead/lookup for base opencode-go/hy4-flash-free ->
  opencode-go/hy3 0.30x rank 50 |
  opencode-go/deepseek-v4.1-flash 0.31x rank 72 |
  console-openrouter/deepseek/deepseek-v4.1-flash-1017 0.31x rank 72

$ grep -o "\[lead[^]]*\]" /tmp/tier-test/lead.out
[lead · opencode-go/hy3 · 188/10000 tokens]
```

That 10000 is 25% of the 40000 floor, which is where a fresh session starts
before it has measured any of its own tokens. The ratios look low because the
base was the free model, whose price is 0, so the anchor falls back to the
median catalog price. That is also why the `2.50x` lines in the earlier snippet
differ from the `8.00x` seen when the base was a paid model: the band is relative
to whatever model the session is on.

## Seeing subagent sessions

Desktop gets a **Subagents** tab for the session on screen, listing its child
sessions, and a **Subagents** entry in the side panel's `+` menu. Clicking a row
opens that child session as a tab. The CLI has `~/bin/oc-subs`, which prints the
same list with the command to open one.

The GUI part is `gui.tsx`, built to `dist/gui-experimental.cjs` by `vite build`
with OpenCode's GUI preset. It follows the shape of
[`slkiser/opencode-quota`](https://github.com/slksiser/opencode-quota), a working
OpenCode Desktop panel, because the GUI plugin API is experimental and the docs
alone are thin on a real panel.

Two facts about loading it, both observed on 2026-11-16: the bundle builds, and
the running app still reports `features: {"server": true}` for this plugin after
`opencode reload`. GUI parts are resolved when the desktop app boots, so quit and
reopen the app once after building. Settings > Extensions > Plugins then lists
the switch for it.

## Limits

- Each agent file still names a model, and that is what OpenCode runs. The
  experimental `experimental.model.resolve` hook can swap the model for a single
  request, but only within the same provider
  ([docs](https://opencode.ai/docs/build/plugins/server)), so it cannot move a
  Claude agent onto a DeepSeek tier. This plugin does not register that hook.
- A tool result that carries a non-finite number is dropped by OpenCode and
  shows as `Tool result missing`. The budget display now prints `no cap` rather
  than `Infinity`, and there is a test for the unbounded case.
- Anthropic validates that an advisor is at least as capable as its executor.
  Here the tier ladder assumes the same, and enforces it only through price,
  which is a proxy rather than a capability check.
- The skim is one short prompt with no tools. It catches a report that
  contradicts its own evidence, not a subtly wrong claim that reads well.
- Reports travel as text through each level, which is the pattern Anthropic
  warns loses fidelity. Their alternative is subagents writing artifacts and
  passing references. That is more faithful and more expensive, and this plugin
  chooses the cheap side on purpose.
- Budgets are estimates from character counts, charged per call. They are for
  keeping spend bounded, not for accounting.
- `subagent_depth` is experimental. A future release can change its name. The
  install sets it to 3, the depth of the chain this layout defines, and the
  permission graph usually stops sooner.
- The tier ladder is per tier, not per agent instance. Two agents mapped to the
  same tier consult the same level above.

## Licence

MIT.
