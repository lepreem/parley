import { getEnv } from "./env";
import { eventHub } from "./sse/hub";

import { mq } from "./message-queue/messageQueue";
import { recurring } from "./recurring";
import { onShutdown } from "@parley/server-kit/runtime/shutdown";
import {
  getTranscriptionConcurrency,
  handleTranscribeJob,
} from "./transcription/transcribeJob";
import { handleYoutubeCaptionsJob } from "./transcription/youtubeCaptionsJob";

import { serve } from "@hono/node-server";
import { createApp } from "./app";

const env = getEnv();

// createApp() runs the fail-fast preflight: if any third-party dependency is
// down (incl. RabbitMQ, which it also connects), the API never starts.
const app = await createApp();
const port = env.PORT;

/**
 * How long an idle keep-alive connection stays open. Caddy reuses its
 * connections to the API, and if Node closes one first (by default after
 * about 6 s), a request Caddy sends on it at that moment is reset and the
 * user's request fails. So this outlasts the 60 s Caddy keeps an idle one
 * (deploy/parley.caddy); keep it above that. Shutdown isn't held up by it:
 * server.close() drops idle connections at once.
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

const server = serve({
  fetch: app.fetch,
  port,
  serverOptions: { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS },
});

/**
 * Every attempt at an audio job can be a billed Deepgram call (which retries
 * once on its own), so a failed job gets one more try, not several.
 */
const TRANSCRIBE_ATTEMPTS = 2;

await mq.consume(mq.queues.TRANSCRIBE_AUDIO, handleTranscribeJob, {
  attempts: TRANSCRIBE_ATTEMPTS,
  prefetch: await getTranscriptionConcurrency(),
});
// One at a time: Supadata's free plan answers one request a second, and each
// takes a couple of seconds. A second attempt fetches again, spending another
// credit, so it's only for a failure saving the captions.
await mq.consume(mq.queues.YT_FETCH_CAPTIONS, handleYoutubeCaptionsJob, {
  attempts: 2,
});

// The storage and guest sweeps, every hour (src/recurring/).
const stopRecurring = recurring.start();

/**
 * Stop taking work, then let go of the connections.
 *
 * Transcriptions in progress get the grace period to finish rather than
 * paying Deepgram twice for them. Abandoning one would still be correct: its
 * delivery goes unacked and the next process reclaims the job under a new
 * claim token, so a transcription that outlasts the grace is simply
 * redelivered.
 *
 * A reply streaming when this fires is not lost: the model run is deliberately
 * decoupled from the response stream, so the turn still completes and is
 * stored, and the client refetches it. The conversation claim it holds is
 * covered by its lease, so even a hard kill frees the conversation rather than
 * locking it.
 */
onShutdown(
  async () => {
    await Promise.all([mq.stopConsuming(), stopRecurring()]);
    // An open event stream would hold the server open until it ended.
    await eventHub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mq.close();
  },
  { graceMs: 30_000 },
);
