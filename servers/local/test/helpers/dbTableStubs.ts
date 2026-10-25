/**
 * Stand-ins for the drizzle tables, for suites that mock `core/db` wholesale.
 *
 * Controllers read columns at module scope (their `select()` projections are
 * module-level consts), so a mock missing a table — or a column — fails the
 * whole file at import. Keeping the stubs here means adding a column touches
 * one place instead of every suite that happens to build the app.
 */
export const tableStubs = {
  DEFAULT_CONVERSATION_TITLE: "New conversation",

  AudioTranscriptionJobs: {
    audioUploadId: "audio_upload_id",
    source: "source",
    status: "status",
    error: "error",
    claimToken: "claim_token",
    transcriptModelId: "transcription_model_id",
  },

  Attachments: {
    attachmentId: "attachment_upload_id",
    kind: "kind",
    fileName: "file_name",
    mimeType: "mime_type",
    sizeBytes: "size_bytes",
    createdAt: "created_at",
  },

  Conversations: {
    id: "id",
    title: "title",
    createdAt: "created_at",
    updatedAt: "updated_at",
    lastMessageId: "last_message_id",
    contextWindowMessageCount: "context_window_message_count",
    activeTurnClaimToken: "active_turn_claim_token",
  },

  ChatMessages: {
    id: "id",
    role: "role",
    content: "content",
    chosenModelId: "chosen_model_id",
    conversationId: "conversation_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },

  ChatMessageAttachmentLinks: {
    messageId: "message_id",
    attachmentId: "attachment_upload_id",
    position: "position",
  },

  AttachmentTurnReservations: {
    attachmentId: "attachment_upload_id",
    claimToken: "claim_token",
    expiresAt: "expires_at",
  },

  TranscriptContents: {
    audioUploadId: "audio_upload_id",
    content: "content",
    charCount: "char_count",
  },

  jobStatuses: ["queued", "processing", "completed", "failed"],
};
