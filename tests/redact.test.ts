import assert from "node:assert/strict"
import test from "node:test"

import { redactSecrets } from "../src/sync.ts"

test("redacts inline API keys from config text", () => {
  const input = `{
  "provider": {
    "zai-coding-plan": {
      "options": { "apiKey": "sk-real-secret-value" },
      "headers": { "Authorization": "Bearer tok" }
    }
  }
}`
  const out = redactSecrets(input)
  assert.ok(!out.includes("sk-real-secret-value"))
  assert.ok(out.includes('"{redacted}"'))
})

test("leaves non-secret fields intact", () => {
  const out = redactSecrets(`{ "model": "opencode-go/x", "apiKey": "abc" }`)
  assert.ok(out.includes('"opencode-go/x"'))
  assert.ok(!out.includes('"abc"'))
})
