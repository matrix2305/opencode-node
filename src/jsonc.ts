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
