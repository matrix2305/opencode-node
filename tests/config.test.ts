import assert from "node:assert/strict"
import test from "node:test"

import { configMode, hubDataDir, normalizeConfig } from "../src/config.ts"

test("legacy boolean config mode maps to manual/off", () => {
  assert.equal(normalizeConfig({ hub: { url: "https://h" }, sync: { config: true } }).sync.config, "manual")
  assert.equal(normalizeConfig({ hub: { url: "https://h" }, sync: { config: false } }).sync.config, false)
})

test("legacy config is migrated into a named hub", () => {
  const cfg = normalizeConfig({ hub: { url: "https://matrix2305.tailbd26da.ts.net" } })
  assert.equal(cfg.version, 2)
  assert.equal(cfg.activeHub, "matrix2305")
  assert.equal(cfg.hubs.matrix2305.url, "https://matrix2305.tailbd26da.ts.net")
  assert.equal(cfg.hub, cfg.hubs.matrix2305)
})

test("multi-hub picks the active hub and isolates its data dir", () => {
  const cfg = normalizeConfig({
    activeHub: "work",
    hubs: { home: { url: "https://home.example" }, work: { url: "https://work.example" } },
  })
  assert.equal(cfg.activeHub, "work")
  assert.equal(cfg.hub.url, "https://work.example")
  const other = normalizeConfig({ ...cfg, activeHub: "home" })
  assert.notEqual(hubDataDir(cfg), hubDataDir(other))
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
