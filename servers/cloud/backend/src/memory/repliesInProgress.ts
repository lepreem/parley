import { createRepliesInProgress } from "@parley/server-kit/memory/repliesInProgress";

const byKey = createRepliesInProgress();

/** A user only ever reaches their own conversations' replies. */
const keyOf = (userId: string, conversationId: string) =>
  `${userId}/${conversationId}`;

/** The replies this instance is writing, by owner and conversation. */
export const repliesInProgress = {
  add: (userId: string, conversationId: string, content: string) =>
    byKey.add(keyOf(userId, conversationId), content),
  find: (userId: string, conversationId: string) =>
    byKey.find(keyOf(userId, conversationId)),
  stop: (userId: string, conversationId: string) =>
    byKey.stop(keyOf(userId, conversationId)),
};
