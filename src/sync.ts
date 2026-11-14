import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DATA_DIR, SNAPSHOT_FILE, type NodeConfig } from "./config.ts"
import { Hub } from "./hub.ts"
import { ensurePluginSpec } from "./jsonc.ts"
import { isText, materializeMemory, rewriteForNode, sha as memorySha } from "./memory.ts"
import type { Applied, AgentEntry, CommandEntry, MemoryFile, SkillEntry, Snapshot } from "./snapshot.ts"

const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])
const BUILTIN_SKILLS = new Set(["opencode", "report", "browser"])

export const APPLIED_FILE = path.join(DATA_DIR, "applied.json")
export const LOCAL_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function loadSnapshot(): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"))
  } catch {
    return null
  }
}

export function saveSnapshot(snapshot: Snapshot) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = SNAPSHOT_FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, SNAPSHOT_FILE)
}

export function loadApplied(): Applied | null {
  try {
    return JSON.parse(fs.readFileSync(APPLIED_FILE, "utf8"))
  } catch {
    return null
  }
}

export function saveApplied(applied: Applied) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(applied, null, 2) + "\n", { mode: 0o600 })
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
        memory.push({
          rel: `${prefix}${name}`,
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

  let configFile: Snapshot["config"]
  for (const candidate of [".config/opencode/opencode.jsonc", ".config/opencode/opencode.json"]) {
    try {
      const content = await hub.read(candidate)
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
    ...(configFile ? { config: configFile } : {}),
    extras,
    hashes: {
      skills: hashList(skills),
      agents: hashList(agents),
      commands: hashList(commands),
      mcp: sha256(JSON.stringify(mcp)),
      memory: hashList(memory),
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
    const file = path.join(DATA_DIR, "skills", skill.id, "SKILL.md")
    if (writeIfChanged(file, skill.content, stamp)) changed = true
  }

  for (const agent of snapshot.agents) {
    const file = path.join(LOCAL_CONFIG_DIR, "agents", `${agent.id}.md`)
    if (writeIfChanged(file, agentMarkdown(agent), stamp)) changed = true
  }

  for (const command of snapshot.commands) {
    const file = path.join(LOCAL_CONFIG_DIR, "commands", command.name)
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

export interface ConfigResult {
  changed: boolean
  wrote: string[]
  removed: string[]
}

/** Write the hub config (raw JSONC) locally, keeping the node plugin entry. */
export function applyConfig(snapshot: Snapshot, spec: string): ConfigResult {
  const result: ConfigResult = { changed: false, wrote: [], removed: [] }
  if (!snapshot.config) return result
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  const target = path.join(LOCAL_CONFIG_DIR, "opencode.jsonc")
  const content = ensurePluginSpec(snapshot.config.content, spec).text
  if (writeIfChanged(target, content, stamp)) {
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
