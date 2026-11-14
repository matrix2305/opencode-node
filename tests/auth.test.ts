import assert from "node:assert/strict"
import test from "node:test"

import { applyAuthMemory, type AuthEntries } from "../src/auth.ts"

function auth(entries: Record<string, { type?: string; key?: string }>): AuthEntries {
  return { entries, sha: "x" }
}

test("connects hub credentials live and reports providers", async () => {
  const calls: Array<{ integrationID: string; key: string; label?: string }> = []
  const result = await applyAuthMemory(auth({ "opencode-go": { type: "api", key: "k1" } }), {
    hubName: "matrix2305",
    connect: async (input) => {
      calls.push(input)
    },
  })
  assert.deepEqual(result.connected, ["opencode-go"])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, "k1")
  assert.equal(calls[0].label, "opencode-node:matrix2305")
})

test("skips entries without keys and collects connect errors", async () => {
  const result = await applyAuthMemory(auth({ broken: {}, "opencode-go": { key: "k" } }), {
    hubName: "h",
    connect: async (input) => {
      if (input.integrationID === "opencode-go") throw new Error("boom")
    },
  })
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.connected, [])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].provider, "opencode-go")
})

test("removes previous hub-labelled credentials before connecting", async () => {
  const removed: string[] = []
  const result = await applyAuthMemory(auth({ "opencode-go": { key: "k" } }), {
    hubName: "work",
    list: async () => [
      { id: "c1", label: "opencode-node:work", integrationID: "opencode-go" },
      { id: "c2", label: "API key", integrationID: "opencode-go" },
      { id: "c3", label: "opencode-node:work", integrationID: "other" },
    ],
    remove: async (id) => {
      removed.push(id)
    },
    connect: async () => {},
  })
  assert.deepEqual(removed, ["c1"]) // c3 ima isti label ali drugi integration — ostaje
  assert.deepEqual(result.connected, ["opencode-go"])
})
