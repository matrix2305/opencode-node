# opencode-node

A node plugin for OpenCode V2: a local OpenCode server connects to a remote
OpenCode server ("hub") and loads its agents, skills, commands, MCP servers and
eventually memory from there.

Status: **M2** — config, CLI, cache-first startup, full setup pull and file-based
memory (pull, injection, tools, conflict-safe push).

## How it works

```
hub (OpenCode 2.x, /home/matrix2305)
  ├─ /api/agent, /api/skill, /api/command, /api/config
  ├─ /api/fs/list, /api/fs/read
  └─ ~/.config/opencode, ~/agents

node (this machine)
  ├─ ~/.config/opencode-node/config.json     hub URL + passwordRef
  ├─ ~/.local/share/opencode-node/
  │    ├─ snapshot.json                      cached setup + hashes
  │    ├─ skills/<id>/SKILL.md               materialised skills
  │    └─ backup/<timestamp>/...             backups before overwrite
  ├─ ~/.config/opencode/agents/*.md          written from the hub
  ├─ ~/.config/opencode/commands/*.md        written from the hub
  └─ opencode.jsonc                          hub config + node plugin entry
```

On every OpenCode start the plugin applies the cached snapshot immediately
(skills are registered at runtime, agents/commands are files), then refreshes in
the background if the cache is older than `cacheSeconds`.

## Install

```bash
node src/cli.ts init \
  --hub https://matrix2305.tailbd26da.ts.net \
  --password-ref keychain:opencode-matrix2305 \
  --config \
  --restart
```

- `--password-ref` accepts `keychain:<service>`, `secret:<name>`, `file:<path>`,
  `env:<VAR>` or a raw password (not recommended).
- `--config` replaces `~/.config/opencode/opencode.jsonc` with the hub config
  (mode 0600, backup kept) and removes the legacy `opencode.json` so only one
  document is active. The node plugin entry is preserved.
- `--restart` runs `opencode service restart`.
- Without `--config`, only agents/skills/commands/MCP are synced; local
  providers/models stay untouched.

## CLI

```bash
oc-node status           # hub, cache age, counts, applied state, config drift
oc-node doctor           # config, password, plugin entry, hub reachability
oc-node pull             # refresh snapshot + materialise files
oc-node push             # push locally changed memory back (conflict-safe)
oc-node pull --config    # also replace local opencode.jsonc with the hub config
oc-node config           # apply the config from the current snapshot
oc-node restart          # opencode service restart
```

`oc-node` is `src/cli.ts` (Node 23+ runs TypeScript directly). Use
`node src/cli.ts <command>` from the repo, or install the bin after packaging.

## What is synced

| Category | Mechanism |
| --- | --- |
| Skills | `ctx.skill.transform` at runtime; `SKILL.md` materialised under the data dir |
| Agents | `~/.config/opencode/agents/<id>.md` + `ctx.agent.reload()` |
| Commands | `~/.config/opencode/commands/<name>.md` + `ctx.command.reload()` |
| MCP | `ctx.mcp.transform` from the hub config |
| Config/providers | raw hub `opencode.jsonc` written locally (0600), plugin entry preserved |
| Memory | `~/agents/<agent>/` pulled from the hub; injected into the system prompt; `memory_*` tools; conflict-safe push |

## Memory

- Hub workspace `~/agents/<agent>/` is mirrored to `~/agents/<agent>/` on the
  node (paths rewritten between `/home/matrix2305/agents` and the local root).
- A locally modified file is never overwritten by a pull; it stays until pushed.
- Push is three-way: hub sha vs local hash vs last synced `localSha`. If both
  sides changed, a `.conflict-<node>-<timestamp>` copy is written and the hub is
  left untouched.
- Injection: the `context` (and `compaction`) hook adds a
  `<opencode-node-memory agent="...">` block for the session's agent, capped at
  `memory.maxInjectBytes` (16 KB by default).
- Tools: `memory_search`, `memory_get`, `memory_store`, `memory_push`.
- A background timer pushes pending changes every `pushIntervalSeconds` (300s).

## Runtime constraints found in 2.3.0

- `AgentEditor` has no `add`; agents must be files + reload (asynchronous).
- `Skill.Info.path` must point to an existing file.
- Do not pass optional fields as `undefined` (`autoinvoke: undefined` silently
  drops the skill).
- `Command.Info` has no template; command files are copied instead.
- `/api/config` contains provider keys; never log it.
- `/api/fs/*` resolves relative paths against `location[directory]`; the client
  always sends the configured remote root.
- MCP transforms apply immediately, but `ctx.mcp.list()` is empty until the
  server connects.

See `docs/M0-FINDINGS.md` for the spike report.

## Security

- `config.json`, `opencode.jsonc` and the password file are `0600`.
- Secrets are never logged. Prefer `keychain:`/`secret:` over a password file.
- The hub password gives full filesystem access to the hub; treat it as a
  server admin credential.
- Every overwritten file is backed up under
  `~/.local/share/opencode-node/backup/<timestamp>/`.

## Development

```bash
npm install
npm run typecheck
node src/cli.ts status
```

Repo layout:

```
src/config.ts    config file, password refs, paths
src/hub.ts       OpenCode hub client (Basic auth)
src/sync.ts      pull, snapshot, materialise, config apply
src/index.ts     OpenCode V2 plugin (cache-first + refresh + node tools)
src/cli.ts       oc-node CLI
docs/            findings and design notes
```
