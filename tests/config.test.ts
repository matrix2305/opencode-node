import assert from "node:assert/strict"
import test from "node:test"

import { configMode, normalizeConfig } from "../src/config.ts"

test("legacy boolean config mode maps to manual/off", () => {
  assert.equal(normalizeConfig({ hub: { url: "https://h" }, sync: { config: true } }).sync.config, "manual")
  assert.equal(normalizeConfig({ hub: { url: "https://h" }, sync: { config: false } }).sync.config, false)
})

test("auto and manual are preserved", () => {
  const auto = normalizeConfig({ hub: { url: "https://h" }, sync: { config: "auto" } })
  assert.equal(configMode(auto), "auto")
  const manual = normalizeConfig({ hub: { url: "https://h" }, sync: { config: "manual" } })
  assert.equal(configMode(manual), "manual")
  const off = normalizeConfig({ hub: { url: "https://h" }, sync: { config: "off" } })
  assert.equal(off.sync.config, false)
  assert.equal(configMode(off), "off")
})
