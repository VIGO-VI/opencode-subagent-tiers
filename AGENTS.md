# Working with the tier system

This repository installs a cheap delegation stack for OpenCode. When the
`tier-router` plugin is active, follow these rules.

**Your first action on a task larger than a single question is to spawn a worker
for the reading.** Plan the split before you open a file, not after the sixth
one. Everything below explains how.

## Delegation

Delegation is the default, not a treat. The reason is your context window, not
the bill: a fact you read and keep costs you tokens on every later turn, while
the same fact in a child costs you once, as a report. So the question is never
"can I afford a subagent" but "do I need this text in front of me again".

**`swarm-peer` is the default delegate.** It runs in your own price band, on a
model that may be better suited to the task than yours, with the same tools and
the same ability to reach a conclusion. It starts with a clean context instead
of your history. There is no intelligence tax to weigh, so anything you would
only summarise goes to a peer: bulky reading, a self-contained piece of
implementation, a question whose answer matters more than its evidence.

**Keep the work inline only when you need the context itself.** That is one of
three cases: you will quote the text exactly, you will patch it, or you will
reason across it over several steps. A peer's summary cannot stand in for the
bytes when the bytes are the deliverable. If none of those apply, delegating is
not a trade — it is strictly cheaper for you.

**`swarm-worker` is for the mechanical tail.** Greps, counts, single lookups,
"which line defines X". It runs on a free model and is billed accordingly, so
give it the narrow question and expect a narrow answer. Do not hand it a step
that needs a judgement it cannot make.

- Prefer two or three small peers over one large one. A child that has to read
  widely is a child that will summarise badly.
- Name the sector when you spawn a peer: the files or directory you expect it to
  change. A peer may read anywhere, but it stops before editing outside that
  sector and asks you first, so two children cannot collide over the same tree.
  Two peers on one sector is your mistake, not theirs.
- Ladder, when a step is uncertain: `swarm-peer` when judgement matters,
  `swarm-worker` when the step is purely mechanical. Escalate to
  `swarm-worker-code` only when a cheap report came back thin or contradicted
  itself.
- If a spawn answers `Unknown agent: swarm-peer`, the install is older than this
  file. Do not retry it and do not file a bug: use `swarm-worker-code` for that
  step, say so in one line, and the agent appears for every session started after
  the next restart.
- Do a step yourself when it is one tool call, when the fact is already in your
  context, or when you need the material itself. Those are the only three.
- Concrete triggers, so this is not a matter of taste: before your second file
  read or second shell command in one turn, hand the rest of that exploration to
  a peer. If a turn reaches six tool calls without having spawned a child, stop
  and spawn one. A conductor that reads six files itself has paid for them again
  on every later turn.
- A top-level session has no parent, so `handoff` there skips its skim by design.
  End a top-level turn with a normal reply after handing the work to workers.
- Spawn before you read: a conductor that has opened a file first has already
  lost the argument. Then keep the fan-out small. Three workers is the default,
  five when the slices are genuinely independent, and more than that only for a
  wide sweep with clearly separate parts. Fifteen is the ceiling, not a target.
  Token cost grows with every child and coordination grows faster, so three
  focused workers beat five scattered ones.
- One worker, one question, one result shape. Name the paths and say what not to
  do. Ask for the lines that decide the answer, never a whole file.
- Builds, tests and anything that writes to the working tree stay with the
  conductor unless a skill says otherwise. A rule that forbids delegating a
  build is about the build, not about reading, searching or planning.

## Consulting up

- `consult` with no tier reaches one tier above the caller. `tier: "same"` gives
  a clean copy of the caller's own tier.
- Use it when genuinely stuck: a decision that is expensive to reverse, the same
  error twice, or a check before calling risky work done. Never for a fact a
  worker can look up.
- Pass `kind` (`lookup`, `code`, `code-go`, `review`, `write`, `general`) so the
  tier picks a model that fits. A lookup should stay cheap even at the advisor
  tier.
- Budgets are tokens per root session per tier, shared by every worker in the
  tree. Small briefs leave room for more questions.

## Handing back

- Finish a worker turn with `handoff`, not a bare reply. The tier above skims it
  and a `PROBLEM` comes back to you first.
- A skim is one short prompt with no tools. Act on it, but do not re-send the
  same report hoping for `OK`.

## Honesty about evidence

- The plugin changes cost and routing, not model quality. Do not claim a quality
  win from a cheaper tier without evidence from the run in front of you.
- The resolver records the pick as `tier-router: <tier>/<kind> for base ... ->
  ...` in `~/.local/share/opencode/log/tier-router.log`. When a pick surprises
  you, read that file instead of guessing.
