/**
 * Minimal, comment-preserving insertion of a plugin path into a JSONC config.
 * It never parses/re-serialises the document, so comments and formatting stay.
 */
export function ensurePluginSpec(text: string, spec: string): { text: string; changed: boolean } {
  if (text.includes(JSON.stringify(spec)) || text.includes(spec)) return { text, changed: false }

  const arrayMatch = /"plugins"\s*:\s*\[/.exec(text)
  if (arrayMatch) {
    const at = arrayMatch.index + arrayMatch[0].length
    const rest = text.slice(at)
    const empty = rest.trimStart().startsWith("]")
    const insert = empty
      ? "\n    " + JSON.stringify(spec) + "\n  "
      : "\n    " + JSON.stringify(spec) + ","
    return { text: text.slice(0, at) + insert + rest, changed: true }
  }

  const close = text.lastIndexOf("}")
  if (close === -1) throw new Error("config has no closing brace")
  const before = text.slice(0, close).trimEnd()
  const needsComma = !before.endsWith("{") && !before.endsWith(",")
  const insert = `${needsComma ? "," : ""}\n  "plugins": [${JSON.stringify(spec)}]\n`
  return { text: text.slice(0, close) + insert + text.slice(close), changed: true }
}

/**
 * Append missing plugin entries to a JSONC document without rewriting it.
 * Entries are compared by their JSON text (or bare path for strings).
 */
export function ensurePluginEntries(text: string, values: unknown[]): { text: string; added: number } {
  let out = text
  let added = 0
  for (const value of values) {
    const json = JSON.stringify(value)
    const spec = typeof value === "string" ? value : (value as any)?.package
    if (!spec) continue
    if (out.includes(json) || (typeof value === "string" && out.includes(spec))) continue

    const arrayMatch = /"plugins"\s*:\s*\[/.exec(out)
    if (arrayMatch) {
      const open = arrayMatch.index + arrayMatch[0].length
      // find the matching closing bracket of this array
      let depth = 1
      let i = open
      let inString = false
      let escape = false
      for (; i < out.length; i++) {
        const ch = out[i]
        if (inString) {
          if (escape) escape = false
          else if (ch === "\\") escape = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') inString = true
        else if (ch === "[") depth++
        else if (ch === "]") {
          depth--
          if (depth === 0) break
        }
      }
      if (i >= out.length) throw new Error("unterminated plugins array")
      const body = out.slice(open, i)
      const trimmed = body.trim()
      if (!trimmed) {
        out = out.slice(0, open) + `\n    ${json}\n  ` + out.slice(i)
      } else {
        const lastContent = open + body.replace(/\s+$/, "").length
        const needsComma = !out.slice(open, lastContent).trimEnd().endsWith(",")
        const tail = out.slice(lastContent)
        const indent = tail.trim() ? "    " : tail || "  "
        out = out.slice(0, lastContent) + `${needsComma ? "," : ""}\n    ${json}` + tail
        void indent
      }
    } else {
      const close = out.lastIndexOf("}")
      if (close === -1) throw new Error("config has no closing brace")
      const before = out.slice(0, close).trimEnd()
      const needsComma = !before.endsWith("{") && !before.endsWith(",")
      out = out.slice(0, close) + `${needsComma ? "," : ""}\n  "plugins": [${json}]\n` + out.slice(close)
    }
    added++
  }
  return { text: out, added }
}
