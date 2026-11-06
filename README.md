# Parley

Chat with Claude about audio, video, YouTube videos and images. It comes in
two parts, sharing one client (`client/`) and a wire contract
(`packages/contract/`): the hosted app, documented in
[`servers/cloud/README.md`](servers/cloud/README.md), and a server you run on
your own machine (`servers/local/`), which this README is about. On your
machine, chat goes through your own Claude Code and audio is transcribed
locally with Whisper, so nothing needs an API key.

To use Parley on your computer, download the
[desktop app](https://github.com/lepreem/parley/releases/latest) for macOS,
Windows or Linux; [`desktop/`](desktop/README.md) is its code. The rest of this
README is for running the server from source.

## Who runs what

An import says whose code it is:

| Import                   | Lives in               | Run by                               |
| ------------------------ | ---------------------- | ------------------------------------ |
| `@parley/contract`       | `packages/contract/`   | the client and both servers          |
| `@parley/server-kit/...` | `packages/server-kit/` | both servers, never the client       |
| a relative path          | the folder you're in   | only that server, or only the client |

The two servers never import from each other.

## What you need

- **Node and npm**, to install and start it. The rest of the toolchain
  (Node 22 and yt-dlp, pinned in `mise.toml` and `servers/local/mise.toml`)
  comes through [mise](https://mise.jdx.dev), which `npm install` brings
  along: the root's npm scripts install those on first run and run the app
  with them.
- **Claude Code, logged in.** Run `claude` once and sign in. Chat uses your
  Claude plan, so it counts against your plan's limits; check Anthropic's
  terms for your use.

## Run it

```sh
npm install         # installs the client's and both servers' dependencies too
npm run start:local # builds the client and the local server, then serves both
```

Then open <http://127.0.0.1:3002>.

The app refuses to start if it can't run Claude Code, ffmpeg, Whisper or
yt-dlp, and says which. Whisper (whisper.cpp) and ffmpeg come with
`npm install`, built for your platform. Start it from the repo root rather
than running `servers/local/` directly: that's what puts yt-dlp on its PATH.
The first transcription downloads its Whisper model (`small`, about 470 MB);
later ones start straight away. The mic button in the message box dictates
with the same model: what you say comes back as text to edit before sending,
and the recording isn't kept.

## Where things live

Everything the app keeps is in `~/.parley`: the database, uploaded files
and Whisper models. Delete the folder to start over. To change it, or the
port, copy `servers/local/.env.example` to `servers/local/.env`.

The app listens on 127.0.0.1 only and answers requests from this machine
only, so other devices on your network, and other sites open in your browser,
can't reach it.

## Use it from your phone

In the desktop app, choose **Use from your phone** in the sidebar and turn it
on. You'll need [Tailscale](https://tailscale.com) on the computer and on the
phone, signed in to the same account; the window walks you through it and shows
a QR code to scan. It works from any network for as long as the computer is
awake and the app is open, only your own Tailscale account gets in, and it comes
back by itself the next time you open the app, until you turn it off.

Running from source, do by hand what the app does:

1. Put the app behind Tailscale:

   ```sh
   tailscale serve --bg 3002
   ```

   It prints the app's new address, like `https://macbook.tail1234.ts.net`.
   The first time, Tailscale asks you to turn on HTTPS for your tailnet.

2. Tell the app that name, in `servers/local/.env`, and restart it:

   ```sh
   ALLOWED_HOSTS=macbook.tail1234.ts.net
   ```

3. Open the address on your phone.

This way, every device on your tailnet can reach it, at home or away; the app
itself still listens on 127.0.0.1 only. `tailscale serve reset` takes it off
again.

## Developing

```sh
npm run dev:local           # the local server on :3002, restarting on changes
npm run dev --prefix client # the client with hot reload on :5173
```

Open <http://localhost:5173/local>. `servers/local/ARCHITECTURE.md` describes
how the local server fits together; `npm test` in `servers/local/` runs its
tests. Its debugger listens on 9231 (`chrome://inspect`).
