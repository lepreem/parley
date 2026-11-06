import type { Conversation } from "../../api/conversations";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ConversationGroup = {
  label: string;
  conversations: Conversation[];
};

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function groupLabel(updatedAt: string, todayStart: number): string {
  const time = new Date(updatedAt).getTime();
  if (Number.isNaN(time)) return "Earlier";
  if (time >= todayStart) return "Today";
  if (time >= todayStart - DAY_MS) return "Yesterday";
  if (time >= todayStart - 7 * DAY_MS) return "Previous 7 days";
  if (time >= todayStart - 30 * DAY_MS) return "Previous 30 days";
  return "Earlier";
}

const ORDER = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Earlier",
];

/** Buckets the list by recency, keeping the server's most-recent-first order. */
export function groupConversations(
  conversations: Conversation[],
): ConversationGroup[] {
  const todayStart = startOfToday();
  const buckets = new Map<string, Conversation[]>();

  for (const conversation of conversations) {
    const label = groupLabel(conversation.updatedAt, todayStart);
    const bucket = buckets.get(label) ?? [];
    bucket.push(conversation);
    buckets.set(label, bucket);
  }

  return ORDER.flatMap((label) => {
    const conversationsInGroup = buckets.get(label);
    return conversationsInGroup
      ? [{ label, conversations: conversationsInGroup }]
      : [];
  });
}
