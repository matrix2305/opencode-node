import assert from "node:assert/strict"
import test from "node:test"

import { planModelUpdates } from "../src/models.ts"

const m = (providerID: string, id: string) => ({ providerID, id })

test("empty hub list disables nothing (failed-fetch guard)", () => {
  const plan = planModelUpdates([m("a", "1"), m("b", "2")], [])
  assert.deepEqual(plan.actions, [])
})

test("disables local-only models and tracks them", () => {
  const plan = planModelUpdates(
    [m("a", "1"), m("b", "2")],
    [{ providerID: "a", id: "1", ref: "a/1" }],
  )
  assert.deepEqual(plan.actions, [{ providerID: "b", id: "2", enabled: false }])
  assert.deepEqual(plan.disabledRefs, ["b/2"])
})

test("re-enables previously disabled models when the hub has them again", () => {
  const plan = planModelUpdates(
    [m("a", "1"), m("b", "2")].map((x) => ({ ...x, enabled: false })),
    [m("a", "1"), m("b", "2")].map((x) => ({ ...x, ref: `${x.providerID}/${x.id}` })) as any,
    ["a/1", "b/2"],
  )
  assert.equal(plan.actions.length, 2)
  assert.ok(plan.actions.every((a) => a.enabled))
  assert.deepEqual(plan.disabledRefs, [])
})

test("leaves already-disabled unknown models alone unless tracked", () => {
  const plan = planModelUpdates([{ ...m("c", "3"), enabled: false }], [m("a", "1", { ref: "a/1" }) as any])
  assert.deepEqual(plan.actions, [])
})
