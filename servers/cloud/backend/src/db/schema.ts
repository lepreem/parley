import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import type { TranscriptSegment } from "@parley/shared/transcript";

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "processing",
  "completed",
  "failed",
] as const);
/**
 * What a job's audio came from. Unlike status, it isn't a Postgres enum; this
 * only types the text column.
 */
const jobSources = ["audio", "video", "youtube"] as const;
export const attachmentKindEnum = pgEnum("attachment_kind", [
  "image",
  "audio",
] as const);
/** Everything the buckets store. */
export const storedObjectKindEnum = pgEnum("stored_object_kind", [
  "image",
  "audio",
] as const);
export const storageLedgerStatusEnum = pgEnum("storage_ledger_status", [
  "pending",
  "confirmed",
  "deleted",
] as const);
export const DEFAULT_CONVERSATION_TITLE = "New conversation";
export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"] as const);

export const users = pgTable("users", {
  // WorkOS user id (eg "user_01...")
  id: text("id").primaryKey(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
}).enableRLS();

/** Stored attachments that can be linked to one or more chat messages. */
export const Attachments = pgTable(
  "attachment_uploads",
  {
    attachmentId: text("attachment_upload_id").notNull().primaryKey(),
    kind: attachmentKindEnum("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    signedUrl: text("signed_url"),
    signedUrlExpiresAt: timestamp("signed_url_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("attachment_uploads_user_kind_created_idx").on(
      table.userId,
      table.kind,
      table.createdAt,
      table.attachmentId,
    ),
  ],
).enableRLS();

/** Transcription processing state for an audio attachment. */
export const AudioTranscriptionJobs = pgTable("audio_transcription_jobs", {
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
  status: jobStatusEnum("status").notNull().default("queued"),
  // queued | processing | completed | failed
  error: text("error"),
  // RabbitMQ redelivers an unACKed message after its consumer connection closes,
  // but that worker may still finish its AI call after a network split. Every
  // claim replaces this fencing token, and terminal writes must still own it so
  // a disconnected worker cannot commit after its replacement has taken over.
  claimToken: uuid("claim_token"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  // Model used to transcribe the audio. Null falls back to the default
  transcriptModelId: text("transcription_model_id"),
}).enableRLS();

/** Chat conversations owned by a user. */
export const Conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull().default(DEFAULT_CONVERSATION_TITLE),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),

    lastMessageId: uuid("last_message_id"),
    contextWindowMessageCount: integer("context_window_message_count")
      .default(0)
      .notNull(),
    activeTurnClaimToken: uuid("active_turn_claim_token"),
    // When the active turn was claimed. Without it a claim is only ever
    // cleared by a clean release, so a process that dies mid-turn — an
    // ordinary deploy — leaves the conversation answering 409 forever. The
    // claim is treated as expired past CLAIM_LEASE_MS.
    activeTurnClaimedAt: timestamp("active_turn_claimed_at", {
      withTimezone: true,
    }),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    // findUserConversations: owner filter + the (updated_at, id) ordering the
    // list is served in.
    index("conversations_user_updated_idx").on(
      table.userId,
      table.updatedAt,
      table.id,
    ),
  ],
).enableRLS();

export const ChatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Which side of the chat wrote this row — mirrors the chat-completion API's
    // turn roles so history can be replayed to the model as-is.
    role: chatRoleEnum("role").notNull(),
    // Written once: an edit deletes the message and saves a new one. Each API
    // process caches it by id (src/chat/historyText.ts). A trigger refuses any
    // UPDATE to this table (drizzle/0004_immutable_messages.sql).
    content: text("content").notNull(),
    // Model that produced an assistant message; null for user messages.
    chosenModelId: text("chosen_model_id"),
    // An assistant reply someone stopped partway; its content is what came
    // before they did.
    stopped: boolean("stopped").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),

    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => Conversations.id, { onDelete: "cascade" }),

    // could be useful for future "shared chat" feature.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    // The busiest read in the app: findConversationMessages (asc) and
    // findContextHistory (desc) both filter by conversation and order by
    // (created_at, role, id), fully covered here so neither scans nor sorts.
    index("chat_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
      table.role,
      table.id,
    ),
  ],
).enableRLS();

export const ChatMessageAttachmentLinks = pgTable(
  "chat_message_attachments",
  {
    messageId: uuid("message_id")
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
).enableRLS();

/** Attachments reserved by a turn until it is persisted or fails. */
export const AttachmentTurnReservations = pgTable(
  "attachment_turn_reservations",
  {
    attachmentId: text("attachment_upload_id")
      .notNull()
      .references(() => Attachments.attachmentId, {
        onDelete: "cascade",
      }),
    claimToken: uuid("claim_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.attachmentId, table.claimToken],
    }),
    index("attachment_turn_reservations_claim_idx").on(table.claimToken),
  ],
).enableRLS();

/**
 * The transcript a completed job produced, out of the job row so it isn't
 * pulled by the job list. A row exists only while a valid transcript does — the
 * worker inserts it on completion, so its presence means "ready".
 *
 * - content: the text the model and the user read, with a timestamp at each
 *   paragraph (transcriptText in @parley/shared/transcript).
 * - segments: what the transcriber heard, with when; null for transcripts
 *   made before timestamps were kept.
 * - charCount lets a chat turn be budgeted without reading the body.
 */
export const TranscriptContents = pgTable("transcript_contents", {
  // The audio job this transcript belongs to (1:1).
  audioUploadId: text("audio_upload_id")
    .primaryKey()
    .references(() => AudioTranscriptionJobs.audioUploadId, {
      onDelete: "cascade",
    }),
  content: text("content").notNull(),
  segments: jsonb("segments").$type<TranscriptSegment[]>(),
  charCount: integer("char_count").notNull(),
}).enableRLS();

/**
 * Every object the bucket holds or is about to hold, so what nothing uses any
 * more can be found and removed without asking storage what it contains.
 *
 * - pending: an upload URL was handed out; the upload isn't confirmed.
 * - confirmed: a row references the object.
 * - deleted: nothing references it any more; the object is due for removal.
 *
 * A row is removed once its object is gone from storage. The sweep removes
 * pending and deleted objects that outlive their grace period.
 *
 * user_id has no foreign key, on purpose: the storage key is built from it, so
 * the row has to outlive the user for their objects to still be removable.
 */
export const StorageLedger = pgTable(
  "storage_ledger",
  {
    uploadId: text("upload_id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: storedObjectKindEnum("kind").notNull(),
    status: storageLedgerStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("storage_ledger_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
).enableRLS();
