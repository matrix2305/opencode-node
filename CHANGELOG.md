# Changelog

## 0.2.0

### Config v3: configurable sync dirs

- `dirs[]` replaces `paths`/`memory`/`extraDirs` — every synced folder is now a
  first-class config entry:
  ```json
  "dirs": [
    { "remote": ".config/opencode", "local": "~/.config/opencode", "types": ["setup"] },
    { "remote": "opencode-memory", "local": "~/opencode-memory", "types": ["memory"] }
  ]
  ```
- Types: `setup` (OpenCode config sync), `memory` (bidirectional mirror),
  `mirror` (pull-only).
- `oc-node init` accepts repeatable `--root remote=<p>,local=<p>[,type=<t>]`.
- v2 configs auto-migrate to v3 dirs.
- No hardcoded remote paths — the hub resolves relative paths from its own home.

### Memory

- Markdown vault sync (flat `.md` files at the root of a memory dir) alongside
  the agent-workspace layout.
- Path rewriting across all memory sync dirs.

### Fixes carried from the audit

- Auth credential dedup, empty model-list guard, path traversal protection,
  push lock, backup rotation, redacted snapshot config, service.json URL.

## 0.1.1

### Fixes

- **Auth credentials no longer stack**: every refresh used to add another
  credential with the same label (verified: 29 duplicates in practice). Connect
  now goes through the local server API which lists and removes previous
  hub-labelled credentials first; plugin-context fallback remains for
  remote-server setups. One-off cleanup included.
- **Empty hub model list no longer disables every model** (failed-fetch guard).
- **Model parity is now correctly awaited and reported** (`models:applied`),
  and previously disabled models are **re-enabled** when the hub re-adds them
  (`applied.nodeDisabledModels` tracking).
- **`applyConfig` fetches the live hub config** when applying, because the
  snapshot now stores a **redacted** copy (`apiKey`/`secret`/`token`/`password`
  values replaced with `{redacted}`) — no key material on disk.
- **Local server URL is read from `service.json`** instead of hard-coded port.
- **Path traversal protection** for ids/paths coming from the hub (skills,
  agents, commands, memory rels, plugin files): `..`, absolute paths, NUL,
  `node_modules`, `.git` rejected (`src/safe.ts`).
- **Memory push lock**: timer, `node.sync` and RPC `push` are serialised; the
  push timer is created once per process instead of once per location.
- `OPENCODE_REMOTE_URL` no longer auto-activates the plugin (only explicit
  `OCN_HUB_URL` does).
- Backups are rotated (newest 20 kept).
- Hub `package.json` dependencies now win over stale local versions
  (local-only deps kept).
- Removed a real API-key prefix from the published docs.

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

### Models

- Hub model list pulled into the snapshot and enforced at runtime
  (`ctx.model.transform`): local-only models disabled, hub parity in the picker.

### Auth

- Hub provider credentials connected **live** into the local server's credential
  store (`connect/key`, stable per-hub label) during `init`/`pull`/refresh.
- No keys in files: `auth.json` is neither read nor written by the plugin; the
  snapshot stores only a provider count and a names-hash.

### Plugins

- Hub plugin list merged into the local config during `init` and `pull`
  (object form/options preserved, local entries kept, JSONC-safe, idempotent).
- `plugin/` + `plugins/` trees copied; `package.json` dependencies merged.
- Server applies the same layer on startup/refresh and emits `plugins`.
- `sync.plugins` toggle (default on).

### Multi-hub

- Config schema v2 with `hubs` + `activeHub`; legacy config migration.
- Per-hub snapshot/applied/skills under `hubs/<name>/`.
- CLI `hub list|add|use|remove`, `init --hub-name`.
- TUI status shows the active hub; footer prefixes it when multiple hubs exist.

### Config modes

- `sync.config`: `off`, `manual`, `auto`.
- `oc-node config --mode auto|manual|off`, `--dry-run`.
- Auto apply on setup/refresh with backups, applied hash and RPC `config` event.

### CLI

- `oc-node init|pull|push|status|doctor|config|restore|restart`.
- Password refs: `keychain:`, `secret:`, `file:`, `env:`.
- Config and secrets written with mode 0600; backups before every overwrite.

### TUI / RPC
- Home footer status (`node 9s · 62m`) via Solid/OpenTUI slot, reactive to RPC
  events and a 30 s poll; TUI errors logged to `tui.log`.


- Server commands `/node-status`, `/node-sync`, `/node-push`.
- Server RPC `matrix2305.opencode-node`: `status`, `sync`, `push` + `updated` event.
- TUI palette commands for status/sync/push, live toasts, no JSX peers.

### Packaging

- tsup build to `dist/` with server, TUI and CLI entries.
- `@matrix2305/opencode-node`, MIT, Node >= 22.
- Tests and CI workflow.
