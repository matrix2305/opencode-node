import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Hub } from "./hub.ts"

export interface AuthEntries {
  entries: Record<string, { type?: string; key?: string }>
  sha: string
}

/** Read the hub's saved provider credentials. Never logged. */
export async function fetchAuth(hub: Hub): Promise<AuthEntries | null> {
  let raw: string
  try {
    raw = await hub.read(".local/share/opencode/auth.json")
  } catch {
    return null
  }
  if (!raw || raw.length > 256 * 1024) return null
  try {
    const entries = JSON.parse(raw)
    if (!entries || typeof entries !== "object") return null
    return { entries, sha: Buffer.from(raw).length + ":" + raw.length }
  } catch {
    return null
  }
}

export interface ConnectResult {
  connected: string[]
  removed: string[]
  skipped: number
  errors: Array<{ provider: string; error: string }>
}

export type ConnectKey = (input: { integrationID: string; key: string; label?: string }) => Promise<unknown>
export type RemoveCredential = (credentialID: string) => Promise<unknown>
export type ListCredentials = () => Promise<Array<{ id: string; label?: string; integrationID?: string }>>

/**
 * Push hub credentials straight into the local OpenCode server (memory),
 * replacing same-provider credentials labelled as hub-managed. Keys are never
 * written to disk by this module.
 */
export async function applyAuthMemory(
  auth: AuthEntries,
  opts: { hubName: string; connect: ConnectKey; remove?: RemoveCredential; list?: ListCredentials },
): Promise<ConnectResult> {
  const result: ConnectResult = { connected: [], removed: [], skipped: 0, errors: [] }
  const label = `opencode-node:${opts.hubName}`

  for (const [provider, entry] of Object.entries(auth.entries)) {
    if (!entry?.key) {
      result.skipped++
      continue
    }
    try {
      // drop previous hub-managed credentials for this provider so they do not stack
      if (opts.list && opts.remove) {
        try {
          for (const cred of await opts.list()) {
            if (cred.label === label && (cred as any).integrationID === provider) {
              await opts.remove(cred.id)
              result.removed.push(cred.id)
            }
          }
        } catch {
          // listing is best-effort
        }
      }
      await opts.connect({ integrationID: provider, key: entry.key, label })
      result.connected.push(provider)
    } catch (err) {
      result.errors.push({ provider, error: String(err) })
    }
  }
  return result
}

export interface LocalService {
  url: string
  password: string
}

export function localService(): LocalService | null {
  if (process.env.OPENCODE_PASSWORD && process.env.OPENCODE_LOCAL_URL) {
    return { url: process.env.OPENCODE_LOCAL_URL, password: process.env.OPENCODE_PASSWORD }
  }
  try {
    const file = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "opencode", "service.json")
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    const url = typeof data.url === "string" ? data.url.replace(/\/$/, "") : "http://127.0.0.1:49374"
    const password = typeof data.password === "string" ? data.password : process.env.OPENCODE_PASSWORD
    return password ? { url, password } : null
  } catch {
    return null
  }
}

/** CLI variant: apply credentials through the local server's HTTP API. */
export async function applyAuthViaLocalServer(auth: AuthEntries, hubName: string): Promise<ConnectResult> {
  const service = localService()
  if (!service) throw new Error("local OpenCode server not found (is the service running?)")
  const { url: base, password } = service
  const authHeader = { Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }

  const list: ListCredentials = async () => {
    const res = await fetch(`${base}/api/credential`, { headers: authHeader })
    if (!res.ok) throw new Error(`credential list -> ${res.status}`)
    const data = await res.json()
    return (data.data ?? data).map((c: any) => ({ id: c.id, label: c.label, integrationID: c.integrationID }))
  }
  const remove: RemoveCredential = async (id) => {
    const res = await fetch(`${base}/api/credential/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeader })
    if (!res.ok) throw new Error(`credential delete -> ${res.status}`)
  }
  const connect: ConnectKey = async ({ integrationID, key, label }) => {
    const res = await fetch(`${base}/api/integration/${encodeURIComponent(integrationID)}/connect/key`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ key, label }),
    })
    if (!res.ok) throw new Error(`connect ${integrationID} -> ${res.status} ${(await res.text()).slice(0, 120)}`)
  }

  return applyAuthMemory(auth, { hubName, connect, remove, list })
}
