/**
 * Bundles the main process and the setup page's preload into dist/. Electron
 * provides itself at runtime, so it stays out; nothing else is a dependency of
 * the running app.
 */
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
