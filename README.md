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

On a fresh machine, one command:

```sh
~/Projects/opencode-subagent-tiers/setup.sh
```

When the repository is not there yet, clone it and run the same script:

```sh
git clone git@github.com:VIGO-VI/opencode-subagent-tiers.git ~/Projects/opencode-subagent-tiers
~/Projects/opencode-subagent-tiers/setup.sh
```

`setup.sh` fetches the repository when it is missing and then runs
`install.sh`. `install.sh` copies the agents into `~/.config/opencode/agents/`,
sets `experimental.subagent_depth` to 3, and adds the plugin entry with the tier
options from `tiers.json` to `~/.config/opencode/opencode.json`. It preserves
every other key, prints the delegation reminder it wired, and is safe to re-run
after editing `tiers.json`.

The reminder arrives with the install. `nudge: 5` in `tiers.json` means a
session that has made five requests since its last subagent call gets the
sentence in its system prompt. Set another number there for a different
interval, or `false` to turn it off. Without the tier options a plugin entry
installed by hand still gets the default of five.

`TIERS_DIR` overrides the checkout location and `TIERS_REMOTE` the clone URL.
On Windows without WSL, run the two scripts from Git Bash.

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

### Sharing it with a local setup

The repo works unchanged for someone running local models, but three things are
theirs to decide, and install says so rather than guessing:

1. Connect the local provider in OpenCode so its models appear in the catalog.
   `opencode models` should list them before you install.
2. Nothing is required first. A provider whose id looks local (`ollama`,
   `lmstudio`, `llama`, `vllm`, `localai`) is detected, and its models get a
   stand-in price from their parameter count and a stand-in rank from their size,
   so the bands keep working with no editing. Both are heuristics, not
   measurements: override them in `pricing` or `rank` when they are wrong, or name
   models per tier under `models`.
3. Add a small `rank` block for their families if they want quality ordering
   instead of the neutral default.

Device capability is checked, not assumed. A candidate is skipped when it cannot
call tools, since every worker needs them, and when its context window is below a
tier's `minContext`. That is what keeps a 4k-context local model from being handed
a job whose brief alone would not fit. Both are fields in `tiers.json`:
`requireTools` is on for every tier, and `minContext` is 16000 for the lead and
advisor tiers where briefs and diffs are larger.

The same model often appears more than once: this machine's catalog carries 15
ids under two providers, and `deepseek-v4.1-flash` is 0.15/0.6 on one and 0.3/1.2
on the other. The selector keeps the cheapest cloud copy and, separately, the
local copy of a family, because two cloud backends for one model are one fallback
between them while a local copy fails differently. `dedupe: false` keeps every
copy.

Two settings control placement, in the config or from the desktop panel:

- `mode`: `hybrid` (default) uses local and cloud, `cloud` hides local
  providers, `local` hides everything else.
- `prefer`: `value` (default) compares rank per dollar, `local` and `cloud` bias
  their side with a 0.7 multiplier on their own prices and 1.4 on the other's.
  It is a tie-break, so it never overrides the mode filter, and it does nothing
  in a single-side mode.

Both appear in **Settings > Tier router**, each a button that cycles the value.
The preference button is disabled unless the mode is hybrid, since a single-side
mode has already decided. The panel writes through the plugin's RPC into plugin
storage, so a change survives a restart without editing JSON, and the config keys
remain the fallback.

A hybrid setup needs no extra switch. Give the local models a pseudo-price, leave
the cloud models at their list price, and both compete in the same bands with the
same rank table. `allow` narrows a tier to chosen providers if a user wants, for
example, local workers and a cloud advisor:

```json
"advisor": { "pick": { "allow": ["anthropic/*", "openai/*"], "prefer": "quality" } }
```

Node 22.6 or newer is needed for the install step, because the model resolver
reads `scripts/models.mjs` and that imports the TypeScript selection logic
directly. If Node is missing, install prints a warning for every agent left
without a model, since a model-less agent inherits the conductor's model, which
is the opposite of what the plugin is for.

A second config directory gets the same treatment, which is how the container
install is made rather than hand-edited:

```sh
OPENCODE_CONFIG_DIR=~/.local/share/vigo-agent/.config/opencode ./install.sh
```

A per-request reminder covers the case instructions miss. A `context` hook appends
one sentence to the system prompt of a session that has made five requests since
it last spawned a subagent, and only for agents whose permissions allow spawning,
which is read from the permission rules rather than a list of names. It starts on
the second request and comes back every time the session drifts into working
alone again, because the interval is measured from the last spawn instead of
being a one-shot budget. `nudge: 5` sets the interval, `nudge: false` turns it
off.

It is cache-safe by construction: the sentence is identical every time, so it
extends the request tail instead of rewriting the prefix, and the prompt cache
still matches everything before it. The tail changes twice per drift, when the
reminder appears and when a spawn removes it, which is two cache misses per cycle
instead of one per request.

A rate-limited worker fails fast. A `retry` hook drops a worker-tier
`provider.rate-limit` that asks for more than ten seconds, and allows one retry
of two seconds otherwise. The free tiers answer with a fifteen-minute
`Retry-After`, which leaves the conductor blocked behind a worker that is not
going to reply, and that stall is what teaches a conductor to stop delegating.
Failing the worker returns the error to the conductor at once, so it can
escalate to `swarm-worker-code` or do the work itself.

What makes an agent actually delegate, in order of strength:

1. `default_agent: "swarm-lead"`, set by `install.sh`, so a new session starts as
   the conductor instead of a general agent.
2. `instructions`, also set by `install.sh`, which injects this repository's
   `AGENTS.md` into every session, so the delegation rules are present even when
   the user picks another agent.
3. The `description` of each agent, which is what the model reads when it picks a
   subagent. They now say when to use each one rather than only what it is.
   Descriptions stay model-free: `models.mjs` rewrites only the `model` line, so
   a model named in a description goes stale at the next install.

Without any of those, an agent can still spawn the workers, because the
permission graph allows it. It just has no reason to.

## Agents

| Agent | Model | Use |
| --- | --- | --- |
Agent files no longer name a model. `install.sh` runs `scripts/models.mjs`, which
asks the running server for the catalog, applies the same tier policy the tools
use, and writes the winning model into each agent's frontmatter. Re-running
install refreshes every pick, and `node scripts/models.mjs --dry` shows what
would change without touching a file.

A pick is probed before it is written. `scripts/models.mjs` asks the running
server for one short answer from the chosen model and falls through to the next
candidate when the answer is a permanent refusal: an endpoint the account's data
policy excludes, a model the provider withdrew, a provider the account holds no
credit for, or a capability the model lacks. A rate limit or a timeout does not
move the pick, because it says nothing about whether the model works; that
candidate is written and marked `unverified`. When no candidate answers, the
agent's model line is left alone and every reason is printed, so an install
cannot silently ship an agent that never replies. `--no-probe`, or
`TIER_PROBE=0`, skips the check for an offline install.

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
first. The report is then posted into the **parent session** through the session
API, not merely returned to the worker.

That last part was a defect, found in use: a tool result goes into the calling
session's context, and the parent only receives the child's final assistant
message. A worker that answered "handed off successfully" therefore delivered
nothing, and one that summarised its own tool result delivered a paraphrase.
Three of five handoffs lost the body that way. Delivery now does not depend on
the model, and the report is written to a file under the system temp directory
before the skim call, so an interrupted skim cannot lose it either. Set
`handoff.deliver` to `child` for the old behaviour.

A skimmer that stops answering cannot hold a worker's turn open: every consultant
call has a deadline, 60 seconds for a consult and 40 for a skim, and a report
whose skim times out comes back unskimmed with a note. The skim also receives at
most 3000 characters of a report, head and tail, because a skimmer that reads a
whole long report costs more than the report was worth.

The skim budget is sized for a skim, not for the session: a 3% share with a 20k
cap over a 100k floor, because a skim costs a fairly constant 400 to 1500 tokens
and a share of a young session was too small to allow even one. A skipped skim
never blocks delivery; the report still reaches the parent with a note.

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
      "limit": 8,
      "byKind": { "lookup": { "ratio": [0.6, 4], "prefer": "cost" } }
    }
  }
}
```

- `limit` is how many candidates the tier may try, in rank order, before it
  gives up: a fallback list, not a shortlist. A provider can refuse a model for
  reasons the resolver cannot see — an endpoint excluded by the account's data
  policy, a provider with no credit left — and a list that stops at three
  candidates hands that refusal to the caller. Every candidate tried is written
  to the resolver trace, so a long walk is visible rather than guessed at. The
  time limit is per call, not per candidate: `timeoutMs` covers the whole walk,
  so one slow provider cannot turn a consult into eight timeouts. What a walk
  should not do is hide a tier that is entirely dead: the advisor tier shipped
  at three and resolved to three models on one provider that answered `402`,
  which is why its default is now eight.
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

Every resolution is recorded as `tier-router: <tier>/<kind> for base ... ->
...`, so a surprising pick is visible. The line is appended to
`$XDG_DATA_HOME/opencode/log/tier-router.log`, which is
`~/.local/share/opencode/log/tier-router.log` unless `XDG_DATA_HOME` is set,
beside the server's own log. It is also written to the console, but a server
started by the desktop app runs with stdout on `/dev/null` and stderr on a
socket the app owns, so the file is the copy that survives. `log` in the plugin
options names another file, or `false` keeps it off disk. The file is capped at
256 KB and rewritten to its last 128 KB, so it needs no rotation.

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

This is also how a local setup joins the same policy. A model that costs nothing
but occupies a GPU for twenty seconds is not free, so declare the compute cost as
a pseudo-price and the price bands keep their meaning:

```json
"pricing": { "ollama/*": 0.5, "lmstudio/llama-70b": 3 }
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

Pass the key in the environment or in a file you own, never on the command
line and never in a chat or a commit:

```sh
mkdir -p ~/.config/openrouter && chmod 700 ~/.config/openrouter
printf '%s' 'sk-or-...' > ~/.config/openrouter/key && chmod 600 ~/.config/openrouter/key
node scripts/rank.mjs --key-file ~/.config/openrouter/key --dry
```

The benchmark endpoint needs a valid key but charges nothing for the calls
themselves; its limits are requests per minute and per day. The key is read from
the environment or that file and never written anywhere. An OpenRouter
integration inside OpenCode Console gives you the models through
`opencode.ai/inference/...`, not a key that `openrouter.ai/api/v1/benchmarks`
accepts, so refreshing the table needs an OpenRouter key of its own.

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

## How wide to fan out

Not as wide as possible. Anthropic, the only vendor publishing measurements for
this, says start with 3-5 teammates for most workflows, that 15 independent
tasks is well served by 3 teammates, and that "three focused teammates often
outperform five scattered ones". Their multi-agent post scales effort to the
question: one agent for simple fact-finding, 2-4 subagents for a comparison, and
more than ten only for genuinely wide research.

Their token evidence points the same way. Multi-agent runs use about 15x the
tokens of chat, token usage alone explains 80% of the performance variance, and
the cost of adding a child is linear while the coordination cost is not.

So the shipped policy is three by default, five when the slices are genuinely
independent, and fifteen as a ceiling for a wide sweep whose parts really are
separate. That ceiling exists to stop a runaway, not to invite one.

## Seeing subagent sessions

Desktop gets a **Subagents** tab for the session on screen, listing its child
sessions, and a **Subagents** entry in the side panel's `+` menu. Clicking a row
opens that child session as a tab. The list follows the session on screen and
polls while the panel is open, so children appear and finish without a refresh
control. The CLI has `~/bin/oc-subs`, which prints the
same list with the command to open one.

The GUI part is `gui.tsx`, built to `dist/gui-experimental.cjs` by `vite build`
with OpenCode's GUI preset. It follows the shape of
[`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota), a working
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
