import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createConversation, type Conversation } from "../../api/conversations";
import { ApiError, errorMessage } from "../../api/http";
import {
  fetchMessages,
  stopReply,
  streamMessage,
  type ChatMessage,
  type MessageAttachmentInput,
  type MessagesResponse,
  type TurnStats,
} from "../../api/messages";
import { queryKeys } from "../../lib/queryClient";
import { useServer } from "../../hooks/server/useServer";
import { useToast } from "../../hooks/toast/useToast";
import { stageSource, type StagedSource } from "../../sources/types";
import type { PendingTurn } from "./types";
import { localId } from "../../lib/localId";

/** A turn stopped before any of its reply came, so nothing was saved. */
class TurnCancelled extends Error {}

/** Deltas arrive faster than a long reply can be re-parsed; batch them. */
const FLUSH_INTERVAL_MS = 80;

/**
 * Collects streamed deltas, handing the text so far to `onFlush` at most once
 * per interval. `stop` drops a flush that is still pending, for the caller
 * that is about to write the finished text itself.
 */
function createDeltaBuffer(onFlush: (text: string) => void) {
  let text = "";
  let timer: number | null = null;

  return {
    get text() {
      return text;
    },
    push(delta: string) {
      text += delta;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        onFlush(text);
      }, FLUSH_INTERVAL_MS);
    },
    stop() {
      if (timer !== null) window.clearTimeout(timer);
    },
  };
}

/** The record without `keys`, or the record itself when it had none of them. */
function without<T>(
  record: Record<string, T>,
  ...keys: (string | null | undefined)[]
): Record<string, T> {
  const present = keys.filter(
    (key): key is string => key != null && key in record,
  );
  if (present.length === 0) return record;

  const next = { ...record };
  for (const key of present) delete next[key];
  return next;
}

function messageAttachmentsOf(
  sources: StagedSource[],
): MessageAttachmentInput[] {
  const attachments: MessageAttachmentInput[] = [];
  for (const source of sources) {
    if (!source.sourceUploadId) continue;
    attachments.push(
      source.kind === "image"
        ? { type: "image", imageUploadId: source.sourceUploadId }
        : { type: "transcript", audioUploadId: source.sourceUploadId },
    );
  }
  return attachments;
}

/**
 * The turn as it will be stored, built from what the client already has: the
 * text it sent, the sources it staged, and the reply it just streamed. Writing
 * this into the cache is what saves re-downloading the whole conversation
 * after every message.
 *
 * The user message gets a local id because the server only returns the
 * assistant's. The query is marked stale straight after, so the next fetch
 * replaces both with the stored rows.
 */
function toStoredTurns(
  input: { content: string; modelId: string; sources: StagedSource[] },
  conversationId: string,
  assistant: { id: string; content: string; stopped: boolean },
): ChatMessage[] {
  const createdAt = new Date().toISOString();
  const user: ChatMessage = {
    id: `local:${localId()}`,
    role: "user",
    content: input.content,
    chosenModelId: null,
    conversationId,
    createdAt,
    attachments: input.sources
      .filter((source) => source.kind === "image" && source.sourceUploadId)
      .map((source) => ({
        imageUploadId: source.sourceUploadId as string,
        fileName: source.name,
        mimeType: source.file?.type ?? "",
        size: source.file?.size ?? 0,
        url: source.previewUrl ?? "",
      })),
    transcriptAttachments: input.sources.flatMap((source) =>
      source.kind !== "image" && source.sourceUploadId
        ? [
            {
              audioUploadId: source.sourceUploadId,
              fileName: source.name,
              source: source.kind,
            },
          ]
        : [],
    ),
    stopped: false,
  };
  return [
    user,
    {
      ...assistant,
      role: "assistant",
      chosenModelId: input.modelId,
      conversationId,
      createdAt,
      attachments: [],
      transcriptAttachments: [],
    },
  ];
}

/**
 * A stored user message's attachments as composer sources, already uploaded
 * and transcribed, so an edit can resend them and a failed one can hand them
 * back to the composer like a failed send does.
 */
export function sourcesOfMessage(message: ChatMessage): StagedSource[] {
  return [
    ...message.transcriptAttachments.map((transcript) =>
      stageSource({
        kind: transcript.source,
        name: transcript.fileName,
        status: "ready",
        sourceUploadId: transcript.audioUploadId,
      }),
    ),
    ...message.attachments.map((image) =>
      stageSource({
        kind: "image",
        name: image.fileName,
        status: "ready",
        sourceUploadId: image.imageUploadId,
        previewUrl: image.url,
      }),
    ),
  ];
}

function toPendingTurn(
  content: string,
  sources: StagedSource[],
  replacesMessageId: string | null,
): PendingTurn {
  return {
    content,
    replacesMessageId,
    images: sources
      .filter((source) => source.kind === "image")
      .map((source) => ({
        imageUploadId: source.sourceUploadId ?? source.localId,
        fileName: source.name,
        url: source.previewUrl ?? "",
      })),
    transcripts: sources.flatMap((source) =>
      source.kind !== "image"
        ? [
            {
              audioUploadId: source.sourceUploadId ?? source.localId,
              fileName: source.name,
              source: source.kind,
            },
          ]
        : [],
    ),
    assistantContent: "",
    reloading: false,
    stoppable: false,
  };
}

type TurnInput = {
  content: string;
  modelId: string;
  sources: StagedSource[];
  lastMessageId: string | null;
  /** Puts the message back in the composer when the turn didn't take. */
  onRestore: (
    content: string,
    sources: StagedSource[],
    draftKey: string,
  ) => void;
};

type SendInput = TurnInput & {
  conversationId: string | undefined;
  /** Called once the conversation exists, before the reply starts. */
  onConversation: (conversationId: string) => void;
};

type EditInput = TurnInput & {
  conversationId: string;
  /** The user message being replaced, along with everything after it. */
  message: ChatMessage;
};

/** Ids the client made up for a turn it wrote into the cache itself. */
function isLocalId(id: string) {
  return id.startsWith("local:");
}

/**
 * Owns the turns that are mid-flight. Keyed by conversation so a reply streaming
 * in one chat keeps streaming while you read or write in another.
 */
export function useChatSend() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingTurns, setPendingTurns] = useState<Record<string, PendingTurn>>(
    {},
  );
  const [sendingKeys, setSendingKeys] = useState<Record<string, boolean>>({});
  const [stoppingKeys, setStoppingKeys] = useState<Record<string, boolean>>({});
  /**
   * How each reply streamed to this page went, by its stored id. Kept for
   * the page's life only: a reply loaded from history has none.
   */
  const [turnStats, setTurnStats] = useState<Record<string, TurnStats>>({});

  const dropPending = useCallback((conversationId: string) => {
    setPendingTurns((current) => without(current, conversationId));
  }, []);

  /**
   * The id the server knows a message by. A turn this client just sent sits
   * in the cache under a made-up id until the next fetch, so look it up by
   * position: the stored history lists the same messages in the same order.
   */
  const storedIdOf = useCallback(
    async (conversationId: string, message: ChatMessage) => {
      if (!isLocalId(message.id)) return message.id;

      const key = queryKeys.messages(server.id, conversationId);
      const position = (
        queryClient.getQueryData<MessagesResponse>(key)?.messages ?? []
      ).indexOf(message);
      const stored = await queryClient.fetchQuery({
        queryKey: key,
        queryFn: () => fetchMessages(server, conversationId),
        staleTime: 0,
      });
      const match = stored.messages[position];
      if (position < 0 || match?.role !== "user" || isLocalId(match.id)) {
        throw new Error("This message changed. Reload the chat and try again.");
      }
      return match.id;
    },
    [queryClient, server],
  );

  /**
   * Streams one turn into `target` and writes it into the cache once stored.
   * An edit's turn replaces the edited message and everything after it, on
   * the server and in the cache alike.
   */
  const streamTurn = useCallback(
    async (
      target: string,
      input: TurnInput,
      replaces: { message: ChatMessage; storedId: string } | null,
    ) => {
      // A stop of a reply this page only showed has nothing here to clear
      // it once that reply ends, so the next turn starts unstopped.
      setStoppingKeys((current) => without(current, target));
      setPendingTurns((current) => ({
        ...current,
        [target]: toPendingTurn(
          input.content,
          input.sources,
          // The stored id: finding it may have refetched the history, which
          // replaces a local id the cache held for this message.
          replaces?.storedId ?? null,
        ),
      }));

      // Set from a callback, which TypeScript doesn't follow; typed by hand so
      // it isn't narrowed to null for good.
      let stored = null as {
        id: string;
        stopped: boolean;
        stats?: TurnStats;
      } | null;
      let cancelled = false;
      const deltas = createDeltaBuffer((assistantContent) =>
        setPendingTurns((current) => {
          const turn = current[target];
          if (!turn) return current;
          return { ...current, [target]: { ...turn, assistantContent } };
        }),
      );

      try {
        await streamMessage(
          server,
          {
            conversationId: target,
            messageContent: input.content,
            chosenModelId: input.modelId,
            attachments: messageAttachmentsOf(input.sources),
            lastMessageId: input.lastMessageId,
            ...(replaces ? { replacesMessageId: replaces.storedId } : {}),
          },
          {
            onOpen: () =>
              setPendingTurns((current) => {
                const turn = current[target];
                if (!turn) return current;
                return { ...current, [target]: { ...turn, stoppable: true } };
              }),
            onDelta: (delta) => deltas.push(delta),
            onDone: (lastMessageId, stopped, stats) => {
              stored = { id: lastMessageId, stopped, stats };
            },
            onCancelled: () => {
              cancelled = true;
            },
          },
        );
      } finally {
        deltas.stop();
        setStoppingKeys((current) => without(current, target));
      }
      if (cancelled) throw new TurnCancelled();
      const stats = stored?.stats;
      if (stored && stats) {
        const storedId = stored.id;
        setTurnStats((current) => ({ ...current, [storedId]: stats }));
      }
      const assistant = {
        id: stored?.id ?? `local:${localId()}`,
        content: deltas.text,
        stopped: stored?.stopped ?? false,
      };

      // Write the finished turn into the cache rather than refetching the
      // conversation: the whole history came down the wire after every
      // message, and it only grows. Cancel first so an in-flight fetch can't
      // land on top of this.
      await queryClient.cancelQueries({
        queryKey: queryKeys.messages(server.id, target),
      });
      queryClient.setQueryData<MessagesResponse>(
        queryKeys.messages(server.id, target),
        (current) => {
          const messages = current?.messages ?? [];
          const kept = replaces
            ? messages.slice(
                0,
                messages.findIndex(
                  (message) =>
                    message.id === replaces.message.id ||
                    message.id === replaces.storedId,
                ),
              )
            : messages;
          return {
            lastMessageId: stored?.id ?? current?.lastMessageId ?? null,
            messages: [...kept, ...toStoredTurns(input, target, assistant)],
            replyInProgress: null,
          };
        },
      );
      dropPending(target);
      // Stale, but not refetched now: the next mount reconciles the local
      // user-message id against the stored one at no cost here.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(server.id, target),
        refetchType: "none",
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations(server.id),
      });
    },
    [dropPending, queryClient, server],
  );

  /**
   * A turn that didn't take, sent or edited alike: the composer gets the
   * message back and the chat is refetched to show what the server kept. A
   * failed edit's rewind stands, so the edited message is gone from the chat
   * and its text waits in the composer, as a failed send's does. A turn
   * stopped before its reply began ends the same way, without the error.
   */
  const recover = useCallback(
    (
      error: unknown,
      input: TurnInput,
      conversationId: string | undefined,
      fallback: string,
    ) => {
      if (conversationId) {
        setPendingTurns((current) => {
          const turn = current[conversationId];
          if (!turn) return current;
          return { ...current, [conversationId]: { ...turn, reloading: true } };
        });
        // The run outlives this stream server-side; a refetch is how a reply
        // that finished anyway still reaches the screen. A turn sent while it
        // runs isn't reloading, so it is left alone.
        void queryClient
          .invalidateQueries({
            queryKey: queryKeys.messages(server.id, conversationId),
          })
          .finally(() =>
            setPendingTurns((current) =>
              current[conversationId]?.reloading
                ? without(current, conversationId)
                : current,
            ),
          );
      }
      input.onRestore(input.content, input.sources, conversationId ?? "new");
      if (error instanceof TurnCancelled) return;
      toast.show({
        kind: "error",
        message:
          error instanceof ApiError && error.status === 409
            ? "This chat moved on. Its latest messages were reloaded — try again."
            : errorMessage(error, fallback),
      });
    },
    [queryClient, server, toast],
  );

  const send = useCallback(
    async (input: SendInput) => {
      let conversationId = input.conversationId;
      const startedKey = conversationId ?? "new";
      setSendingKeys((current) => ({ ...current, [startedKey]: true }));

      try {
        if (!conversationId) {
          const created = await createConversation(server);
          const createdId = created.id;
          conversationId = createdId;
          queryClient.setQueryData<Conversation[]>(
            queryKeys.conversations(server.id),
            (current) => [
              created,
              ...(current ?? []).filter(
                (conversation) => conversation.id !== createdId,
              ),
            ],
          );
          setSendingKeys((current) => ({ ...current, [createdId]: true }));
          input.onConversation(createdId);
        }

        await streamTurn(conversationId, input, null);
      } catch (error) {
        recover(error, input, conversationId, "The message didn't send.");
      } finally {
        setSendingKeys((current) =>
          without(current, startedKey, conversationId),
        );
      }
    },
    [queryClient, recover, server, streamTurn],
  );

  /** Replaces a user message, and every turn after it, with a new turn. */
  const edit = useCallback(
    async (input: EditInput) => {
      const { conversationId } = input;
      setSendingKeys((current) => ({ ...current, [conversationId]: true }));

      try {
        const storedId = await storedIdOf(conversationId, input.message);
        await streamTurn(conversationId, input, {
          message: input.message,
          storedId,
        });
      } catch (error) {
        recover(error, input, conversationId, "The edit didn't send.");
      } finally {
        setSendingKeys((current) => without(current, conversationId));
      }
    },
    [recover, storedIdOf, streamTurn],
  );

  /**
   * Stops the reply being written in a conversation, whether this page is
   * streaming it or only showing how far it had got. How it ends arrives the
   * way the reply would have: its stream, or the replyFinished event.
   */
  const stop = useCallback(
    async (conversationId: string) => {
      setStoppingKeys((current) => ({ ...current, [conversationId]: true }));
      try {
        await stopReply(server, conversationId);
      } catch (error) {
        toast.show({
          kind: "error",
          message: errorMessage(error, "The reply didn't stop."),
        });
        setStoppingKeys((current) => without(current, conversationId));
      }
    },
    [server, toast],
  );

  return {
    pendingTurns,
    sendingKeys,
    stoppingKeys,
    turnStats,
    send,
    edit,
    stop,
  };
}
