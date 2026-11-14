import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"

import { DATA_DIR, LOG_FILE, configMode, defaultConfig, loadConfig, pluginSpec, resolvePassword, skillsDir, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
import { applyAuthMemory, applyAuthViaLocalServer, fetchAuth, type ConnectResult } from "./auth.ts"
import { planModelUpdates, type ModelPlan } from "./models.ts"
import { safeName } from "./safe.ts"
import { NodeRpc } from "./rpc.ts"
import { pendingMemory, pushMemory } from "./memory.ts"
import type { Snapshot } from "./snapshot.ts"
import {
  applyConfig,
  applyPlugins,
  loadApplied,
  loadSnapshot,
  materialize,
  pull,
  saveApplied,
  saveSnapshot,
} from "./sync.ts"

let current: Snapshot | null = null
let refreshing: Promise<void> | null = null
let pushing: Promise<unknown> | null = null
let timerStarted = false
let rpc: { events: { emit: (name: string, data: any) => unknown } } | null = null

/** Serialise memory pushes so the timer, tools and RPC cannot race. */
async function pushMemoryLocked(hub: Hub, cfg: NodeConfig, snapshot: Snapshot): Promise<import("./memory.ts").PushResult> {
  if (pushing) return pushing as Promise<import("./memory.ts").PushResult>
  pushing = pushMemory(hub, cfg, snapshot).finally(() => {
    pushing = null
  })
  return pushing as Promise<import("./memory.ts").PushResult>
}

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
  // Explicit OCN_* envs opt in; ambient shell exports do not (avoids surprise
  // activation in every project when OPENCODE_REMOTE_URL is globally exported).
  const url = process.env.OCN_HUB_URL
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
      ? {
          skills: current.skills.length,
          agents: current.agents.length,
          commands: current.commands.length,
          mcp: Object.keys(current.mcp).length,
          plugins: current.plugins?.length ?? 0,
          pluginFiles: current.pluginFiles?.length ?? 0,
          models: current.models?.length ?? 0,
        }
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

async function applyAuthLive(ctx: any, hub: Hub, cfg: NodeConfig): Promise<ConnectResult | null> {
  if (!cfg.sync.auth) return null
  try {
    const auth = await fetchAuth(hub)
    if (!auth) return null
    // Preferred: HTTP route can list+remove, so hub-labelled credentials are
    // replaced instead of stacking on every refresh.
    try {
      const result = await applyAuthViaLocalServer(auth, cfg.activeHub)
      if (result.connected.length || result.errors.length) log("auth:applied", { connected: result.connected, removed: result.removed.length, errors: result.errors.map((e) => e.provider) })
      return result
    } catch {
      // Fallback: plugin-context connect only (no dedup available here).
      const result = await applyAuthMemory(auth, {
        hubName: cfg.activeHub,
        connect: (input) => ctx.integration.connect.key(input),
      })
      if (result.connected.length || result.errors.length) log("auth:applied-fallback", { connected: result.connected, errors: result.errors.map((e) => e.provider) })
      return result
    }
  } catch (err) {
    log("auth:error", String(err))
    return null
  }
}

async function applyModels(ctx: any, models: import("./snapshot.ts").ModelEntry[], cfg: NodeConfig): Promise<void> {
  if (!cfg.sync.models) return
  if (!models.length) {
    log("models:skipped", "hub model list empty (failed fetch?) — nothing disabled")
    return
  }
  const applied = loadApplied(cfg)
  const previous = applied?.nodeDisabledModels ?? []
  const holder: { plan?: ModelPlan } = {}
  await ctx.model.transform((editor: any) => {
    const plan = planModelUpdates(editor.list(), models, previous)
    for (const action of plan.actions) {
      editor.update(action.providerID, action.id, (draft: any) => {
        draft.enabled = action.enabled
      })
    }
    holder.plan = plan
  })
  const plan = holder.plan
  if (!plan) return
  const disabled = plan.actions.filter((a) => !a.enabled).length
  const enabled = plan.actions.length - disabled
  if (disabled || enabled) log("models:applied", { disabled, reEnabled: enabled, tracked: plan.disabledRefs.length })
  if (JSON.stringify(plan.disabledRefs) !== JSON.stringify(previous)) {
    saveApplied(cfg, {
      skills: applied?.skills ?? current?.hashes.skills ?? "",
      agents: applied?.agents ?? current?.hashes.agents ?? "",
      commands: applied?.commands ?? current?.hashes.commands ?? "",
      mcp: applied?.mcp ?? current?.hashes.mcp ?? "",
      ...(applied?.config ? { config: applied.config } : {}),
      nodeDisabledModels: plan.disabledRefs,
    })
  }
}

async function maybeApplyConfig(hub: Hub, cfg: NodeConfig, snapshot: Snapshot): Promise<boolean> {
  if (cfg.sync.config !== "auto" || !snapshot.config) return false
  const previous = loadApplied(cfg)
  if (previous?.config === snapshot.hashes.config) return false
  const result = await applyConfig(hub, snapshot, cfg, pluginSpec())
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
        const skillId = safeName(String(skill.id))
        if (!skillId) {
          log("skills:skipped-unsafe-id", String(skill.id))
          continue
        }
        const entry: any = {
          id: skill.id,
          name: skill.name,
          path: path.join(skillsDir(cfg), skillId, "SKILL.md"),
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
      void applyAuthLive(ctx, hub, cfg)
      void applyModels(ctx, current.models ?? [], cfg)
      if (cfg.sync.plugins) {
        try {
          applyPlugins(current, pluginSpec())
        } catch (err) {
          log("plugins:apply-error", String(err))
        }
      }
      if (cfg.sync.config === "auto") {
        const cached = current
        setTimeout(() => {
          try {
            maybeApplyConfig(hub, cfg, cached)
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
          if (cfg.sync.plugins) {
            try {
              const plugins = applyPlugins(fresh, pluginSpec())
              if (plugins.configChanged || plugins.filesWritten) {
                log("plugins:applied", { entries: plugins.pluginCount, files: plugins.filesWritten, config: plugins.configChanged })
                void rpc?.events.emit("updated", { kind: "plugins", summary: summary(cfg) })
              }
            } catch (err) {
              log("plugins:apply-error", String(err))
            }
          }
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
            await applyAuthLive(ctx, hub, cfg)
          } catch (err) {
            log("auth:error", String(err))
          }
          try {
            await applyModels(ctx, fresh.models, cfg)
          } catch (err) {
            log("models:error", String(err))
          }
          try {
            maybeApplyConfig(hub, cfg, fresh)
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
            const result = await pushMemoryLocked(hub, cfg, current)
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
          const result = await pushMemoryLocked(hub, cfg, current)
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
          const result = await pushMemoryLocked(hub, cfg, current)
          saveSnapshot(cfg, current)
          if (result.uploaded.length || result.conflicts.length) log("memory:push", result)
        }
        return summary(cfg)
      },
      push: async () => {
        if (!current) return { uploaded: [], conflicts: [], unchanged: 0, error: "no snapshot" }
        const result = await pushMemoryLocked(hub, cfg, current)
        saveSnapshot(cfg, current)
        void rpc?.events.emit("updated", { kind: "push", summary: summary(cfg) })
        return result
      },
    })
    rpc = registration as any

    let timer: ReturnType<typeof setInterval> | undefined
    if (cfg.memory.enabled && cfg.memory.push && !timerStarted) {
      timerStarted = true
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
      if (timer) {
        clearInterval(timer)
        timerStarted = false
      }
      rpc = null
      void registration.dispose()
    }
  },
})
