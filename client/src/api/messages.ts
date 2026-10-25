import type {
  ChatMessage,
  MessageAttachmentInput,
  MessagesResponse,
  MessageTranscript,
  ReplyInProgress,
  ReplyStreamEvents,
  SendMessageBody,
  TurnStats,
} from "@parley/contract";
import { readServerSentEvents, type ServerSentEvent } from "../sse/reader";
import { ApiError, apiFetch, apiJson, jsonRequest } from "./http";
import { serverUrl, type Server } from "./server";

export type {
  ChatMessage,
  MessageAttachmentInput,
  MessagesResponse,
  MessageTranscript,
  ReplyInProgress,
  TurnStats,
};

/**
 * How many turns the server replays (messages.controller.ts). The client needs
 * it to predict what a turn will actually send: the prompt is not just the
 * message being written, it is the replayed history as well, and a model has
 * to be able to serve the whole thing.
 */
export const MAX_CONTEXT_MESSAGES = 50;

export type SendMessageInput = SendMessageBody & {
  conversationId: string;
  /**
   * Set to edit that message instead of adding one: the server drops it and
   * everything after it, then answers this turn in its place.
   */
  replacesMessageId?: string;
};

export async function fetchMessages(
  server: Server,
  conversationId: string,
): Promise<MessagesResponse> {
  const data = await apiJson<MessagesResponse>(
    server,
    `/conversations/${conversationId}/messages`,
  );
  if (!Array.isArray(data?.messages)) {
    throw new Error("Invalid messages response");
  }
  return {
    ...data,
    messages: data.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((image) => ({
        ...image,
        url: serverUrl(server, image.url),
      })),
    })),
  };
}

type StreamCallbacks = {
  /** The reply has started, so it can be stopped from now on. */
  onOpen: () => void;
  onDelta: (delta: string) => void;
  /** `stats` when the server sent them, for the reply's stats panel. */
  onDone: (lastMessageId: string, stopped: boolean, stats?: TurnStats) => void;
  /** Stopped before any of the reply came: nothing was saved. */
  onCancelled: () => void;
};

function dispatchReplyEvent(
  { event: eventName, data: rawData }: ServerSentEvent,
  callbacks: StreamCallbacks,
): void {
  // Checked field by field rather than trusted, since a stream can be cut off
  // or come from a proxy's error page.
  const data = JSON.parse(rawData) as Partial<
    ReplyStreamEvents["delta"] &
      ReplyStreamEvents["done"] &
      ReplyStreamEvents["error"]
  >;
  if (eventName === "delta" && typeof data.delta === "string") {
    callbacks.onDelta(data.delta);
  } else if (eventName === "done" && typeof data.lastMessageId === "string") {
    callbacks.onDone(
      data.lastMessageId,
      data.stopped === true,
      Array.isArray(data.stats?.steps) && typeof data.stats.context === "object"
        ? data.stats
        : undefined,
    );
  } else if (eventName === "cancelled") {
    callbacks.onCancelled();
  } else if (eventName === "error") {
    throw new Error(
      typeof data.message === "string" ? data.message : "Model response failed",
    );
  }
}

/**
 * Sends the turn and reads the reply off the SSE body. EventSource can't POST,
 * so this is fetch + a reader. The run itself is server-side and finishes even
 * if this stream dies — a failure here means "refetch", not "the turn was lost".
 *
 * An edit (`replacesMessageId`) streams the same way. If the model fails once
 * the server has dropped the old turns, they stay dropped and nothing new is
 * saved, which reads exactly like a send that failed.
 */
export async function streamMessage(
  server: Server,
  input: SendMessageInput,
  callbacks: StreamCallbacks,
): Promise<void> {
  const messagesPath = `/conversations/${input.conversationId}/messages`;
  const response = await apiFetch(
    server,
    input.replacesMessageId
      ? `${messagesPath}/${input.replacesMessageId}`
      : messagesPath,
    jsonRequest(input.replacesMessageId ? "PATCH" : "POST", {
      messageContent: input.messageContent,
      chosenModelId: input.chosenModelId,
      attachments: input.attachments,
      lastMessageId: input.lastMessageId,
    } satisfies SendMessageBody),
  );

  if (!response.body) throw new Error("The response stream was empty");
  callbacks.onOpen();

  let completed = false;
  await readServerSentEvents(response.body, (event) =>
    dispatchReplyEvent(event, {
      ...callbacks,
      onDone: (lastMessageId, stopped, stats) => {
        completed = true;
        callbacks.onDone(lastMessageId, stopped, stats);
      },
      onCancelled: () => {
        completed = true;
        callbacks.onCancelled();
      },
    }),
  );
  if (!completed) throw new Error("The response stream ended unexpectedly");
}

/**
 * Stops the reply being written in a conversation. The turn's own stream, or
 * the replyFinished event for a page that no longer has it, says how it
 * ended. A 404 means it ended before the stop got there, which is no failure.
 */
export async function stopReply(
  server: Server,
  conversationId: string,
): Promise<void> {
  try {
    await apiFetch(server, `/conversations/${conversationId}/messages/stop`, {
      method: "POST",
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}
