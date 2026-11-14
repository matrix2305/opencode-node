#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import {
  CONFIG_DIR,
  CONFIG_FILE,
  DATA_DIR,
  defaultConfig,
  loadConfig,
  pluginSpec,
  resolvePassword,
  saveConfig,
  type NodeConfig,
} from "./config.ts"
import { Hub } from "./hub.ts"
import { pendingMemory, pushMemory } from "./memory.ts"
import { ensurePluginSpec } from "./jsonc.ts"
import { applyConfig, loadApplied, loadSnapshot, materialize, pull, saveApplied, saveSnapshot } from "./sync.ts"

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

function recordApplied(snapshot: NonNullable<ReturnType<typeof loadSnapshot>>, configChanged = false) {
  const previous = loadApplied()
  const config = configChanged ? snapshot.hashes.config : previous?.config
  saveApplied({
    skills: snapshot.hashes.skills,
    agents: snapshot.hashes.agents,
    commands: snapshot.hashes.commands,
    mcp: snapshot.hashes.mcp,
    ...(config ? { config } : {}),
  })
}

function printSummary(snapshot: ReturnType<typeof loadSnapshot>) {
  if (!snapshot) return info("no snapshot (run: oc-node pull)")
  info(`hub:      ${snapshot.hub}`)
  info(`pulled:   ${new Date(snapshot.fetchedAt).toISOString()}`)
  info(`skills:   ${snapshot.skills.length}`)
  info(`agents:   ${snapshot.agents.length}`)
  info(`commands: ${snapshot.commands.length}`)
  info(`mcp:      ${Object.keys(snapshot.mcp).join(", ") || "-"}`)
  info(`memory:   ${snapshot.memory?.length ?? 0} files`)
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

  const cfg = defaultConfig(hubUrl, passwordRef)
  saveConfig(cfg)
  const hub = ensureConfig(cfg)

  const installed = installPluginEntry(pluginSpec())
  info(`config:   ${CONFIG_FILE}`)
  info(`plugin:   ${pluginSpec()} ${installed ? "(added to local config)" : "(already present)"}`)

  return hub.info().then((hubInfo) => {
    info(`hub:      ${hubInfo.hostname ?? "?"} · OpenCode ${hubInfo.version}`)
    return pull(hub, cfg).then((snapshot) => {
      saveSnapshot(snapshot)
      materialize(snapshot, cfg)
      let configChanged = false
      if (flag("--config")) {
        info("warning:  local opencode.jsonc will be replaced by the hub config (backup kept)")
        const result = applyConfig(snapshot, pluginSpec())
        configChanged = result.changed
        if (result.changed) info("config:   hub opencode.jsonc written (backup kept)")
      }
      recordApplied(snapshot, configChanged)
      printSummary(snapshot)
      if (flag("--restart")) restartService()
      else info("next:     restart OpenCode so the plugin and config load (oc-node restart)")
    })
  })
}

function cmdPull() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised (run: oc-node init --hub <url> --password-ref ...)")
  const hub = ensureConfig(cfg)
  return pull(hub, cfg).then((snapshot) => {
    saveSnapshot(snapshot)
    const result = materialize(snapshot, cfg)
    let configChanged = false
    if (flag("--config")) {
      const written = applyConfig(snapshot, pluginSpec())
      configChanged = written.changed
      if (written.changed) info("config:   hub opencode.jsonc written")
      else info("config:   already up to date")
    }
    recordApplied(snapshot, configChanged)
    printSummary(snapshot)
    info(`files:    ${result.skillFiles} skills, ${result.agentFiles} agents, ${result.commandFiles} commands`)
    if (configChanged) info("next:     restart OpenCode to apply config/providers (oc-node restart)")
    if (result.changed) info("next:     run `oc-node restart` (or `opencode reload`) to apply agents/commands")
  })
}

function cmdPush() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const snapshot = loadSnapshot()
  if (!snapshot) fail("no snapshot (run: oc-node pull)")
  const hub = ensureConfig(cfg)
  return pushMemory(hub, cfg, snapshot).then((result) => {
    saveSnapshot(snapshot)
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
  info(`hub:      ${cfg.hub.url}`)
  info(`password: ${cfg.hub.passwordRef ?? "unset"}`)
  info(`plugin:   ${pluginEntryPresent(pluginSpec()) ? "installed" : "missing in local config"}`)
  const snapshot = loadSnapshot()
  if (!snapshot) {
    info("snapshot: none")
    return
  }
  info(`cached:   ${new Date(snapshot.fetchedAt).toISOString()} (${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s ago)`)
  printSummary(snapshot)
  const pending = pendingMemory(cfg, snapshot)
  info(`pending:  ${pending.length ? pending.join(", ") : "-"}`)
  const applied = loadApplied()
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
  const hub = new Hub(cfg.hub.url, password, cfg.paths.remoteRoot)
  return hub
    .info()
    .then(async (hubInfo) => {
      checks.push(["hub", `${hubInfo.hostname ?? "?"} · ${hubInfo.version}`])
      const skills = await hub.json("/api/skill")
      const agents = await hub.json("/api/agent")
      checks.push(["skills endpoint", `${skills.data?.length ?? 0}`])
      checks.push(["agents endpoint", `${agents.data?.length ?? 0}`])
      const snapshot = loadSnapshot()
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

function cmdRestart() {
  restartService()
}

function cmdConfig() {
  const cfg = loadConfig()
  if (!cfg) fail("not initialised")
  const snapshot = loadSnapshot()
  if (!snapshot) fail("no snapshot (run: oc-node pull)")
  const result = applyConfig(snapshot, pluginSpec())
  if (result.changed) {
    const applied = loadApplied() ?? { skills: "", agents: "", commands: "", mcp: "" }
    saveApplied({ ...applied, config: snapshot.hashes.config })
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
    case "restore":
      return cmdRestore()
    case "restart":
      return cmdRestart()
    default:
      info("usage: oc-node <init|pull|push|status|doctor|config|restore|restart>")
      info("  init --hub <url> --password-ref keychain:<service> [--config] [--restart]")
      info("  pull [--config] | push")
      info("  status | doctor | config | restore [--from <stamp>] | restart")
      process.exit(command ? 1 : 0)
  }
}

void main()
