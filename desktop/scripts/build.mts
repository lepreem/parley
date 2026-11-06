/**
 * Bundles the main process and its pages' preload into dist/. Electron provides
 * itself at runtime, so it stays out; everything else it uses, like the QR
 * code library, ends up inside the bundle.
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
