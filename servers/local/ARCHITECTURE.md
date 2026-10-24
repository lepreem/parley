# Backend architecture

A monolith. Everything under `servers/local/` is a single npm package
(`@parley/local`) that runs as one process, `api`: the HTTP service
clients talk to, with job updates pushed over server-sent events (`GET
/events`), which also fetches YouTube videos and runs
transcription off in-memory queues. It keeps its data in SQLite, in one file under `DATA_DIR`. Migrations in `drizzle/` are
applied at startup. Statements and transactions run one at a time, in order
(`shared/db/connect.ts` says why), so work inside a transaction goes through
its own handle, never `db`.

## Attachment vocabulary

- **Attachment** is the stored database object. Use **upload** for uploading operations.
- **Linked / unlinked** describes whether a saved message references an attachment. Use **link / unlink** for changing that relationship.
- **Reserved / unreserved** describes whether an active turn reservation protects an attachment. Use **reserve / release** for changing that protection.
- Linking and reservation are independent. Deletion requires an attachment that is both **unlinked and unreserved**. Spell out both states in deletion helpers.

Backend TypeScript uses `Attachments`, `attachmentId`, and `ChatMessageAttachmentLinks`.
Physical SQL names and API fields such as `imageUploadId` and `audioUploadId` retain their existing names.

## Files

Uploaded images and audio, and the audio a YouTube fetch downloads, are files
under `DATA_DIR` (`shared/files.ts`): `images/<uploadId>` and
`audios/<uploadId>`. An upload arrives as a multipart form and is written
before its row, so a row never points at a missing file; a deletion removes the
row first, then the file. Whatever a crash leaves between the two, and audio a
YouTube fetch writes for a job deleted while it ran, is a file no row uses:
startup removes those before anything else runs.

The client reads an image from `GET /upload/image/:imageUploadId`. The model is
handed it inline, base64-encoded in the prompt (`chatImageInput`).

## Chat

Chat runs on the user's own Claude Code (`shared/ai/ai_chat_client.ts`): each
turn is one `claude --print` run, with the app's system prompt and no tools,
MCP servers, slash commands or settings, so none of the user's own setup
reaches the conversation. Claude Code keeps history only in its own sessions,
while the app's changes under edits and deletes, so each run is handed the
whole conversation as one message: every turn in `<user>` or `<assistant>`
tags, its images in place. The models are Claude Code's aliases (`opus`,
`sonnet`, `haiku`), which follow the newest of each family. `CLAUDE_PATH`
names the program when it isn't on PATH.

## Transcription

Audio is transcribed on this machine by faster-whisper, in
`shared/ai/whisper.py`, which uv runs with the dependencies the script declares
(`uv run --script`). The script prints each segment as it's transcribed;
`transcribeAI` joins them into paragraphs, breaking where the speaker pauses
or at a sentence end once a paragraph passes 500 characters, and gives up on
a run that prints nothing for ten minutes. Models download into
`DATA_DIR/models` the first time they're used, from Hugging Face. The build
copies the script next to the bundle.

## External dependencies

The programs the API runs: Claude Code (logged in), uv and yt-dlp. It runs a
**fail-fast preflight** on boot (`startup.ts` → `verifyServices`): if any of
them can't run, it aborts instead of starting half-alive.

## Message queues

Defined in `shared/message-queue/queues.ts`:

| Queue                | Producer → Consumer                          | Payload                                          |
| -------------------- | -------------------------------------------- | ------------------------------------------------ |
| `yt_fetch`           | upload route → YouTube fetch                 | `{ audioUploadId, url, useCaptionsIfAvailable }` |
| `yt_fetch_failed`    | YouTube fetch → job update                   | `{ audioUploadId, error? }`                      |
| `caption_transcript` | YouTube fetch → transcription                | `{ audioUploadId, transcript }`                  |
| `transcribe`         | upload route / YouTube fetch → transcription | `{ audioUploadId }`                              |
| `transcribe_done`    | transcription → browser notifier             | `{ audioUploadId }`                              |

The queues are in memory (`shared/message-queue/messageQueue.ts`). Each
queue's consumer takes its messages one at a time, in the order they were
published, and publishing never runs a handler inside the publisher.

Each consumer sets how many attempts a message gets:
`mq.consume(queue, handler, { attempts })`. A handler fails an attempt by
throwing, and the next attempt runs 2 seconds later. A message that fails its
last attempt or throws a `DeadLetterError` is given up and logged with its
payload. Transcription and the YouTube fetch record their failures on the job
row first, so the user sees them.

A transcription handler that fails a job it claimed hands the claim back before
its next attempt, so that attempt finds the job queued.

Nothing on the queues outlives the process. The job rows do: at startup, before
the consumers start, `resumeUnfinishedJobs` returns every job left `processing`
to `queued`, then queues every unfinished job again. A YouTube job is fetched
again, with the caption preference stored on its row; any other is transcribed.

## End-to-end flow (audio upload)

```
  browser
    │  upload audio
    ▼
  api: create AudioTranscriptionJobs (queued)
    │
    ├──── transcribe ────▶ api, transcription handler:
    │                        claim job, transcribe the file with Whisper,
    │                        save transcript and complete job in SQLite
    │◀── transcribe_done ────┘
    │
    └── GET /events: jobUpdated to every connected browser
```

A YouTube upload takes the same path one step earlier: the API publishes
`yt_fetch`, and the YouTube fetch (`api/src/youtubeFetch.ts`, running the
`yt-dlp` program) takes it. When captions are preferred, it tries them first:
if the video has a caption track, it skips the audio download and publishes
`caption_transcript` with the caption text in the message, which the
transcription handler stores as the transcript. Otherwise it stores audio under
the job's `audioUploadId` and publishes `transcribe`.

Completed transcripts are immutable. The API has no rerun route, and a source
linked to a message or reserved for a response cannot be deleted. Trying another
transcription requires a new upload and job, so old conversation history cannot
change underneath a message. The database holds this for messages too: triggers
(`drizzle/0003_immutable_messages.sql`) refuse any UPDATE to `chat_messages`,
`chat_message_attachments` and `transcript_contents`, so an edit deletes rows
and inserts new ones.

**Transcripts are not summarized.** The transcript is stored in SQLite under
the audio job's `audioUploadId`. The user feeds one or more completed jobs to a
model through `chat_message_attachments`, which preserves their link
order. There is no second job pipeline: the prompt contains the linked
transcripts plus whatever the user types, and the reply streams over the same
SSE endpoint every other chat turn uses.

Job state transitions are **claimed atomically**: only a queued job can be
claimed. Every claim gets a new token, which prevents an older attempt from
writing a stale result if it later finishes.

## Running

One process, `api`, on the user's machine, listening on `127.0.0.1:PORT`
only. It serves the built client (`client/dist`, `CLIENT_DIR`) on its own
origin, so the page, the API and its event stream share one origin and one
port. Under `npm run dev` the client isn't built: Vite serves it on its own
port and calls the API on this one, as the hosted client does.

With no sign-in, the browser is the way in, so the API answers only pages it
trusts (`api/src/allowedHosts.ts`): this machine's, and the origins listed in
`ALLOWED_ORIGINS`, meant for the hosted client.

- a request addressed to anything but `localhost`, `127.0.0.1`, `[::1]` or a
  name in `ALLOWED_HOSTS` is refused, which stops DNS rebinding;
- CORS lets only a trusted page read a response; any other site's JSON or
  DELETE is refused at the preflight;
- a form post, which a browser sends cross-site without asking, is refused
  unless it comes from a trusted page;
- when Chrome asks before a public page reaches this machine, a trusted
  page's preflight says it may, and the user allows it once.

Transcription runs inside it, one message per queue at a time, so there are no
worker replicas to scale.
