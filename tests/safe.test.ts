import assert from "node:assert/strict"
import test from "node:test"

import { safeName, safeRel } from "../src/safe.ts"

test("safeName rejects traversal and absolute paths", () => {
  assert.equal(safeName("../../evil"), null)
  assert.equal(safeName(".."), null)
  assert.equal(safeName("/etc/passwd"), null)
  assert.equal(safeName("a/b"), null)
  assert.equal(safeName(""), null)
  assert.equal(safeName("x\0y"), null)
})

test("safeName accepts plain ids", () => {
  assert.equal(safeName("genesis2"), "genesis2")
  assert.equal(safeName("pr-review"), "pr-review")
  assert.equal(safeName("muzej_jugoslavije"), "muzej_jugoslavije")
})

test("safeRel allows nested paths but blocks escape", () => {
  assert.equal(safeRel("lawyer-ai/memory/project.md", { allowNested: true }), "lawyer-ai/memory/project.md")
  assert.equal(safeRel("a/../../b", { allowNested: true }), null)
  assert.equal(safeRel("plugin/nested/two.ts", { allowNested: true, maxDepth: 6 }), "plugin/nested/two.ts")
  assert.equal(safeRel("node_modules/x", { allowNested: true }), null)
})
