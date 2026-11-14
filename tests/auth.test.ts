import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { applyAuth } from "../src/sync.ts"
import type { Snapshot } from "../src/snapshot.ts"

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocn-auth-"))
}

function snapshotWith(entries: Record<string, unknown>): Snapshot {
  return {
    version: 1,
    hub: "https://hub.example",
    fetchedAt: Date.now(),
    skills: [],
    agents: [],
    commands: [],
    mcp: {},
    memory: [],
    plugins: [],
    pluginFiles: [],
    extras: [],
    hashes: { skills: "", agents: "", commands: "", mcp: "", memory: "", plugins: "" },
    auth: { entries: entries as any, sha: "x" },
  }
}

test("merges hub credentials and keeps local-only providers", () => {
  const dir = home()
  process.env.XDG_DATA_HOME = path.join(dir, ".local", "share")
  const target = path.join(dir, ".local", "share", "opencode", "auth.json")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ deepinfra: { type: "api", key: "local-key" } }))

  const result = applyAuth(snapshotWith({ "opencode-go": { type: "api", key: "hub-key" } }))

  assert.deepEqual(result.merged, ["opencode-go"])
  const after = JSON.parse(fs.readFileSync(target, "utf8"))
  assert.equal(after["opencode-go"].key, "hub-key")
  assert.equal(after.deepinfra.key, "local-key")
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  delete process.env.XDG_DATA_HOME
})

test("is idempotent when entries already match", () => {
  const dir = home()
  process.env.XDG_DATA_HOME = path.join(dir, ".local", "share")
  const target = path.join(dir, ".local", "share", "opencode", "auth.json")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ "opencode-go": { type: "api", key: "hub-key" } }))

  const result = applyAuth(snapshotWith({ "opencode-go": { type: "api", key: "hub-key" } }))
  assert.deepEqual(result.merged, [])
  assert.equal(result.unchanged, 1)
  delete process.env.XDG_DATA_HOME
})

test("creates auth.json when missing", () => {
  const dir = home()
  process.env.XDG_DATA_HOME = path.join(dir, ".local", "share")
  const result = applyAuth(snapshotWith({ "opencode-go": { type: "api", key: "hub-key" } }))
  assert.deepEqual(result.merged, ["opencode-go"])
  const target = path.join(dir, ".local", "share", "opencode", "auth.json")
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8"))["opencode-go"].key, "hub-key")
  delete process.env.XDG_DATA_HOME
})
