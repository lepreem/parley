/**
 * Puts together what the app carries for this platform, in build/:
 *
 *   server/  the bundled local server, its migrations and production packages
 *   client/  the built client
 *   bin/     yt-dlp
 *
 * Run on the platform being built for: the packages and programs are native.
 * The server's packages are installed from the repo's lockfile, in a copy that
 * holds only the package.json files, so the app gets what the tests ran on.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("..");
const build = path.resolve("build");
const serverDir = path.join(build, "server");

const YT_DLP_VERSION = "2026.10.26";
/** As GitHub lists them for that release, which pins what the app first ships. */
const YT_DLP_BUILDS: Partial<Record<string, { file: string; sha256: string }>> =
  {
    "darwin-arm64": {
      file: "yt-dlp_macos",
      sha256:
        "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
    },
    "darwin-x64": {
      file: "yt-dlp_macos",
      sha256:
        "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
    },
    "linux-arm64": {
      file: "yt-dlp_linux_aarch64",
      sha256:
        "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483",
    },
    "linux-x64": {
      file: "yt-dlp_linux",
      sha256:
        "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795",
    },
    "win32-x64": {
      file: "yt-dlp.exe",
      sha256:
        "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
    },
  };

/** The npm this script was started with, `npm run stage`, on any platform. */
function npm(args: string[], cwd: string) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run this through npm: npm run stage");
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
}

function buildClientAndServer() {
  npm(["run", "build", "--prefix", "client"], root);
  npm(["run", "build", "--prefix", "servers/local"], root);
}

/** Every workspace's package.json, which `npm ci` wants to match the lockfile. */
function workspaceManifests(): string[] {
  const { workspaces } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ) as { workspaces: string[] };
  return ["package.json", "package-lock.json"].concat(
    workspaces.map((workspace) => path.join(workspace, "package.json")),
  );
}

async function installServerPackages() {
  const copy = path.join(build, "install");
  for (const file of workspaceManifests()) {
    await cp(path.join(root, file), path.join(copy, file));
  }
  npm(
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspace=@parley/local",
    ],
    copy,
  );
  // Links to the workspaces, whose code is already in the server's bundle.
  await rm(path.join(copy, "node_modules", "@parley"), {
    recursive: true,
    force: true,
  });

  await cp(
    path.join(copy, "node_modules"),
    path.join(serverDir, "node_modules"),
    {
      recursive: true,
      verbatimSymlinks: true,
    },
  );
  // A package npm couldn't hoist, because something else needs another version.
  const nested = path.join(copy, "servers", "local", "node_modules");
  if (existsSync(nested)) {
    await cp(nested, path.join(serverDir, "node_modules"), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
  // The one install script the server needs: it downloads this platform's
  // ffmpeg, which the server checks against its pinned sha256 before running.
  // Run in the copy's place, so its root package.json is the server's own.
  await writeFile(
    path.join(serverDir, "package.json"),
    `${JSON.stringify({ name: "parley-server", private: true, type: "module" }, null, 2)}\n`,
  );
  npm(["rebuild", "ffmpeg-static"], serverDir);
  await rm(copy, { recursive: true, force: true });
  await pruneWhisperBuilds();
  await removeWhatTheServerDoesNotUse();
  await removeCommandLinks(path.join(serverDir, "node_modules"));
}

/**
 * Nothing runs packages' commands here, and links to the ones just removed
 * would point nowhere, which stops a Mac build being signed.
 */
async function removeCommandLinks(modules: string) {
  const entries = await readdir(modules, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === ".bin") {
      await rm(path.join(entry.parentPath, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

/**
 * npm brings along the optional peers of other workspaces' packages, like Vite
 * and its compilers. Only what the server's own dependencies lead to stays.
 */
async function removeWhatTheServerDoesNotUse() {
  const modules = path.join(serverDir, "node_modules");
  const manifest = (name: string) =>
    JSON.parse(
      readFileSync(path.join(modules, name, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

  const { dependencies } = JSON.parse(
    readFileSync(path.join(root, "servers", "local", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const needed = new Set<string>();
  const queue = Object.keys(dependencies).filter(
    (name) => !name.startsWith("@parley/"),
  );
  for (let name = queue.pop(); name; name = queue.pop()) {
    if (needed.has(name) || !existsSync(path.join(modules, name))) continue;
    needed.add(name);
    const { dependencies: own, optionalDependencies: optional } =
      manifest(name);
    queue.push(...Object.keys({ ...own, ...optional }));
  }

  for (const entry of await readdir(modules)) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@")
      ? (await readdir(path.join(modules, entry))).map(
          (name) => `${entry}/${name}`,
        )
      : [entry];
    for (const name of names) {
      if (!needed.has(name)) {
        await rm(path.join(modules, name), { recursive: true, force: true });
      }
    }
    if (
      entry.startsWith("@") &&
      (await readdir(path.join(modules, entry))).length === 0
    ) {
      await rm(path.join(modules, entry), { recursive: true, force: true });
    }
  }
}

/**
 * The GPU builds of whisper.cpp for NVIDIA and Vulkan, up to 200 MB each, come
 * along on Windows and Linux. The server loads the default build, so the rest
 * are dead weight. On a Mac the default build is the GPU build.
 */
async function pruneWhisperBuilds() {
  const scope = path.join(serverDir, "node_modules", "@fugood");
  for (const name of await readdir(scope)) {
    if (
      name.endsWith("-cuda") ||
      name.endsWith("-vulkan") ||
      name.endsWith("-wasm")
    ) {
      await rm(path.join(scope, name), { recursive: true });
    }
  }
}

async function downloadYtDlp() {
  const platform = `${process.platform}-${process.arch}`;
  const pinned = YT_DLP_BUILDS[platform];
  if (!pinned) throw new Error(`No yt-dlp build is pinned for ${platform}`);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${pinned.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== pinned.sha256) {
    throw new Error(`${url}: sha256 ${actual}, not ${pinned.sha256}`);
  }
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const target = path.join(build, "bin", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  await chmod(target, 0o755);
}

await rm(build, { recursive: true, force: true });
await mkdir(serverDir, { recursive: true });

buildClientAndServer();
const local = path.join(root, "servers", "local");
await cp(path.join(local, "dist"), path.join(serverDir, "dist"), {
  recursive: true,
});
await cp(path.join(local, "drizzle"), path.join(serverDir, "drizzle"), {
  recursive: true,
});
await cp(path.join(root, "client", "dist"), path.join(build, "client"), {
  recursive: true,
});
await cp(path.resolve("static", "run.mjs"), path.join(serverDir, "run.mjs"));
await installServerPackages();
await downloadYtDlp();

console.log(`staged the app's contents into ${build}`);
