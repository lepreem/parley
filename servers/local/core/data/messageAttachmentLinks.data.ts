import { eq, notExists } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  db,
  type Executor,
} from "../db";

export function attachmentIsUnlinked(executor: Executor) {
  return notExists(
    executor
      .select({ messageId: ChatMessageAttachmentLinks.messageId })
      .from(ChatMessageAttachmentLinks)
      .where(
        eq(ChatMessageAttachmentLinks.attachmentId, Attachments.attachmentId),
      ),
  );
}

export async function linkAttachmentsToMessage(
  messageId: string,
  attachmentIds: readonly string[],
  executor: Executor = db,
) {
  if (attachmentIds.length === 0) return;

  await executor.insert(ChatMessageAttachmentLinks).values(
    attachmentIds.map((attachmentId, position) => ({
      messageId,
      attachmentId,
      position,
    })),
  );
}
