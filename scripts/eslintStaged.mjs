/**
 * Lints the files lint-staged hands it with the ESLint config of the package
 * each one belongs to, run from that package's folder: a flat config's file
 * patterns are relative to where ESLint runs, so running them all from the
 * root would match nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PACKAGES = ["client", "servers/cloud/backend", "servers/local"];
const root = process.cwd();

const filesByPackage = new Map();
for (const file of process.argv.slice(2)) {
  const fromRoot = path.relative(root, path.resolve(file));
  const pkg = PACKAGES.find((dir) => fromRoot.startsWith(`${dir}/`));
  if (!pkg) continue;
  const files = filesByPackage.get(pkg) ?? [];
  files.push(path.relative(pkg, fromRoot));
  filesByPackage.set(pkg, files);
}

let failed = false;
for (const [pkg, files] of filesByPackage) {
  const own = path.join(root, pkg, "node_modules/.bin/eslint");
  const eslint = existsSync(own)
    ? own
    : path.join(root, "node_modules/.bin/eslint");
  // Files a package's config ignores (its tests, say) aren't an error.
  const result = spawnSync(
    eslint,
    ["--no-warn-ignored", "--max-warnings", "0", ...files],
    { cwd: path.join(root, pkg), stdio: "inherit" },
  );
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
