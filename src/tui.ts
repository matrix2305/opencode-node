import { Plugin } from "@opencode/plugin/tui"

import { NodeRpc } from "./rpc.ts"

function formatStatus(status: any): string {
  const counts = status?.counts ?? {}
  const memory = status?.memory ?? {}
  const lines = [
    `hub:      ${status?.hub ?? "?"}`,
    `pulled:   ${status?.lastPull ?? "never"}`,
    `skills:   ${counts.skills ?? 0}`,
    `agents:   ${counts.agents ?? 0}`,
    `commands: ${counts.commands ?? 0}`,
    `mcp:      ${counts.mcp ?? 0}`,
    `memory:   ${memory.files ?? 0} files${memory.pending?.length ? ` (${memory.pending.length} pending)` : ""}`,
  ]
  if (status?.configDrift) lines.push("config:   drift (oc-node pull --config)")
  return lines.join("\n")
}

export default Plugin.define({
  id: "opencode-node.tui",
  async setup(context) {
    const rpc = context.client.rpc(NodeRpc)
    const toast = (message: string, variant?: "success" | "warning" | "error") => {
      context.ui.toast.show({
        title: "opencode-node",
        message,
        ...(variant ? { variant } : {}),
        duration: 4000,
      })
    }

    try {
      const status = await rpc.status({})
      const counts: any = (status as any)?.counts ?? {}
      const memory: any = (status as any)?.memory ?? {}
      toast(`connected · ${counts.skills ?? 0} skills · ${memory.files ?? 0} memory files`, "success")
    } catch {
      toast("server unreachable", "error")
    }

    const unsubscribe = rpc.events.on("updated", (event: any) => {
      const data = event?.data ?? {}
      if (data.kind === "sync") toast("setup synced from hub", "success")
      if (data.kind === "push") {
        const summary: any = data.summary ?? {}
        const pending: string[] = summary?.memory?.pending ?? []
        toast(pending.length ? `memory pushed · ${pending.length} pending` : "memory pushed", pending.length ? "warning" : "success")
      }
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
              const status = await rpc.status({})
              await context.ui.dialog.alert({ title: "opencode-node", message: formatStatus(status) })
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
              const status = await rpc.sync({})
              const counts: any = (status as any)?.counts ?? {}
              toast(`synced · ${counts.skills ?? 0} skills`, "success")
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
            } catch (err) {
              toast(String(err), "error")
            }
          },
        },
      ],
      bindings: [],
    }))

    return () => {
      unsubscribe()
    }
  },
})
