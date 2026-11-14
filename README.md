# opencode-node

A node plugin for OpenCode V2: a local OpenCode server connects to a remote
OpenCode server ("hub") and loads its agents, skills, commands, MCP servers and
memory from there.

Status: **M0 spike** (validated). Not published yet.

## What is validated

Running the plugin inside an isolated OpenCode 2.3.0 server against a live hub:

- **Skills** — loaded from `GET /api/skill`, materialised as `SKILL.md` under the
  local data dir and registered at runtime with `ctx.skill.transform`.
- **Agents** — `AgentEditor` has no `add`, so the plugin writes
  `~/.config/opencode/agents/<id>.md` and calls `ctx.agent.reload()`.
- **Commands** — `Command.Info` has no template, so the plugin copies
  `commands/*.md` from the hub via `/api/fs/read` and calls `ctx.command.reload()`.
- **MCP** — servers are read from the hub config and registered with
  `ctx.mcp.transform`.
- **Hub transport** — plain HTTPS + Basic auth (`opencode:<password>`), works over
  Tailscale without any special handling.

## Spike usage

```bash
OCN_HUB_URL=https://matrix2305.tailbd26da.ts.net \
OCN_HUB_PASSWORD=... \
opencode serve
```

The plugin reads those env vars, pulls from the hub, and writes a diagnostic log
to `~/.local/share/opencode-node/spike.log`.

`src/index.ts` is the spike. See `docs/M0-FINDINGS.md` for details and the next
steps.

## Known constraints found in M0

- `AgentEditor` has no `add`; agents require files + reload (async pickup).
- `ctx.skill.transform` silently drops a skill if an optional field is passed as
  `undefined` (e.g. `autoinvoke: undefined`). Build objects conditionally.
- `Skill.Info.path` must point to an existing file at registration time.
- `/api/agent` with `location[directory]` only returns data after that location is
  loaded; call `/api/location` first.
- `/api/config` contains provider API keys. Do not log it or store it in plain text.

## Roadmap

M0 spike (done) → M1 config + CLI `init` → M2 full setup pull (agents/skills/
commands/config/providers) → M3 memory pull/inject/push → M4 MCP allowlist +
plugins → M5 TUI → M6 hardening + docs → publish `@matrix2305/opencode-node`.
