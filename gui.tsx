/** @jsxImportSource solid-js */
/**
 * The Subagents tab for OpenCode Desktop: lists the child sessions of the
 * session on screen and opens one as a tab when clicked.
 *
 * Built into `dist/gui-experimental.cjs` by `vite build`. The GUI API is
 * experimental, so every registry is used behind a guard.
 */
import { MenuItem, Panel, Plugin, type PanelTab, type Context } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"

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
        mobile: { title: "Subagents", order: 60, kind: "menu", icon: "git-branch" },
        list: (input) => (input.open.includes(PANEL_ID) ? [panelTab()] : []),
        render: (props) => <List session={props.session} ctx={ctx} />,
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
          icon: "git-branch" as const,
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
