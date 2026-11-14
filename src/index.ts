import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HUB = (process.env.OCN_HUB_URL ?? "").replace(/\/$/, "")
const PASSWORD = process.env.OCN_HUB_PASSWORD ?? ""
const STATE = path.join(os.homedir(), ".local", "share", "opencode-node")
const LOG = path.join(STATE, "spike.log")

const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])
const BUILTIN_SKILLS = new Set(["opencode", "report", "browser"])

function log(...parts: unknown[]) {
  fs.mkdirSync(STATE, { recursive: true })
  const line = `[${new Date().toISOString()}] ${parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" ")}\n`
  fs.appendFileSync(LOG, line)
}

function auth() {
  return { Authorization: "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64") }
}

function hubUrl(pathname: string, query?: Record<string, string>) {
  const url = new URL(pathname, HUB)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  return url
}

async function api(pathname: string, query?: Record<string, string>) {
  const res = await fetch(hubUrl(pathname, query), { headers: auth() })
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`)
  return res.json() as Promise<any>
}

async function readRemote(rel: string) {
  const res = await fetch(hubUrl("/api/fs/read/" + rel.split("/").map(encodeURIComponent).join("/")), { headers: auth() })
  if (!res.ok) throw new Error(`read ${rel} -> ${res.status}`)
  return res.text()
}

async function listRemote(abs: string) {
  const data = await api("/api/fs/list", { path: abs })
  return (data.data ?? []) as Array<{ path: string; type: "file" | "directory" }>
}

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
}

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export default Plugin.define({
  id: "opencode-node",
  async setup(ctx) {
    log("setup:start", { version: ctx.app.version, location: ctx.location?.directory, hub: HUB })
    if (!HUB || !PASSWORD) return log("setup:missing-config")

    try {
      const info = await api("/api/info")
      log("hub:info", { version: info.version, host: info.hostname })

      // ---------- skills: materialise then register at runtime ----------
      const skills = await api("/api/skill")
      const hubSkills = (skills.data ?? []).filter((s: any) =>
        !BUILTIN_SKILLS.has(s.id) && String(s.path ?? "").includes("/.config/opencode/skills/"))
      const registered: string[] = []
      for (const skill of hubSkills) {
        const file = path.join(STATE, "skills", skill.id, "SKILL.md")
        writeFile(file, skill.content)
        await ctx.skill.transform((editor) => {
          const entry: any = { id: skill.id, name: skill.name, path: file, content: skill.content }
          if (skill.description !== undefined) entry.description = skill.description
          if (skill.autoinvoke !== undefined) entry.autoinvoke = skill.autoinvoke
          editor.add(entry)
        })
        registered.push(skill.id)
      }
      await ctx.skill.reload()
      log("skills:registered", { count: registered.length, ids: registered })

      // ---------- agents: files + reload (AgentEditor has no add) ----------
      const agents = await api("/api/agent")
      const hubAgents = (agents.data ?? []).filter((a: any) => !BUILTIN_AGENTS.has(a.id))
      const agentDir = path.join(configDir(), "agents")
      for (const agent of hubAgents) {
        const front: string[] = ["---", `description: ${JSON.stringify(agent.description ?? agent.id)}`, `mode: ${agent.mode ?? "primary"}`]
        if (agent.model) front.push(`model: ${agent.model.providerID}/${agent.model.id}`)
        if (agent.permissions?.length) front.push(`permissions: ${JSON.stringify(agent.permissions)}`)
        front.push("---", "", agent.system ?? "", "")
        writeFile(path.join(agentDir, `${agent.id}.md`), front.join("\n"))
      }
      await ctx.agent.reload()
      log("agents:written", { count: hubAgents.length, ids: hubAgents.map((a: any) => a.id) })

      // ---------- commands: copy files + reload ----------
      const commandFiles: string[] = []
      for (const dir of ["commands", "command"]) {
        try {
          for (const entry of await listRemote(`/home/matrix2305/.config/opencode/${dir}`)) {
            if (entry.type === "file" && entry.path.endsWith(".md")) commandFiles.push(entry.path)
          }
        } catch {
          // directory does not exist on the hub
        }
      }
      for (const rel of commandFiles) {
        const content = await readRemote(rel)
        const name = rel.split("/").pop()!
        writeFile(path.join(configDir(), "commands", name), content)
      }
      if (commandFiles.length) await ctx.command.reload()
      log("commands:written", { count: commandFiles.length, files: commandFiles.map((f) => f.split("/").pop()) })

      // ---------- MCP: runtime transform ----------
      const config = await api("/api/config")
      const doc = config.find((c: any) => c.info?.mcp?.servers)
      const servers = (doc?.info?.mcp?.servers ?? {}) as Record<string, any>
      if (Object.keys(servers).length) {
        await ctx.mcp.transform((editor) => {
          for (const [name, def] of Object.entries(servers)) {
            if (def.type === "remote") {
              editor.set(name, { type: "remote", url: def.url, ...(def.headers ? { headers: def.headers } : {}) } as any)
            } else if (def.type === "local") {
              editor.set(name, { type: "local", command: def.command, ...(def.environment ? { environment: def.environment } : {}) } as any)
            }
          }
        })
        await ctx.mcp.reload()
      }
      log("mcp:registered", { names: Object.keys(servers) })
    } catch (err) {
      log("setup:error", String(err))
    }
    log("setup:end")
  },
})
