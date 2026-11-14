# Changelog

## 0.1.0

First working release of the OpenCode node plugin.

### Setup sync

- Pull agents, skills, commands, MCP servers and the raw hub `opencode.jsonc`.
- Skills registered at runtime; agents/commands materialised as files + reload.
- Cache-first startup with background refresh (`cacheSeconds`, default 300).

### Memory

- Mirror `~/agents/<agent>/` workspaces, with `/home/matrix2305/agents` ⇄ local
  root path rewriting.
- Three-way materialise: local edits are kept, never overwritten by a pull.
- `context`/`compaction` hooks inject an agent memory block (16 KB cap).
- Tools: `memory_search`, `memory_get`, `memory_store`, `memory_push`.
- Conflict-safe push: remote changes win the race, local copy saved as
  `.conflict-<node>-<timestamp>`.
- Background push timer (default 5 minutes).

### CLI

- `oc-node init|pull|push|status|doctor|config|restore|restart`.
- Password refs: `keychain:`, `secret:`, `file:`, `env:`.
- Config and secrets written with mode 0600; backups before every overwrite.

### TUI / RPC

- Server commands `/node-status`, `/node-sync`, `/node-push`.
- Server RPC `matrix2305.opencode-node`: `status`, `sync`, `push` + `updated` event.
- TUI palette commands for status/sync/push, live toasts, no JSX peers.

### Packaging

- tsup build to `dist/` with server, TUI and CLI entries.
- `@matrix2305/opencode-node`, MIT, Node >= 22.
- Tests and CI workflow.
