# Backend architecture

A monolith. Everything under `backend/` is a single npm package
(`@parley/cloud`) that runs as one process, `api`:

- the HTTP service clients talk to, with job updates pushed over server-sent
  events (`GET /events`). In production it also serves the built client
  (`CLIENT_DIR`) on `/`, `/chat` and `/chat/*`, so the page and the API share
  one origin and the session cookie is first-party.
- transcription, which it takes from a RabbitMQ queue. See
  [Why transcription runs in the API](#why-transcription-runs-in-the-api).

The Python YouTube fetcher (`servers/cloud/youtube-fetcher`) is the other
process; the two talk only through RabbitMQ.

The source is all in `src/`, entry point `src/index.ts`. `scripts/` holds the
one-shots (migrate, baseline, push-storage) and `test/` the tests.

## Attachment vocabulary

- **Attachment** is the stored database object. Use **upload** for uploading operations.
- **Linked / unlinked** describes whether a saved message references an attachment. Use **link / unlink** for changing that relationship.
- **Reserved / unreserved** describes whether an active turn reservation protects an attachment. Use **reserve / release** for changing that protection.
- Linking and reservation are independent. Deletion requires ownership and an attachment that is both **unlinked and unreserved**. Spell out both states in deletion helpers.

Backend TypeScript uses `Attachments`, `attachmentId`, and `ChatMessageAttachmentLinks`.
Physical SQL names and API fields such as `imageUploadId` and `audioUploadId` retain their existing names.

## External dependencies

Each process runs a **fail-fast preflight** on boot (`startup.ts` →
`verifyServices`): if any dependency it needs is down, it aborts instead of
starting half-alive.

## Message queues

Defined in `src/message-queue/queues.ts`, each named for what its consumer
does with a message, with `yt_` on the ones only YouTube uploads go through:

| Queue               | Producer → Consumer                     | Payload                             |
| ------------------- | --------------------------------------- | ----------------------------------- |
| `yt_fetch_captions` | api → youtube-fetcher                   | `{ audioUploadId, url, userId }`    |
| `yt_fetch_audio`    | api / youtube-fetcher → youtube-fetcher | `{ audioUploadId, url, userId }`    |
| `yt_save_captions`  | youtube-fetcher → api                   | `{ audioUploadId, segments }`       |
| `transcribe_audio`  | api / youtube-fetcher → api             | `{ audioUploadId }`                 |
| `yt_fail_job`       | youtube-fetcher → api                   | `{ audioUploadId, userId, error? }` |

The API publishes to `transcribe_audio` and consumes it too. The queue is what
keeps an upload's job across a restart or deploy, and what holds back the
ones over the concurrency limit until there's room.

Each consumer sets how many messages it works on at once,
`mq.consume(queue, handler, { attempts, prefetch })`, 1 unless it says
otherwise. `transcribe_audio` takes `getTranscriptionConcurrency()`
(`src/transcribeJob.ts`): 40, under the 50 transcriptions Deepgram runs at
once for a project. Every API instance together has to stay under that, so
once there are several, each one's share comes from the load balancer.
`yt_save_captions` stays at 1: it is only database writes, and one at a time
keeps it to one of the pool's connections, so chat turns don't wait behind a
burst of them.

The fetcher sets its own in `youtube-fetcher/app/app.py`: 5 for
`yt_fetch_captions`, one small request each, and 3 for
`yt_fetch_audio`, a download of up to 50 MB each in a 1 GB container.
Captions get their own queue so they never wait behind a download.

Each consumer also sets how many attempts a message gets. A handler fails an attempt by
throwing, and the next attempt runs 2 seconds later in the same process.
A message that fails its last attempt, throws a `DeadLetterError`, or isn't
valid JSON of its queue's shape (the schemas in `queues.ts`) is published to the `dead_letter` queue under its original queue's
name, with the reason in an `x-failure-reason` header, and then acked.
Nothing is requeued, and nothing consumes `dead_letter`: replay by hand once
the cause is fixed.

A transcription that fails a job it claimed hands the claim back before its next
attempt, so that attempt finds the job queued. If it can't hand the claim
back, the job stays `processing` and the message is dead-lettered; set the
job back to `queued` with no claim token before replaying it.

A lost RabbitMQ connection or channel exits the process with code 1. Nothing
reconnects in-process; the platform's restart policy brings it back.

## End-to-end flow (audio upload)

```
  browser
    │  upload audio
    ▼
  ┌──────┐  create AudioTranscriptionJobs (queued)   ┌──────────┐
  │ api  │ ───────── publish transcribe_audio ──────▶│ RabbitMQ │
  │      │ ◀──────── consume transcribe_audio ───────┤          │
  └──────┘                                           └──────────┘
    │  claim job, sign audio URL, call Deepgram,
    │  save transcript and complete job in Postgres
    └── GET /events: jobUpdated to the user's streams ──▶ browser
```

A YouTube upload takes the same path one step earlier. When captions are
preferred, the API publishes `yt_fetch_captions`: if the video has a
caption track, the Python fetcher skips the audio download and publishes
`yt_save_captions` with the caption segments in the message, which the API stores
as the transcript; if it has none, the fetcher publishes
`yt_fetch_audio`. Otherwise the API publishes `yt_fetch_audio`
itself. For that one, the fetcher stores audio under the job's
`audioUploadId` and publishes `transcribe_audio`. Either fetch that fails
publishes `yt_fail_job`.

Completed transcripts are immutable. The API has no rerun route, and a source
linked to a message or reserved for a response cannot be deleted. Trying another
transcription requires a new upload and job, so old conversation history cannot
change underneath a message.

**Transcripts are not summarized.** The transcript is stored in Postgres under
the audio job's `audioUploadId`. The user feeds one or more completed jobs to a
model through `chat_message_attachments`, which preserves their link
order. There is no second job pipeline: the prompt contains the linked
transcripts plus whatever the user types, and the reply streams over the same
SSE endpoint every other chat turn uses.

Job state transitions are **claimed atomically**. A fresh delivery can claim
only a queued job; a broker redelivery can reclaim a processing job. Every claim
gets a new token, which prevents an older delivery from writing a stale result if
it later finishes.

## Deployment & scaling

Production is one VPS running `servers/cloud/compose.yaml` with
`compose.prod.yaml` on top, behind a shared Caddy proxy, deployed by
`.github/workflows/deploy.yml` on every push to `main`. See
[`servers/cloud/deploy/README.md`](../deploy/README.md).

`api` runs as a single instance behind Caddy. Its port is fixed and known
(`PORT`, which also carries its event stream) because Caddy dials it. Do not
randomize it.

Running more than one instance needs more than a replica count: rate limits
and event streams are per process (see the root TODO.md), and so are the
replies being written (`src/replies.ts`), so a stop request or a reloaded
page has to reach the instance writing the reply. The instances
have to split the transcription concurrency between them (see
[Message queues](#message-queues)), and each holds its own database
connections out of the session pooler's fixed budget, so adding one means
shrinking the pool in `src/db/pool.ts`.

### History text cache

Each `api` process keeps the text of the messages and transcripts it has read
or saved, per conversation (`src/chat/historyText.ts`), and the next
turn's history read leaves that text out. Sending it is most of what the read
costs. The cache needs no shared store, routing or invalidation, because the
text is written once: nothing updates a message's `content` or a transcript in
place, and an edit deletes messages and saves new ones under new ids. The query
still decides which messages, attachments and images a turn gets; the cache
only fills in text for ids it returned. A process that has never seen a
conversation reads it in full once.

The database holds this: triggers (`drizzle/0004_immutable_messages.sql`)
refuse any UPDATE to `chat_messages`, `chat_message_attachments` and
`transcript_contents`, so a feature that tried to rewrite either in place, and
would have let this cache serve the old text, fails instead. Deletes, cascades
included, are unaffected.

### Schema changes

Deploys build the database from the migrations in `drizzle/`, through the
`migrate` one-shot (`dist/migrate.js`), never from `schema.ts` directly. So
a change to `schema.ts` comes with its migration:

1. Edit `src/db/schema.ts`. `npm run db` (push) is fine for trying it on
   your own database.
2. `npm run db:generate`, and commit the new file in `drizzle/` with the
   change. `test/unit/migrations.test.ts` fails until you do.

What `schema.ts` can't express, such as the triggers above, goes in a
migration written by hand: `npm run db:generate -- --custom --name <name>`
makes the empty file. Push doesn't apply those, so run `npm run db:migrate`
for them; add the file to `HANDWRITTEN_MIGRATIONS` in
`test/helpers/schemaSql.ts` so the integration suites get it too.

A database made with push rather than migrations (the existing ones were)
needs `npm run db:baseline` once before its first `migrate`: it checks the
schema is all there and records the migrations as applied.

## Why transcription runs in the API

It used to be a separate `transcribe-worker` process, from when that process
also wrote summaries; summaries became chat replies, which the API runs. What
was left only waits: it signs a URL to the audio, Deepgram downloads and
transcribes it, and the transcript is saved. Waiting costs a Node process
almost nothing, and the API already waits on longer calls than this for every
chat reply.

A separate process would buy independent scaling, and there is nothing to
scale: one process can wait on more transcriptions than the 50 Deepgram runs
at once. In the API, the user's screen is updated directly when a transcript
is saved, rather than through a message back to the API that could be lost.
