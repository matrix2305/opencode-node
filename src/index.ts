import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

import { DATA_DIR, LOG_FILE, defaultConfig, loadConfig, resolvePassword, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
import { NodeRpc } from "./rpc.ts"
import { buildMemoryBlock, memoryRoot, pendingMemory, pushMemory, searchMemory, storeMemory } from "./memory.ts"
import type { Snapshot } from "./snapshot.ts"
import {
  loadApplied,
  loadSnapshot,
  materialize,
  pull,
  saveApplied,
  saveSnapshot,
} from "./sync.ts"

let current: Snapshot | null = loadSnapshot()
let refreshing: Promise<void> | null = null
let rpc: { events: { emit: (name: string, data: any) => unknown } } | null = null

function log(...parts: unknown[]) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const line = `[${new Date().toISOString()}] ${parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ")}\n`
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

function envConfig(): NodeConfig | null {
  const url = process.env.OCN_HUB_URL ?? process.env.OPENCODE_REMOTE_URL
  if (!url) return null
  return {
    ...defaultConfig(url, process.env.OCN_HUB_PASSWORD ? "env:OCN_HUB_PASSWORD" : undefined),
  }
}

function mcpConfig(def: any): any | null {
  if (!def || typeof def !== "object") return null
  if (def.type === "remote") {
    return { type: "remote", url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
  }
  if (def.type === "local") {
    return {
      type: "local",
      command: def.command,
      ...(def.environment ? { environment: def.environment } : {}),
      ...(def.cwd ? { cwd: def.cwd } : {}),
    }
  }
  return null
}

function summary(cfg: NodeConfig) {
  const applied = loadApplied()
  return {
    hub: current?.hub ?? null,
    lastPull: current ? new Date(current.fetchedAt).toISOString() : null,
    cacheAgeSeconds: current ? Math.round((Date.now() - current.fetchedAt) / 1000) : null,
    counts: current
      ? { skills: current.skills.length, agents: current.agents.length, commands: current.commands.length, mcp: Object.keys(current.mcp).length }
      : null,
    applied,
    memory: current ? { files: current.memory?.length ?? 0, pending: pendingMemory(cfg, current) } : null,
    hashes: current?.hashes ?? null,
    configDrift: Boolean(current?.config && loadApplied()?.config !== current.hashes.config),
  }
}

export default Plugin.define({
  id: "opencode-node",
  async setup(ctx) {
    const cfg = loadConfig() ?? envConfig()
    if (!cfg) return
    const password = resolvePassword(cfg.hub.passwordRef)
    if (!password) {
      log("setup:no-password", cfg.hub.url)
      return
    }
    const hub = new Hub(cfg.hub.url, password, cfg.paths.remoteRoot)
    log("setup:start", { location: ctx.location?.directory, hub: cfg.hub.url, cached: Boolean(current) })

    // Register transforms once; their callbacks always read the latest snapshot.
    await ctx.skill.transform((editor) => {
      const snap = current
      if (!snap) return
      for (const skill of snap.skills) {
        const entry: any = {
          id: skill.id,
          name: skill.name,
          path: path.join(DATA_DIR, "skills", skill.id, "SKILL.md"),
          content: skill.content,
        }
        if (skill.description !== undefined) entry.description = skill.description
        if (skill.autoinvoke !== undefined) entry.autoinvoke = skill.autoinvoke
        editor.add(entry)
      }
    })

    await ctx.session.hook("context", (event: any) => {
      if (!current) return
      const block = buildMemoryBlock(String(event.agent ?? ""), ctx.location.directory, cfg, current)
      if (block && Array.isArray(event.system)) event.system.push({ type: "text", text: block })
    })

    await ctx.session.hook("compaction", (event: any) => {
      if (!current) return
      const block = buildMemoryBlock(String(event.agent ?? ""), ctx.location.directory, cfg, current)
      if (block && Array.isArray(event.system)) event.system.push({ type: "text", text: block })
    })

    await ctx.mcp.transform((editor) => {
      const snap = current
      if (!snap) return
      for (const [name, def] of Object.entries(snap.mcp)) {
        const config = mcpConfig(def)
        if (config) editor.set(name, config)
      }
    })

    let applied = false
    if (current) {
      materialize(current, cfg)
      await ctx.skill.reload()
      await ctx.mcp.reload()
      const previous = loadApplied()
      if (previous?.agents !== current.hashes.agents) await ctx.agent.reload()
      if (previous?.commands !== current.hashes.commands) await ctx.command.reload()
      saveApplied({
        skills: current.hashes.skills,
        agents: current.hashes.agents,
        commands: current.hashes.commands,
        mcp: current.hashes.mcp,
        ...(previous?.config ? { config: previous.config } : {}),
      })
      applied = Boolean(previous)
    }

    const refresh = async (force = false) => {
      if (refreshing) return refreshing
      refreshing = (async () => {
        try {
          const age = current ? (Date.now() - current.fetchedAt) / 1000 : Infinity
          if (!force && age < cfg.cacheSeconds) {
            log("refresh:cache", { age: Math.round(age), ttl: cfg.cacheSeconds })
            return
          }
          const fresh = await pull(hub, cfg)
          const changed = !current || JSON.stringify(fresh.hashes) !== JSON.stringify(current.hashes)
          current = fresh
          saveSnapshot(fresh)
          materialize(fresh, cfg)
          await ctx.skill.reload()
          await ctx.mcp.reload()
          const previous = loadApplied()
          if (previous?.agents !== fresh.hashes.agents) await ctx.agent.reload()
          if (previous?.commands !== fresh.hashes.commands) await ctx.command.reload()
          saveApplied({
            skills: fresh.hashes.skills,
            agents: fresh.hashes.agents,
            commands: fresh.hashes.commands,
            mcp: fresh.hashes.mcp,
            ...(previous?.config ? { config: previous.config } : {}),
          })
          log("refresh:ok", { changed, counts: { skills: fresh.skills.length, agents: fresh.agents.length, commands: fresh.commands.length, mcp: Object.keys(fresh.mcp).length } })
          void rpc?.events.emit("updated", { kind: "sync", summary: summary(cfg) })
          if (changed && fresh.config) log("config:drift", "hub config changed; run: oc-node pull --config")
        } catch (err) {
          log("refresh:error", String(err))
        } finally {
          refreshing = null
        }
      })()
      return refreshing
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "node", description: "Remote OpenCode hub (opencode-node)" })
      editor.add({
        name: "status",
        description: "Show the state of the connected OpenCode hub and the local cache",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(summary(cfg), null, 2) }),
      })
      editor.add({
        name: "sync",
        description: "Pull the latest agents, skills, commands, MCP servers and memory from the hub",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh(true)
          return { content: JSON.stringify(summary(cfg), null, 2) }
        },
      })
      editor.add({
        name: "memory_search",
        description: "Search local memory files synced from the hub",
        input: {
          type: "object",
          properties: { query: { type: "string" }, agent: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (input: any) => ({
          content: JSON.stringify(searchMemory(cfg, input.query, input.agent, input.limit ?? 20), null, 2),
        }),
      })
      editor.add({
        name: "memory_get",
        description: "Read a memory file by its path relative to the agents root",
        input: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        execute: async (input: any) => {
          try {
            const fsmod = await import("node:fs")
            const file = path.join(memoryRoot(cfg), input.path)
            return { content: fsmod.readFileSync(file, "utf8") }
          } catch (err) {
            return { content: `error: ${String(err)}` }
          }
        },
      })
      editor.add({
        name: "memory_store",
        description: "Append a note to an agent's memory file (MEMORY.md by default)",
        input: {
          type: "object",
          properties: { text: { type: "string" }, agent: { type: "string" }, file: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const agent = input.agent ?? String(context?.agent ?? "")
          if (!agent) return { content: "error: no agent; pass agent explicitly" }
          const rel = storeMemory(cfg, input.text, agent, input.file ?? "MEMORY.md")
          return { content: `stored in ${rel}` }
        },
      })
      editor.add({
        name: "memory_push",
        description: "Push locally changed memory files back to the hub (conflict-safe)",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (!current) return { content: "no snapshot" }
          const result = await pushMemory(hub, cfg, current)
          saveSnapshot(current)
          void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
          return { content: JSON.stringify(result, null, 2) }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "node-status",
        description: "Show opencode-node status (hub, cache, memory)",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({ sessionID, text: JSON.stringify(summary(cfg), null, 2) })
        },
      })
      editor.add({
        name: "node-sync",
        description: "Pull the latest setup and memory from the hub",
        execute: async ({ sessionID }) => {
          await refresh(true)
          await ctx.session.synthetic({ sessionID, text: JSON.stringify(summary(cfg), null, 2) })
        },
      })
      editor.add({
        name: "node-push",
        description: "Push locally changed memory to the hub",
        execute: async ({ sessionID }) => {
          if (!current) {
            await ctx.session.synthetic({ sessionID, text: "opencode-node: no snapshot" })
            return
          }
          const result = await pushMemory(hub, cfg, current)
          saveSnapshot(current)
          await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) })
        },
      })
    })

    const registration = await ctx.rpc.register(NodeRpc, {
      status: async () => summary(cfg),
      sync: async () => {
        await refresh(true)
        return summary(cfg)
      },
      push: async () => {
        if (!current) return { uploaded: [], conflicts: [], unchanged: 0, error: "no snapshot" }
        const result = await pushMemory(hub, cfg, current)
        saveSnapshot(current)
        void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
        return result
      },
    })
    rpc = registration as any

    let timer: ReturnType<typeof setInterval> | undefined
    if (cfg.memory.enabled && cfg.memory.push) {
      timer = setInterval(() => {
        if (!current) return
        void pushMemory(hub, cfg, current)
          .then((result) => {
            saveSnapshot(current!)
            void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
            if (result.uploaded.length || result.conflicts.length) log("memory:push", result)
          })
          .catch((err) => log("memory:push-error", String(err)))
      }, Math.max(60, cfg.memory.pushIntervalSeconds) * 1000)
      timer.unref?.()
    }

    if (!applied) await refresh(true)
    else void refresh()

    return () => {
      if (timer) clearInterval(timer)
      rpc = null
      void registration.dispose()
    }
  },
})
