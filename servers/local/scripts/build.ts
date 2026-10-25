/**
 * Bundles the entrypoints for production.
 *
 * tsc cannot do this job here: tsconfig.json sets `noEmit` with
 * `allowImportingTsExtensions` (which requires it) and `moduleResolution:
 * "bundler"`, so the source uses extensionless imports Node's ESM loader will
 * not resolve. The code is written for a bundler, so it gets a bundler.
 *
 * Dependencies stay out of the bundle and are resolved at runtime from an
 * ordinary `npm ci --omit=dev`, which keeps the output small and avoids
 * bundling packages that do dynamic requires. The workspace's own packages are
 * the exception: they ship as TypeScript, so they're bundled in like our own
 * source.
 */
import { copyFile, readFile } from "node:fs/promises";
import { build } from "esbuild";

const { dependencies } = JSON.parse(await readFile("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const external = Object.keys(dependencies)
  .filter((name) => !name.startsWith("@parley/"))
  .flatMap((name) => [name, `${name}/*`]);

const ENTRYPOINTS = {
  api: "api/index.ts",
} as const;

const results = await Promise.all(
  Object.entries(ENTRYPOINTS).map(([name, entry]) =>
    build({
      entryPoints: { [name]: entry },
      outdir: "dist",
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external,
      sourcemap: true,
      logLevel: "info",
      // Reported by the bundle rather than inferred, so a build artifact can
      // say which mode it was produced for.
      define: { "process.env.BUILD_TARGET": JSON.stringify("production") },
    }),
  ),
);

const failed = results.filter((result) => result.errors.length > 0);
if (failed.length > 0) process.exit(1);

// Transcription runs this script from beside the bundle.
await copyFile("core/ai/whisper.py", "dist/whisper.py");

console.log(`built ${Object.keys(ENTRYPOINTS).join(", ")} into dist/`);
