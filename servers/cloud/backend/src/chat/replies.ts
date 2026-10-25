import { createReplyRegistry } from "@parley/server-kit/chat/replies";

/** The replies this instance is writing, by owner and conversation. */
export const replies = createReplyRegistry();

/** A user only ever reaches their own conversations' replies. */
export function replyKey(userId: string, conversationId: string) {
  return `${userId}/${conversationId}`;
}
