import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ReplyStreamEvents, TurnStats } from "@parley/contract";
import type { ReplyInProgressEntry } from "@parley/server-kit/memory/repliesInProgress";
import { logger } from "@parley/server-kit/runtime/logger";
import { SSEEventQueue } from "@parley/server-kit/sse/eventQueue";
import {
  msSince,
  stepsInOrder,
  type RecordedStep,
} from "../preparationMetrics";
import { NoRoomToReply } from "../ai";
import { eventHub } from "../sse/hub";
import { memory } from "../memory";
import {
  answerTurn,
  TurnRejected,
  type PreparedTurn,
  type TurnRequest,
} from "./turn";
import type { TurnClaim } from "./turnClaim";

/**
 * Answers a turn as server-sent events: `delta` ({ delta }) per model chunk,
 * then `done` ({ lastMessageId, stopped, stats }) once the turn is stored, `cancelled`
 * if it was stopped before any reply came, or `error` ({ message }) if the
 * model call fails. A turn rejected before the model is
 * asked gets a plain JSON error instead. The client reads the stream with
 * fetch + response.body.getReader() (EventSource can't POST).
 *
 * The run that produces the reply is decoupled from the response stream, so a
 * client that disconnects mid-stream still has its turn run to completion and
 * saved; GET .../messages is the source of truth.
 *
 * The turn owns its claim throughout: saving the turn releases it in the same
 * transaction, and anything that fails releases it here or in writeReply. `prepare` settles
 * everything the turn needs and throws if it can't run, so nothing it destroys
 * (an edit's rewind) is destroyed for a turn that was never going to happen.
 */
export async function streamTurn(
  c: Context,
  request: TurnRequest,
  metrics: TurnMetrics,
  claim: TurnClaim,
  prepare: () => Promise<PreparedTurn>,
) {
  let prepared: PreparedTurn;
  try {
    prepared = await prepare();
  } catch (error) {
    // Released before answering, so a client that retries at once doesn't
    // meet its own claim.
    await claim.release();
    if (error instanceof TurnRejected) {
      return c.json(error.body, error.status);
    }
    throw error;
  }

  // An entry for this reply while it's being written, so a page reloaded
  // midway can show it and the stop button can reach it. It holds the
  // user's message too, which isn't saved until the turn is.
  const entry = memory.repliesInProgress.add(
    request.userId,
    request.conversationId,
    request.content,
  );
  const sseEvents = new SSEEventQueue<ReplyStreamEvents>();

  // Not awaited: the response goes back now, and the reply is written and
  // saved whether or not the client stays to read it.
  void writeReply({
    request,
    metrics,
    claim,
    prepared,
    entry,
    sseEvents,
  }).catch((error: unknown) => logger.error("Writing a reply failed", error));
  return streamSSE(c, (stream) => sseEvents.pipeTo(stream, c.req.raw.signal));
}

/**
 * Runs the model and saves the turn, pushing each piece of the reply to
 * `sseEvents`, then `done`, `cancelled` or `error`. However it ends, it ends
 * the stream, removes the reply's entry and sends `replyFinished`.
 */
async function writeReply({
  request,
  metrics,
  claim,
  prepared,
  entry,
  sseEvents,
}: {
  request: TurnRequest;
  metrics: TurnMetrics;
  claim: TurnClaim;
  prepared: PreparedTurn;
  entry: ReplyInProgressEntry;
  sseEvents: SSEEventQueue<ReplyStreamEvents>;
}) {
  const modelStartedAfterMs = msSince(metrics.startedAt);
  const timings: ModelTimings = {
    modelStartedAfterMs,
    firstTokenAfterMs: null,
    modelFinishedAfterMs: modelStartedAfterMs,
  };

  try {
    const answer = await answerTurn(
      request,
      claim,
      prepared,
      entry,
      (delta) => {
        if (delta.length > 0 && timings.firstTokenAfterMs === null) {
          timings.firstTokenAfterMs = msSince(metrics.startedAt);
          metrics.log.info("Message first token generated", {
            modelStartedAfterMs,
            modelTimeToFirstTokenMs:
              timings.firstTokenAfterMs - modelStartedAfterMs,
            firstTokenAfterMs: timings.firstTokenAfterMs,
          });
        }
        sseEvents.push("delta", { delta });
      },
      () => {
        timings.modelFinishedAfterMs = msSince(metrics.startedAt);
      },
    );

    if (answer) {
      sseEvents.push("done", {
        ...answer,
        stats: {
          steps: stepsInOrder(metrics.steps),
          ...timings,
          totalMs: msSince(metrics.startedAt),
          context: prepared.contextStats,
        },
      });
    } else {
      await claim.release();
      sseEvents.push("cancelled", {});
    }
  } catch (error) {
    await claim.release();
    sseEvents.push("error", {
      message:
        error instanceof NoRoomToReply
          ? error.message
          : "Model response failed",
    });
  } finally {
    sseEvents.end();
    entry.remove();
    // For a page that was reloaded mid-reply: its stream is gone, and this is
    // how it hears the turn is saved.
    eventHub.send(request.userId, "replyFinished", {
      conversationId: request.conversationId,
    });
  }
}

/** When the model started, wrote its first token and finished, in ms after the request came in. */
type ModelTimings = Pick<
  TurnStats,
  "modelStartedAfterMs" | "firstTokenAfterMs" | "modelFinishedAfterMs"
>;

export type TurnMetrics = {
  log: Pick<typeof logger, "info">;
  startedAt: number;
  steps: RecordedStep[];
};
