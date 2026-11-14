import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    tui: "src/tui.tsx",
    rpc: "src/rpc.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  external: ["@opencode/plugin", "@opencode/plugin/tui", "@opencode/plugin/rpc", /^@opentui\//, /^solid-js/],
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "@opentui/solid"
  },
})
