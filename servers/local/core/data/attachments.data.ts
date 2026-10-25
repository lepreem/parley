import { and, eq, inArray, sql } from "drizzle-orm";
import {
  AttachmentTurnReservations,
  Attachments,
  Conversations,
  db,
  type Executor,
} from "../db";
import { CLAIM_LEASE_MS } from "./conversations.data";
import { messageAttachmentLinks } from "./messageAttachmentLinks.data";

type AttachmentValues = Pick<
  typeof Attachments.$inferInsert,
  "attachmentId" | "kind" | "fileName" | "mimeType" | "sizeBytes"
>;

type DeleteAttachmentInput = {
  attachmentId: string;
  kind: AttachmentValues["kind"];
};

type DeleteAttachmentsInput = {
  attachmentIds: readonly string[];
  kind: AttachmentValues["kind"];
};

type AttachmentsOfKind = {
  attachmentIds?: readonly string[];
  kind: AttachmentValues["kind"];
};

function attachmentsOfKind(input: AttachmentsOfKind) {
  return and(
    eq(Attachments.kind, input.kind),
    input.attachmentIds === undefined
      ? undefined
      : inArray(Attachments.attachmentId, [...input.attachmentIds]),
  );
}

function unlinkedUnreservedAttachments(
  input: DeleteAttachmentsInput,
  executor: Executor,
) {
  return and(
    attachmentsOfKind(input),
    messageAttachmentLinks.attachmentIsUnlinked(executor),
    attachmentIsUnreserved(),
  );
}

function attachmentIsUnreserved() {
  // A slow provider may outlive the lease while its conversation claim still owns the turn.
  return sql`not exists (
    select 1 from ${AttachmentTurnReservations}
    where ${AttachmentTurnReservations.attachmentId} = ${Attachments.attachmentId}
      and (${AttachmentTurnReservations.expiresAt} > ${Date.now()} or exists (
        select 1 from ${Conversations}
        where ${Conversations.activeTurnClaimToken} = ${AttachmentTurnReservations.claimToken}
      ))
  )`;
}

/**
 * Reserves every one of the attachments for the turn, or none of them: false
 * when any is gone.
 */
async function claimAttachments(
  attachmentIds: readonly string[],
  claimToken: string,
) {
  const uniqueAttachmentIds = [...new Set(attachmentIds)];
  if (uniqueAttachmentIds.length === 0) return true;

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ attachmentId: Attachments.attachmentId })
      .from(Attachments)
      .where(inArray(Attachments.attachmentId, uniqueAttachmentIds));
    if (existing.length !== uniqueAttachmentIds.length) return false;

    const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS);
    await tx.insert(AttachmentTurnReservations).values(
      existing.map(({ attachmentId }) => ({
        attachmentId,
        claimToken,
        expiresAt,
      })),
    );
    return true;
  });
}

async function unclaimAttachments(claimToken: string, executor: Executor = db) {
  await executor
    .delete(AttachmentTurnReservations)
    .where(eq(AttachmentTurnReservations.claimToken, claimToken));
}

async function createAttachment(
  values: AttachmentValues,
  executor: Executor = db,
) {
  await executor.insert(Attachments).values(values);
}

async function deleteUnlinkedUnreservedAttachment(
  input: DeleteAttachmentInput,
  executor: Executor = db,
) {
  const [deletedAttachmentId] = await deleteUnlinkedUnreservedAttachments(
    { attachmentIds: [input.attachmentId], kind: input.kind },
    executor,
  );

  return deletedAttachmentId ?? null;
}

async function deleteUnlinkedUnreservedAttachments(
  input: DeleteAttachmentsInput,
  executor: Executor = db,
): Promise<string[]> {
  const attachmentIds = [...new Set(input.attachmentIds)];
  if (attachmentIds.length === 0) return [];

  if (executor === db) {
    return db.transaction((transaction) =>
      deleteUnlinkedUnreservedAttachments(input, transaction),
    );
  }

  const deletedAttachments = await executor
    .delete(Attachments)
    .where(unlinkedUnreservedAttachments({ ...input, attachmentIds }, executor))
    .returning({
      attachmentId: Attachments.attachmentId,
    });
  return deletedAttachments.map((attachment) => attachment.attachmentId);
}

/** Every attachment's id: the files that are in use. */
async function findAttachmentIds() {
  const rows = await db
    .select({ attachmentId: Attachments.attachmentId })
    .from(Attachments);
  return new Set(rows.map((row) => row.attachmentId));
}

export const attachments = {
  findAttachmentIds,
  attachmentsOfKind,
  claimAttachments,
  unclaimAttachments,
  createAttachment,
  deleteUnlinkedUnreservedAttachment,
  deleteUnlinkedUnreservedAttachments,
};
