export interface SkillEntry {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  content: string
  sha: string
}

export interface AgentEntry {
  id: string
  name?: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  model?: { providerID: string; id: string; variant?: string }
  permissions?: unknown[]
  hidden?: boolean
  system?: string
  sha: string
}

export interface CommandEntry {
  file: string
  name: string
  content: string
  sha: string
}

export interface MemoryFile {
  rel: string
  agent: string
  content: string
  sha: string
  localSha: string
}

export interface Snapshot {
  version: 1
  hub: string
  fetchedAt: number
  skills: SkillEntry[]
  agents: AgentEntry[]
  commands: CommandEntry[]
  mcp: Record<string, unknown>
  memory: MemoryFile[]
  config?: { file: string; content: string; sha: string }
  extras: Array<{ file: string; content: string; sha: string }>
  hashes: {
    skills: string
    agents: string
    commands: string
    mcp: string
    memory: string
    config?: string
  }
}

export interface Applied {
  skills: string
  agents: string
  commands: string
  mcp: string
  memory?: string
  config?: string
}
