import assert from "node:assert/strict"
import test from "node:test"

import { NodeRpc } from "../src/rpc.ts"

test("RPC exposes the node methods and update event", () => {
  const rpc = NodeRpc as any
  assert.equal(rpc.id, "matrix2305.opencode-node")
  assert.deepEqual(Object.keys(rpc.methods).sort(), ["push", "status", "sync"])
  assert.ok(rpc.events?.updated)
})
