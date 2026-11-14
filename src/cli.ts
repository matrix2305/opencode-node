#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import {
  CONFIG_DIR,
  CONFIG_FILE,
  DATA_DIR,
  configMode,
  defaultConfig,
  hubDir,
  loadConfig,
  pluginSpec,
  resolvePassword,
  saveConfig,
  type NodeConfig,
} from "./config.ts"
import { Hub } from "./hub.ts"
import { pendingMemory, pushMemory } from "./memory.ts"
import { ensurePluginSpec } from "./jsonc.ts"
import { applyAuthViaLocalServer, fetchAuth } from "./auth.ts"
import { applyConfig, applyPlugins, loadApplied, loadSnapshot, materialize, pull, saveApplied, saveSnapshot } from "./sync.ts"
import type { Snapshot } from "./snapshot.ts"

function localConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function fail(message: string): never {
  console.error(`oc-node: ${message}`)
  process.exit(1)
}

function info(message: string) {
  console.log(message)
}

function ensureConfig(cfg: NodeConfig): Hub {
  const password = resolvePassword(cfg.hub.passwordRef)
  if (!password) fail(`no password for ${cfg.hub.url} (passwordRef: ${cfg.hub.passwordRef ?? "unset"})`)
  return new Hub(cfg.hub.url, password, cfg.paths.remoteRoot)
}

function backup(file: string) {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join(DATA_DIR, "backup", stamp, path.relative(os.homedir(), file))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
}

function installPluginEntry(spec: string): boolean {
  const dir = localConfigDir()
  fs.mkdirSync(dir, { recursive: true })
  let target = path.join(dir, "opencode.jsonc")
  if (!fs.existsSync(target)) {
    const json = path.join(dir, "opencode.json")
    if (fs.existsSync(json)) target = json
    else {
      fs.writeFileSync(target, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`, { mode: 0o600 })
    }
  }
  const text = fs.readFileSync(target, "utf8")
  const result = ensurePluginSpec(text, spec)
  if (!result.changed) return false
  backup(target)
  fs.writeFileSync(target, result.text)
  fs.chmodSync(target, 0o600)
  return true
}

function pluginEntryPresent(spec: string): boolean {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      if (fs.readFileSync(path.join(localConfigDir(), name), "utf8").includes(spec)) return true
    } catch {}
  }
  return false
}

function restartService() {
  const result = spawnSync("opencode", ["service", "restart"], { stdio: "inherit" })
  if (result.error) console.error("oc-node: could not run `opencode service restart`:", result.error.message)
}

function recordApplied(snapshot: Snapshot, cfg: NodeConfig, configChanged = false) {
  const previous = loadApplied(cfg)
  const config = configChanged ? snapshot.hashes.config : previous?.config
  saveApplied(cfg, {
    skills: snapshot.hashes.skills,
    agents: snapshot.hashes.agents,
    commands: snapshot.hashes.commands,
    mcp: snapshot.hashes.mcp,
    ...(config ? { config } : {}),
  })
}

function printSummary(snapshot: Snapshot | null) {
  if (!snapshot) return info("no snapshot (run: oc-node pull)")
  info(`hub:      ${snapshot.hub}`)
  info(`pulled:   ${new Date(snapshot.fetchedAt).toISOString()}`)
  info(`skills:   ${snapshot.skills.length}`)
  info(`agents:   ${snapshot.agents.length}`)
  info(`commands: ${snapshot.commands.length}`)
  info(`mcp:      ${Object.keys(snapshot.mcp).join(", ") || "-"}`)
  info(`memory:   ${snapshot.memory?.length ?? 0} files`)
  info(`plugins:  ${snapshot.plugins?.length ?? 0} entries, ${snapshot.pluginFiles?.length ?? 0} local file(s)`)
  info(`auth:     ${snapshot.authCount ?? 0} provider credential(s) on the hub (applied to the local server, not stored in files)`)
  info(`config:   ${snapshot.config ? snapshot.config.file : "-"}`)
}

function cmdInit() {
  const hubUrl = arg("--hub")
  if (!hubUrl) fail("usage: oc-node init --hub <url> [--password-ref keychain:name | --password <secret>] [--config] [--restart]")
  const passwordRefArg = arg("--password-ref")
  const passwordArg = arg("--password")
  let passwordRef = passwordRefArg
  if (!passwordRef && passwordArg) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    const file = path.join(CONFIG_DIR, "password")
    fs.writeFileSync(file, passwordArg + "\n", { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    passwordRef = "file:" + file
  }
  if (!passwordRef) fail("pass --password-ref (e.g. keychain:opencode-matrix2305) or --password")

  let hubName = arg("--hub-name")
  if (!hubName) {
    try {
      hubName = new URL(hubUrl).hostname.split(".")[0] || "default"
    } catch {
      hubName = "default"
    }
  }
  const cfg = defaultConfig(hubUrl, passwordRef, hubName)
  saveConfig(cfg)
  const hub = ensureConfig(cfg)

  const installed = installPluginEntry(pluginSpec())
  info(`config:   ${CONFIG_FILE}`)
  info(`plugin:   ${pluginSpec()} ${installed ? "(added to local config)" : "(already present)"}`)

  return hub.info().then(async (hubInfo) => {
    info(`hub:      ${hubInfo.hostname ?? "?"} · OpenCode ${hubInfo.version}`)
    const snapshot = await pull(hub, cfg)
    {
      saveSnapshot(cfg, snapshot)
      materialize(snapshot, cfg)
      let plugins
      if (cfg.sync.plugins) {
        plugins = applyPlugins(snapshot, pluginSpec())
        if (plugins.configChanged) info("plugins:  hub plugin list merged into local config")
        if (plugins.filesWritten) info(`plugins:  ${plugins.filesWritten} local plugin file(s) written`)
      }
      if (cfg.sync.auth) {
        const hubClient = new Hub(cfg.hub.url, resolvePassword(cfg.hub.passwordRef), cfg.paths.remoteRoot)
        const auth = await fetchAuth(hubClient)
        if (auth) {
          const result = await applyAuthViaLocalServer(auth, cfg.activeHub)
          if (result.connected.length) info(`auth:     ${result.connected.length} credential(s) connected live (${result.connected.join(", ")})`)
          for (const e of result.errors) info(`auth:     ${e.provider}: ${e.error}`)
        } else info("auth:     none on the hub")
      }
      let configChanged = false
      if (flag("--config")) {
        info("warning:  local opencode.jsonc will be replaced by the hub config (backup kept)")
        const result = applyConfig(snapshot, cfg, pluginSpec())
        configChanged = result.changed
        if (result.changed) info("config:   hub opencode.jsonc written (backup kept)")
      }
      recordApplied(snapshot, cfg, configChanged)
      printSummary(snapshot)
      if (flag("--restart")) restartService()
      else info("next:     restart OpenCode so the plugin and config load (oc-node restart)")
    }
  })
}

function cmdPull() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised (run: oc-node init --hub <url> --password-ref ...)")
  const hub = ensureConfig(cfg)
  return pull(hub, cfg).then(async (snapshot) => {
    saveSnapshot(cfg, snapshot)
    const result = materialize(snapshot, cfg)
    let pluginResult
    if (cfg.sync.plugins) {
      pluginResult = applyPlugins(snapshot, pluginSpec())
    }
    let authLine = ""
    if (cfg.sync.auth) {
      const hub = ensureConfig(cfg)
      const auth = await fetchAuth(hub)
      if (auth) {
        const result = await applyAuthViaLocalServer(auth, cfg.activeHub)
        authLine = result.connected.length ? `${result.connected.length} connected (${result.connected.join(", ")})` : result.errors.length ? `errors: ${result.errors.map((e) => e.provider).join(",")}` : "already up to date"
      } else authLine = "none on the hub"
    }
    let configChanged = false
    if (flag("--config")) {
      const written = applyConfig(snapshot, cfg, pluginSpec())
      configChanged = written.changed
      if (written.changed) info("config:   hub opencode.jsonc written")
      else info("config:   already up to date")
    }
    recordApplied(snapshot, cfg, configChanged)
    printSummary(snapshot)
    info(`files:    ${result.skillFiles} skills, ${result.agentFiles} agents, ${result.commandFiles} commands`)
    if (pluginResult) {
      info(`plugins:  ${pluginResult.pluginCount} from hub, ${pluginResult.filesWritten} file(s) written${pluginResult.configChanged ? ", config updated" : ""}`)
      if (pluginResult.configChanged || pluginResult.filesWritten) info("next:     restart OpenCode to install/load the synced plugins")
    }
    if (authLine) info(`auth:     ${authLine}`)
    if (configChanged) info("next:     restart OpenCode to apply config/providers (oc-node restart)")
    if (result.changed) info("next:     run `oc-node restart` (or `opencode reload`) to apply agents/commands")
  })
}

function cmdPush() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const snapshot = loadSnapshot(cfg)
  if (!snapshot) fail("no snapshot (run: oc-node pull)")
  const hub = ensureConfig(cfg)
  return pushMemory(hub, cfg, snapshot).then((result) => {
    saveSnapshot(cfg, snapshot)
    info(`uploaded: ${result.uploaded.join(", ") || "-"}`)
    info(`conflicts: ${result.conflicts.join(", ") || "-"}`)
    info(`unchanged: ${result.unchanged}`)
    if (result.conflicts.length) info("conflict copies were written next to the local files")
  })
}

function cmdStatus() {
  const cfg = loadConfig()
  if (!cfg) {
    info("oc-node: not initialised")
    return
  }
  info(`config:   ${CONFIG_FILE}`)
  info(`hub:      ${cfg.activeHub} · ${cfg.hub.url}`)
  info(`hubs:     ${Object.keys(cfg.hubs).join(", ")}`)
  info(`password: ${cfg.hub.passwordRef ?? "unset"}`)
  info(`config:   mode=${configMode(cfg)} (oc-node config --mode auto|manual|off)`)
  info(`plugin:   ${pluginEntryPresent(pluginSpec()) ? "installed" : "missing in local config"}`)
  const snapshot = loadSnapshot(cfg)
  if (!snapshot) {
    info("snapshot: none")
    return
  }
  info(`cached:   ${new Date(snapshot.fetchedAt).toISOString()} (${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s ago)`)
  printSummary(snapshot)
  const pending = pendingMemory(cfg, snapshot)
  info(`pending:  ${pending.length ? pending.join(", ") : "-"}`)
  const applied = loadApplied(cfg)
  if (applied) {
    info(`applied:  skills=${applied.skills === snapshot.hashes.skills} agents=${applied.agents === snapshot.hashes.agents} commands=${applied.commands === snapshot.hashes.commands} mcp=${applied.mcp === snapshot.hashes.mcp}`)
    if (snapshot.hashes.config) info(`config:   ${applied.config === snapshot.hashes.config ? "in sync" : "drift (oc-node pull --config)"}`)
  }
}

function cmdDoctor() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const checks: Array<[string, string]> = []
  const password = resolvePassword(cfg.hub.passwordRef)
  checks.push(["config file", fs.existsSync(CONFIG_FILE) ? "ok" : "missing"])
  checks.push(["password", password ? `ok (${password.length} chars)` : "missing"])
  checks.push(["plugin entry", pluginEntryPresent(pluginSpec()) ? "ok" : "missing"])
  checks.push(["cache dir", fs.existsSync(DATA_DIR) ? "ok" : "will be created"])
  checks.push(["config mode", configMode(cfg)])
  const hub = new Hub(cfg.hub.url, password, cfg.paths.remoteRoot)
  return hub
    .info()
    .then(async (hubInfo) => {
      checks.push(["hub", `${hubInfo.hostname ?? "?"} · ${hubInfo.version}`])
      const skills = await hub.json("/api/skill")
      const agents = await hub.json("/api/agent")
      checks.push(["skills endpoint", `${skills.data?.length ?? 0}`])
      checks.push(["agents endpoint", `${agents.data?.length ?? 0}`])
      const snapshot = loadSnapshot(cfg)
      if (snapshot) checks.push(["snapshot", `${snapshot.skills.length} skills / ${snapshot.agents.length} agents`])
      for (const [name, value] of checks) info(`${name.padEnd(16)} ${value}`)
      if (password && cfg.hub.url) info("result           ok")
    })
    .catch((err) => {
      for (const [name, value] of checks) info(`${name.padEnd(16)} ${value}`)
      info(`result           FAIL: ${String(err)}`)
      process.exitCode = 1
    })
}

function cmdRestore() {
  const base = path.join(DATA_DIR, "backup")
  if (!fs.existsSync(base)) fail("no backups yet")
  const stamps = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort()
  if (!stamps.length) fail("no backups yet")
  const stamp = arg("--from") ?? stamps[stamps.length - 1]
  const root = path.join(base, stamp)
  if (!fs.existsSync(root)) fail(`backup not found: ${stamp}`)
  let restored = 0
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(src)
      else {
        const rel = path.relative(root, src)
        const dest = path.join(os.homedir(), rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
        restored++
      }
    }
  }
  walk(root)
  info(`restored ${restored} files from ${stamp}`)
  info("next: oc-node restart")
}

function cmdHub() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const sub = process.argv[3]
  const positional = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : undefined
  const name = arg("--name") ?? positional

  if (!sub || sub === "list") {
    for (const [key, value] of Object.entries(cfg.hubs)) {
      info(`${key === cfg.activeHub ? "*" : " "} ${key.padEnd(18)} ${value.url}`)
    }
    return
  }

  if (sub === "add") {
    if (!name) fail("usage: oc-node hub add <name> --url <url> --password-ref <ref> [--use]")
    const url = arg("--url")
    const ref = arg("--password-ref")
    if (!url || !ref) fail("hub add requires --url and --password-ref")
    if (cfg.hubs[name]) fail(`hub already exists: ${name}`)
    cfg.hubs[name] = { url: url.replace(/\/$/, ""), passwordRef: ref }
    if (flag("--use") || Object.keys(cfg.hubs).length === 1) cfg.activeHub = name
    saveConfig(cfg)
    info(`added hub ${name}: ${cfg.hubs[name].url}${cfg.activeHub === name ? " (active)" : ""}`)
    return
  }

  if (sub === "use") {
    if (!name || !cfg.hubs[name]) fail(`unknown hub: ${name ?? ""}`)
    cfg.activeHub = name
    saveConfig(cfg)
    info(`active hub: ${name} · ${cfg.hub.url}`)
    if (flag("--pull")) return cmdPull()
    info("next: oc-node pull (or oc-node restart) to load its setup")
    return
  }

  if (sub === "remove") {
    if (!name || !cfg.hubs[name]) fail(`unknown hub: ${name ?? ""}`)
    if (cfg.activeHub === name) fail("cannot remove the active hub; switch to another first")
    delete cfg.hubs[name]
    saveConfig(cfg)
    if (flag("--purge")) {
      fs.rmSync(hubDir(name), { recursive: true, force: true })
      info(`purged ${hubDir(name)}`)
    }
    info(`removed hub ${name}`)
    return
  }

  fail("usage: oc-node hub <list|add|use|remove>")
}

function cmdRestart() {
  restartService()
}

function cmdConfig() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const mode = arg("--mode")
  if (mode) {
    if (!["auto", "manual", "off"].includes(mode)) fail("--mode must be auto, manual or off")
    cfg.sync.config = mode === "off" ? false : (mode as "auto" | "manual")
    saveConfig(cfg)
    info(`config mode: ${mode}`)
    if (mode !== "auto") return
  }
  const snapshot = loadSnapshot(cfg)
  if (!snapshot) fail("no snapshot (run: oc-node pull)")
  if (flag("--dry-run")) {
    info(`would write: ${path.join(localConfigDir(), "opencode.jsonc")}`)
    info(`hub sha: ${snapshot.hashes.config ?? "-"}`)
    return
  }
  if (mode === "auto" && flag("--no-apply")) return
  const result = applyConfig(snapshot, cfg, pluginSpec())
  if (result.changed) {
    const applied = loadApplied(cfg) ?? { skills: "", agents: "", commands: "", mcp: "" }
    saveApplied(cfg, { ...applied, config: snapshot.hashes.config })
    info(`wrote: ${result.wrote.join(", ") || "-"}`)
    if (result.removed.length) info(`removed: ${result.removed.join(", ")}`)
    info("next: restart OpenCode (oc-node restart)")
  } else info("config already up to date")
}

function main() {
  const command = process.argv[2]
  switch (command) {
    case "init":
      return cmdInit()
    case "pull":
      return cmdPull()
    case "push":
      return cmdPush()
    case "status":
      return cmdStatus()
    case "doctor":
      return cmdDoctor()
    case "config":
      return cmdConfig()
    case "hub":
      return cmdHub()
    case "restore":
      return cmdRestore()
    case "restart":
      return cmdRestart()
    default:
      info("usage: oc-node <init|pull|push|status|doctor|config|hub|restore|restart>")
      info("  init --hub <url> --password-ref keychain:<service> [--hub-name <name>] [--config] [--restart]")
      info("  pull [--config] | push")
      info("  hub list | hub add <name> --url <url> --password-ref <ref> [--use] | hub use <name> [--pull] | hub remove <name> [--purge]")
      info("  status | doctor | config [--mode auto|manual|off] [--dry-run] | restore [--from <stamp>] | restart")
      process.exit(command ? 1 : 0)
  }
}

void main()
