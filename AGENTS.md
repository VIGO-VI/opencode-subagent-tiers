# Working with the tier system

This repository installs a cheap delegation stack for OpenCode. When the
`tier-router` plugin is active, follow these rules.

## Delegation

- Send self-contained reading to a worker: locating code, quoting a section,
  running one check, counting call sites, summarising a document. Keep synthesis
  and judgement for the conductor.
- Two worker profiles: `swarm-worker` runs on a free model and suits lookups and
  extraction. `swarm-worker-code` runs on a cheap paid model and suits anything
  where a wrong answer decides a change.
- Three good reasons to do a step yourself: it is one tool call, the fact is
  already in context, or no cheaper tier can do it well. Delegation is the
  default for bulk reading, not a rule for everything.
- At most three children running at once.
- One worker, one question, one result shape. Name the paths and say what not to
  do. Ask for the lines that decide the answer, never a whole file.

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
