import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ReplyStreamEvents } from "@parley/contract";
import type { TrackedReply } from "@parley/server-kit/chat/replies";
import type { logger } from "@parley/server-kit/runtime/logger";
import { SSEEventQueue } from "@parley/server-kit/sse/replyQueue";
import {
  msSince,
  stepsInOrder,
  type RecordedStep,
} from "../preparationMetrics";
import { eventHub } from "../sse/hub";
import { replies, replyKey } from "./replies";
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
    const replyEvents = new SSEEventQueue<ReplyStreamEvents>();
    let streamResponse: Response | undefined;
    let reply: TrackedReply | undefined; // TODO: make it somehow clearer in the name that this is an in memory thing?

    try {
      const prepared = await prepare();
      reply = replies.start(
        // adds entry for this user, for recovering a stream if the user refreshes in the mid of it, and also allows the user to stop the stream
        replyKey(request.userId, request.conversationId),
        request.content, // the user's message isnt written in the db yet, so we also need to store it to recover it for the mid-refreshs
      );

      streamResponse = streamSSE(c, (stream) =>
        replyEvents.pipeTo(stream, c.req.raw.signal),
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
        reply,
        (delta) => {
          if (delta.length > 0 && firstTokenAfterMs === null) {
            firstTokenAfterMs = msSince(metrics.startedAt);
            metrics.log.info("Message first token generated", {
              modelStartedAfterMs,
              modelTimeToFirstTokenMs: msSince(modelStartedAt),
              firstTokenAfterMs,
            });
          }
          replyEvents.push("delta", { delta });
        },
        () => {
          modelFinishedAfterMs = msSince(metrics.startedAt);
        },
      );

      if (answer) {
        replyEvents.push("done", {
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
        replyEvents.push("cancelled", {});
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

      replyEvents.push("error", { message: "Model response failed" });
      return streamResponse;
    } finally {
      replyEvents.end();
      if (reply) {
        reply.end();
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
