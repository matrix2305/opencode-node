import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DATA = path.join(os.homedir(), ".local", "share", "opencode-node")
const CONFIG = path.join(os.homedir(), ".config", "opencode-node", "config.json")

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

function statusText(): string {
  const cfg = readJson<any>(CONFIG)
  const snap = readJson<any>(path.join(DATA, "snapshot.json"))
  if (!cfg) return "opencode-node: not configured\nrun: oc-node init --hub <url> --password-ref ..."
  if (!snap) return `hub: ${cfg.hub?.url ?? "?"}\nno snapshot yet (run: oc-node pull)`
  const age = Math.round((Date.now() - snap.fetchedAt) / 1000)
  const lines = [
    `hub:      ${cfg.hub?.url ?? snap.hub}`,
    `pulled:   ${new Date(snap.fetchedAt).toISOString()} (${age}s ago)`,
    `skills:   ${snap.skills?.length ?? 0}`,
    `agents:   ${snap.agents?.length ?? 0}`,
    `commands: ${snap.commands?.length ?? 0}`,
    `mcp:      ${Object.keys(snap.mcp ?? {}).length}`,
    `memory:   ${snap.memory?.length ?? 0} files`,
  ]
  if (snap.config) lines.push(`config:   ${snap.config.file} (apply: oc-node pull --config)`)
  return lines.join("\n")
}

export default Plugin.define({
  id: "opencode-node.tui",
  async setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-node.status",
          title: "opencode-node: status",
          group: "opencode-node",
          palette: true,
          slash: { name: "node-status" },
          suggested: false,
          run: async () => {
            await context.ui.dialog.alert({ title: "opencode-node", message: statusText() })
          },
        },
      ],
      bindings: [],
    }))
  },
})
