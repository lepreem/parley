import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Attachments,
  AudioTranscriptionJobs,
  ChatMessageAttachmentLinks,
  TranscriptContents,
  db,
  type Executor,
} from "../db";

import { jobs } from "./jobs.data";
import type { JobSource } from "@parley/contract";
import {
  transcriptText,
  type TranscriptSegment,
} from "@parley/server-kit/transcription/transcript";
import type { UploadId } from "@parley/server-kit/ids";
import { attachments } from "./attachments.data";

/**
 * The transcript a completed job produced. Lives here, not in the job row
 * or the bucket, so it can be joined into a chat's context (for `charCount`) and
 * read only for the turns that make the budget. Read scoped by owner; presence
 * of a row means a valid transcript is ready.
 */

async function insertTranscript(
  audioUploadId: UploadId,
  segments: readonly TranscriptSegment[],
  executor: Executor = db,
) {
  const content = transcriptText(segments);
  await executor.insert(TranscriptContents).values({
    audioUploadId,
    content,
    segments: [...segments],
    charCount: content.length,
  });
}

/**
 * Stores the transcript and marks the job completed in one transaction, so a
 * crash can't leave a job stuck `processing` with a transcript already written
 * (or a completed job with none).
 */
async function saveCompletedTranscript(
  audioUploadId: UploadId,
  segments: readonly TranscriptSegment[],
  claimToken: string,
) {
  return db.transaction(async (tx) => {
    const ownsJob = await jobs.completeAudioJob(audioUploadId, claimToken, tx);
    if (!ownsJob) return false;

    await insertTranscript(audioUploadId, segments, tx);
    return true;
  });
}

/** Bodies for a set of turns at once, keyed by audioUploadId — the batched context read. */
async function findTranscripts(
  userId: string,
  audioUploadIds: readonly string[],
): Promise<Map<string, string>> {
  if (audioUploadIds.length === 0) return new Map<string, string>();

  const rows = await db
    .select({
      audioUploadId: TranscriptContents.audioUploadId,
      content: TranscriptContents.content,
    })
    .from(TranscriptContents)
    .innerJoin(
      Attachments,
      eq(Attachments.attachmentId, TranscriptContents.audioUploadId),
    )
    .where(
      and(
        attachments.userOwnsAttachments({ userId, kind: "audio" }),
        inArray(TranscriptContents.audioUploadId, [...audioUploadIds]),
      ),
    );

  return new Map(rows.map((row) => [row.audioUploadId, row.content]));
}

export type StoredTranscriptAttachment = {
  audioUploadId: string;
  fileName: string;
  source: JobSource;
  charCount: number | null;
};

/** Ordered transcription attachments grouped by chat message. */
async function findMessageTranscriptAttachments(
  userId: string,
  messageIds: readonly string[],
): Promise<Map<string, StoredTranscriptAttachment[]>> {
  const transcriptionsByMessageId = new Map<
    string,
    StoredTranscriptAttachment[]
  >();
  if (messageIds.length === 0) return transcriptionsByMessageId;

  const rows = await db
    .select({
      messageId: ChatMessageAttachmentLinks.messageId,
      audioUploadId: AudioTranscriptionJobs.audioUploadId,
      fileName: Attachments.fileName,
      source: AudioTranscriptionJobs.source,
      charCount: TranscriptContents.charCount,
    })
    .from(ChatMessageAttachmentLinks)
    .innerJoin(
      Attachments,
      and(
        eq(Attachments.attachmentId, ChatMessageAttachmentLinks.attachmentId),
        attachments.userOwnsAttachments({ userId, kind: "audio" }),
      ),
    )
    .innerJoin(
      AudioTranscriptionJobs,
      eq(
        AudioTranscriptionJobs.audioUploadId,
        ChatMessageAttachmentLinks.attachmentId,
      ),
    )
    .leftJoin(
      TranscriptContents,
      and(
        eq(
          TranscriptContents.audioUploadId,
          AudioTranscriptionJobs.audioUploadId,
        ),
      ),
    )
    .where(inArray(ChatMessageAttachmentLinks.messageId, [...messageIds]))
    .orderBy(
      asc(ChatMessageAttachmentLinks.messageId),
      asc(ChatMessageAttachmentLinks.position),
    );

  for (const { messageId, ...transcription } of rows) {
    const transcripts = transcriptionsByMessageId.get(messageId) ?? [];
    transcripts.push(transcription);
    transcriptionsByMessageId.set(messageId, transcripts);
  }

  return transcriptionsByMessageId;
}

export const transcripts = {
  saveCompletedTranscript,
  findTranscripts,
  findMessageTranscriptAttachments,
};
