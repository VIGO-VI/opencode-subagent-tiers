/** @jsxImportSource solid-js */
/**
 * The Subagents tab for OpenCode Desktop: lists the child sessions of the
 * session on screen and opens one as a tab when clicked.
 *
 * Built into `dist/gui-experimental.cjs` by `vite build`. The GUI API is
 * experimental, so every registry is used behind a guard.
 */
import {
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  usePlugin,
  type PanelTab,
  type Context,
} from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"

import { Settings } from "./rpc.ts"

const MODES = ["hybrid", "cloud", "local"] as const
const PREFERS = ["value", "local", "cloud"] as const
const MODE_LABEL: Record<string, string> = {
  hybrid: "Hybrid",
  cloud: "Cloud only",
  local: "Local only",
}
const PREFER_LABEL: Record<string, string> = {
  value: "Best price/performance",
  local: "Prefer local",
  cloud: "Prefer cloud",
}

function cycle<T extends readonly string[]>(list: T, current: string): T[number] {
  const index = list.indexOf(current as T[number])
  return list[(index + 1) % list.length] as T[number]
}

function SettingsView() {
  const ctx = usePlugin()
  const ui = (ctx as any).ui ?? {}
  const [mode, setMode] = createSignal<string>("hybrid")
  const [prefer, setPrefer] = createSignal<string>("value")
  const [error, setError] = createSignal<string | undefined>()

  const load = async () => {
    try {
      const value = (await ctx.client.rpc(Settings).get({})) as { mode: string; prefer: string }
      setMode(value.mode)
      setPrefer(value.prefer)
    } catch (cause) {
      setError(String(cause))
    }
  }

  const update = async (patch: { mode?: string; prefer?: string }) => {
    try {
      const value = (await ctx.client.rpc(Settings).set(patch)) as { mode: string; prefer: string }
      setMode(value.mode)
      setPrefer(value.prefer)
      setError(undefined)
    } catch (cause) {
      setError(String(cause))
    }
  }

  onMount(() => void load())

  const Row = ui.SettingsRow ?? ((props: any) => <div style={{ padding: "8px 0" }}>{props.children}</div>)
  const Section = ui.SettingsSection ?? ((props: any) => <section>{props.children}</section>)
  const Layout = ui.SettingsLayout ?? ((props: any) => <div>{props.children}</div>)

  const control = (label: string, value: string, onClick: () => void, disabled = false) => (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        border: "1px solid rgba(127,127,127,.4)",
        "border-radius": "6px",
        background: "transparent",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  )

  return (
    <Layout title="Tier router" description="Where subagent models come from, and which side wins a close call.">
      <Section title="Placement">
        <Row id="mode" title="Models allowed" description="Hybrid uses both. Cloud only hides local providers. Local only hides cloud providers.">
          {control(MODE_LABEL[mode()] ?? mode(), mode(), () => void update({ mode: cycle(MODES, mode()) }))}
        </Row>
        <Row
          id="prefer"
          title="Preference"
          description={
            mode() === "hybrid"
              ? "Which side wins a close call. Best price/performance compares rank per dollar."
              : "Only meaningful in Hybrid; a single-side mode already decides."
          }
        >
          {control(
            PREFER_LABEL[prefer()] ?? prefer(),
            prefer(),
            () => void update({ prefer: cycle(PREFERS, prefer()) }),
            mode() !== "hybrid",
          )}
        </Row>
        <Show when={error()}>
          <p style={{ opacity: 0.7 }}>{error()}</p>
        </Show>
      </Section>
    </Layout>
  )
}

const PANEL_ID = "subagents"

type Child = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created?: number; updated?: number }
}

function when(child: Child) {
  const t = child.time?.updated ?? child.time?.created ?? 0
  return t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""
}

function List(props: { session: any; ctx: Context }) {
  const [rows, setRows] = createSignal<Child[]>([])
  const [error, setError] = createSignal<string | undefined>()

  const load = async (session: any) => {
    try {
      const result = await session.server.client.session.list({ directory: session.directory })
      const data: Child[] = result?.data ?? []
      setRows(data.filter((entry) => entry.parentID === session.id))
      setError(undefined)
    } catch (cause) {
      setError(String(cause))
    }
  }

  // Children appear and finish while the panel is open, so follow the session
  // on screen and poll while mounted. No refresh button: there is nothing to
  // press if the list keeps itself current.
  createEffect(() => {
    const session = props.session
    void load(session)
    const timer = setInterval(() => void load(session), 3000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div style={{ padding: "10px 12px", display: "flex", "flex-direction": "column", gap: "6px" }}>
      <Show when={!error()} fallback={<p style={{ opacity: 0.7 }}>{error()}</p>}>
        <Show
          when={rows().length > 0}
          fallback={
            <p style={{ opacity: 0.7, margin: 0 }}>
              No subagent sessions under this one. They appear here while they run.
            </p>
          }
        >
          <For each={rows()}>
            {(child) => (
              <button
                style={{
                  "text-align": "left",
                  padding: "6px 8px",
                  border: "1px solid rgba(127,127,127,.35)",
                  "border-radius": "6px",
                  background: "transparent",
                  cursor: "pointer",
                }}
                onClick={() =>
                  props.ctx.tabs.open({ server: props.session.server.id, id: child.id }, { focus: true })
                }
              >
                <strong>{child.agent ?? "subagent"}</strong> <span style={{ opacity: 0.6 }}>{when(child)}</span>
                <br />
                <span style={{ opacity: 0.85 }}>{child.title ?? child.id}</span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    let tab: PanelTab | undefined
    const panelKey = `${ctx.id}:${PANEL_ID}`

    const panelTab = () => {
      if (tab?.title !== "Subagents") tab = { id: PANEL_ID, title: "Subagents", closable: "compact" }
      return tab
    }

    if (Panel) {
      ctx.add(Panel, {
        id: PANEL_ID,
        region: "side",
        width: "narrow",
        mobile: { title: "Subagents", order: 60, kind: "menu", icon: "branch" },
        list: (input) => (input.open.includes(PANEL_ID) ? [panelTab()] : []),
        render: (props) => <List session={props.session} ctx={ctx} />,
      })
    }

    if (SettingsPage) {
      ctx.add(SettingsPage, {
        id: "tier-router",
        icon: "server" as const,
        get title() {
          return "Tier router"
        },
        get entries() {
          return [
            { id: "mode", title: "Models allowed", keywords: "hybrid cloud local" },
            { id: "prefer", title: "Preference", keywords: "price performance local cloud" },
          ]
        },
        render: () => <SettingsView />,
      })
    }

    if (MenuItem) {
      ctx.add(MenuItem, (): any => {
        const session = ctx.sessions.current()
        const state = session ? ctx.layout?.state(panelKey, session) : undefined
        return {
          menu: "session.panel" as const,
          id: PANEL_ID,
          title: "Subagents",
          icon: "branch" as const,
          order: 60,
          ...(state !== undefined && state !== "closed" ? { opened: true } : {}),
          run: () => {
            const shown = ctx.sessions.current()
            if (shown) ctx.layout.open(panelKey, shown)
          },
        }
      })
    }
  },
})
