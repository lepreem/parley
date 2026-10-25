// TODO: stop referring to ONLY images as attachments. attachments means both in one var, seperated by "kind" attr.

import type { Context } from "hono";
import type {
  ChatMessage,
  MessagesResponse,
  ReplyStreamEvents,
} from "@parley/contract";
import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { logger } from "@parley/server-kit/runtime/logger";
import { SSEEventQueue } from "@parley/server-kit/sse/replyQueue";
import type { TrackedReply } from "@parley/server-kit/chat/replies";
import {
  data,
  type MessageRow,
  type ResolvedImage,
  type StoredTranscriptAttachment,
} from "../data";
import {
  measurePreparation,
  msSince,
  stepsInOrder,
  withPreparationMetrics,
  type RecordedStep,
} from "../preparationMetrics";
import { uploads } from "../uploads";
import { events as serverEvents } from "../events";
import { replies, replyKey } from "../replies";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { conversationReqParamSchema } from "../schema/conversations.schema";
import {
  messageCreateBodySchema,
  messageReqParamSchema,
} from "../schema/messages.schema";
import {
  answerTurn,
  prepareTurn,
  rewindTo,
  turnRequestFrom,
  TurnRejected,
  type PreparedTurn,
  type TurnRequest,
} from "../chat/turn";
import { claimTurn, type TurnClaim } from "../chat/turnClaim";

function toMessageJson(
  row: MessageRow,
  images: ResolvedImage[] = [],
  transcripts: StoredTranscriptAttachment[] = [],
): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    chosenModelId: row.chosenModelId,
    stopped: row.stopped,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
    attachments: images,
    transcriptAttachments: transcripts.map(
      ({ charCount: _charCount, ...attachment }) => attachment,
    ),
  };
}

/** Assistant turns never carry images, so they're not worth looking up. */
function userMessageIds(
  rows: readonly { id: string; role: MessageRow["role"] }[],
) {
  return rows.filter((row) => row.role === "user").map((row) => row.id);
}

/** GET /conversations/:conversationId/messages — full history, oldest first. */
export const handleListMessages = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId } = c.req.valid("param");

    // Read before the rows: a reply that ends in between is then in both,
    // until the replyFinished it sends has the client read again, rather than
    // in neither, with nothing to say it's missing.
    const replyInProgress = replies.find(replyKey(userId, conversationId));

    // Ownership check and the rows themselves are independent reads; the rows
    // are simply discarded on the 404 path.
    const [ownedConversation, rows] = await Promise.all([
      data.conversations.findOwnedConversation(userId, conversationId),
      data.messages.findConversationMessages(conversationId),
    ]);

    if (!ownedConversation)
      return c.json({ message: "Conversation not found" }, 404);

    const messageIds = userMessageIds(rows);
    const [imagesByMessageId, transcriptsByMessageId] = await Promise.all([
      data.images.resolveMessageImages(userId, messageIds),
      data.transcripts.findMessageTranscriptAttachments(userId, messageIds),
    ]);

    return c.json({
      lastMessageId: ownedConversation.lastMessageId,
      messages: rows.map((row) =>
        toMessageJson(
          row,
          imagesByMessageId.get(row.id),
          transcriptsByMessageId.get(row.id),
        ),
      ),
      replyInProgress,
    } satisfies MessagesResponse);
  },
);

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
function streamTurn(
  c: Context,
  request: TurnRequest,
  metrics: TurnMetrics,
  claim: TurnClaim,
  prepare: () => Promise<PreparedTurn>,
) {
  const responseReady = Promise.withResolvers<Response>();

  // The HTTP response can be ready before the task that owns the claim finishes.
  void (async () => {
    const events = new SSEEventQueue<ReplyStreamEvents>();
    let streamResponse: Response | undefined;
    let reply: TrackedReply | undefined;

    try {
      const prepared = await prepare();
      reply = replies.start(
        replyKey(request.userId, request.conversationId),
        request.content,
      );

      streamResponse = streamSSE(c, (stream) =>
        events.pipeTo(stream, c.req.raw.signal),
      );
      responseReady.resolve(streamResponse);

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
          events.push("delta", { delta });
        },
        () => {
          modelFinishedAfterMs = msSince(metrics.startedAt);
        },
      );

      if (answer) {
        events.push("done", {
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
        events.push("cancelled", {});
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

      events.push("error", { message: "Model response failed" });
      return streamResponse;
    } finally {
      events.end();
      if (reply) {
        reply.end();
        // For a page that was reloaded mid-reply: its stream is gone, and
        // this is how it hears the turn is saved.
        serverEvents.send(request.userId, "replyFinished", {
          conversationId: request.conversationId,
        });
      }
    }
  })().then(responseReady.resolve, responseReady.reject);

  return responseReady.promise;
}

type TurnMetrics = {
  log: Pick<typeof logger, "info">;
  startedAt: number;
  steps: RecordedStep[];
};

/**
 * Times every step of a turn from the handler's start (after auth and body
 * validation). Each step logs "Message preparation operation completed"; the
 * claims and the reads that run beside them share a promiseAllId, so the
 * slowest of them is what the turn waited for. The steps are kept too, for
 * the stats the turn's `done` carries.
 */
function withTurnMetrics<T>(
  request: TurnRequest,
  run: (metrics: TurnMetrics) => T,
): T {
  const metrics = {
    log: logger.child({
      controller: "messages",
      requestId: randomUUID(),
      conversationId: request.conversationId,
    }),
    startedAt: performance.now(),
    steps: [],
  };
  return withPreparationMetrics(metrics, () => run(metrics));
}

/** POST /conversations/:conversationId/messages — answer a new user turn. */
export const handleCreateMessage = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  validate("json", messageCreateBodySchema),
  async (c) => {
    const request = turnRequestFrom(
      c.var.userId,
      c.req.valid("param").conversationId,
      c.req.valid("json"),
    );
    return withTurnMetrics(request, (metrics) => {
      const claim = claimTurn(request);
      return streamTurn(c, request, metrics, claim, () =>
        prepareTurn(request, claim),
      );
    });
  },
);

/**
 * PATCH /conversations/:conversationId/messages/:messageId — replace a message
 * and everything after it with a fresh turn. The claim is taken up front, the
 * new turn is validated, and only then is the old tail dropped, so a request
 * that would be rejected takes nothing with it. The replacement is a new
 * message; the edited one is gone.
 */
export const handlePatchMessage = authed.createHandlers(
  validate("param", messageReqParamSchema),
  validate("json", messageCreateBodySchema),
  async (c) => {
    const { conversationId, messageId } = c.req.valid("param");
    const request = turnRequestFrom(
      c.var.userId,
      conversationId,
      c.req.valid("json"),
    );
    return withTurnMetrics(request, (metrics) => {
      const claim = claimTurn(request);
      return streamTurn(c, request, metrics, claim, async () => {
        const prepared = await prepareTurn(request, claim, messageId);
        await measurePreparation("rewindTo", undefined, () =>
          rewindTo(request, claim, messageId),
        );
        return prepared;
      });
    });
  },
);

/**
 * POST /conversations/:conversationId/messages/stop — stops the reply being
 * written. Its turn's stream ends as stopping leaves it: `done` with the
 * reply saved so far, or `cancelled` if none had come.
 *
 * Its own request, because the reply stream closing isn't one: that's also
 * what a dropped connection looks like, and a reply outlives those.
 */
export const handleStopReply = authed.createHandlers(
  validate("param", conversationReqParamSchema),
  (c) => {
    const { conversationId } = c.req.valid("param");
    return replies.stop(replyKey(c.var.userId, conversationId))
      ? c.body(null, 204)
      : c.json({ message: "No reply in progress" }, 404);
  },
);

/** DELETE /conversations/:conversationId/messages/:messageId */
export const handleDeleteMessage = authed.createHandlers(
  validate("param", messageReqParamSchema),
  async (c) => {
    const { userId } = c.var;
    const { conversationId, messageId } = c.req.valid("param");

    const result = await data.messages.deleteOwnedMessage(
      userId,
      conversationId,
      messageId,
    );

    if (!result) return c.json({ message: "Message not found" }, 404);
    // Without `onlyRole` the only other outcome is a claimed turn.
    if (result.status !== "deleted")
      return c.json({ message: "A response is already in progress" }, 409);

    await uploads.deleteObjects(
      userId,
      result.imageUploadIds.map((uploadId) => ({ kind: "image", uploadId })),
    );
    return c.json({ message: "Message deleted" }, 200);
  },
);
