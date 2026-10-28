import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ReplyStreamEvents } from "@parley/contract";
import type { ReplyInProgressEntry } from "@parley/server-kit/memory/repliesInProgress";
import type { logger } from "@parley/server-kit/runtime/logger";
import { SSEEventQueue } from "@parley/server-kit/sse/eventQueue";
import {
  msSince,
  stepsInOrder,
  type RecordedStep,
} from "../preparationMetrics";
import { eventHub } from "../sse/hub";
import { memory, replyKey } from "../memory";
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
 * transaction, and anything that fails releases it here. `prepare` settles
 * everything the turn needs and throws if it can't run, so nothing it destroys
 * (an edit's rewind) is destroyed for a turn that was never going to happen.
 */
export function streamTurn(
  c: Context,
  request: TurnRequest,
  metrics: TurnMetrics,
  claim: TurnClaim,
  prepare: () => Promise<PreparedTurn>,
) {
  // TODO: move responseReady, streamResponse
  const responseReady = Promise.withResolvers<Response>();

  // The HTTP response can be ready before the task that owns the claim finishes.
  void (async () => {
    const sseEvents = new SSEEventQueue<ReplyStreamEvents>();
    let streamResponse: Response | undefined;
    let entryToRemove: ReplyInProgressEntry | undefined;

    try {
      const prepared = await prepare();
      // An entry for this reply while it's being written, so a page reloaded
      // midway can show it and the stop button can reach it. It holds the
      // user's message too, which isn't saved until the turn is.
      const entry = memory.repliesInProgress.add(
        replyKey(request.userId, request.conversationId),
        request.content,
      );
      entryToRemove = entry;

      streamResponse = streamSSE(c, (stream) =>
        sseEvents.pipeTo(stream, c.req.raw.signal),
      );
      responseReady.resolve(streamResponse);

      // TODO: make this one stats object?
      const modelStartedAt = performance.now();
      const modelStartedAfterMs = msSince(metrics.startedAt);
      let firstTokenAfterMs: number | null = null;
      let modelFinishedAfterMs = modelStartedAfterMs;

      const answer = await answerTurn(
        request,
        claim,
        prepared,
        entry,
        (delta) => {
          if (delta.length > 0 && firstTokenAfterMs === null) {
            firstTokenAfterMs = msSince(metrics.startedAt);
            metrics.log.info("Message first token generated", {
              modelStartedAfterMs,
              modelTimeToFirstTokenMs: msSince(modelStartedAt),
              firstTokenAfterMs,
            });
          }
          sseEvents.push("delta", { delta });
        },
        () => {
          modelFinishedAfterMs = msSince(metrics.startedAt);
        },
      );

      if (answer) {
        sseEvents.push("done", {
          ...answer,
          stats: {
            steps: stepsInOrder(metrics.steps),
            modelStartedAfterMs,
            firstTokenAfterMs,
            modelFinishedAfterMs,
            totalMs: msSince(metrics.startedAt),
            context: prepared.contextStats,
          },
        });
      } else {
        await claim.release();
        sseEvents.push("cancelled", {});
      }
      return streamResponse;
    } catch (error) {
      // Released before answering, so a client that retries at once doesn't
      // meet its own claim.
      await claim.release();

      if (!streamResponse) {
        if (error instanceof TurnRejected) {
          return c.json(error.body, error.status);
        }
        throw error;
      }

      sseEvents.push("error", { message: "Model response failed" });
      return streamResponse;
    } finally {
      sseEvents.end();
      if (entryToRemove) {
        entryToRemove.remove();
        // For a page that was reloaded mid-reply: its stream is gone, and
        // this is how it hears the turn is saved.
        eventHub.send(request.userId, "replyFinished", {
          conversationId: request.conversationId,
        });
      }
    }
  })().then(responseReady.resolve, responseReady.reject);

  return responseReady.promise;
}

export type TurnMetrics = {
  log: Pick<typeof logger, "info">;
  startedAt: number;
  steps: RecordedStep[];
};
