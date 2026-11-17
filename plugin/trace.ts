import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Where the resolver trace goes when the plugin has no `log` option.
 * `~/.local/share/opencode/log/` is the directory the server itself logs into,
 * so a reader only has to look in one place.
 */
export const defaultTracePath = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "log",
  "tier-router.log",
)

/** Past this size the file is rewritten to its last `keep` bytes. */
const limit = 256_000
const keep = 128_000

export type Trace = {
  /** The file being written, or `false` when only the console is used. */
  readonly path: string | false
  /** Record one diagnostic line. Never throws. */
  line(text: string): void
}

/**
 * Build the sink for `tier-router:` diagnostics.
 *
 * `console.warn` on its own is not enough. A server started by the desktop app
 * has stdout on `/dev/null` and stderr on a socket owned by the app, so every
 * console write from a plugin is discarded. The same line is therefore appended
 * to a file the reader can open, and the console call stays for a server that
 * was started from a terminal.
 */
export function createTrace(target: string | false = defaultTracePath): Trace {
  const path = target
  return {
    path,
    line(text: string) {
      console.warn(text)
      if (!path) return
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, `${new Date().toISOString()} ${text}\n`)
        if (statSync(path).size > limit) writeFileSync(path, readFileSync(path, "utf8").slice(-keep))
      } catch {
        // Diagnostics are best effort. A read-only home, a full disk or a path
        // that is a directory must not break the call being diagnosed.
      }
    },
  }
}
