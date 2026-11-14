# M0 findings — runtime capabilities of `@opencode/plugin` 2.3.0

Validated against a live OpenCode 2.3.0 hub (`matrix2305`) inside an isolated
server (temp `HOME`/XDG dirs, custom port).

## Works

| Feature | API | Notes |
| --- | --- | --- |
| Load plugin from local dir | `plugins: ["/path/to/dir"]` | dir with `index.ts` is enough |
| Network from `setup` | `fetch` | Basic auth against hub works |
| Skills | `ctx.skill.transform(editor.add)` | `path` must point to a real file; content is served from cache |
| Commands | `ctx.command.transform(editor.add)` | `Command.Info` from hub has no template |
| Commands (files) | write + `ctx.command.reload()` | new command visible after reload |
| Agents | write markdown + `ctx.agent.reload()` | not immediate in `ctx.agent.list()`; visible on the API shortly after |
| MCP | `ctx.mcp.transform(editor.set)` | registered server appears on `/api/mcp`; `ctx.mcp.list()` may be empty until connected |
| Location loading | `GET /api/location?location[directory]=...` | must be called before `/api/agent` on a fresh location |

## Gotchas

1. **`AgentEditor` has no `add`.** Runtime agent registration is impossible; use
   files + `reload()`. Agents are eventually visible, not synchronously.
2. **`Skill.Info.path` must exist.** Passing a path to a not-yet-written file
   silently drops the skill.
3. **Optional fields must be omitted, not `undefined`.** `autoinvoke: undefined`
   makes `editor.add` silently fail and can poison the transform list.
4. **`Command.Info` has no template.** Sync command files via `/api/fs` and
   `ctx.command.reload()`.
5. **`/api/config` includes secrets.** The config document contains provider API
   keys. Do not log it; if config sync is enabled, write it with `0600` and redact
   logs.
6. **`/api/agent` needs an active location.** On a fresh server, call
   `/api/location` first; otherwise the list is empty.
7. **MCP registration is asynchronous.** The transform returns before the server
   connects; `/api/mcp` shows status `failed`/`connected` separately.

## Next steps (M1)

- `HubClient` with capability probe (`/api/info`), auth, timeouts, retries.
- Config file `~/.config/opencode-node/config.json` + Keychain secret ref.
- CLI `oc-node init|status|pull|doctor`.
- Move spike code into `src/{config,hub,sync}/`.
- Cache-first startup: read snapshot synchronously, register transforms before
  any `await`, refresh in the background.
- Memory: pull agent workspaces, inject via prompt/context hooks, push changes
  with hash-based conflict detection.
- Config/providers: decide between runtime `ctx.provider.transform` and writing
  `opencode.jsonc` + restart. M0 shows transforms are viable for MCP; providers
  need the `Provider.Info`/`Model.Info` mapping.
- Plugins: cannot be registered at runtime; write config + restart.
