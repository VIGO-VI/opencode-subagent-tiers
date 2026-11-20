import assert from "node:assert/strict"
import { test } from "node:test"

import plugin from "./index.ts"

const ZDR =
  "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. " +
  "We removed them for the following reasons: ZDR violation (account settings): 1 endpoint excluded; " +
  "configurable at https://openrouter.ai/settings/privacy"

type Model = Record<string, unknown>

function model(providerID: string, id: string, price: number, extra: Model = {}): Model {
  return {
    providerID,
    id,
    enabled: true,
    cost: [{ input: price, output: 0 }],
    capabilities: { tools: true },
    limit: { context: 32_768 },
    time: { released: 1 },
    ...extra,
  }
}

type Handler = (event: Record<string, unknown>) => Promise<void> | void

/**
 * A minimal plugin host. The real one only provides these calls during setup
 * and the two hooks, so this is enough to drive the shipped plugin end to end
 * without a server or a network.
 */
function harness(options: Record<string, unknown>, catalog: Model[], hang = false) {
  const storage = new Map<string, unknown>()
  const asked: string[] = []
  const hooks = new Map<string, Handler[]>()
  const toolHooks = new Map<string, Handler[]>()
  const sessions: Record<string, Record<string, unknown>> = {
    root: { id: "root", model: { providerID: "root", id: "base" } },
    child: { id: "child", parentID: "root", model: { providerID: "root", id: "base" } },
  }
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>()
  const notes: Array<{ sessionID: string; text: string }> = []
  const switches: Array<{ sessionID: string; model: { providerID: string; id: string } }> = []
  const answers = new Map<string, string>()
  let failures = 0

  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    model: { list: async () => ({ data: catalog }) },
    agent: {
      get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID } }),
      // The list the nudge reads permissions from. A mapped agent below the
      // top tier can spawn; a worker is not pestered to delegate.
      list: async () => ({
        data: Object.entries((options as { agents?: Record<string, string> }).agents ?? {})
          .filter(([, tier]) => tier !== "worker")
          .map(([id]) => ({ id, permissions: [{ action: "subagent", resource: "*", effect: "allow" }] })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      context: async () => [],
      hook: async (name: string, callback: Handler) => {
        const list = hooks.get(name) ?? []
        list.push(callback)
        hooks.set(name, list)
        return { dispose: async () => {} }
      },
      synthetic: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        notes.push({ sessionID, text })
      },
      switchModel: async ({
        sessionID,
        model,
      }: {
        sessionID: string
        model: { providerID: string; id: string }
      }) => {
        switches.push({ sessionID, model })
        const session = sessions[sessionID]
        if (session) session.model = model
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => void) => {
        callback({ add: (tool) => tools.set((tool as { name: string }).name, tool as never) })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: Handler) => {
        const list = toolHooks.get(name) ?? []
        list.push(callback)
        toolHooks.set(name, list)
        return { dispose: async () => {} }
      },
    },
    rpc: { register: async () => {} },
    experimental: {
      generate: {
        text: async ({ model: ref }: { model: { providerID: string; id: string } }) => {
          const key = `${ref.providerID}/${ref.id}`
          asked.push(key)
          if (hang) return new Promise(() => {})
          const answer = answers.get(key)
          if (answer === undefined) {
            failures += 1
            throw new Error(ZDR)
          }
          return { text: answer }
        },
      },
    },
  }

  return {
    ctx: ctx as never,
    storage,
    hooks,
    toolHooks,
    tools,
    notes,
    switches,
    answers,
    asked,
    failures: () => failures,
    /** Fire the plugin's execute.before callbacks, the way a tool call would. */
    async toolBefore(event: Record<string, unknown>) {
      for (const callback of toolHooks.get("execute.before") ?? []) await callback(event)
    },
    /** Fire the plugin's context callbacks, the way a request would. */
    async fireContext(event: Record<string, unknown>) {
      for (const callback of hooks.get("context") ?? []) await callback(event)
    },
  }
}

async function start(host: ReturnType<typeof harness>) {
  await plugin.setup(host.ctx)
  const resolve = host.hooks.get("experimental.model.resolve")?.[0]
  const retry = host.hooks.get("retry")?.[0]
  assert.ok(resolve, "the model resolve hook must be registered")
  assert.ok(retry, "the retry hook must be registered")
  return { resolve, retry }
}

const baseTiers = {
  order: ["worker", "lead", "advisor"],
  fallback: "advisor",
  log: false,
  nudge: false,
}

test("a paid ZDR refusal fails a lead-tier subagent over to a warm free sibling", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker-code": "lead" },
      tiers: {
        lead: {
          pick: {
            ratio: [0, 10],
            prefer: "quality",
            limit: 4,
            rank: { "*paid-a*": 90, "*free-b*": 60, "*base*": 10, "*paid-root*": 5 },
          },
        },
      },
    },
    [
      model("openrouter", "paid-a", 4),
      model("openrouter", "free-b", 0),
      model("root", "paid-root", 1),
      model("root", "base", 2),
    ],
  )
  const { resolve, retry } = await start(host)

  const failed = {
    sessionID: "child",
    agent: "swarm-worker-code",
    model: { providerID: "openrouter", id: "paid-a" },
    error: { type: "provider.error", message: ZDR },
    attempt: 1,
    decision: { retry: true, delay: 15 * 60_000 },
  }
  await retry(failed)

  assert.deepEqual(failed.decision, { retry: true, delay: 1_500 })
  const cooldown = host.storage.get("cooldown") as Record<string, { until: number }>
  const now = Date.now()
  assert.ok(cooldown["openrouter/paid-a"]!.until - now > 71 * 3_600_000, "the refused model is out for ~72 h")
  assert.equal(cooldown["provider:openrouter:paid"], undefined, "its paid siblings are not parked")
  assert.equal(cooldown["provider:openrouter:free"], undefined, "the free half is not parked")

  const next = {
    sessionID: "child",
    agent: "swarm-worker-code",
    kind: "primary",
    model: { providerID: "openrouter", id: "paid-a" },
  }
  await resolve(next)
  assert.deepEqual(next.model, { providerID: "openrouter", id: "free-b" })
})

test("the model hook never changes provider, because OpenCode cannot resolve one", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: { ratio: [0, 10], prefer: "cost", limit: 4, rank: { "*iceman-free*": 90, "*longcat-free*": 40 } },
        },
      },
    },
    [
      model("opencode", "iceman-free", 0),
      model("opencode-go", "longcat-free", 0),
      model("opencode-go", "paid-go", 1),
      model("root", "base", 2),
    ],
  )
  const { resolve } = await start(host)
  const event = {
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "opencode-go", id: "longcat-free" },
  }
  await resolve(event)
  // iceman-free is free and ranks higher, but it is on another provider, and
  // OpenCode answers a provider change with `ModelUnavailableError` before the
  // request is sent. The walk must stay on the provider the child started on.
  assert.deepEqual(event.model, { providerID: "opencode-go", id: "longcat-free" })
})

test("free models that are both out are saved by the same provider's paid floor", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 0.05],
            prefer: "quality",
            limit: 4,
            rank: { "*free-a*": 90, "*free-b*": 80, "*paid-floor*": 70 },
          },
        },
      },
    },
    [
      model("openrouter", "free-a", 0),
      model("openrouter", "free-b", 0),
      model("openrouter", "paid-floor", 1),
      model("root", "base", 10),
    ],
  )
  const { resolve, retry } = await start(host)

  const ask = async () => {
    const event = {
      sessionID: "child",
      agent: "swarm-worker",
      kind: "primary",
      model: { providerID: "openrouter", id: "free-a" },
    }
    await resolve(event)
    return event.model as { providerID: string; id: string }
  }
  const refuse = async (id: string) => {
    const event = {
      sessionID: "child",
      agent: "swarm-worker",
      model: { providerID: "openrouter", id },
      error: { type: "provider.error", message: ZDR },
      attempt: 1,
      decision: { retry: true, delay: 15 * 60_000 },
    }
    await retry(event)
    assert.deepEqual(event.decision, { retry: true, delay: 1_500 })
  }

  assert.deepEqual(await ask(), { providerID: "openrouter", id: "free-a" })
  await refuse("free-a")
  // The sibling free model has its own endpoint pool, so it is still served.
  assert.deepEqual(await ask(), { providerID: "openrouter", id: "free-b" })
  await refuse("free-b")

  const cooldown = host.storage.get("cooldown") as Record<string, { until: number }>
  assert.equal(cooldown["provider:openrouter:paid"], undefined, "only the free models are out")
  assert.equal(cooldown["provider:openrouter:free"], undefined, "even the free half is not parked")
  assert.deepEqual(await ask(), { providerID: "openrouter", id: "paid-floor" })
})

test("a rate limit stays in the minutes however many strikes it takes", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: { ratio: [0, 10], prefer: "quality", limit: 2, rank: { "*free-a*": 90 } },
        },
      },
    },
    [model("openrouter", "free-a", 0), model("openrouter", "paid", 1), model("root", "base", 10)],
  )
  const { retry } = await start(host)

  const limit = () => ({
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "openrouter", id: "free-a" },
    error: { type: "provider.rate-limit", message: "429 Too Many Requests" },
    attempt: 1,
    decision: { retry: true, delay: 900_000 },
  })

  // Free tiers limit strictly, so the third 429 in a row must not hand the tier
  // to a paid model for the rest of the day: 60 s, 120 s, 240 s, and the cap is
  // ten minutes rather than six hours.
  const waits: number[] = []
  for (let round = 0; round < 3; round++) {
    await retry(limit())
    const entry = (host.storage.get("cooldown") as Record<string, { until: number; at: number }>)[
      "openrouter/free-a"
    ]!
    waits.push(entry.until - entry.at)
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000])
  assert.equal((host.storage.get("cooldown") as Record<string, unknown>)["provider:openrouter:free"], undefined)
})

test("consult walks past a ZDR refusal to the next candidate and records it", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-lead": "lead" },
      tiers: {
        lead: {
          pick: {
            ratio: [0, 10],
            prefer: "quality",
            limit: 3,
            rank: { "*paid-a*": 90, "*free-b*": 60, "*base*": 10, "*paid-root*": 5 },
          },
        },
      },
    },
    [
      model("openrouter", "paid-a", 4),
      model("openrouter", "free-b", 0),
      model("root", "paid-root", 1),
      model("root", "base", 2),
    ],
  )
  await start(host)
  host.answers.set("openrouter/free-b", "DECISION: use the paid sibling")

  const consult = host.tools.get("consult")
  assert.ok(consult, "the consult tool must be registered")
  const result = (await consult.execute(
    { brief: "The first model refused; what next?", question: "Pick a model.", tier: "same" },
    { agent: "swarm-lead", sessionID: "child" },
  )) as { content: string; metadata: { model: string } }

  assert.equal(host.failures(), 1, "the first candidate was asked and refused")
  assert.equal(result.metadata.model, "openrouter/free-b")
  assert.match(result.content, /openrouter\/free-b/)
  const cooldown = host.storage.get("cooldown") as Record<string, { until: number }>
  assert.ok((cooldown["openrouter/paid-a"]?.until ?? 0) > Date.now() + 71 * 3_600_000)
})

test("the paid floor moves to the next paid model when the cheapest is rate limited", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 0.05],
            prefer: "quality",
            limit: 4,
            rank: { "*free-a*": 90, "*paid-cheap*": 70, "*paid-next*": 60 },
          },
        },
      },
    },
    [
      model("openrouter", "free-a", 0),
      model("openrouter", "paid-cheap", 1),
      model("openrouter", "paid-next", 2),
      model("root", "base", 10),
    ],
  )
  const { resolve, retry } = await start(host)

  const ask = async () => {
    const event = {
      sessionID: "child",
      agent: "swarm-worker",
      kind: "primary",
      model: { providerID: "openrouter", id: "free-a" },
    }
    await resolve(event)
    return event.model as { providerID: string; id: string }
  }

  assert.deepEqual(await ask(), { providerID: "openrouter", id: "free-a" })

  const freeLimit = {
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "openrouter", id: "free-a" },
    error: { type: "provider.rate-limit", message: "429 Too Many Requests" },
    attempt: 1,
    decision: { retry: true, delay: 15 * 60_000 },
  }
  await retry(freeLimit)
  assert.deepEqual(await ask(), { providerID: "openrouter", id: "paid-cheap" })

  const paidLimit = {
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "openrouter", id: "paid-cheap" },
    error: { type: "provider.rate-limit", message: "429 Too Many Requests" },
    attempt: 1,
    decision: { retry: true, delay: 15 * 60_000 },
  }
  await retry(paidLimit)
  // A paid rate limit is model-scoped, so the next paid model is still usable.
  assert.deepEqual(await ask(), { providerID: "openrouter", id: "paid-next" })
  const cooldown = host.storage.get("cooldown") as Record<string, { until: number }>
  assert.equal(cooldown["provider:openrouter:paid"], undefined)
})

test("consult tries the last candidate of a short list instead of reporting it not tried", async () => {
  const host = harness(
    {
      ...baseTiers,
      timeoutMs: 200,
      agents: { "swarm-lead": "lead" },
      tiers: {
        lead: {
          pick: {
            ratio: [0, 10],
            prefer: "quality",
            limit: 3,
            rank: { "*paid-a*": 90, "*free-b*": 60, "*base*": 10, "*paid-root*": 5 },
          },
        },
      },
    },
    [
      model("openrouter", "paid-a", 4),
      model("openrouter", "free-b", 0),
      model("root", "paid-root", 1),
      model("root", "base", 2),
    ],
    true,
  )
  await start(host)

  const consult = host.tools.get("consult")
  assert.ok(consult, "the consult tool must be registered")
  await assert.rejects(
    consult.execute(
      { brief: "Every candidate is slow.", question: "Which one?", tier: "same" },
      { agent: "swarm-lead", sessionID: "child" },
    ),
    (error: Error) => {
      // The old single deadline left the tail "not tried"; the shared slices
      // must reach every candidate, including the last one.
      assert.doesNotMatch(error.message, /not tried/)
      assert.match(error.message, /root\/paid-root/)
      return true
    },
  )
  assert.deepEqual(host.asked, [
    "openrouter/paid-a",
    "openrouter/free-b",
    "root/base",
    "root/paid-root",
  ])
})

test("the issue's 'Model unavailable' refusal moves to a sibling, not to a parked provider", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "explore": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 10],
            prefer: "quality",
            limit: 3,
            rank: { "*iceman-free*": 90, "*sibling-free*": 80, "*base*": 10 },
          },
        },
      },
    },
    [
      model("opencode", "iceman-free", 0),
      model("opencode", "sibling-free", 0),
      model("root", "base", 2),
    ],
  )
  const { resolve, retry } = await start(host)

  const first = {
    sessionID: "child",
    agent: "explore",
    kind: "primary",
    model: { providerID: "opencode", id: "iceman-free" },
  }
  await resolve(first)
  assert.deepEqual(first.model, { providerID: "opencode", id: "iceman-free" })

  const failed = {
    sessionID: "child",
    agent: "explore",
    model: { providerID: "opencode", id: "iceman-free" },
    error: { type: "provider.error", message: "Model unavailable: opencode/iceman-free" },
    attempt: 1,
    decision: { retry: false },
  }
  await retry(failed)
  assert.deepEqual(failed.decision, { retry: true, delay: 1_500 })

  const cooldown = host.storage.get("cooldown") as Record<string, { until: number }>
  assert.ok((cooldown["opencode/iceman-free"]?.until ?? 0) > Date.now() + 71 * 3_600_000)
  assert.equal(cooldown["provider:opencode:free"], undefined, "one unserved id must not park its provider")

  const next = {
    sessionID: "child",
    agent: "explore",
    kind: "primary",
    model: { providerID: "opencode", id: "iceman-free" },
  }
  await resolve(next)
  assert.deepEqual(next.model, { providerID: "opencode", id: "sibling-free" })
})

test("the paid floor does not preempt an in-band candidate on the same provider", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0.5, 0.6],
            prefer: "quality",
            limit: 3,
            rank: { "*quality*": 90, "*start*": 10 },
          },
        },
      },
    },
    [
      model("other", "quality", 5.5),
      model("other", "floor", 1),
      model("other", "start", 10),
      model("root", "base", 10),
    ],
  )
  const { resolve } = await start(host)
  const event = {
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "other", id: "start" },
  }
  await resolve(event)
  // The in-band `other/quality` is paid like the floor, but the floor is a tail
  // and must stay last, so the band wins.
  assert.deepEqual(event.model, { providerID: "other", id: "quality" })
})

test("the give-up notice runs once, names the 72 h window, and does not repeat", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 10],
            prefer: "quality",
            limit: 1,
            allow: ["openrouter/*"],
            rank: { "*only*": 90 },
          },
        },
      },
    },
    [model("openrouter", "only", 4), model("root", "base", 2)],
  )
  const { resolve, retry } = await start(host)

  const first = {
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "openrouter", id: "only" },
  }
  await resolve(first)
  assert.deepEqual(first.model, { providerID: "openrouter", id: "only" })

  const failure = () => ({
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "openrouter", id: "only" },
    error: { type: "provider.error", message: ZDR },
    attempt: 1,
    decision: { retry: true, delay: 15 * 60_000 },
  })

  const one = failure()
  await retry(one)
  assert.deepEqual(one.decision, { retry: true, delay: 1_500 })
  assert.equal(host.notes.length, 0, "no notice while another candidate may still run")

  const next = {
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "openrouter", id: "only" },
  }
  await resolve(next)
  assert.deepEqual(next.model, { providerID: "openrouter", id: "only" }, "nothing warm is left")

  const two = failure()
  await retry(two)
  assert.deepEqual(two.decision, { retry: false })
  assert.equal(host.notes.length, 1)
  assert.match(host.notes[0]!.text, /out for about 72h/)
  assert.match(host.notes[0]!.text, /Use a different subagent/)

  const three = failure()
  await retry(three)
  assert.equal(host.notes.length, 1, "the same outage is not announced twice")
})

test("a spent provider switches the session instead of waking the caller", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 10],
            prefer: "cost",
            limit: 4,
            rank: { "*free-a*": 90, "*free-b*": 80, "*free-c*": 70, "*base*": 10 },
            deny: ["*base*"],
          },
        },
      },
    },
    [
      model("opencode-go", "free-a", 0),
      model("opencode-go", "free-b", 0),
      model("other", "free-c", 0),
      model("root", "base", 2),
    ],
  )
  const now = Date.now()
  host.storage.set("cooldown", {
    "opencode-go/free-a": { until: now + 3_600_000, strikes: 1 },
    "opencode-go/free-b": { until: now + 3_600_000, strikes: 1 },
  })
  const { resolve, retry } = await start(host)

  const event = {
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "opencode-go", id: "free-a" },
  }
  await resolve(event)
  assert.equal(host.notes.length, 0, "no notice while the walk is merely being set up")

  const failed = {
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "opencode-go", id: "free-a" },
    error: { type: "provider.error", message: ZDR },
    attempt: 1,
    decision: { retry: false },
  }
  await retry(failed)
  assert.deepEqual(host.switches, [{ sessionID: "child", model: { providerID: "other", id: "free-c" } }])
  assert.deepEqual(failed.decision, { retry: true, delay: 1_500 })
  assert.equal(host.notes.length, 0, "the caller is not woken when the child can continue")
})

test("when every provider is spent the caller is told, and nothing is switched", async () => {
  const host = harness(
    {
      ...baseTiers,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 10],
            prefer: "cost",
            limit: 4,
            rank: { "*free-a*": 90, "*free-c*": 70, "*base*": 10 },
            deny: ["*base*"],
          },
        },
      },
    },
    [model("opencode-go", "free-a", 0), model("other", "free-c", 0), model("root", "base", 2)],
  )
  const now = Date.now()
  host.storage.set("cooldown", {
    "opencode-go/free-a": { until: now + 3_600_000, strikes: 1 },
    "other/free-c": { until: now + 3_600_000, strikes: 1 },
  })
  const { resolve, retry } = await start(host)
  await resolve({
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "opencode-go", id: "free-a" },
  })
  const failed = {
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "opencode-go", id: "free-a" },
    error: { type: "provider.error", message: ZDR },
    attempt: 1,
    decision: { retry: true },
  }
  await retry(failed)
  assert.deepEqual(host.switches, [])
  assert.deepEqual(failed.decision, { retry: false })
  assert.equal(host.notes.length, 1)
  assert.match(host.notes[0]!.text, /no working model/)
})

test("crossProvider false keeps the old fail-and-tell behaviour", async () => {
  const host = harness(
    {
      ...baseTiers,
      crossProvider: false,
      agents: { "swarm-worker": "worker" },
      tiers: {
        worker: {
          pick: {
            ratio: [0, 10],
            prefer: "cost",
            limit: 4,
            rank: { "*free-a*": 90, "*free-c*": 70, "*base*": 10 },
            deny: ["*base*"],
          },
        },
      },
    },
    [model("opencode-go", "free-a", 0), model("other", "free-c", 0), model("root", "base", 2)],
  )
  const now = Date.now()
  host.storage.set("cooldown", { "opencode-go/free-a": { until: now + 3_600_000, strikes: 1 } })
  const { resolve, retry } = await start(host)
  await resolve({
    sessionID: "child",
    agent: "swarm-worker",
    kind: "primary",
    model: { providerID: "opencode-go", id: "free-a" },
  })
  const failed = {
    sessionID: "child",
    agent: "swarm-worker",
    model: { providerID: "opencode-go", id: "free-a" },
    error: { type: "provider.error", message: ZDR },
    attempt: 1,
    decision: { retry: true },
  }
  await retry(failed)
  assert.deepEqual(host.switches, [])
  assert.deepEqual(failed.decision, { retry: false })
  assert.equal(host.notes.length, 1)
})

test("the delegation reminder counts tool calls and names the number", async () => {
  const host = harness({ ...baseTiers, nudge: 2, agents: { "swarm-worker-code": "lead" } }, [
    model("root", "base", 1),
  ])
  await start(host)
  const event = {
    sessionID: "child",
    agent: "swarm-worker-code",
    system: [] as Array<{ type: string; text: string }>,
  }
  await host.toolBefore({ tool: "read", sessionID: "child" })
  await host.fireContext(event)
  assert.equal(event.system.length, 0, "one call is below the threshold")
  await host.toolBefore({ tool: "shell", sessionID: "child" })
  await host.fireContext(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0]!.text, /^Delegation reminder: 2 tool calls since the last spawn/)
  assert.match(event.system[0]!.text, /spawn a swarm-worker/)
})

test("the reminder escalates while the session keeps working inline", async () => {
  const host = harness({ ...baseTiers, nudge: 2, agents: { "swarm-worker-code": "lead" } }, [
    model("root", "base", 1),
  ])
  await start(host)
  for (let call = 0; call < 4; call++) await host.toolBefore({ tool: "read", sessionID: "child" })
  const event = {
    sessionID: "child",
    agent: "swarm-worker-code",
    system: [] as Array<{ type: string; text: string }>,
  }
  await host.fireContext(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0]!.text, /4 tool calls/)
  assert.match(event.system[0]!.text, /Stop reading inline/)
})

test("a spawn resets the count", async () => {
  const host = harness({ ...baseTiers, nudge: 2, agents: { "swarm-worker-code": "lead" } }, [
    model("root", "base", 1),
  ])
  await start(host)
  for (let call = 0; call < 3; call++) await host.toolBefore({ tool: "read", sessionID: "child" })
  await host.toolBefore({ tool: "subagent", sessionID: "child" })
  const event = {
    sessionID: "child",
    agent: "swarm-worker-code",
    system: [] as Array<{ type: string; text: string }>,
  }
  await host.fireContext(event)
  assert.equal(event.system.length, 0, "the spawn cleared the counter")
  await host.toolBefore({ tool: "read", sessionID: "child" })
  await host.fireContext(event)
  assert.equal(event.system.length, 0, "one call after a spawn is below the threshold")
  await host.toolBefore({ tool: "read", sessionID: "child" })
  await host.fireContext(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0]!.text, /2 tool calls/)
})

test("nudge false and nudge zero both register no reminder", async () => {
  for (const nudge of [false, 0]) {
    const host = harness({ ...baseTiers, nudge, agents: { "swarm-worker-code": "lead" } }, [
      model("root", "base", 1),
    ])
    await start(host)
    assert.equal(host.hooks.get("context"), undefined)
  }
})

test("an agent that cannot spawn is not reminded", async () => {
  const host = harness({ ...baseTiers, nudge: 1, agents: { "swarm-worker": "worker" } }, [
    model("root", "base", 1),
  ])
  await start(host)
  await host.toolBefore({ tool: "read", sessionID: "child" })
  const event = {
    sessionID: "child",
    agent: "swarm-worker",
    system: [] as Array<{ type: string; text: string }>,
  }
  await host.fireContext(event)
  assert.equal(event.system.length, 0)
})
