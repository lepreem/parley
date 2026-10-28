import { z } from "zod";
import type { SendMessageBody } from "@parley/contract";
import { takesBody } from "@parley/server-kit/http/takesBody";
import { chat } from "../ai";

const MAX_MESSAGE_LENGTH = 50_000;

/**
 * Images one turn may carry. Every attachment is handed to the model as vision
 * input, which is priced per image, so the cap is what keeps a single message
 * from being an unbounded bill.
 */
const MAX_IMAGES = 6;

/**
 * Transcripts one turn may carry. This is not what limits the prompt: the
 * context budget (MAX_CONTEXT_CHARS in chat/contextWindow.ts) does that, once
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
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});

/** Body for POST /conversations/:id/messages — the user turn to answer. */
export const messageCreateBodySchema = takesBody<SendMessageBody>()(
  z
    .object({
      messageContent: z
        .string()
        .trim()
        .min(1, "Message must not be empty")
        .max(MAX_MESSAGE_LENGTH, "Message is too long"),
      chosenModelId: z.string().min(1),
      attachments: z
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
      lastMessageId: z.string().uuid().nullable(),
    })
    .superRefine(async (data, ctx) => {
      const model = await chat.findModel(data.chosenModelId);
      if (!model) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid model: not a chat model",
          path: ["chosenModelId"],
        });
        return;
      }
      const imageCount = data.attachments.filter(
        (attachment) => attachment.type === "image",
      ).length;
      if (imageCount > MAX_IMAGES) {
        ctx.addIssue({
          code: "custom",
          message: `Too many images: at most ${MAX_IMAGES} per message`,
          path: ["attachments"],
        });
      }
      const transcriptCount = data.attachments.filter(
        (attachment) => attachment.type === "transcript",
      ).length;
      if (transcriptCount > MAX_TRANSCRIPTS) {
        ctx.addIssue({
          code: "custom",
          message: `Too many transcripts: at most ${MAX_TRANSCRIPTS} per message`,
          path: ["attachments"],
        });
      }
      if (imageCount > 0 && !model.acceptsImages) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid model: must accept image input",
          path: ["attachments"],
        });
      }
    }),
);
