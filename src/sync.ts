import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DATA_DIR, appliedFile, ensureHubData, skillsDir, snapshotFile, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
import { ensurePluginEntries, ensurePluginSpec } from "./jsonc.ts"
import { fetchAuth } from "./auth.ts"
import { safeName, safeRel } from "./safe.ts"
import { isText, materializeMemory, rewriteForNode, sha as memorySha } from "./memory.ts"
import type { Applied, AgentEntry, CommandEntry, MemoryFile, ModelEntry, PluginEntry, SkillEntry, Snapshot } from "./snapshot.ts"

const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])
const BUILTIN_SKILLS = new Set(["opencode", "report", "browser"])

/**
 * Replace inline secret values (apiKey and friends) with env-substitution
 * placeholders so the snapshot on disk never contains key material. Values are
 * restored from the live credential store instead (M11 auth sync).
 */
export function redactSecrets(text: string): string {
  return text.replace(
    /("(?:apiKey|api_key|apiKeyId|secret|token|password)"\s*:\s*)"[^"\n]*"/gi,
    (_m, prefix: string) => `${prefix}"{redacted}"`,
  )
}

export const LOCAL_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function loadSnapshot(cfg: NodeConfig): Snapshot | null {
  ensureHubData(cfg)
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(cfg), "utf8"))
  } catch {
    return null
  }
}

export function saveSnapshot(cfg: NodeConfig, snapshot: Snapshot) {
  const dir = ensureHubData(cfg)
  const file = path.join(dir, "snapshot.json")
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function loadApplied(cfg: NodeConfig): Applied | null {
  ensureHubData(cfg)
  try {
    return JSON.parse(fs.readFileSync(appliedFile(cfg), "utf8"))
  } catch {
    return null
  }
}

export function saveApplied(cfg: NodeConfig, applied: Applied) {
  const dir = ensureHubData(cfg)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(appliedFile(cfg), JSON.stringify(applied, null, 2) + "\n", { mode: 0o600 })
}

function hashList(values: unknown[]): string {
  return sha256(JSON.stringify(values))
}

export async function pull(hub: Hub, cfg: NodeConfig): Promise<Snapshot> {
  const info = await hub.info()
  if (!String(info.version).startsWith("2.")) {
    throw new Error(`hub runs OpenCode ${info.version}; only 2.x is supported`)
  }

  const root = cfg.paths.remoteRoot.replace(/\/$/, "")

  const loc = { "location[directory]": root }
  const skillsRaw = await hub.json("/api/skill", loc)
  const skills: SkillEntry[] = (skillsRaw.data ?? [])
    .filter((s: any) => {
      if (BUILTIN_SKILLS.has(s.id)) return false
      const p = String(s.path ?? "")
      if (p.includes("/.config/opencode/skills/")) return true
      return !p
    })
    .map((s: any) => ({
      id: s.id,
      name: s.name,
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.autoinvoke !== undefined ? { autoinvoke: s.autoinvoke } : {}),
      content: s.content,
      sha: sha256(s.id + "\0" + s.content),
    }))

  const agentsRaw = await hub.json("/api/agent", loc)
  const agents: AgentEntry[] = (agentsRaw.data ?? [])
    .filter((a: any) => !BUILTIN_AGENTS.has(a.id))
    .map((a: any) => ({
      id: a.id,
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.mode !== undefined ? { mode: a.mode } : {}),
      ...(a.model !== undefined ? { model: a.model } : {}),
      ...(a.permissions?.length ? { permissions: a.permissions } : {}),
      ...(a.hidden ? { hidden: true } : {}),
      ...(a.system !== undefined ? { system: a.system } : {}),
      sha: sha256(JSON.stringify(a)),
    }))

  const commandMap = new Map<string, CommandEntry>()
  for (const dir of ["commands", "command"]) {
    let entries: Array<{ path: string; type: string }> = []
    try {
      entries = await hub.list(`${root}/.config/opencode/${dir}`)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.path.endsWith(".md")) continue
      const content = await hub.read(entry.path)
      const name = entry.path.split("/").pop()!
      commandMap.set(name, { file: entry.path, name, content, sha: sha256(content) })
    }
  }
  const commands = [...commandMap.values()]

  let mcp: Record<string, unknown> = {}
  try {
    const config = await hub.json("/api/config", loc)
    const doc = (config as any[]).find((c) => c.info?.mcp?.servers)
    mcp = doc?.info?.mcp?.servers ?? {}
  } catch {}

  const memory: MemoryFile[] = []
  const walkMemory = async (abs: string, prefix: string) => {
    let entries: Array<{ path: string; type: string }> = []
    try {
      entries = await hub.list(abs)
    } catch {
      return
    }
    for (const entry of entries) {
      const clean = entry.path.replace(/\/$/, "")
      const name = clean.split("/").pop() ?? ""
      if (entry.type === "directory") {
        if ([".git", "node_modules", "skills", ".clawhub", ".dreams"].includes(name)) continue
        await walkMemory(`${root}/${clean}`, `${prefix}${name}/`)
      } else {
        if (name.includes(".conflict-")) continue
        let content: string
        try {
          content = await hub.read(entry.path)
        } catch {
          continue
        }
        if (content.length > 1024 * 1024 || !isText(content)) continue
        const relCheck = safeRel(`${prefix}${name}`, { allowNested: true })
        if (!relCheck) continue
        memory.push({
          rel: relCheck,
          agent: prefix.split("/")[0] ?? "",
          content,
          sha: memorySha(content),
          localSha: memorySha(rewriteForNode(content, cfg)),
        })
      }
    }
  }
  try {
    for (const entry of await hub.list(`${root}/agents`)) {
      if (entry.type !== "directory") continue
      const clean = entry.path.replace(/\/$/, "")
      const name = clean.split("/").pop() ?? ""
      if ([".git", "skills", ".clawhub", ".dreams"].includes(name)) continue
      await walkMemory(`${root}/${clean}`, `${name}/`)
    }
  } catch {}
  memory.sort((a, b) => a.rel.localeCompare(b.rel))

  // ---------- plugins ----------
  const pluginEntries: PluginEntry[] = []
  const pushPlugin = (value: unknown) => {
    const spec =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && typeof (value as any).package === "string"
          ? (value as any).package
          : undefined
    if (!spec) return
    if (pluginEntries.some((p) => p.spec === spec)) return
    pluginEntries.push({ spec, value })
  }
  const collectPlugins = (info: any) => {
    for (const key of ["plugins", "plugin"]) {
      const value = info?.[key]
      if (Array.isArray(value)) value.forEach(pushPlugin)
    }
  }
  try {
    const config = await hub.json("/api/config", loc)
    for (const entry of config as any[]) collectPlugins(entry?.info)
  } catch {}

  const pluginFiles: Snapshot["pluginFiles"] = []
  for (const dir of ["plugin", "plugins"]) {
    const walk = async (abs: string, rel: string) => {
      let entries: Array<{ path: string; type: string }> = []
      try {
        entries = await hub.list(abs)
      } catch {
        return
      }
      for (const entry of entries) {
        const clean = entry.path.replace(/\/$/, "")
        const name = clean.split("/").pop() ?? ""
        if (name === "node_modules" || name === ".git") continue
        if (entry.type === "directory") {
          await walk(`${root}/${clean}`, `${rel}${name}/`)
        } else {
          if (name.includes(".conflict-")) continue
          let content: string
          try {
            content = await hub.read(clean)
          } catch {
            continue
          }
          if (content.length > 512 * 1024 || !isText(content)) continue
          pluginFiles.push({ file: `${rel}${name}`, content, sha: sha256(content) })
        }
      }
    }
    await walk(`${root}/.config/opencode/${dir}`, `${dir}/`)
  }
  pluginFiles.sort((a, b) => a.file.localeCompare(b.file))

  let pluginPackage: Snapshot["pluginPackage"]
  try {
    const content = await hub.read(".config/opencode/package.json")
    if (content.length <= 256 * 1024) pluginPackage = { content, sha: sha256(content) }
  } catch {}

  let authCount: number | undefined
  let authSha: string | undefined
  if (cfg.sync.auth) {
    const auth = await fetchAuth(hub)
    if (auth) {
      authCount = Object.keys(auth.entries).length
      authSha = sha256(JSON.stringify(Object.keys(auth.entries).sort()))
    }
  }

  // ---------- models ----------
  const models: ModelEntry[] = []

  const seenModel = new Set<string>()
  const pushModel = (m: any) => {
    if (!m?.id || !m?.providerID) return
    const ref = `${m.providerID}/${m.id}`
    if (seenModel.has(ref)) return
    seenModel.add(ref)
    const entry: ModelEntry = { providerID: m.providerID, id: m.id, ref }
    if (m.name !== undefined) entry.name = m.name
    if (m.hidden !== undefined) entry.hidden = m.hidden
    if (m.enabled !== undefined) entry.enabled = m.enabled
    if (m.deprecated !== undefined) entry.deprecated = m.deprecated
    models.push(entry)
  }
  if (cfg.sync.models) {
    try {
      const listed = await hub.json("/api/model", loc)
      for (const m of listed.data ?? []) pushModel(m)
    } catch {}
  }
  models.sort((a, b) => a.ref.localeCompare(b.ref))

  let configFile: Snapshot["config"]
  for (const candidate of [".config/opencode/opencode.jsonc", ".config/opencode/opencode.json"]) {
    try {
      const content = redactSecrets(await hub.read(candidate))
      configFile = { file: candidate, content, sha: sha256(content) }
      break
    } catch {}
  }

  const extras: Snapshot["extras"] = []
  for (const file of [".config/opencode/opencode-mem.jsonc"]) {
    try {
      const content = await hub.read(file)
      extras.push({ file, content, sha: sha256(content) })
    } catch {}
  }

  return {
    version: 1,
    hub: cfg.hub.url,
    fetchedAt: Date.now(),
    skills,
    agents,
    commands,
    mcp,
    memory,
    plugins: pluginEntries,
    models,
    pluginFiles,
    ...(pluginPackage ? { pluginPackage } : {}),
    ...(authCount !== undefined ? { authCount } : {}),
    ...(configFile ? { config: configFile } : {}),
    extras,
    hashes: {
      skills: hashList(skills),
      agents: hashList(agents),
      commands: hashList(commands),
      mcp: sha256(JSON.stringify(mcp)),
      memory: hashList(memory),
      plugins: sha256(JSON.stringify(pluginEntries.map((p) => p.value).concat(pluginFiles.map((f) => f.sha)))),
      models: sha256(JSON.stringify(models.map((m) => m.ref))),
      ...(authSha ? { auth: authSha } : {}),

      ...(configFile ? { config: configFile.sha } : {}),
    },
  }
}

function backupFile(file: string, stamp: string) {
  if (!fs.existsSync(file)) return
  const rel = path.relative(os.homedir(), file)
  const dest = path.join(DATA_DIR, "backup", stamp, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
}

function writeIfChanged(file: string, content: string, stamp: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false
  } catch {}
  backupFile(file, stamp)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return true
}

function agentMarkdown(agent: AgentEntry): string {
  const front: string[] = ["---", `description: ${JSON.stringify(agent.description ?? agent.id)}`]
  front.push(`mode: ${agent.mode ?? "primary"}`)
  if (agent.model) {
    front.push(`model: ${agent.model.providerID}/${agent.model.id}${agent.model.variant ? "#" + agent.model.variant : ""}`)
  }
  if (agent.permissions?.length) front.push(`permissions: ${JSON.stringify(agent.permissions)}`)
  if (agent.hidden) front.push("hidden: true")
  front.push("---", "", agent.system ?? "", "")
  return front.join("\n")
}

export interface MaterializeResult {
  skillFiles: number
  agentFiles: number
  commandFiles: number
  memoryFiles: number
  memoryWritten: number
  memoryKeptLocal: number
  changed: boolean
}

/** Write snapshot content to local files. Safe to call on every start. */
export function materialize(snapshot: Snapshot, cfg: NodeConfig): MaterializeResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let changed = false

  for (const skill of snapshot.skills) {
    const skillId = safeName(String(skill.id))
    if (!skillId) continue
    const file = path.join(skillsDir(cfg), skillId, "SKILL.md")
    if (writeIfChanged(file, skill.content, stamp)) changed = true
  }

  for (const agent of snapshot.agents) {
    const agentId = safeName(String(agent.id))
    if (!agentId) continue
    const file = path.join(LOCAL_CONFIG_DIR, "agents", `${agentId}.md`)
    if (writeIfChanged(file, agentMarkdown(agent), stamp)) changed = true
  }

  for (const command of snapshot.commands) {
    const commandName = safeName(String(command.name))
    if (!commandName) continue
    const file = path.join(LOCAL_CONFIG_DIR, "commands", commandName)
    if (writeIfChanged(file, command.content, stamp)) changed = true
  }

  const memory = materializeMemory(snapshot, cfg)
  if (memory.written > 0) changed = true

  return {
    skillFiles: snapshot.skills.length,
    agentFiles: snapshot.agents.length,
    commandFiles: snapshot.commands.length,
    memoryFiles: snapshot.memory?.length ?? 0,
    memoryWritten: memory.written,
    memoryKeptLocal: memory.keptLocal,
    changed,
  }
}

export interface PluginsResult {
  configChanged: boolean
  pluginCount: number
  filesWritten: number
  packageMerged: boolean
}

/**
 * Apply only the plugin layer of a snapshot: merge the hub plugin list into the
 * local config (never removing local entries), copy local plugin files and merge
 * package.json dependencies.
 */
export function applyPlugins(snapshot: Snapshot, spec: string): PluginsResult {
  const result: PluginsResult = { configChanged: false, pluginCount: snapshot.plugins?.length ?? 0, filesWritten: 0, packageMerged: false }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  if (snapshot.plugins?.length) {
    let target = path.join(LOCAL_CONFIG_DIR, "opencode.jsonc")
    if (!fs.existsSync(target)) {
      const json = path.join(LOCAL_CONFIG_DIR, "opencode.json")
      if (fs.existsSync(json)) target = json
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(LOCAL_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(target, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`, { mode: 0o600 })
    }
    const current = fs.readFileSync(target, "utf8")
    const pluginEntry = ensurePluginSpec(current, spec)
    const merged = ensurePluginEntries(pluginEntry.text, snapshot.plugins.map((p) => p.value))
    if (pluginEntry.changed || merged.added) {
      backupFile(target, stamp)
      fs.writeFileSync(target, merged.text)
      fs.chmodSync(target, 0o600)
      result.configChanged = true
    }
  }

  for (const file of snapshot.pluginFiles ?? []) {
    const rel = safeRel(file.file, { allowNested: true, maxDepth: 6 })
    if (!rel) continue
    const dest = path.join(LOCAL_CONFIG_DIR, rel)
    if (writeIfChanged(dest, file.content, stamp)) result.filesWritten++
  }

  if (snapshot.pluginPackage) {
    const dest = path.join(LOCAL_CONFIG_DIR, "package.json")
    try {
      const hubPkg = JSON.parse(snapshot.pluginPackage.content)
      const localPkg = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : {}
      // hub is the source of truth for its own deps; local-only deps stay
      const dependencies = { ...(localPkg.dependencies ?? {}), ...(hubPkg.dependencies ?? {}) }
      const merged = { ...hubPkg, ...localPkg, dependencies }
      const text = JSON.stringify(merged, null, 2) + "\n"
      if (writeIfChanged(dest, text, stamp)) {
        result.packageMerged = true
        result.filesWritten++
      }
    } catch {}
  }

  return result
}

export interface ConfigResult {
  changed: boolean
  wrote: string[]
  removed: string[]
}

/** Write the hub config (raw JSONC) locally, keeping the node plugin entry. */
export async function applyConfig(hub: Hub, snapshot: Snapshot, cfg: NodeConfig, spec: string): Promise<ConfigResult> {
  const result: ConfigResult = { changed: false, wrote: [], removed: [] }
  if (!snapshot.config) return result
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  // The snapshot stores a redacted copy; fetch the real config live so provider
  // apiKey fields survive in the local file (mode 0600, credentials-only copy).
  let content = snapshot.config.content
  try {
    content = await hub.read(snapshot.config.file)
  } catch {}

  const target = path.join(LOCAL_CONFIG_DIR, "opencode.jsonc")
  const text = ensurePluginSpec(content, spec).text
  if (writeIfChanged(target, text, stamp)) {
    fs.chmodSync(target, 0o600)
    result.changed = true
    result.wrote.push(target)
  }

  for (const extra of snapshot.extras) {
    const file = path.join(LOCAL_CONFIG_DIR, path.basename(extra.file))
    if (writeIfChanged(file, extra.content, stamp)) {
      fs.chmodSync(file, 0o600)
      result.changed = true
      result.wrote.push(file)
    }
  }

  // avoid a second, conflicting config document
  const legacy = path.join(LOCAL_CONFIG_DIR, "opencode.json")
  if (fs.existsSync(legacy)) {
    backupFile(legacy, stamp)
    fs.rmSync(legacy)
    result.changed = true
    result.removed.push(legacy)
  }

  return result
}
