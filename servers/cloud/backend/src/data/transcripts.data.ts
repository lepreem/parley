import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
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

/** A transcript as it's stored: what was said, with when, and in what language. */
type TranscriptToSave = {
  segments: readonly TranscriptSegment[];
  /** A BCP-47 tag ("de", "ar-JO"); null when the transcriber named none. */
  language: string | null;
};

async function insertTranscript(
  audioUploadId: UploadId,
  { segments, language }: TranscriptToSave,
  executor: Executor = db,
) {
  const content = transcriptText(segments);
  await executor.insert(TranscriptContents).values({
    audioUploadId,
    content,
    segments: [...segments],
    language,
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
  transcript: TranscriptToSave,
  transcriptModelId: string | null,
  claimToken: string,
) {
  return db.transaction(async (tx) => {
    const ownsJob = await jobs.completeAudioJob(
      audioUploadId,
      claimToken,
      transcriptModelId,
      tx,
    );
    if (!ownsJob) return false;

    await insertTranscript(audioUploadId, transcript, tx);
    return true;
  });
}

/**
 * A completed YouTube job's transcript of the video, whoever's job it is, or
 * null when no one has one. The one read here not scoped by owner: it only
 * matches YouTube transcripts, the text of a public video, and the caller
 * copies it into a job of its own rather than linking anyone to this one.
 *
 * Only a transcript the request would have made itself: one by the model the
 * server transcribes with now, or when it takes captions, the video's
 * captions too. A transcript by a model must have its language: one without
 * was made before Deepgram was asked to detect it, and may be English that
 * was never said.
 */
async function findYoutubeTranscript(
  youtubeVideoId: string,
  {
    transcriptModelId,
    useCaptionsIfAvailable,
  }: { transcriptModelId: string | undefined; useCaptionsIfAvailable: boolean },
) {
  const madeByModel = transcriptModelId
    ? and(
        eq(AudioTranscriptionJobs.transcriptModelId, transcriptModelId),
        isNotNull(TranscriptContents.language),
      )
    : undefined;
  const madeFromCaptions = useCaptionsIfAvailable
    ? isNull(AudioTranscriptionJobs.transcriptModelId)
    : undefined;
  const madeAsAsked =
    madeByModel && madeFromCaptions
      ? or(madeByModel, madeFromCaptions)
      : (madeByModel ?? madeFromCaptions);
  if (!madeAsAsked) return null;

  const [row] = await db
    .select({
      transcriptModelId: AudioTranscriptionJobs.transcriptModelId,
      content: TranscriptContents.content,
      segments: TranscriptContents.segments,
      language: TranscriptContents.language,
      charCount: TranscriptContents.charCount,
    })
    .from(AudioTranscriptionJobs)
    .innerJoin(
      TranscriptContents,
      eq(
        TranscriptContents.audioUploadId,
        AudioTranscriptionJobs.audioUploadId,
      ),
    )
    .where(
      and(
        eq(AudioTranscriptionJobs.youtubeVideoId, youtubeVideoId),
        eq(AudioTranscriptionJobs.status, "completed"),
        madeAsAsked,
      ),
    )
    .limit(1);

  return row ?? null;
}

type ReusableTranscript = NonNullable<
  Awaited<ReturnType<typeof findYoutubeTranscript>>
>;

/**
 * A YouTube job that starts out completed, with a copy of a transcript the
 * video already has, in one transaction. Nothing is fetched or transcribed
 * for it, so no audio is recorded for it either. It says what made the copy,
 * not what the request asked for.
 */
async function createReusedYoutubeJob(
  job: Omit<
    Parameters<typeof jobs.createAudioJob>[0],
    "status" | "transcriptModelId"
  >,
  { transcriptModelId, ...transcript }: ReusableTranscript,
) {
  await db.transaction(async (tx) => {
    await jobs.createAudioJob(
      { ...job, transcriptModelId, status: "completed" },
      tx,
    );
    await tx.insert(TranscriptContents).values({
      audioUploadId: job.audioUploadId,
      ...transcript,
    });
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
  findYoutubeTranscript,
  createReusedYoutubeJob,
  findTranscripts,
  findMessageTranscriptAttachments,
};
