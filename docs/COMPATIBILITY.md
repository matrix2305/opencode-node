# Compatibility

## OpenCode

| Component | Range | Tested |
| --- | --- | --- |
| Local server / plugin API | `@opencode/plugin` 2.x | 2.3.0 |
| Hub server | OpenCode 2.x (`/api/*`) | 2.3.0 |

OpenCode 1.x is not supported: its plugin API and server API differ. The plugin
checks the hub with `GET /api/info` and refuses to pull when the major version
is not `2`.

The package declares `peerDependencies: { "@opencode/plugin": ">=2.0 <3" }`.
OpenCode loads its own copy at runtime; the plugin never bundles it.

## Hub endpoints used

| Endpoint | Used for |
| --- | --- |
| `GET /api/info` | version + reachability |
| `GET /api/agent` | agents (with `location[directory]`) |
| `GET /api/skill` | skills |
| `GET /api/command` | command names (templates come from files) |
| `GET /api/config` | MCP servers |
| `GET /api/fs/list` | workspace files (memory) |
| `GET /api/fs/read/*` | memory, command and config files |
| `POST /api/experimental/fs/write` | memory push |

`/api/fs/*` calls send `location[directory]` set to `paths.remoteRoot`, so
relative paths resolve against the configured root instead of the server's
default location.

## Node runtime

- CLI (`dist/cli.js`): Node >= 22.
- Plugin (`dist/index.js`): runs inside OpenCode's Bun/Node runtime; no extra
  native dependencies.
- TUI part (`dist/tui.js`): loads only in the terminal client; no JSX/OpenTUI
  peer dependencies in 0.1.0.

## Known API constraints

- `AgentEditor` has no `add`; agents are files + `ctx.agent.reload()`.
- `Skill.Info.path` must point to an existing file.
- Optional fields passed as `undefined` silently drop a skill.
- `Command.Info` has no template; command files are copied.
- `/api/config` may contain provider API keys; never log it.
- MCP transforms apply immediately; `ctx.mcp.list()` is empty until connected.
- Plugin tool definitions require a server restart after upgrading the package
  in place.

## Tested combinations

- macOS 26 (arm64), OpenCode 2.3.0, Node 26, hub OpenCode 2.3.0 on Linux.
- Linux (headless) hub via Tailscale HTTPS with a valid certificate.
