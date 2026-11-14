import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface NodeConfig {
  version: 1
  hub: {
    url: string
    passwordRef?: string
  }
  node: {
    id: string
  }
  sync: {
    skills: boolean
    agents: boolean
    commands: boolean
    mcp: boolean
    config: boolean
    memory: boolean
  }
  paths: {
    remoteRoot: string
    agentsRoot: string
  }
  memory: {
    enabled: boolean
    localRoot: string
    maxInjectBytes: number
    push: boolean
    pushIntervalSeconds: number
  }
  cacheSeconds: number
}

export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode-node")
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
export const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode-node")
export const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshot.json")
export const LOG_FILE = path.join(DATA_DIR, "node.log")

export function defaultConfig(hub: string, passwordRef?: string): NodeConfig {
  return {
    version: 1,
    hub: { url: hub.replace(/\/$/, ""), ...(passwordRef ? { passwordRef } : {}) },
    node: { id: os.hostname() },
    sync: { skills: true, agents: true, commands: true, mcp: true, config: true, memory: false },
    paths: { remoteRoot: "/home/matrix2305", agentsRoot: "agents" },
    memory: {
      enabled: true,
      localRoot: path.join(os.homedir(), "agents"),
      maxInjectBytes: 16000,
      push: true,
      pushIntervalSeconds: 300,
    },
    cacheSeconds: 300,
  }
}

export function loadConfig(): NodeConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
    const base = defaultConfig(raw.hub?.url ?? "")
    return {
      ...base,
      ...raw,
      hub: { ...base.hub, ...raw.hub },
      sync: { ...base.sync, ...raw.sync },
      paths: { ...base.paths, ...raw.paths },
      memory: { ...base.memory, ...raw.memory },
    }
  } catch {
    return null
  }
}

export function saveConfig(cfg: NodeConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = CONFIG_FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
  try {
    fs.chmodSync(CONFIG_FILE, 0o600)
  } catch {}
}

export function resolvePassword(ref?: string): string {
  const value = ref ?? process.env.OPENCODE_PASSWORD ?? ""
  if (!value) return ""
  if (value.startsWith("keychain:")) {
    const service = value.slice("keychain:".length)
    try {
      return execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return ""
    }
  }
  if (value.startsWith("secret:")) {
    const name = value.slice("secret:".length)
    try {
      return execFileSync("secret-tool", ["lookup", "service", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      return ""
    }
  }
  if (value.startsWith("env:")) return process.env[value.slice("env:".length)] ?? ""
  if (value.startsWith("file:")) {
    try {
      return fs.readFileSync(value.slice("file:".length), "utf8").trim()
    } catch {
      return ""
    }
  }
  return value
}

export function pluginSpec(): string {
  // package root (the directory that contains package.json)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
}
