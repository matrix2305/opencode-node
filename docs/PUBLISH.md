# Publishing

Scope: `@matrix2305`. Package: `@matrix2305/opencode-node`.

## Checklist

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run     # inspect the tarball
npm publish --access public
```

`prepack` runs `npm run build`, so `dist/` is always fresh.

## Tarball contents

- `dist/index.js` — server plugin
- `dist/tui.js` — TUI command part
- `dist/cli.js` — `oc-node` CLI (shebang, executable)
- `README.md`, `LICENSE`, `docs/`

`src/`, `tests/` and `node_modules/` are not published.

## Versioning

- 0.x while the OpenCode V2 plugin/API contract is still moving.
- Bump the minor for new synced categories (memory backend, TUI, plugins).
- Bump the patch for fixes.
- `peerDependencies` stays `@opencode/plugin >=2.0 <3`; when OpenCode 3 lands,
  publish a new major and add a compatibility table entry.

## Release notes

Keep `CHANGELOG.md` updated. Mention:

- hub version tested,
- new endpoints used,
- config schema changes (CLI migrates or warns),
- manual steps (restart, `pull --config`).

## After publishing

```bash
npm i -g @matrix2305/opencode-node
oc-node init --hub https://matrix2305.tailbd26da.ts.net \
  --password-ref keychain:opencode-matrix2305
```

Repository: https://github.com/matrix2305/opencode-node (public, tag `v0.1.0`).

The CLI records the installed package directory in the local OpenCode config, so
upgrades keep the same plugin path.
