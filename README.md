# opencode-node

A node plugin for OpenCode V2: a local OpenCode server connects to a remote
OpenCode server ("hub") and loads its agents, skills, commands, MCP servers and
file-based memory from there.

Status: **M3 / 0.1.0** — setup + memory sync, CLI, cache-first startup, TUI
commands, conflict-safe push, tests, build and publish pipeline.

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

From npm:

```bash
npm i -g @matrix2305/opencode-node
oc-node init \
  --hub https://matrix2305.tailbd26da.ts.net \
  --password-ref keychain:opencode-matrix2305
```

From this repo:

```bash
npm install
npm run build
node dist/cli.js init --hub <url> --password-ref <ref>
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

The published CLI is `dist/cli.js` (Node >= 22). In the repo you can also run
`node src/cli.ts <command>` (Node 23+).

## Config/providers modes

`sync.config` controls the raw hub `opencode.jsonc` (providers, models, plugins,
MCP):

| Mode | Behavior |
| --- | --- |
| `off` | never touch the local config |
| `manual` | only `oc-node config` / `oc-node pull --config` |
| `auto` | write the hub config when its hash changes |

```bash
oc-node config --mode auto      # set + apply now
oc-node config --mode manual
oc-node config --dry-run
```

Auto apply keeps the node plugin entry, removes the legacy `opencode.json`,
records `applied.config`, backs up every overwritten file, and logs
`config:auto-applied`. Restart OpenCode for a guaranteed clean load.
`auth.json` (provider credentials stored outside config) is not synced.

## What is synced

| Category | Mechanism |
| --- | --- |
| Skills | `ctx.skill.transform` at runtime; `SKILL.md` materialised under the data dir |
| Agents | `~/.config/opencode/agents/<id>.md` + `ctx.agent.reload()` |
| Commands | `~/.config/opencode/commands/<name>.md` + `ctx.command.reload()` |
| MCP | `ctx.mcp.transform` from the hub config |
| Config/providers | raw hub `opencode.jsonc` written locally (0600), plugin entry preserved, `off`/`manual`/`auto` modes |
| Memory | `~/agents/<agent>/` pulled from the hub; injected into the system prompt; `memory_*` tools; conflict-safe push |

## TUI

Server slash commands:

- `/node-status` — hub, cache age, counts, memory state.
- `/node-sync` — force a pull.
- `/node-push` — push memory changes.

TUI part (palette commands, live via RPC):

- **opencode-node: status** — dialog with hub/cache/counts/memory.
- **opencode-node: sync now** — pull + toast.
- **opencode-node: push memory** — push + conflict/upload toast.
- Startup and `updated` event toasts.

## RPC

The server registers `matrix2305.opencode-node`:

- `status`, `sync`, `push`
- event `updated` (`kind`, `summary`)

```bash
curl -u opencode:<password> -X POST -H 'Content-Type: application/json' \
  -d '{"input":{}}' \
  'http://127.0.0.1:49374/api/rpc/matrix2305.opencode-node/status?location[directory]=/home/me'
```

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
npm test
npm run build
node dist/cli.js status
```

Build: tsup → `dist/index.js` (server), `dist/tui.js` (terminal),
`dist/cli.js` (CLI). See `docs/PUBLISH.md` and `docs/COMPATIBILITY.md`.

Repo layout:

```
src/config.ts    config file, password refs, paths
src/hub.ts       OpenCode hub client (Basic auth)
src/sync.ts      pull, snapshot, materialise, config apply
src/index.ts     OpenCode V2 plugin (cache-first + refresh + node tools)
src/cli.ts       oc-node CLI
docs/            findings and design notes
```
