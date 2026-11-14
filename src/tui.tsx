import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"

import { NodeRpc } from "./rpc.ts"

function log(...parts: unknown[]) {
  try {
    const dir = path.join(os.homedir(), ".local", "share", "opencode-node")
    fs.mkdirSync(dir, { recursive: true })
    const text = parts
      .map((p) => {
        if (typeof p === "string") return p
        try {
          const err = p as any
          if (err?.message) return `${err.name ?? "Error"}: ${err.message}\n${err.stack ?? ""}`
          return JSON.stringify(p)
        } catch {
          return String(p)
        }
      })
      .join(" ")
    fs.appendFileSync(path.join(dir, "tui.log"), `[${new Date().toISOString()}] ${text}\n`)
  } catch {}
}

function formatStatus(status: any): string {
  const counts = status?.counts ?? {}
  const memory = status?.memory ?? {}
  const lines = [
    `hub:      ${status?.hubName ? `${status.hubName} · ` : ""}${status?.hub ?? "?"}`,
    `pulled:   ${status?.lastPull ?? "never"}`,
    `skills:   ${counts.skills ?? 0}`,
    `agents:   ${counts.agents ?? 0}`,
    `commands: ${counts.commands ?? 0}`,
    `mcp:      ${counts.mcp ?? 0}`,
    `memory:   ${memory.files ?? 0} files${memory.pending?.length ? ` (${memory.pending.length} pending)` : ""}`,
    `plugins:  ${counts.plugins ?? 0} entries${counts.pluginFiles ? `, ${counts.pluginFiles} file(s)` : ""}`,
    `models:   ${counts.models ?? 0} from hub (local-only disabled)`,

  ]
  if (status?.configDrift) lines.push("config:   drift (oc-node pull --config)")
  return lines.join("\n")
}

function footerLine(status: any): string {
  if (!status) return "node …"
  const skills = status.counts?.skills ?? 0
  const memory = status.memory?.files ?? 0
  const pending = status.memory?.pending?.length ?? 0
  const multi = (status.hubs?.length ?? 0) > 1
  return `node${multi && status.hubName ? `:${status.hubName}` : ""} ${skills}s · ${memory}m${pending ? ` · ${pending}↑` : ""}`
}

export default Plugin.define({
  id: "opencode-node.tui",
  async setup(context) {
    const rpc = context.client.rpc(NodeRpc)
    const [status, setStatus] = createSignal<any>(null)

    const toast = (message: string, variant?: "success" | "warning" | "error") => {
      context.ui.toast.show({
        title: "opencode-node",
        message,
        ...(variant ? { variant } : {}),
        duration: 4000,
      })
    }

    const refresh = async () => {
      try {
        setStatus(await rpc.status({}))
      } catch (err) {
        log("status error", err)
        setStatus(null)
      }
    }

    void refresh()

    const unsubscribe = rpc.events.on("updated", (event: any) => {
      const data = event?.data ?? {}
      if (data.summary) setStatus(data.summary)
      else void refresh()
      if (data.kind === "sync") toast("setup synced from hub", "success")
      if (data.kind === "config") toast("config updated · restart OpenCode", "warning")
      if (data.kind === "plugins") toast("plugins synced · restart OpenCode", "warning")
      if (data.kind === "push") {
        const summary: any = data.summary ?? {}
        const pending: string[] = summary?.memory?.pending ?? []
        toast(pending.length ? `memory pushed · ${pending.length} pending` : "memory pushed", pending.length ? "warning" : "success")
      }
    })

    const timer = setInterval(() => void refresh(), 30_000)

    const footer = context.ui.slot({
      append: "home.footer.status",
      render: () => <text fg={context.theme.text.base}>{footerLine(status())}</text>,
    })
    const promptFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={context.theme.text.base}>{footerLine(status())}</text>,
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-node.status",
          title: "opencode-node: status",
          group: "opencode-node",
          palette: true,
          run: async () => {
            try {
              const current = await rpc.status({})
              setStatus(current)
              await context.ui.dialog.alert({ title: "opencode-node", message: formatStatus(current) })
            } catch (err) {
              toast(String(err), "error")
            }
          },
        },
        {
          id: "opencode-node.sync",
          title: "opencode-node: sync now",
          group: "opencode-node",
          palette: true,
          run: async () => {
            try {
              toast("syncing from hub…")
              setStatus(await rpc.sync({}))
              toast("synced", "success")
            } catch (err) {
              toast(String(err), "error")
            }
          },
        },
        {
          id: "opencode-node.push",
          title: "opencode-node: push memory",
          group: "opencode-node",
          palette: true,
          run: async () => {
            try {
              const result: any = await rpc.push({})
              if (result?.conflicts?.length) toast(`${result.conflicts.length} conflict(s)`, "warning")
              else toast(`${result?.uploaded?.length ?? 0} uploaded`, "success")
              void refresh()
            } catch (err) {
              toast(String(err), "error")
            }
          },
        },
      ],
      bindings: [],
    }))

    return () => {
      clearInterval(timer)
      unsubscribe()
      footer?.()
      promptFooter?.()
    }
  },
})
