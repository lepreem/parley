import type { z } from "zod";
import type { TurnStats } from "@parley/contract";
import type { ReplyInProgressEntry } from "@parley/server-kit/memory/repliesInProgress";
import { logger, messageOf } from "@parley/server-kit/runtime/logger";
import { data, type HistoryCandidate, type HistoryTranscript } from "../data";
import { buildUserTurn, chat, type ChatTurn } from "../ai";
import { measurePreparation } from "../preparationMetrics";
import { uploads } from "../uploads";
import type { messageCreateBodySchema } from "../schema/messages.schema";
import {
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_RESPONSE_TOKENS,
  admitHistory,
  countMessagesInContextWindow,
} from "./contextWindow";
import { memory } from "../memory";
import { buildPrompt, containsImageInput, withTranscripts } from "./prompt";
import type { TurnClaim } from "./turnClaim";

const log = logger.child({ component: "chat-turn" });

const FALLBACK_CONVERSATION_TITLE_CHARS = 80;

/** One user turn to answer, as the request asked for it. */
export type TurnRequest = {
  userId: string;
  conversationId: string;
  content: string;
  chosenModelId: string;
  /** Every attachment, images and transcripts, in the order they were sent. */
  attachmentIds: string[];
  imageUploadIds: string[];
  audioUploadIds: string[];
  /** The conversation's head as the client last saw it. */
  expectedLastMessageId: string | null;
};

export function turnRequestFrom(
  userId: string,
  conversationId: string,
  {
    messageContent,
    chosenModelId,
    attachments,
    lastMessageId,
  }: z.output<typeof messageCreateBodySchema>,
): TurnRequest {
  return {
    userId,
    conversationId,
    content: messageContent,
    chosenModelId,
    attachmentIds: attachments.map((attachment) =>
      attachment.type === "image"
        ? attachment.imageUploadId
        : attachment.audioUploadId,
    ),
    imageUploadIds: attachments.flatMap((attachment) =>
      attachment.type === "image" ? [attachment.imageUploadId] : [],
    ),
    audioUploadIds: attachments.flatMap((attachment) =>
      attachment.type === "transcript" ? [attachment.audioUploadId] : [],
    ),
    expectedLastMessageId: lastMessageId,
  };
}

/** A turn that can't run, with the answer the request gets instead. */
export class TurnRejected extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    readonly body: { message: string; maxChars?: number; chars?: number },
  ) {
    super(body.message);
  }
}

type AdmittedTurn = {
  role: ChatTurn["role"];
  promptContent: string;
  contextCharCount: number;
  imageUrls: string[];
};

export type PreparedTurn = {
  /** The prompt, oldest turn first. */
  prompt: ChatTurn[];
  /** Each replayed turn's length, newest first, for the next turn's window. */
  historyCharCounts: number[];
  newTurnCharCount: number;
  /** The new turn's transcripts, kept with its text once it's saved. */
  newTurnTranscripts: HistoryTranscript[];
  /** What went into the prompt, for the turn's stats. */
  contextStats: TurnStats["context"];
};

/** History candidates as the prompt would carry them, measured for the budget. */
function measureHistory(candidates: readonly HistoryCandidate[]) {
  return candidates.map((candidate) => {
    const promptContent = withTranscripts(
      candidate.content,
      candidate.transcripts.map((transcript) => transcript.content),
    );
    return {
      role: candidate.role,
      promptContent,
      contextCharCount: promptContent.length,
      images: candidate.images,
    };
  });
}

/**
 * Admits the history that fits, then signs only the images it kept.
 */
async function admitAndSignHistory(
  userId: string,
  candidates: readonly HistoryCandidate[],
  newTurnCharCount: number,
  newTurnImageCount: number,
): Promise<AdmittedTurn[]> {
  const admitted = admitHistory(
    measureHistory(candidates),
    newTurnCharCount,
    newTurnImageCount,
  );
  const urlByImageUploadId = await data.images.resolveImageAttachmentUrls(
    userId,
    admitted.flatMap((turn) => turn.images),
  );

  return admitted.map(({ images, ...turn }) => ({
    ...turn,
    imageUrls: images.flatMap((image) => {
      const url = urlByImageUploadId.get(image.imageUploadId);
      return url ? [url] : [];
    }),
  }));
}

/**
 * Settles the claim, the reservations and everything the turn reads in one
 * batch, then checks all of it. Throws TurnRejected for anything that stops
 * the turn. `beforeMessageId` takes the history from before a message instead
 * of from the tail: an edit replaces that message and everything after it, so
 * none of it is context.
 */
export async function prepareTurn(
  request: TurnRequest,
  claim: TurnClaim,
  beforeMessageId?: string,
): Promise<PreparedTurn> {
  const knownText = memory.historyText.known(
    request.userId,
    request.conversationId,
  );
  const [
    conversationClaimed,
    attachmentsReserved,
    newTurnResolvedImages,
    newTurnTranscriptByAudioUploadId,
    historyCandidates,
  ] = await Promise.all([
    claim.conversationClaimedPromise,
    claim.attachmentsReservedPromise,
    measurePreparation("resolveImages", claim.preparationId, () =>
      data.images.resolveImages(request.userId, request.imageUploadIds),
    ),
    measurePreparation("findTranscripts", claim.preparationId, () =>
      data.transcripts.findTranscripts(request.userId, request.audioUploadIds),
    ),
    measurePreparation("findContextHistory", claim.preparationId, () =>
      data.messages.findContextHistory({
        userId: request.userId,
        conversationId: request.conversationId,
        maximumMessageCount: MAX_HISTORY_MESSAGES,
        ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
        ...(knownText === undefined ? {} : { knownText }),
      }),
    ),
  ]);
  memory.historyText.rememberHistory(
    request.userId,
    request.conversationId,
    historyCandidates,
  );

  if (!conversationClaimed) {
    const ownedConversation = await data.conversations.findOwnedConversation(
      request.userId,
      request.conversationId,
    );
    throw ownedConversation
      ? new TurnRejected(409, {
          message: "Conversation changed or a response is already in progress",
        })
      : new TurnRejected(404, { message: "Conversation not found" });
  }
  if (newTurnResolvedImages.length !== request.imageUploadIds.length) {
    throw new TurnRejected(404, { message: "Image not found" });
  }
  const newTurnTranscripts = request.audioUploadIds.flatMap((audioUploadId) => {
    const content = newTurnTranscriptByAudioUploadId.get(audioUploadId);
    return content === undefined ? [] : [{ audioUploadId, content }];
  });
  if (newTurnTranscripts.length !== request.audioUploadIds.length) {
    throw new TurnRejected(404, { message: "Transcript not found" });
  }

  const newTurnContent = withTranscripts(
    request.content,
    newTurnTranscripts.map((transcript) => transcript.content),
  );
  if (newTurnContent.length >= MAX_CONTEXT_CHARS) {
    throw new TurnRejected(413, {
      message: "Message is too long for one message",
      maxChars: MAX_CONTEXT_CHARS,
      chars: newTurnContent.length,
    });
  }

  const history = await admitAndSignHistory(
    request.userId,
    historyCandidates,
    newTurnContent.length,
    newTurnResolvedImages.length,
  );
  const prompt = buildPrompt(
    history,
    buildUserTurn(
      newTurnContent,
      newTurnResolvedImages.map((image) => image.url),
    ),
  );
  // The request schema already turned away new images for a text-only
  // model, before anything was claimed; this also covers replayed ones.
  if (
    containsImageInput(prompt) &&
    !(await chat.findModel(request.chosenModelId))?.acceptsImages
  ) {
    throw new TurnRejected(400, {
      message: "Invalid model: must accept image input",
    });
  }
  if (!attachmentsReserved) {
    throw new TurnRejected(404, { message: "Attachment not found" });
  }

  const historyCharCounts = history.map((turn) => turn.contextCharCount);
  return {
    prompt,
    historyCharCounts,
    newTurnCharCount: newTurnContent.length,
    newTurnTranscripts,
    contextStats: {
      historyReadMessages: historyCandidates.length,
      historyCachedMessages: historyCandidates.filter((candidate) =>
        knownText?.messages.has(candidate.id),
      ).length,
      historyMessages: history.length,
      historyChars: historyCharCounts.reduce((total, n) => total + n, 0),
      newTurnChars: newTurnContent.length,
      maxChars: MAX_CONTEXT_CHARS,
      maxHistoryMessages: MAX_HISTORY_MESSAGES,
    },
  };
}

/**
 * Drops a message and everything after it, under the claim this turn already
 * holds, and releases the images that lose their last link. Only a user
 * message can be replaced; the check happens before anything is deleted.
 */
export async function rewindTo(
  request: TurnRequest,
  claim: TurnClaim,
  messageId: string,
) {
  const rewound = await data.messages.deleteOwnedMessage(
    request.userId,
    request.conversationId,
    messageId,
    { claimToken: claim.token, onlyRole: "user" },
  );

  if (!rewound) {
    throw new TurnRejected(404, { message: "Message not found" });
  }
  if (rewound.status === "wrong_role") {
    throw new TurnRejected(400, {
      message: "Only user messages can be edited",
    });
  }
  if (rewound.status === "active") {
    throw new TurnRejected(409, {
      message: "A response is already in progress",
    });
  }

  await uploads.deleteObjects(
    request.userId,
    rewound.imageUploadIds.map((uploadId) => ({
      kind: "image" as const,
      uploadId,
    })),
  );
}

async function titleForFirstTurn(content: string, conversationId: string) {
  const fallback = content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FALLBACK_CONVERSATION_TITLE_CHARS);

  try {
    return (await chat.generateTitle("conversation", content)) || fallback;
  } catch (error) {
    log.warn("Conversation title generation failed", {
      conversationId,
      error: messageOf(error),
    });
    return fallback;
  }
}

/**
 * Asks the model, handing each piece of the answer to `onDelta`, then saves
 * the turn and lets go of the claim in one transaction, keeping its text for
 * the next turn's history read here. Returns the conversation's new head.
 * `onModelFinished` marks the model being done with a reply that will be
 * saved, stopped or not.
 *
 * A stopped reply is saved with what came before the stop, marked as
 * stopped. One stopped before anything came isn't saved: this returns null,
 * and the caller still holds the claim.
 */
export async function answerTurn(
  request: TurnRequest,
  claim: TurnClaim,
  prepared: PreparedTurn,
  entry: ReplyInProgressEntry,
  onDelta: (delta: string) => void,
  onModelFinished: () => void,
) {
  const conversationTitle =
    request.expectedLastMessageId === null
      ? titleForFirstTurn(request.content, request.conversationId)
      : Promise.resolve(undefined);

  let assistantContent: string;
  let stopped = false;
  try {
    assistantContent = await chat.complete(
      request.chosenModelId,
      prepared.prompt,
      {
        onDelta: async (delta) => {
          entry.append(delta);
          onDelta(delta);
        },
        maxOutputTokens: MAX_RESPONSE_TOKENS,
        sessionId: request.conversationId,
        signal: entry.signal,
      },
    );
  } catch (error) {
    if (!entry.stopped) throw error;
    if (entry.text.length === 0) return null;
    assistantContent = entry.text;
    stopped = true;
  }
  onModelFinished();

  const title = await conversationTitle;
  const saved = await measurePreparation(
    "persistAndUnclaimChatTurn",
    undefined,
    () =>
      data.messages.persistAndUnclaimChatTurn({
        userId: request.userId,
        conversationId: request.conversationId,
        content: request.content,
        attachmentIds: request.attachmentIds,
        chosenModelId: request.chosenModelId,
        assistantContent,
        stopped,
        conversationTitle: title,
        contextWindowMessageCount: countMessagesInContextWindow([
          assistantContent.length,
          prepared.newTurnCharCount,
          ...prepared.historyCharCounts,
        ]),
        claimToken: claim.token,
      }),
  );
  memory.historyText.rememberTurn(request.userId, request.conversationId, {
    userMessageId: saved.userMessageId,
    content: request.content,
    transcripts: prepared.newTurnTranscripts,
    assistantMessageId: saved.assistantMessageId,
    assistantContent,
  });
  return { lastMessageId: saved.assistantMessageId, stopped };
}
