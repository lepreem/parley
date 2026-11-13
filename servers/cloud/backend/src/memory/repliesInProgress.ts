/** The replies this instance is writing, by owner and conversation. */

import { createRepliesInProgress } from "@parley/server-kit/memory/repliesInProgress";

const byKey = createRepliesInProgress();

/** A user only ever reaches their own conversations' replies. */
const keyOf = (userId: string, conversationId: string) =>
  `${userId}/${conversationId}`;

export const add = (userId: string, conversationId: string, content: string) =>
  byKey.add(keyOf(userId, conversationId), content);

export const find = (userId: string, conversationId: string) =>
  byKey.find(keyOf(userId, conversationId));

export const stop = (userId: string, conversationId: string) =>
  byKey.stop(keyOf(userId, conversationId));
