import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  AttachmentTurnReservations,
  Attachments,
  Conversations,
  db,
  type Executor,
} from "../db";
import * as conversations from "./conversations.data";
import * as messageAttachmentLinks from "./messageAttachmentLinks.data";
import * as storageLedger from "./storageLedger.data";

type AttachmentValues = Pick<
  typeof Attachments.$inferInsert,
  | "attachmentId"
  | "kind"
  | "userId"
  | "fileName"
  | "mimeType"
  | "sizeBytes"
  | "signedUrl"
  | "signedUrlExpiresAt"
>;

type DeleteAttachmentInput = {
  userId: string;
  attachmentId: string;
  kind: AttachmentValues["kind"];
};

type DeleteAttachmentsInput = {
  userId: string;
  attachmentIds: readonly string[];
  kind: AttachmentValues["kind"];
};

type OwnedAttachments = {
  userId: string;
  attachmentIds?: readonly string[];
  kind: AttachmentValues["kind"];
};

export function userOwnsAttachments(input: OwnedAttachments) {
  return and(
    eq(Attachments.userId, input.userId),
    eq(Attachments.kind, input.kind),
    input.attachmentIds === undefined
      ? undefined
      : inArray(Attachments.attachmentId, [...input.attachmentIds]),
  );
}

function ownedUnlinkedUnreservedAttachments(
  input: DeleteAttachmentsInput,
  executor: Executor,
) {
  return and(
    userOwnsAttachments(input),
    messageAttachmentLinks.attachmentIsUnlinked(executor),
    attachmentIsUnreserved(),
  );
}

function attachmentIsUnreserved() {
  // A slow provider may outlive the lease while its conversation claim still owns the turn.
  return sql`not exists (
    select 1 from ${AttachmentTurnReservations}
    where ${AttachmentTurnReservations.attachmentId} = ${Attachments.attachmentId}
      and (${AttachmentTurnReservations.expiresAt} > now() or exists (
        select 1 from ${Conversations}
        where ${Conversations.activeTurnClaimToken} = ${AttachmentTurnReservations.claimToken}
      ))
  )`;
}

async function lockOwnedAttachments(
  userId: string,
  attachmentIds: readonly string[],
  executor: Executor,
) {
  return executor
    .select({ attachmentId: Attachments.attachmentId })
    .from(Attachments)
    .where(
      and(
        eq(Attachments.userId, userId),
        inArray(Attachments.attachmentId, [...attachmentIds]),
      ),
    )
    .orderBy(asc(Attachments.attachmentId))
    .for("update");
}

export async function claimAttachments(
  userId: string,
  attachmentIds: readonly string[],
  claimToken: string,
) {
  const uniqueAttachmentIds = [...new Set(attachmentIds)];
  if (uniqueAttachmentIds.length === 0) return true;

  const [result] = await db.execute<{ reservationCount: number }>(sql`
    with locked_attachments as materialized (
      select ${Attachments.attachmentId}
      from ${Attachments}
      where ${Attachments.userId} = ${userId}
        and ${inArray(Attachments.attachmentId, uniqueAttachmentIds)}
      order by ${Attachments.attachmentId}
      for update
    ),
    inserted_reservations as (
      insert into ${AttachmentTurnReservations} (
        ${sql.identifier(AttachmentTurnReservations.attachmentId.name)},
        ${sql.identifier(AttachmentTurnReservations.claimToken.name)},
        ${sql.identifier(AttachmentTurnReservations.expiresAt.name)}
      )
      select
        ${sql.identifier(Attachments.attachmentId.name)},
        ${claimToken},
        ${new Date(Date.now() + conversations.CLAIM_LEASE_MS).toISOString()}::timestamptz
      from locked_attachments
      where (
        select count(*) from locked_attachments
      ) = ${uniqueAttachmentIds.length}
      returning ${AttachmentTurnReservations.attachmentId}
    )
    select count(*)::integer as "reservationCount"
    from inserted_reservations
  `);

  return result?.reservationCount === uniqueAttachmentIds.length;
}

export async function unclaimAttachments(
  claimToken: string,
  executor: Executor = db,
) {
  await executor
    .delete(AttachmentTurnReservations)
    .where(eq(AttachmentTurnReservations.claimToken, claimToken));
}

export async function createAttachment(
  values: AttachmentValues,
  executor: Executor = db,
) {
  await executor.insert(Attachments).values(values);
}

export async function deleteOwnedUnlinkedUnreservedAttachment(
  input: DeleteAttachmentInput,
  executor: Executor = db,
) {
  const [deletedAttachmentId] = await deleteOwnedUnlinkedUnreservedAttachments(
    {
      userId: input.userId,
      attachmentIds: [input.attachmentId],
      kind: input.kind,
    },
    executor,
  );

  return deletedAttachmentId ?? null;
}

export async function deleteOwnedUnlinkedUnreservedAttachments(
  input: DeleteAttachmentsInput,
  executor: Executor = db,
): Promise<string[]> {
  const attachmentIds = [...new Set(input.attachmentIds)];
  if (attachmentIds.length === 0) return [];

  if (executor === db) {
    return db.transaction((transaction) =>
      deleteOwnedUnlinkedUnreservedAttachments(input, transaction),
    );
  }

  // Recheck references in a fresh statement after any competing reservation commits.
  await lockOwnedAttachments(input.userId, attachmentIds, executor);

  const deletedAttachments = await executor
    .delete(Attachments)
    .where(
      ownedUnlinkedUnreservedAttachments({ ...input, attachmentIds }, executor),
    )
    .returning({
      attachmentId: Attachments.attachmentId,
    });
  const deletedIds = deletedAttachments.map(
    (attachment) => attachment.attachmentId,
  );

  // Same transaction: once the rows are gone, the objects are due for
  // removal on record, whatever happens to the caller's storage delete.
  await storageLedger.markDeleted(
    input.userId,
    deletedIds.map((uploadId) => ({ kind: input.kind, uploadId })),
    executor,
  );

  return deletedIds;
}
