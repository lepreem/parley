const file = "file";
const fileName = "fileName";
const audioSource = "audioSource";
const chosenModelId = "chosenModelId";
const transcriptModelId = "transcriptModelId";
const youtubeUrl = "youtubeUrl";
const useCaptionsIfAvailable = "useCaptionsIfAvailable";

export const CTX_KEYS = {
  imageUploadId: "imageUploadId",
  audioUploadId: "audioUploadId",
  conversationId: "conversationId",
  messageId: "messageId",

  limit: "limit",
  cursor: "cursor",
  status: "status",
  q: "q",

  conversationTitle: "conversationTitle",

  messageContent: "messageContent",
  messageAttachmentsIds: "attachments",
  lastMessageId: "lastMessageId",

  file,
  fileName,
  chosenModelId,
  transcriptModelId,
  audioSource,
  youtubeUrl,
  useCaptionsIfAvailable,
} as const;

export const FORM_KEYS = {
  file,
  transcriptModelId,
  audioSource,
} as const;
