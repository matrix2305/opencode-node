import assert from "node:assert/strict"
import test from "node:test"

import { ensurePluginSpec } from "../src/jsonc.ts"

const spec = "/Users/me/opencode-node"

test("inserts plugins when the key is missing", () => {
  const result = ensurePluginSpec(`{\n  "$schema": "x"\n}\n`, spec)
  assert.equal(result.changed, true)
  assert.match(result.text, /"plugins": \["\/Users\/me\/opencode-node"\]/)
})

test("inserts into an existing plugins array", () => {
  const result = ensurePluginSpec(`{\n  "plugins": ["other"]\n}\n`, spec)
  assert.equal(result.changed, true)
  assert.match(result.text, /"plugins": \[\n    "\/Users\/me\/opencode-node",/)
  assert.match(result.text, /"other"/)
})

test("inserts into an empty plugins array without a trailing comma", () => {
  const result = ensurePluginSpec(`{ "plugins": [] }`, spec)
  assert.equal(result.changed, true)
  assert.doesNotMatch(result.text, /,\s*\]/)
})

test("is idempotent", () => {
  const once = ensurePluginSpec("{}", spec).text
  const twice = ensurePluginSpec(once, spec)
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once)
})

test("merges plugin entries without dropping existing ones", async () => {
  const { ensurePluginEntries } = await import("../src/jsonc.ts")
  const base = `{\n  "plugins": ["local-plugin"]\n}\n`
  const result = ensurePluginEntries(base, ["hub-a", { package: "hub-b", options: { x: true } }])
  assert.equal(result.added, 2)
  assert.match(result.text, /"local-plugin"/)
  assert.match(result.text, /"hub-a"/)
  assert.match(result.text, /"package":"hub-b"/)
})

test("plugin merge is idempotent", async () => {
  const { ensurePluginEntries } = await import("../src/jsonc.ts")
  const once = ensurePluginEntries("{}", ["hub-a"]).text
  const twice = ensurePluginEntries(once, ["hub-a"])
  assert.equal(twice.added, 0)
  assert.equal(twice.text, once)
})

test("plugin merge creates the plugins array when missing", async () => {
  const { ensurePluginEntries } = await import("../src/jsonc.ts")
  const result = ensurePluginEntries(`{\n  "$schema": "x"\n}\n`, ["hub-a"])
  assert.equal(result.added, 1)
  assert.match(result.text, /"plugins": \["hub-a"\]/)
})
