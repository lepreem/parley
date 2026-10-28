import { z } from "zod";
import type { SendMessageBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { CTX_KEYS } from "../../../core/keys";
import { findChatModel } from "../../../core/ai/ai_chat_client";

const MAX_MESSAGE_LENGTH = 50_000;

/**
 * Images one turn may carry. Every attachment is handed to the model as vision
 * input, which counts against the user's Claude plan, so the cap is what keeps
 * a single message from using up an unbounded share of it.
 */
const MAX_IMAGES = 6;

/**
 * Transcripts one turn may carry. This is not what limits the prompt: the
 * context budget (MAX_CONTEXT_CHARS in messages.controller.ts) does that, once
 * the database has reported each transcript's size. This only bounds the
 * request, so its ids never reach the claim and context queries by the
 * thousand. Transcripts run about 900 characters a minute, so about ten
 * 10-minute YouTube videos fill the budget: past this many, the budget would
 * turn the message away anyway.
 */
export const MAX_TRANSCRIPTS = 10;

const messageAttachmentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    imageUploadId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("transcript"),
    audioUploadId: z.string().uuid(),
  }),
]);

export type MessageAttachmentInput = z.infer<typeof messageAttachmentSchema>;

function getAttachmentId(attachment: MessageAttachmentInput) {
  return attachment.type === "image"
    ? attachment.imageUploadId
    : attachment.audioUploadId;
}

export const messageReqParamSchema = z.object({
  [CTX_KEYS.conversationId]: z.string().uuid(),
  [CTX_KEYS.messageId]: z.string().uuid(),
});

/** Body for POST /conversations/:id/messages — the user turn to answer. */
export const messageCreateBodySchema = takesBody<SendMessageBody>()(
  z
    .object({
      [CTX_KEYS.messageContent]: z
        .string()
        .trim()
        .min(1, "Message must not be empty")
        .max(MAX_MESSAGE_LENGTH, "Message is too long"),
      [CTX_KEYS.chosenModelId]: z.string().min(1),
      [CTX_KEYS.messageAttachmentsIds]: z
        .array(messageAttachmentSchema)
        .optional()
        .default([])
        .transform((attachments) => {
          const seenAttachmentIds = new Set<string>();
          return attachments.filter((attachment) => {
            const attachmentId = getAttachmentId(attachment);
            if (seenAttachmentIds.has(attachmentId)) return false;
            seenAttachmentIds.add(attachmentId);
            return true;
          });
        }),
      [CTX_KEYS.lastMessageId]: z.string().uuid().nullable(),
    })
    .superRefine(async (data, ctx) => {
      const model = await findChatModel(data[CTX_KEYS.chosenModelId]);
      if (!model) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid model: not a chat model",
          path: [CTX_KEYS.chosenModelId],
        });
        return;
      }
      const imageCount = data[CTX_KEYS.messageAttachmentsIds].filter(
        (attachment) => attachment.type === "image",
      ).length;
      if (imageCount > MAX_IMAGES) {
        ctx.addIssue({
          code: "custom",
          message: `Too many images: at most ${MAX_IMAGES} per message`,
          path: [CTX_KEYS.messageAttachmentsIds],
        });
      }
      const transcriptCount = data[CTX_KEYS.messageAttachmentsIds].filter(
        (attachment) => attachment.type === "transcript",
      ).length;
      if (transcriptCount > MAX_TRANSCRIPTS) {
        ctx.addIssue({
          code: "custom",
          message: `Too many transcripts: at most ${MAX_TRANSCRIPTS} per message`,
          path: [CTX_KEYS.messageAttachmentsIds],
        });
      }
      if (imageCount > 0 && !model.acceptsImages) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid model: must accept image input",
          path: [CTX_KEYS.messageAttachmentsIds],
        });
      }
    }),
);
