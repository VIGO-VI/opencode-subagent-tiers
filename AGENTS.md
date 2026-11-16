# Working with the tier system

This repository installs a cheap delegation stack for OpenCode. When the
`tier-router` plugin is active, follow these rules.

**Your first action on a task larger than a single question is to spawn a worker
for the reading.** Plan the split before you open a file, not after the sixth
one. Everything below explains how.

## Delegation

Delegation is the default, not a treat. If a step can be handed to a worker, hand
it over, because the worker runs on a free model and your own context is the
expensive part of the session.

- Send self-contained reading to a worker: locating code, quoting a section,
  running one check, counting call sites, summarising a document. Keep synthesis
  and judgement for the conductor.
- Prefer two or three small workers over one large one. A worker that has to read
  widely is a worker that will summarise badly.
- Worker ladder, cheapest first. Start every job with `swarm-worker`, which runs
  on a free model. Escalate to `swarm-worker-code`, which costs money, only when
  the free report came back missing its evidence or contradicting itself. A
  conductor that opens with the paid worker has paid for a check it never
  needed.
- The only good reasons to do a step yourself: it is one tool call, the fact is
  already in context, or no cheaper tier can do it well. Anything else is a
  worker's job.
- Concrete triggers, so this is not a matter of taste: before your second file
  read or second shell command in one turn, hand the rest of that exploration to
  a worker. If a turn reaches six tool calls without a worker, stop and spawn
  one. A conductor that reads six files itself has spent more than the whole
  fan-out would have.
- A top-level session has no parent, so `handoff` there skips its skim by design.
  End a top-level turn with a normal reply after handing the work to workers.
- At most fifteen children running at once, and spawning comes before reading: a
  conductor that has opened a file first has already lost the argument. Most
  children should be `swarm-worker`, which costs nothing, so a wide fan-out is
  the cheap option rather than the extravagant one.
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
- The resolver logs the pick as `tier-router: <tier>/<kind> for base ... -> ...`.
  When a pick surprises you, read that line instead of guessing.
