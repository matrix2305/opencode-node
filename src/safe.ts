import path from "node:path"

/**
 * Sanitise an id/path segment coming from a hub so it cannot escape the
 * destination directory. Rejects traversal, absolute paths and NUL; collapses
 * everything else into a safe single-or-nested relative path.
 */
export function safeRel(input: string, opts: { maxDepth?: number; allowNested?: boolean } = {}): string | null {
  if (typeof input !== "string" || !input.length || input.length > 512) return null
  if (input.includes("\0")) return null
  if (path.isAbsolute(input)) return null
  const parts: string[] = []
  for (const raw of input.split(/[/\\]+/)) {
    if (raw === "" || raw === ".") continue
    if (raw === "..") return null
    if (raw === "node_modules" || raw === ".git") return null
    parts.push(raw)
  }
  if (!parts.length) return null
  const maxDepth = opts.maxDepth ?? (opts.allowNested ? 8 : 1)
  if (parts.length > maxDepth) return null
  const joined = parts.join("/")
  // belt and braces: a normalised join must stay inside
  const normalised = path.normalize(joined)
  if (normalised === "" || normalised.startsWith("..") || path.isAbsolute(normalised)) return null
  return normalised.split(path.sep).join("/")
}

/** id for a single file/folder name (skills, agents) */
export function safeName(input: string): string | null {
  return safeRel(input, { maxDepth: 1 })
}
