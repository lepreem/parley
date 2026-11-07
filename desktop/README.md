# Parley's desktop app

The Electron app people download to use Parley on their own computer. It starts
the local server (`servers/local/`) and shows its page in a window, so nobody
installs Node, ffmpeg, Whisper or yt-dlp, or runs a command. The program chat
runs on is the one thing it can't carry, because each person signs in to their
own: Claude Code or Codex, either is enough. If neither is ready, the window
offers to install Claude Code with Anthropic's installer or to sign in; someone
who uses Codex installs it and runs `codex login` themselves.

It isn't one of the repo's npm workspaces, so Electron stays out of the cloud
image and out of every other install.

## How it fits together

- `src/main.ts` runs the app: Claude Code or Codex (`src/claudeCode.ts`,
  `src/codex.ts`), then the server, then the chat page, stopping at whichever
  needs the person (`static/setup.*`).
- `src/server.ts` starts the server with the app's own Node (`static/run.mjs`),
  on port 47821 or any free one. Closing the server's stdin stops it, so it
  can't outlive the app.
- `src/shellPath.ts` finds the terminal's PATH, which an app opened from the
  Finder doesn't get.
- `src/ytDlp.ts` keeps yt-dlp in the data folder, where it can update itself,
  but only to a release that has been out for a week.
- `src/phoneAccess.ts` keeps the person's phone connected while they want it,
  over their own Tailscale (`src/tailscale.ts`, `static/phone.*`). It runs
  `tailscale serve` in the foreground, so serving ends with the app, tells the
  running server over its IPC channel which name and account to answer, and
  stops the machine going to sleep by itself in the meantime. The setting is
  `phone-access.json` in the data folder.
- `src/updates.ts` tells people about a new release. The app can't replace
  itself on a Mac without a paid signing certificate, so no platform does.

Everything it keeps is in `~/.parley`, the same as a server started by hand.
`~/.parley/logs/server.log` has the server's output from the last launch.

## Building

From the repo root, after the root's `npm install`:

```sh
npm install --prefix desktop
npm run package --prefix desktop # release/Parley-*, for this platform only
npm run smoke --prefix desktop   # opens that build and transcribes a clip
```

`npm run stage` puts together what the app carries (`build/`), and `npm start`
runs the app from there without packaging it. Native packages can't be built
for another platform, so `.github/workflows/desktop.yml` builds each one on its
own machine.

## Releasing

Bump `version` in `package.json`, commit, and push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The workflow builds and tests all five builds, then publishes them. The download
page links to the latest release's files by name, so those names
(`artifactName` in `electron-builder.yml`) and `DownloadPage.tsx` move together.

A new ffmpeg-static or yt-dlp needs its pinned sha256s updated
(`servers/local/core/ai/decodeAudio.ts`, `scripts/stage.mts`).
