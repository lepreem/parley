import { createRepliesInProgress } from "@parley/server-kit/memory/repliesInProgress";

/** The replies this instance is writing, by owner and conversation. */
export const repliesInProgress = createRepliesInProgress();

/** A user only ever reaches their own conversations' replies. */
export function replyKey(userId: string, conversationId: string) {
  return `${userId}/${conversationId}`;
}
