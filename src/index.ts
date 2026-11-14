// Local development entrypoint. The published package resolves "." to
// dist/index.js; this shim keeps an already-running OpenCode server (which
// cached src/index.ts before the dist switch) working across reloads.
// @ts-ignore - dist is a build artifact without declarations
export { default } from "../dist/index.js"
