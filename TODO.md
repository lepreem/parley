# To do

Open work on the cloud server, checked against the code on 2026-10-23.
Paths are under `servers/cloud/backend/`.

## Message latency

Every turn logs its timings ("Message preparation operation completed",
`src/preparationMetrics.ts`). The last measurement put the model's own time
to first token (median 1.76 s) far ahead of everything the server does.

1. **The model.** A faster default, or telling OpenRouter to prefer faster
   providers. A product call; measure first.
2. **`persistAndUnclaimChatTurn` takes ~6 round trips** before `done`
   (`src/data/messages.data.ts`). The user message is inserted first only
   because the database makes its id; with ids made in the app the rest can
   go at once, or in one statement with CTEs.
3. **`done` waits for the title** on a conversation's first turn
   (`answerTurn`, `src/chat/turn.ts`). Save the turn without it, write the
   title when it arrives, and push it to the client.
4. **An edit deletes dropped images from storage before it streams**
   (`rewindTo`). The ledger already marks them deleted and the sweep removes
   leftovers, so the storage call can run after the stream starts.
5. **Re-signed image URLs are saved before the model call starts**
   (`resolveImageAttachmentUrls`). Only conversations reopened after ~7 days;
   ~300 ms. Return the URLs and save them without waiting.

## Robustness

- **Queue publish gap.** A process that dies between committing a job and
  publishing its work leaves it `queued` forever (`publishOrFail` covers a
  refused publish, not a crash). Fix only if stuck jobs show up: a periodic
  pass that republishes jobs `queued` past a threshold per source (YouTube
  jobs stay `queued` for the whole fetch).
- **Unconfirmed uploads hold storage for hours.** Each upload URL accepts one
  file (50 MB audio, 10 MB image) and an unconfirmed one lives until the
  sweep, 3 to 4 hours. At 30 mints per 15 minutes, one user can park ~18 GB.
  Cap a user's pending uploads.
- History images are signed before the model's image support is checked
  (`prepareTurn`), so a text-only model with stale images costs a storage call,
  and a storage failure there is a 500 instead of the 400.

## Scaling past one API instance

Nothing needs this yet. Everything below is per process today:

- **Job updates.** `eventHub.send` (`src/sse/hub.ts`) only reaches streams on
  this instance, and a work queue hands each message to one instance. Fix: a
  `job_updates` fanout exchange; each instance binds its own exclusive queue
  and forwards what it hears. Work that must happen once (failing a job) stays
  on a work queue and publishes to the fanout after.
- **Rate limits** are counted in memory (`src/middleware/rateLimit.middleware.ts`).
  The policies are plain data (`src/rateLimit/policies.ts`) so they can move
  to a load balancer, which must verify the WorkOS token itself, since most
  are per user. Caddy needs a plugin (`caddy-ratelimit`) for that. Until
  then, divide the limits by the replica count.
- **Refresh replay** (`src/auth/refreshSession.ts`) dedupes refreshes per
  process.
- **Shared budgets.** Deepgram's 40 concurrent transcriptions
  (`getTranscriptionConcurrency`) and the session pooler's 15 connections
  (`src/db/pool.ts`) have to be split between instances.

## Naming

- The contract's `ChatMessage.attachments` holds only images; rename it
  `imageAttachments`.
- `/contract` serves the audio bucket as `bucket`; rename it `audioBucket`
  (the fetcher reads it).
