const env = getApiEnv();

import { getApiEnv } from "../core/env";
import { EVERYONE, events } from "./src/events";

import { mq } from "../core/message-queue/messageQueue";
import { resumeUnfinishedJobs } from "../core/audioTranscription";
import { data } from "../core/data";
import { closeDb, migrateDb } from "../core/db";
import { onShutdown } from "@parley/server-kit/runtime/shutdown";
import { files } from "../core/files";
import { logger } from "@parley/server-kit/runtime/logger";
import { handleTranscribeJob } from "./src/transcribeJob";
import { handleYoutubeFetch } from "./src/youtubeFetch";

import { serve } from "@hono/node-server";
import { createApp } from "./app";

await migrateDb();

// Before anything can write a file, so none is mid-write.
const orphans = await files.removeOrphans(
  await data.attachments.findAttachmentIds(),
);
if (orphans > 0) logger.info("Removed files no row uses", { count: orphans });

// createApp() runs the fail-fast preflight: if any third-party dependency is
// down, the API never starts.
const app = await createApp();
const port = env.PORT;

// Before the consumers start, so what the last run left unfinished goes first.
await resumeUnfinishedJobs();

// Listening starts here, on the loopback interface only: nothing on the
// network can reach it.
const hostname = "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  logger.info(`Listening on http://${hostname}:${port}`);
});

mq.consume(
  mq.queues.TRANSCRIBE_DONE,
  ({ audioUploadId }) => {
    events.send(EVERYONE, "jobUpdated", { audioUploadId });
  },
  { attempts: 1 },
);
// The YouTube fetch retries on its own, so the message gets one attempt.
mq.consume(mq.queues.YT_FETCH, handleYoutubeFetch, { attempts: 1 });
// The fetch couldn't get the audio: mark the job failed and notify the user.
// The row was created by POST /upload/youtube.
mq.consume(
  mq.queues.YT_FETCH_FAILED,
  async ({ audioUploadId, error }) => {
    await data.jobs.failAudioJobById(
      audioUploadId,
      error ?? "Failed to fetch YouTube audio",
    );
    events.send(EVERYONE, "jobUpdated", { audioUploadId });
  },
  { attempts: 2 },
);

/**
 * Every attempt at an audio job transcribes the whole file again, which can
 * take minutes, so a failed job gets one more try, not several.
 */
const TRANSCRIBE_ATTEMPTS = 2;

mq.consume(mq.queues.TRANSCRIBE, handleTranscribeJob, {
  attempts: TRANSCRIBE_ATTEMPTS,
});
mq.consume(mq.queues.CAPTION_TRANSCRIPT, handleTranscribeJob, {
  attempts: TRANSCRIBE_ATTEMPTS,
});

/**
 * Stop taking work, then let go of the connections.
 *
 * The transcription in progress gets the grace period to finish rather than
 * running again from the start. Abandoning it would still be correct: the
 * next startup queues every unfinished job again, so a transcription that
 * outlasts the grace period simply runs again.
 *
 * A reply streaming when this fires is not lost: the model run is deliberately
 * decoupled from the response stream, so the turn still completes and is
 * stored, and the client refetches it. The conversation claim it holds is
 * covered by its lease, so even a hard kill frees the conversation rather than
 * locking it.
 */
onShutdown(
  async () => {
    await mq.stopConsuming();
    // An open event stream would hold the server open until it ended.
    await events.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
  },
  { graceMs: 30_000 },
);
