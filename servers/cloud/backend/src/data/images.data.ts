import { randomUUID } from "node:crypto";
import { measurePreparation } from "../preparationMetrics";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import {
  Attachments,
  ChatMessageAttachmentLinks,
  ChatMessages,
  db,
  type Executor,
} from "../db";
import { IMAGE_URL_TTL_SECONDS, sign } from "../storage";
import type { UploadId } from "@parley/server-kit/ids";
import { attachments } from "./attachments.data";

/**
 * What resolving an image needs: the signature cache to decide whether to
 * re-sign, the message it hangs off so a batch can be grouped by turn, and the
 * metadata the client is handed. `userId` is a predicate here, not an output,
 * so it stays out.
 */
const imageAttachmentColumns = {
  imageUploadId: Attachments.attachmentId,
  fileName: Attachments.fileName,
  mimeType: Attachments.mimeType,
  sizeBytes: Attachments.sizeBytes,
  signedUrl: Attachments.signedUrl,
  signedUrlExpiresAt: Attachments.signedUrlExpiresAt,
};

type ImageAttachmentRow = {
  imageUploadId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  signedUrl: string | null;
  signedUrlExpiresAt: Date | null;
};

/** One image as the client and the model both receive it. */
export type ResolvedImage = {
  imageUploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
};

const SIGNED_URL_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** When a URL signed right now stops being valid — fills `signedUrlExpiresAt`. */
function getSignedUrlExpiryDate() {
  return new Date(Date.now() + IMAGE_URL_TTL_SECONDS * 1000);
}

/**
 * The row for an image already in the bucket. Takes the signature rather than
 * making it, so the caller can hand the same URL straight back to the client
 * instead of reading it out again. `executor` lets a direct upload's confirm
 * write it in the transaction that confirms the upload.
 */
async function createImageAttachment(
  input: {
    userId: string;
    imageUploadId: UploadId;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    signedUrl: string;
  },
  executor: Executor = db,
) {
  await attachments.createAttachment(
    {
      attachmentId: input.imageUploadId,
      kind: "image",
      userId: input.userId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      signedUrl: input.signedUrl,
      signedUrlExpiresAt: getSignedUrlExpiryDate(),
    },
    executor,
  );
}

/** The subset of an image row needed to decide whether its url must be re-signed. */
type SignableImageRow = Pick<
  ImageAttachmentRow,
  "imageUploadId" | "signedUrl" | "signedUrlExpiresAt"
>;

function hasFreshSignedUrl(row: SignableImageRow) {
  if (!row.signedUrl || !row.signedUrlExpiresAt) return false;
  return (
    row.signedUrlExpiresAt.getTime() - Date.now() > SIGNED_URL_REFRESH_MARGIN_MS
  );
}

/**
 * Every read here is scoped to one owner, so `userId` is the constant part of
 * the predicate and the caller supplies only what narrows it further.
 */
async function findImageAttachments(
  userId: string,
  imageUploadIds: readonly string[],
  filter: SQL | undefined,
): Promise<ImageAttachmentRow[]> {
  return db
    .select(imageAttachmentColumns)
    .from(Attachments)
    .where(
      and(
        attachments.userOwnsAttachments({
          userId,
          attachmentIds: imageUploadIds,
          kind: "image",
        }),
        filter,
      ),
    )
    .orderBy(asc(Attachments.createdAt), asc(Attachments.attachmentId));
}

/**
 * imageUploadId → usable url for a set of image rows, signing (and persisting the
 * signature on) only those whose stored url has expired. Takes just the fields
 * it reads, so a projection from a join can be passed straight in.
 */
async function resolveImageAttachmentUrls(
  userId: string,
  rows: readonly SignableImageRow[],
): Promise<Map<string, string>> {
  const details = { imageCount: rows.length, cachedUrlCount: 0, urlsToSign: 0 };
  return measurePreparation(
    "imageUrls.resolve",
    undefined,
    async () => {
      const urlByImageUploadId = new Map<string, string>();
      const needsSigning: SignableImageRow[] = [];

      for (const row of rows) {
        if (hasFreshSignedUrl(row))
          urlByImageUploadId.set(row.imageUploadId, row.signedUrl as string);
        else needsSigning.push(row);
      }
      details.cachedUrlCount = rows.length - needsSigning.length;
      details.urlsToSign = needsSigning.length;
      if (needsSigning.length === 0) return urlByImageUploadId;

      const freshlySigned = await measurePreparation(
        "bucket.createSignedUrls",
        undefined,
        () =>
          sign.urls(
            needsSigning.map((row) => ({
              userId,
              kind: "image",
              uploadId: row.imageUploadId,
            })),
          ),
        { imageCount: needsSigning.length },
      );
      const expiresAt = getSignedUrlExpiryDate();
      const persistUrlsPromiseAllId = randomUUID();

      await Promise.all(
        needsSigning.map((row) => {
          const url = freshlySigned.get(row.imageUploadId);
          if (!url) return;
          urlByImageUploadId.set(row.imageUploadId, url);
          return measurePreparation(
            "db.persistSignedUrl",
            persistUrlsPromiseAllId,
            () =>
              db
                .update(Attachments)
                .set({ signedUrl: url, signedUrlExpiresAt: expiresAt })
                .where(eq(Attachments.attachmentId, row.imageUploadId)),
          );
        }),
      );

      return urlByImageUploadId;
    },
    details,
  );
}

function toResolvedImage(row: ImageAttachmentRow, url: string): ResolvedImage {
  // `url`, not `signedUrl`: the same key POST /upload/image and a message's
  // attachments use, so the client reads one field name everywhere.
  return {
    imageUploadId: row.imageUploadId,
    fileName: row.fileName,
    mimeType: row.mimeType ?? "application/octet-stream",
    size: row.sizeBytes,
    url,
  };
}

/**
 * (first, sign whatever expired), return each image's url. Ordered to match
 * `imageUploadIds`; ids with no row, or that could not be signed, are dropped.
 */
async function resolveImagesWhere(
  // Plain strings, not UploadId: these arrive from the wire (a request body or
  // a stored row), and are only trusted after findImageAttachments matches them
  // against rows this user owns.
  userId: string,
  imageUploadIds: readonly string[],
  filter: SQL | undefined,
): Promise<ResolvedImage[]> {
  if (imageUploadIds.length === 0) return [];

  const rows = await measurePreparation(
    "db.findImageAttachments",
    undefined,
    () => findImageAttachments(userId, imageUploadIds, filter),
    { imageCount: imageUploadIds.length },
  );
  if (rows.length === 0) return [];

  const urlByImageUploadId = await resolveImageAttachmentUrls(userId, rows);
  const rowByImageUploadId = new Map(
    rows.map((row) => [row.imageUploadId, row]),
  );

  return imageUploadIds.flatMap((imageUploadId) => {
    const row = rowByImageUploadId.get(imageUploadId);
    const url = urlByImageUploadId.get(imageUploadId);
    return row && url ? [toResolvedImage(row, url)] : [];
  });
}

/** The user's images by id, whether or not they've been sent on a message. */
async function resolveImages(
  userId: string,
  imageUploadIds: readonly string[],
) {
  return resolveImagesWhere(userId, imageUploadIds, undefined);
}

/**
 * The attachments of many messages at once, keyed by message id — one query for
 * a whole page of history rather than one per turn. Messages with no images are
 * absent from the map.
 */
async function resolveMessageImages(
  userId: string,
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
        attachments.userOwnsAttachments({ userId, kind: "image" }),
        inArray(ChatMessageAttachmentLinks.messageId, [...messageIds]),
      ),
    )
    .orderBy(
      asc(ChatMessageAttachmentLinks.messageId),
      asc(ChatMessageAttachmentLinks.position),
    );
  if (rows.length === 0) return imagesByMessageId;

  const urlByImageUploadId = await resolveImageAttachmentUrls(userId, rows);

  for (const row of rows) {
    const url = urlByImageUploadId.get(row.imageUploadId);
    if (!row.messageId || !url) continue;

    const images = imagesByMessageId.get(row.messageId) ?? [];
    images.push(toResolvedImage(row, url));
    imagesByMessageId.set(row.messageId, images);
  }

  return imagesByMessageId;
}

async function findLinkedImageAttachmentIdsWhere(
  userId: string,
  filter: SQL | undefined,
) {
  const rows = await db
    .select({ imageUploadId: Attachments.attachmentId })
    .from(ChatMessageAttachmentLinks)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, ChatMessageAttachmentLinks.attachmentId),
    )
    .where(
      and(attachments.userOwnsAttachments({ userId, kind: "image" }), filter),
    );

  return rows.map((row) => row.imageUploadId);
}

/** Same, for every message in a conversation about to be deleted. */
async function findConversationImageAttachmentIds(
  userId: string,
  conversationId: string,
) {
  return findLinkedImageAttachmentIdsWhere(
    userId,
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
 * Deletes the row and marks its object deleted in the ledger, together. The
 * caller removes the object from storage; if that fails, the sweep does.
 * Null when no owned, unlinked, unreserved image matched.
 */
async function deleteOwnedUnlinkedUnreservedImageAttachment(
  userId: string,
  imageUploadId: string,
) {
  return attachments.deleteOwnedUnlinkedUnreservedAttachment({
    userId,
    attachmentId: imageUploadId,
    kind: "image",
  });
}

async function deleteOwnedUnlinkedUnreservedImageAttachments(
  userId: string,
  candidateAttachmentIds: readonly string[],
  executor: Executor = db,
) {
  return attachments.deleteOwnedUnlinkedUnreservedAttachments(
    {
      userId,
      attachmentIds: candidateAttachmentIds,
      kind: "image",
    },
    executor,
  );
}

export const images = {
  createImageAttachment,
  resolveImageAttachmentUrls,
  resolveImages,
  resolveMessageImages,
  findConversationImageAttachmentIds,
  deleteOwnedUnlinkedUnreservedImageAttachment,
  deleteOwnedUnlinkedUnreservedImageAttachments,
};
