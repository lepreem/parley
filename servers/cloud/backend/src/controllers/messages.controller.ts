// TODO: stop referring to ONLY images as attachments. attachments means both in one var, seperated by "kind" attr.

import type { ChatMessage, MessagesResponse } from "@parley/contract";
import { randomUUID } from "node:crypto";
import { logger } from "@parley/server-kit/runtime/logger";
import {
  data,
  type MessageRow,
  type ResolvedImage,
  type StoredTranscriptAttachment,
} from "../data";
import {
  measurePreparation,
  withPreparationMetrics,
} from "../preparationMetrics";
import { uploads } from "../uploads";
import { memory, replyKey } from "../memory";
import { streamTurn, type TurnMetrics } from "../chat/replyStream";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { conversationReqParamSchema } from "../schema/conversations.schema";
import {
  messageCreateBodySchema,
  messageReqParamSchema,
} from "../schema/messages.schema";
import {
  prepareTurn,
  rewindTo,
  turnRequestFrom,
  type TurnRequest,
} from "../chat/turn";
import { claimTurn } from "../chat/turnClaim";

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
    const replyInProgress = memory.repliesInProgress.find(
      replyKey(userId, conversationId),
    );

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
    return memory.repliesInProgress.stop(replyKey(c.var.userId, conversationId))
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
