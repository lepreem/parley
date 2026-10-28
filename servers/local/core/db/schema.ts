import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";

export const jobStatuses = [
  "queued",
  "processing",
  "completed",
  "failed",
] as const;
/**
 * What a job's audio came from. Unlike status, it isn't checked in the
 * database; the enum only types the column.
 */
const jobSources = ["audio", "video", "youtube"] as const;
const attachmentKinds = ["image", "audio"] as const;
const chatRoles = ["user", "assistant"] as const;
export const DEFAULT_CONVERSATION_TITLE = "New conversation";

/** SQLite has no enum type, so a CHECK keeps the column to the listed values. */
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  )})`;
}

/** Epoch milliseconds, read and written as a Date. */
function timestamp(name: string) {
  return integer(name, { mode: "timestamp_ms" });
}

/** The moment a row is written, to the millisecond. */
const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** Stored attachments that can be linked to one or more chat messages. */
export const Attachments = sqliteTable(
  "attachment_uploads",
  {
    attachmentId: text("attachment_upload_id").notNull().primaryKey(),
    kind: text("kind", { enum: attachmentKinds }).notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at").default(now).notNull(),
  },
  (table) => [
    check("attachment_uploads_kind", oneOf(table.kind, attachmentKinds)),
    // findJobsPage: one kind, newest first.
    index("attachment_uploads_kind_created_idx").on(
      table.kind,
      table.createdAt,
      table.attachmentId,
    ),
  ],
);

/** Transcription processing state for an audio attachment. */
export const AudioTranscriptionJobs = sqliteTable(
  "audio_transcription_jobs",
  {
    audioUploadId: text("audio_upload_id")
      .notNull()
      .primaryKey()
      .references(() => Attachments.attachmentId, {
        onDelete: "cascade",
      }),
    source: text("source", { enum: jobSources }).notNull(),
    // Origin URL for 'youtube' jobs; null for direct uploads. Stored for history
    // display and to enable transcript caching by video id later.
    YT_sourceUrl: text("YT_source_url"),
    // Whether a 'youtube' job's fetch tries the video's captions before its
    // audio; null for direct uploads. Kept so the fetch can run again after a
    // restart.
    YT_useCaptionsIfAvailable: integer("YT_use_captions_if_available", {
      mode: "boolean",
    }),
    status: text("status", { enum: jobStatuses }).notNull().default("queued"),
    // queued | processing | completed | failed
    error: text("error"),
    // Every claim replaces this fencing token, and terminal writes must still
    // own it, so an attempt that lost its claim can't commit over the one that
    // took the job after it.
    claimToken: text("claim_token"),
    updatedAt: timestamp("updated_at")
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
    // Model used to transcribe the audio. Null falls back to the default
    transcriptModelId: text("transcription_model_id"),
  },
  (table) => [
    check("audio_transcription_jobs_status", oneOf(table.status, jobStatuses)),
  ],
);

/** Chat conversations. */
export const Conversations = sqliteTable(
  "conversations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    title: text("title").notNull().default(DEFAULT_CONVERSATION_TITLE),
    createdAt: timestamp("created_at").default(now).notNull(),
    updatedAt: timestamp("updated_at")
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),

    lastMessageId: text("last_message_id"),
    contextWindowMessageCount: integer("context_window_message_count")
      .default(0)
      .notNull(),
    activeTurnClaimToken: text("active_turn_claim_token"),
    // When the active turn was claimed. Without it a claim is only ever
    // cleared by a clean release, so a process that dies mid-turn — an
    // ordinary deploy — leaves the conversation answering 409 forever. The
    // claim is treated as expired past CLAIM_LEASE_MS.
    activeTurnClaimedAt: timestamp("active_turn_claimed_at"),
  },
  (table) => [
    // findConversations: the (updated_at, id) ordering the list is served
    // in.
    index("conversations_updated_idx").on(table.updatedAt, table.id),
  ],
);

export const ChatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Which side of the chat wrote this row — mirrors the chat-completion API's
    // turn roles so history can be replayed to the model as-is.
    role: text("role", { enum: chatRoles }).notNull(),
    // Orders a turn's two messages, which can share a timestamp: the user's
    // comes first. Text would sort 'assistant' before 'user'.
    roleOrder: integer("role_order")
      .notNull()
      .generatedAlwaysAs(sql`case role when 'user' then 0 else 1 end`, {
        mode: "virtual",
      }),
    content: text("content").notNull(),
    // Model that produced an assistant message; null for user messages.
    chosenModelId: text("chosen_model_id"),
    // An assistant reply someone stopped partway; its content is what came
    // before they did.
    stopped: integer("stopped", { mode: "boolean" }).default(false).notNull(),

    createdAt: timestamp("created_at").default(now).notNull(),
    updatedAt: timestamp("updated_at")
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),

    conversationId: text("conversation_id")
      .notNull()
      .references(() => Conversations.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("chat_messages_role", oneOf(table.role, chatRoles)),
    // The busiest read in the app: findConversationMessages (asc) and
    // findRecentMessagesWithContext (desc) both filter by conversation and order
    // by (created_at, role_order, id), fully covered here so neither scans nor
    // sorts.
    index("chat_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
      table.roleOrder,
      table.id,
    ),
  ],
);

export const ChatMessageAttachmentLinks = sqliteTable(
  "chat_message_attachments",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => ChatMessages.id, { onDelete: "cascade" }),
    attachmentId: text("attachment_upload_id")
      .notNull()
      .references(() => Attachments.attachmentId, {
        onDelete: "restrict",
      }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.attachmentId],
    }),
    uniqueIndex("chat_message_attachments_message_position_idx").on(
      table.messageId,
      table.position,
    ),
    index("chat_message_attachments_upload_idx").on(table.attachmentId),
  ],
);

/** Attachments reserved by a turn until it is persisted or fails. */
export const AttachmentTurnReservations = sqliteTable(
  "attachment_turn_reservations",
  {
    attachmentId: text("attachment_upload_id")
      .notNull()
      .references(() => Attachments.attachmentId, {
        onDelete: "cascade",
      }),
    claimToken: text("claim_token").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.attachmentId, table.claimToken],
    }),
    index("attachment_turn_reservations_claim_idx").on(table.claimToken),
  ],
);

/**
 * The transcript a completed job produced, out of the job row so it isn't
 * pulled by the job list. A row exists only while a valid transcript does — the
 * worker inserts it on completion, so its presence means "ready".
 *
 * - content: the text the model and the user read, with a timestamp at each
 *   paragraph (transcriptText in @parley/server-kit/transcription/transcript).
 * - segments: what the transcriber heard, with when; null for transcripts
 *   made before timestamps were kept.
 * - charCount lets a chat turn be budgeted without reading the body.
 */
export const TranscriptContents = sqliteTable("transcript_contents", {
  // The audio job this transcript belongs to (1:1).
  audioUploadId: text("audio_upload_id")
    .primaryKey()
    .references(() => AudioTranscriptionJobs.audioUploadId, {
      onDelete: "cascade",
    }),
  content: text("content").notNull(),
  segments: text("segments", { mode: "json" }).$type<TranscriptSegment[]>(),
  charCount: integer("char_count").notNull(),
});
