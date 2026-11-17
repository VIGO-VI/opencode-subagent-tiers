// Decide whether a candidate model can actually answer, so an install never
// bakes a dead model into an agent's frontmatter. The probe is one short
// request through the running server; nothing here spawns a session.
import { execFileSync } from "node:child_process"

/** The JSON body the CLI prints before its `HTTP <code>` line, when there is one. */
function payload(text) {
  // The CLI prints the body, then a line like `HTTP 502 Bad Gateway`. Anything
  // after that can repeat braces from the command that was run, so cut first.
  const marker = text.search(/\nHTTP \d{3}/)
  const head = marker === -1 ? text : text.slice(0, marker)
  const start = head.indexOf("{")
  if (start === -1) return undefined
  for (let end = head.lastIndexOf("}"); end > start; end = head.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(head.slice(start, end + 1))
    } catch {
      // A shorter slice may still be the whole body.
    }
  }
  return undefined
}

/**
 * What a failed probe means for the pick.
 *
 * - `unavailable`: the provider refused this model for a reason that will not
 *   change by retrying — an endpoint excluded by the account's data policy, a
 *   model the provider stopped serving, a capability mismatch, an account with
 *   no credit for that provider. Move on.
 * - `transient`: a rate limit, a timeout or a socket error. It says nothing
 *   about whether the model works, so the pick stands and is marked unverified.
 *
 * The provider's own `reason` is not trusted: a 402 from a provider with no
 * credit arrives labelled `rate_limit`, which would send the pick down the
 * transient path for a condition only a payment fixes.
 */
export function classify(text) {
  const raw = String(text ?? "")
  const body = `${raw} ${JSON.stringify(payload(raw) ?? {})}`
  if (
    /insufficient balance|guardrail|ZDR|data policy|no endpoints|model_not_found|ModelNotFound|not supported|UnsupportedModel|ProviderNotFound/i.test(
      body,
    ) ||
    /"status":\s*(402|404|422)\b/.test(body)
  ) {
    return "unavailable"
  }
  if (/429|too many requests|rate.?limit|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(body)) {
    return "transient"
  }
  // An error nobody classified is treated as transient: skipping a model that
  // does work is worse than installing one that needs a retry.
  return "transient"
}

/** The part of an error worth printing, on one line. */
export function summarize(text, limit = 200) {
  const raw = String(text ?? "")
  const json = payload(raw)
  const body = (json?.message || json?._tag || raw)
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part && !/^HTTP \d+/.test(part))
    .join(" ")
  return body.length > limit ? `${body.slice(0, limit - 1)}…` : body
}

/**
 * Walk the shortlist and return the first candidate that answers.
 *
 * `attempt(ref)` is injected so the order and the skip rules can be tested
 * without a server. It returns `{ status: "ok" | "unavailable" | "transient",
 * reason?: string }`.
 */
export function firstAnswering(candidates, attempt, note = () => {}) {
  const skipped = []
  for (const candidate of candidates) {
    let result
    try {
      result = attempt(candidate.ref)
    } catch (error) {
      result = { status: "transient", reason: summarize(error?.message ?? error) }
    }
    if (result?.status === "ok") return { chosen: candidate, skipped, unverified: undefined }
    if (result?.status === "transient") {
      note(`probe skipped for ${candidate.ref.providerID}/${candidate.ref.id}: ${result.reason ?? "no answer"}`)
      return { chosen: candidate, skipped, unverified: result.reason ?? "no answer" }
    }
    const reason = result?.reason ?? "no answer"
    skipped.push({ ref: candidate.ref, reason })
    note(`skipping ${candidate.ref.providerID}/${candidate.ref.id}: ${reason}`)
  }
  return { chosen: undefined, skipped, unverified: undefined }
}

/** Send one short request to `ref` through the CLI and classify the outcome. */
export function probe(binary, ref, { prompt = "Reply with the single word: ok", timeout = 45_000 } = {}) {
  const body = JSON.stringify({ prompt, model: { providerID: ref.providerID, id: ref.id } })
  try {
    execFileSync(binary, ["api", "post", "/api/experimental/generate/text", "-d", body], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: "ok" }
  } catch (error) {
    const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`
    return { status: classify(text), reason: summarize(text) }
  }
}
