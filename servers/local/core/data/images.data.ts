import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  db,
  type Executor,
} from "../db";
import type { UploadId } from "@parley/server-kit/ids";
import { attachments } from "./attachments.data";

/** What the client is told about an image, and what the model needs of it. */
const imageAttachmentColumns = {
  imageUploadId: Attachments.attachmentId,
  fileName: Attachments.fileName,
  mimeType: Attachments.mimeType,
  sizeBytes: Attachments.sizeBytes,
};

type ImageAttachmentRow = {
  imageUploadId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
};

/**
 * Where an image's bytes are served. Relative to this server, which may be
 * reached by more than one name (this machine's, or its Tailscale one).
 */
function imageUrl(imageUploadId: string) {
  return `/upload/image/${imageUploadId}`;
}

/** One image as the client receives it. */
export type ResolvedImage = {
  imageUploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
};

/** The row for an image whose file is already written. */
async function createImageAttachment(input: {
  imageUploadId: UploadId;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  await attachments.createAttachment({
    attachmentId: input.imageUploadId,
    kind: "image",
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  });
}

/** The image rows with these ids, narrowed further by `filter`. */
async function findImageAttachments(
  imageUploadIds: readonly string[],
  filter: SQL | undefined,
): Promise<ImageAttachmentRow[]> {
  return db
    .select(imageAttachmentColumns)
    .from(Attachments)
    .where(
      and(
        attachments.attachmentsOfKind({
          attachmentIds: imageUploadIds,
          kind: "image",
        }),
        filter,
      ),
    )
    .orderBy(asc(Attachments.createdAt), asc(Attachments.attachmentId));
}

function toResolvedImage(row: ImageAttachmentRow): ResolvedImage {
  return {
    imageUploadId: row.imageUploadId,
    fileName: row.fileName,
    mimeType: row.mimeType ?? "application/octet-stream",
    size: row.sizeBytes,
    url: imageUrl(row.imageUploadId),
  };
}

/**
 * The images with these ids, narrowed by `filter`, in the order asked for;
 * ids with no image row are dropped.
 */
async function resolveImagesWhere(
  // Plain strings, not UploadId: these arrive from the wire (a request body or
  // a stored row), and are only trusted after findImageAttachments matches them
  // against image rows.
  imageUploadIds: readonly string[],
  filter: SQL | undefined,
): Promise<ResolvedImage[]> {
  if (imageUploadIds.length === 0) return [];

  const rows = await findImageAttachments(imageUploadIds, filter);
  const rowByImageUploadId = new Map(
    rows.map((row) => [row.imageUploadId, row]),
  );

  return imageUploadIds.flatMap((imageUploadId) => {
    const row = rowByImageUploadId.get(imageUploadId);
    return row ? [toResolvedImage(row)] : [];
  });
}

/** Images by id, whether or not they've been sent on a message. */
async function resolveImages(imageUploadIds: readonly string[]) {
  return resolveImagesWhere(imageUploadIds, undefined);
}

/**
 * The attachments of many messages at once, keyed by message id — one query for
 * a whole page of history rather than one per turn. Messages with no images are
 * absent from the map.
 */
async function resolveMessageImages(
  messageIds: readonly string[],
): Promise<Map<string, ResolvedImage[]>> {
  const imagesByMessageId = new Map<string, ResolvedImage[]>();
  if (messageIds.length === 0) return imagesByMessageId;

  const rows = await db
    .select({
      ...imageAttachmentColumns,
      messageId: ChatMessageAttachmentLinks.messageId,
    })
    .from(ChatMessageAttachmentLinks)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, ChatMessageAttachmentLinks.attachmentId),
    )
    .where(
      and(
        attachments.attachmentsOfKind({ kind: "image" }),
        inArray(ChatMessageAttachmentLinks.messageId, [...messageIds]),
      ),
    )
    .orderBy(
      asc(ChatMessageAttachmentLinks.messageId),
      asc(ChatMessageAttachmentLinks.position),
    );
  for (const row of rows) {
    if (!row.messageId) continue;

    const images = imagesByMessageId.get(row.messageId) ?? [];
    images.push(toResolvedImage(row));
    imagesByMessageId.set(row.messageId, images);
  }

  return imagesByMessageId;
}

async function findLinkedImageAttachmentIdsWhere(filter: SQL | undefined) {
  const rows = await db
    .select({ imageUploadId: Attachments.attachmentId })
    .from(ChatMessageAttachmentLinks)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, ChatMessageAttachmentLinks.attachmentId),
    )
    .where(and(attachments.attachmentsOfKind({ kind: "image" }), filter));

  return rows.map((row) => row.imageUploadId);
}

/** Same, for every message in a conversation about to be deleted. */
async function findConversationImageAttachmentIds(conversationId: string) {
  return findLinkedImageAttachmentIdsWhere(
    inArray(
      ChatMessageAttachmentLinks.messageId,
      db
        .select({ id: ChatMessages.id })
        .from(ChatMessages)
        .where(eq(ChatMessages.conversationId, conversationId)),
    ),
  );
}

/**
 * Deletes the row; the caller removes its file. Null when no unlinked,
 * unreserved image matched.
 */
async function deleteUnlinkedUnreservedImageAttachment(imageUploadId: string) {
  return attachments.deleteUnlinkedUnreservedAttachment({
    attachmentId: imageUploadId,
    kind: "image",
  });
}

async function deleteUnlinkedUnreservedImageAttachments(
  candidateAttachmentIds: readonly string[],
  executor: Executor = db,
) {
  return attachments.deleteUnlinkedUnreservedAttachments(
    { attachmentIds: candidateAttachmentIds, kind: "image" },
    executor,
  );
}

export const images = {
  imageUrl,
  createImageAttachment,
  resolveImages,
  resolveMessageImages,
  findConversationImageAttachmentIds,
  deleteUnlinkedUnreservedImageAttachment,
  deleteUnlinkedUnreservedImageAttachments,
};
