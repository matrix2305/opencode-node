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
