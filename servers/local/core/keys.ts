const file = "file";
const fileName = "fileName";
const audioSource = "audioSource";
const chosenModelId = "chosenModelId";
const reasoningEffort = "reasoningEffort";
const webSearch = "webSearch";
const youtubeUrl = "youtubeUrl";
const youtubeVideoId = "youtubeVideoId";
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
  reasoningEffort,
  webSearch,
  audioSource,
  youtubeUrl,
  youtubeVideoId,
  useCaptionsIfAvailable,
} as const;

export const FORM_KEYS = {
  file,
  audioSource,
} as const;
