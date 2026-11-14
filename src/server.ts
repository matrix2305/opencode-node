import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

import { DATA_DIR, LOG_FILE, configMode, defaultConfig, loadConfig, pluginSpec, resolvePassword, skillsDir, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
import { NodeRpc } from "./rpc.ts"
import { pendingMemory, pushMemory } from "./memory.ts"
import type { Snapshot } from "./snapshot.ts"
import {
  applyConfig,
  loadApplied,
  loadSnapshot,
  materialize,
  pull,
  saveApplied,
  saveSnapshot,
} from "./sync.ts"

let current: Snapshot | null = null
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
  const applied = loadApplied(cfg)
  return {
    hub: current?.hub ?? null,
    lastPull: current ? new Date(current.fetchedAt).toISOString() : null,
    cacheAgeSeconds: current ? Math.round((Date.now() - current.fetchedAt) / 1000) : null,
    counts: current
      ? { skills: current.skills.length, agents: current.agents.length, commands: current.commands.length, mcp: Object.keys(current.mcp).length }
      : null,
    applied,
    configMode: configMode(cfg),
    memory: current ? { files: current.memory?.length ?? 0, pending: pendingMemory(cfg, current) } : null,
    hashes: current?.hashes ?? null,
    hubName: cfg.activeHub,
    hubs: Object.keys(cfg.hubs),
    configDrift: Boolean(current?.config && loadApplied(cfg)?.config !== current.hashes.config),
  }
}

function maybeApplyConfig(cfg: NodeConfig, snapshot: Snapshot): boolean {
  if (cfg.sync.config !== "auto" || !snapshot.config) return false
  const previous = loadApplied(cfg)
  if (previous?.config === snapshot.hashes.config) return false
  const result = applyConfig(snapshot, cfg, pluginSpec())
  saveApplied(cfg, {
    skills: snapshot.hashes.skills,
    agents: snapshot.hashes.agents,
    commands: snapshot.hashes.commands,
    mcp: snapshot.hashes.mcp,
    ...(previous?.config ? { config: previous.config } : {}),
    config: snapshot.hashes.config,
  })
  log("config:auto-applied", { files: result.wrote, removed: result.removed, restartRequired: true })
  void rpc?.events.emit("updated", { kind: "config", summary: summary(cfg) })
  return result.changed
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
    current = loadSnapshot(cfg)
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
          path: path.join(skillsDir(cfg), skill.id, "SKILL.md"),
          content: skill.content,
        }
        if (skill.description !== undefined) entry.description = skill.description
        if (skill.autoinvoke !== undefined) entry.autoinvoke = skill.autoinvoke
        editor.add(entry)
      }
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
      if (cfg.sync.config === "auto") {
        const cached = current
        setTimeout(() => {
          try {
            maybeApplyConfig(cfg, cached)
          } catch (err) {
            log("config:auto-error", String(err))
          }
        }, 1500).unref?.()
      }
      await ctx.skill.reload()
      await ctx.mcp.reload()
      const previous = loadApplied(cfg)
      if (previous?.agents !== current.hashes.agents) await ctx.agent.reload()
      if (previous?.commands !== current.hashes.commands) await ctx.command.reload()
      saveApplied(cfg, {
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
          saveSnapshot(cfg, fresh)
          materialize(fresh, cfg)
          await ctx.skill.reload()
          await ctx.mcp.reload()
          const previous = loadApplied(cfg)
          if (previous?.agents !== fresh.hashes.agents) await ctx.agent.reload()
          if (previous?.commands !== fresh.hashes.commands) await ctx.command.reload()
          saveApplied(cfg, {
            skills: fresh.hashes.skills,
            agents: fresh.hashes.agents,
            commands: fresh.hashes.commands,
            mcp: fresh.hashes.mcp,
            ...(previous?.config ? { config: previous.config } : {}),
          })
          log("refresh:ok", { changed, counts: { skills: fresh.skills.length, agents: fresh.agents.length, commands: fresh.commands.length, mcp: Object.keys(fresh.mcp).length } })
          try {
            maybeApplyConfig(cfg, fresh)
          } catch (err) {
            log("config:auto-error", String(err))
          }
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
        description: "Pull the latest setup from the hub and push pending memory changes",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh(true)
          if (current && pendingMemory(cfg, current).length) {
            const result = await pushMemory(hub, cfg, current)
            saveSnapshot(cfg, current)
            if (result.uploaded.length || result.conflicts.length) log("memory:push", result)
          }
          return { content: JSON.stringify(summary(cfg), null, 2) }
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
          saveSnapshot(cfg, current)
          await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2) })
        },
      })
    })

    const registration = await ctx.rpc.register(NodeRpc, {
      status: async () => summary(cfg),
      sync: async () => {
        await refresh(true)
        if (current && pendingMemory(cfg, current).length) {
          const result = await pushMemory(hub, cfg, current)
          saveSnapshot(cfg, current)
          if (result.uploaded.length || result.conflicts.length) log("memory:push", result)
        }
        return summary(cfg)
      },
      push: async () => {
        if (!current) return { uploaded: [], conflicts: [], unchanged: 0, error: "no snapshot" }
        const result = await pushMemory(hub, cfg, current)
        saveSnapshot(cfg, current)
        void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
        return result
      },
    })
    rpc = registration as any

    let timer: ReturnType<typeof setInterval> | undefined
    if (cfg.memory.enabled && cfg.memory.push) {
      const seconds = Math.max(5, cfg.memory.syncIntervalSeconds ?? 10)
      timer = setInterval(() => {
        if (!current) return
        if (!pendingMemory(cfg, current).length) return
        void pushMemory(hub, cfg, current)
          .then((result) => {
            saveSnapshot(cfg, current!)
            void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
            if (result.uploaded.length || result.conflicts.length) log("memory:push", result)
          })
          .catch((err) => log("memory:push-error", String(err)))
      }, seconds * 1000)
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
