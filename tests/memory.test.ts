import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { NodeConfig } from "../src/config.ts"
import { materializeMemory, pendingMemory, rewriteForHub, rewriteForNode, sha } from "../src/memory.ts"
import type { Snapshot } from "../src/snapshot.ts"

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function config(localRoot: string): NodeConfig {
  return {
    version: 2,
    activeHub: "test",
    hubs: { test: { url: "https://hub.example" } },
    hub: { url: "https://hub.example" },
    node: { id: "testnode" },
    sync: { skills: true, agents: true, commands: true, mcp: true, config: false, memory: true },
    paths: { remoteRoot: "/home/hub", agentsRoot: "agents" },
    memory: { enabled: true, localRoot, push: false, syncIntervalSeconds: 10 },
    cacheSeconds: 0,
  }
}

function snapshot(entries: Snapshot["memory"]): Snapshot {
  return {
    version: 1,
    hub: "https://hub.example",
    fetchedAt: Date.now(),
    skills: [],
    agents: [],
    commands: [],
    mcp: {},
    memory: entries,
    extras: [],
    hashes: { skills: "", agents: "", commands: "", mcp: "", memory: "" },
  }
}

test("rewrites hub paths to the node and back", () => {
  const cfg = config("/tmp/node-agents")
  const raw = "workspace: /home/hub/agents/genesis2\n"
  const local = rewriteForNode(raw, cfg)
  assert.match(local, /\/tmp\/node-agents\/genesis2/)
  assert.equal(rewriteForHub(local, cfg), raw)
})

test("materialize keeps a locally edited file", () => {
  const root = tmp("ocn-mem-")
  const cfg = config(root)
  const raw = "hub memory\n"
  const local = rewriteForNode(raw, cfg)
  fs.mkdirSync(path.join(root, "a"), { recursive: true })
  fs.writeFileSync(path.join(root, "a", "MEMORY.md"), "local edit\n")
  const snap = snapshot([
    { rel: "a/MEMORY.md", agent: "a", content: raw, sha: sha(raw), localSha: sha(local) },
  ])
  const result = materializeMemory(snap, cfg)
  assert.equal(result.keptLocal, 1)
  assert.equal(fs.readFileSync(path.join(root, "a", "MEMORY.md"), "utf8"), "local edit\n")
})

test("materialize writes unchanged and new files", () => {
  const root = tmp("ocn-mem-")
  const cfg = config(root)
  const raw = "hub memory\n"
  const snap = snapshot([
    { rel: "a/MEMORY.md", agent: "a", content: raw, sha: sha(raw), localSha: sha(rewriteForNode(raw, cfg)) },
  ])
  const result = materializeMemory(snap, cfg)
  assert.equal(result.written, 1)
  assert.equal(fs.readFileSync(path.join(root, "a", "MEMORY.md"), "utf8"), raw)
})

test("detects pending local memory changes", () => {
  const root = tmp("ocn-mem-")
  const cfg = config(root)
  const raw = "hub memory\n"
  const local = rewriteForNode(raw, cfg)
  fs.mkdirSync(path.join(root, "a"), { recursive: true })
  fs.writeFileSync(path.join(root, "a", "MEMORY.md"), "local edit\n")
  const snap = snapshot([
    { rel: "a/MEMORY.md", agent: "a", content: raw, sha: sha(raw), localSha: sha(local) },
  ])
  assert.deepEqual(pendingMemory(cfg, snap), ["a/MEMORY.md"])
})
