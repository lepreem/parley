import { randomUUID } from "node:crypto";
import { logger } from "@parley/shared/logger";
import { data } from "../data";
import { measurePreparation } from "../preparationMetrics";

const log = logger.child({ component: "turn-claim" });

/**
 * What one turn holds while it runs: the conversation, so no other turn
 * answers it at the same time, and its attachments, so none is deleted out
 * from under it. Both are taken under one token.
 */
export type TurnClaim = {
  token: string;
  /** Groups the claim's timings with the reads prepareTurn runs beside it. */
  preparationId: string;
  /** False when the conversation moved on or another turn holds it. */
  conversationClaimedPromise: Promise<boolean>;
  /** False when an attachment is missing or not the user's. */
  attachmentsReservedPromise: Promise<boolean>;
  /**
   * Lets go of both, for a turn that won't be saved. A saved turn lets go in
   * the transaction that saves it, so it never calls this. Never throws.
   */
  release(): Promise<void>;
};

/**
 * Starts taking the claim and the reservations. Neither is awaited here, so
 * the caller can read everything else the turn needs alongside them.
 */
export function claimTurn(request: {
  userId: string;
  conversationId: string;
  expectedLastMessageId: string | null;
  attachmentIds: readonly string[];
}): TurnClaim {
  const token = randomUUID();
  const preparationId = randomUUID();
  const conversationClaimedPromise = measurePreparation(
    "claimConversationTurn",
    preparationId,
    () =>
      data.conversations.claimConversationTurn(
        request.userId,
        request.conversationId,
        request.expectedLastMessageId,
        token,
      ),
  ).then((claimToken) => claimToken !== null);
  const attachmentsReservedPromise = measurePreparation(
    "claimAttachments",
    preparationId,
    () =>
      data.attachments.claimAttachments(
        request.userId,
        request.attachmentIds,
        token,
      ),
  );

  async function release() {
    // A failed read elsewhere doesn't cancel the claim; let it land before
    // undoing it, or the undo could run first and leave it held.
    await Promise.allSettled([
      conversationClaimedPromise,
      attachmentsReservedPromise,
    ]);
    await data.attachments.unclaimAttachments(token).catch((error) => {
      log.error("Failed to release attachment reservations", error, {
        conversationId: request.conversationId,
      });
    });
    await data.conversations
      .unclaimConversationTurn(request.userId, request.conversationId, token)
      .catch((error) => {
        log.error("Failed to release conversation turn claim", error, {
          conversationId: request.conversationId,
        });
      });
  }

  return {
    token,
    preparationId,
    conversationClaimedPromise,
    attachmentsReservedPromise,
    release,
  };
}
