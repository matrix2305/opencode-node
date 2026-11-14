import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface HubConfig {
  url: string
  passwordRef?: string
}

export interface NodeConfig {
  version: 2
  activeHub: string
  hubs: Record<string, HubConfig>
  /** active hub (kept in sync with hubs[activeHub]) */
  hub: HubConfig
  node: {
    id: string
  }
  sync: {
    skills: boolean
    agents: boolean
    commands: boolean
    mcp: boolean
    config: boolean | "manual" | "auto"
    memory: boolean
    plugins: boolean
    auth: boolean
    models: boolean
  }
  paths: {
    remoteRoot: string
    agentsRoot: string
  }
  memory: {
    enabled: boolean
    localRoot: string
    push: boolean
    /** how often pending local changes are scanned and pushed (default 10s) */
    syncIntervalSeconds: number
  }
  cacheSeconds: number
}

export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode-node")
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
export const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode-node")
export const LOG_FILE = path.join(DATA_DIR, "node.log")

export function hubSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "default"
}

export function hubDir(name: string): string {
  return path.join(DATA_DIR, "hubs", hubSlug(name))
}

export function hubDataDir(cfg: NodeConfig): string {
  return hubDir(cfg.activeHub)
}

export function snapshotFile(cfg: NodeConfig): string {
  return path.join(hubDataDir(cfg), "snapshot.json")
}

export function appliedFile(cfg: NodeConfig): string {
  return path.join(hubDataDir(cfg), "applied.json")
}

export function skillsDir(cfg: NodeConfig): string {
  return path.join(hubDataDir(cfg), "skills")
}

/** Move pre-multi-hub data into the active hub directory once. */
export function ensureHubData(cfg: NodeConfig): string {
  const dir = hubDataDir(cfg)
  fs.mkdirSync(dir, { recursive: true })
  const legacy: Array<[string, string]> = [
    [path.join(DATA_DIR, "snapshot.json"), path.join(dir, "snapshot.json")],
    [path.join(DATA_DIR, "applied.json"), path.join(dir, "applied.json")],
    [path.join(DATA_DIR, "skills"), path.join(dir, "skills")],
  ]
  for (const [from, to] of legacy) {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.renameSync(from, to)
      } catch {
        try {
          fs.cpSync(from, to, { recursive: true })
        } catch {}
      }
    }
  }
  return dir
}

function inferHubName(raw: any): string {
  if (raw?.activeHub && raw?.hubs?.[raw.activeHub]) return raw.activeHub
  const first: any = Object.values(raw?.hubs ?? {})[0]
  const url = raw?.hub?.url ?? first?.url
  if (typeof url === "string" && url) {
    try {
      return hubSlug(new URL(url).hostname.split(".")[0])
    } catch {}
  }
  return "default"
}

export function defaultConfig(hub: string, passwordRef?: string, name = "default"): NodeConfig {
  const entry: HubConfig = { url: hub.replace(/\/$/, ""), ...(passwordRef ? { passwordRef } : {}) }
  const safe = hubSlug(name)
  return {
    version: 2,
    activeHub: safe,
    hubs: { [safe]: entry },
    hub: entry,
    node: { id: os.hostname() },
    sync: { skills: true, agents: true, commands: true, mcp: true, config: true, memory: false, plugins: true, auth: true, models: true },
    paths: { remoteRoot: "/home/matrix2305", agentsRoot: "agents" },
    memory: {
      enabled: true,
      localRoot: path.join(os.homedir(), "agents"),
      push: true,
      syncIntervalSeconds: 10,
    },
    cacheSeconds: 300,
  }
}

export function normalizeConfig(raw: any): NodeConfig {
  const rawHubs = raw?.hubs && typeof raw.hubs === "object" ? raw.hubs : undefined
  const name = inferHubName(raw)
  const hubs: Record<string, HubConfig> = rawHubs
    ? Object.fromEntries(
        Object.entries(rawHubs).map(([key, value]: [string, any]) => [
          hubSlug(key),
          { url: String(value?.url ?? "").replace(/\/$/, ""), ...(value?.passwordRef ? { passwordRef: value.passwordRef } : {}) },
        ]),
      )
    : { [name]: { url: String(raw?.hub?.url ?? "").replace(/\/$/, ""), ...(raw?.hub?.passwordRef ? { passwordRef: raw.hub.passwordRef } : {}) } }

  const activeHub = raw?.activeHub && hubs[hubSlug(raw.activeHub)] ? hubSlug(raw.activeHub) : Object.keys(hubs)[0] ?? "default"
  const base = defaultConfig(hubs[activeHub]?.url ?? "", hubs[activeHub]?.passwordRef, activeHub)
  const merged: NodeConfig = {
    ...base,
    ...raw,
    version: 2,
    hubs,
    activeHub,
    hub: hubs[activeHub] ?? { url: "" },
    sync: { ...base.sync, ...raw?.sync },
    paths: { ...base.paths, ...raw?.paths },
    memory: { ...base.memory, ...raw?.memory },
  }
  const mode = merged.sync.config as unknown
  merged.sync.config = mode === "auto" || mode === "manual" ? mode : mode === false || mode === "off" ? false : "manual"
  return merged
}

export function loadConfig(): NodeConfig | null {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")))
  } catch {
    return null
  }
}

export function configMode(cfg: NodeConfig): "auto" | "manual" | "off" {
  return cfg.sync.config === "auto" ? "auto" : cfg.sync.config === "manual" ? "manual" : "off"
}

export function saveConfig(cfg: NodeConfig) {
  cfg.version = 2
  if (!cfg.hubs[cfg.activeHub]) throw new Error(`unknown hub: ${cfg.activeHub}`)
  cfg.hub = cfg.hubs[cfg.activeHub]
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
