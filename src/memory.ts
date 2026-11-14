import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DATA_DIR, type NodeConfig } from "./config.ts"
import type { Hub } from "./hub.ts"
import type { MemoryFile, Snapshot } from "./snapshot.ts"

const SKIP_DIRS = new Set([".git", "node_modules", "skills", ".clawhub", ".dreams"])
const SKIP_SUFFIX = [".conflict-"]
const MAX_FILE = 1024 * 1024

export function memoryRoot(cfg: NodeConfig): string {
  const root = cfg.memory.localRoot
  return root.startsWith("~") ? path.join(os.homedir(), root.slice(1)) : root
}

export function rewriteForNode(content: string, cfg: NodeConfig): string {
  const remote = `${cfg.paths.remoteRoot.replace(/\/$/, "")}/agents`
  return content.split(remote).join(memoryRoot(cfg))
}

export function rewriteForHub(content: string, cfg: NodeConfig): string {
  const remote = `${cfg.paths.remoteRoot.replace(/\/$/, "")}/agents`
  return content.split(memoryRoot(cfg)).join(remote)
}

export function isText(content: string): boolean {
  return !content.includes("\0")
}

export function sha(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name)
}

function backupFile(file: string, stamp: string) {
  if (!fs.existsSync(file)) return
  const rel = path.relative(os.homedir(), file)
  const dest = path.join(DATA_DIR, "backup", stamp, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
}

export function listLocalMemory(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) walk(path.join(dir, entry.name))
      } else if (!SKIP_SUFFIX.some((s) => entry.name.includes(s))) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  walk(root)
  return out
}

/**
 * Write hub memory locally. A locally modified file is never overwritten: it is
 * kept and pushed later (three-way: hub sha vs local hash vs last synced localSha).
 */
export function materializeMemory(snapshot: Snapshot, cfg: NodeConfig): { written: number; keptLocal: number } {
  const root = memoryRoot(cfg)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let written = 0
  let keptLocal = 0

  for (const entry of snapshot.memory ?? []) {
    const dest = path.join(root, entry.rel)
    const content = rewriteForNode(entry.content, cfg)
    let local: string | undefined
    try {
      local = fs.readFileSync(dest, "utf8")
    } catch {}
    if (local !== undefined && sha(local) !== entry.localSha) {
      keptLocal++
      continue
    }
    if (local === content) continue
    backupFile(dest, stamp)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
    written++
  }
  return { written, keptLocal }
}

export interface PushResult {
  uploaded: string[]
  conflicts: string[]
  unchanged: number
}

export async function pushMemory(hub: Hub, cfg: NodeConfig, snapshot: Snapshot): Promise<PushResult> {
  const root = memoryRoot(cfg)
  if (!snapshot.memory) snapshot.memory = []
  const known = new Map(snapshot.memory.map((m) => [m.rel, m]))
  const result: PushResult = { uploaded: [], conflicts: [], unchanged: 0 }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  for (const file of listLocalMemory(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/")
    let local: string
    try {
      local = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    if (!isText(local) || local.length > MAX_FILE) continue
    const localSha = sha(local)
    const entry = known.get(rel)
    if (entry && localSha === entry.localSha) {
      result.unchanged++
      continue
    }

    const remoteRel = `agents/${rel}`
    let remote: string | undefined
    try {
      remote = await hub.read(remoteRel)
    } catch {}

    const raw = rewriteForHub(local, cfg)
    const rawSha = sha(raw)

    const conflict =
      (entry && remote !== undefined && sha(remote) !== entry.sha) ||
      (!entry && remote !== undefined && sha(remote) !== rawSha)

    if (conflict) {
      const conflictFile = `${file}.conflict-${cfg.node.id}-${stamp}`
      fs.copyFileSync(file, conflictFile)
      result.conflicts.push(rel)
      continue
    }

    if (remote !== undefined && sha(remote) === rawSha) {
      result.unchanged++
    } else {
      await hub.write(`${cfg.paths.remoteRoot.replace(/\/$/, "")}/${remoteRel}`, raw)
      result.uploaded.push(rel)
    }

    const next: MemoryFile = {
      rel,
      agent: rel.split("/")[0] ?? "",
      content: raw,
      sha: rawSha,
      localSha,
    }
    if (entry) Object.assign(entry, next)
    else {
      snapshot.memory.push(next)
      known.set(rel, next)
    }
  }

  snapshot.hashes.memory = sha(JSON.stringify([...snapshot.memory].sort((a, b) => a.rel.localeCompare(b.rel))))
  return result
}

function readMemoryFile(root: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8")
  } catch {
    return undefined
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n\n… [truncated ${text.length - limit} chars]`
}

export function buildMemoryBlock(agent: string, directory: string, cfg: NodeConfig, snapshot: Snapshot): string | null {
  if (!cfg.memory.enabled) return null
  const files = (snapshot.memory ?? []).filter((m) => m.agent === agent)
  if (!files.length) return null
  const root = memoryRoot(cfg)
  const project = path.basename(directory || "")
  const order = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"]
  const candidates: Array<{ label: string; rel: string }> = []
  for (const name of order) {
    const rel = `${agent}/${name}`
    if (files.some((f) => f.rel === rel)) candidates.push({ label: name, rel })
  }
  if (project) {
    const projectRel = `${agent}/memory/projects/${project}.md`
    if (files.some((f) => f.rel === projectRel)) candidates.push({ label: `project:${project}`, rel: projectRel })
  }
  const today = new Date().toISOString().slice(0, 10)
  const dailyRel = `${agent}/memory/${today}.md`
  if (files.some((f) => f.rel === dailyRel)) candidates.push({ label: `memory:${today}`, rel: dailyRel })
  if (!candidates.length) return null

  let budget = cfg.memory.maxInjectBytes
  const parts: string[] = []
  for (const candidate of candidates) {
    if (budget <= 0) break
    const content = readMemoryFile(root, candidate.rel)
    if (!content) continue
    const slice = truncate(content, Math.min(budget, Math.max(1000, Math.floor(cfg.memory.maxInjectBytes / 2))))
    parts.push(`### ${candidate.label}\n${slice}`)
    budget -= slice.length
  }
  if (!parts.length) return null
  return `<opencode-node-memory agent="${agent}" source="hub">\n${parts.join("\n\n")}\n</opencode-node-memory>`
}

export interface MemoryMatch {
  path: string
  line: number
  text: string
}

export function searchMemory(cfg: NodeConfig, query: string, agent?: string, limit = 20): MemoryMatch[] {
  const root = memoryRoot(cfg)
  const needle = query.toLowerCase()
  const matches: MemoryMatch[] = []
  for (const file of listLocalMemory(agent ? path.join(root, agent) : root)) {
    let content: string
    try {
      content = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push({ path: path.relative(root, file).split(path.sep).join("/"), line: i + 1, text: lines[i].trim().slice(0, 300) })
        if (matches.length >= limit) return matches
      }
    }
  }
  return matches
}

export function pendingMemory(cfg: NodeConfig, snapshot: Snapshot): string[] {
  const root = memoryRoot(cfg)
  const known = new Map((snapshot.memory ?? []).map((m) => [m.rel, m]))
  const out: string[] = []
  for (const file of listLocalMemory(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/")
    let local: string
    try {
      local = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const entry = known.get(rel)
    if (!entry || sha(local) !== entry.localSha) out.push(rel)
  }
  return out
}

export function storeMemory(cfg: NodeConfig, text: string, agent: string, file = "MEMORY.md"): string {
  const root = memoryRoot(cfg)
  const rel = `${agent}/${file}`.replace(/\/+/g, "/")
  const dest = path.join(root, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const stamp = new Date().toISOString()
  const entry = `\n\n## ${stamp}\n${text.trim()}\n`
  fs.appendFileSync(dest, entry)
  return rel
}
