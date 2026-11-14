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

export interface ModelEntry {
  providerID: string
  id: string
  name?: string
  /** full provider-scoped reference, e.g. "opencode-go/deepseek-v4.1-flash" */
  ref: string
  hidden?: boolean
  enabled?: boolean
  deprecated?: boolean
}

export interface PluginEntry {
  /** package spec or local path used for de-duplication */
  spec: string
  /** exact entry to insert into the plugins array */
  value: unknown
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
  plugins: PluginEntry[]
  models: ModelEntry[]
  pluginFiles: Array<{ file: string; content: string; sha: string }>
  pluginPackage?: { content: string; sha: string }
  /** how many provider credentials the hub has (keys are never persisted) */
  authCount?: number
  config?: { file: string; content: string; sha: string }
  extras: Array<{ file: string; content: string; sha: string }>
  hashes: {
    skills: string
    agents: string
    commands: string
    mcp: string
    memory: string
    plugins: string
    models: string
    auth?: string
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
