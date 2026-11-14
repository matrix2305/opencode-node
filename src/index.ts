import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

import { DATA_DIR, LOG_FILE, defaultConfig, loadConfig, resolvePassword, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
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

function summary() {
  const applied = loadApplied()
  return {
    hub: current?.hub ?? null,
    lastPull: current ? new Date(current.fetchedAt).toISOString() : null,
    cacheAgeSeconds: current ? Math.round((Date.now() - current.fetchedAt) / 1000) : null,
    counts: current
      ? { skills: current.skills.length, agents: current.agents.length, commands: current.commands.length, mcp: Object.keys(current.mcp).length }
      : null,
    applied,
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
    const hub = new Hub(cfg.hub.url, password)
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
      materialize(current)
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
          materialize(fresh)
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
        execute: async () => ({ content: JSON.stringify(summary(), null, 2) }),
      })
      editor.add({
        name: "sync",
        description: "Pull the latest agents, skills, commands, MCP servers and memory from the hub",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          await refresh(true)
          return { content: JSON.stringify(summary(), null, 2) }
        },
      })
    })

    if (!applied) await refresh(true)
    else void refresh()
  },
})
