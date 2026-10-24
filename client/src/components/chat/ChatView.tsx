import { useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CHARS_PER_TOKEN,
  meetsRequirements,
  resolveDefaultModel,
  type MessageRequirements,
} from "../../api/models";
import { useServerReady } from "../../hooks/server/useServerReady";
import { useChatModelsQuery } from "../../hooks/queries/useModelsQuery";
import { useServer } from "../../hooks/server/useServer";
import { sectionPath } from "../app/sections";
import { MAX_CONTEXT_MESSAGES } from "../../api/messages";
import { useMessagesQuery } from "../../hooks/queries/useMessagesQuery";
import { isSourceInFlight, type StagedSource } from "../../sources/types";
import { useSources } from "../../sources/useSources";
import { Composer } from "../composer/Composer";
import { DropOverlay } from "../composer/DropOverlay";
import { MessageList } from "./MessageList";
import type { ChatMessage, ReplyInProgress } from "../../api/messages";
import type { PendingTurn } from "./types";
import { sourcesOfMessage, useChatSend } from "./useChatSend";

const NEW_CHAT_KEY = "new";

/**
 * A turn the server is answering that this page isn't streaming: sent from
 * another tab, or before a reload. Only its text is known.
 */
function pendingTurnOf(reply: ReplyInProgress): PendingTurn {
  return {
    content: reply.content,
    replacesMessageId: null,
    images: [],
    transcripts: [],
    assistantContent: reply.assistantContent,
    reloading: false,
    stoppable: true,
    elsewhere: true,
  };
}

function blockedReasonFor(sources: StagedSource[]): string | null {
  const failed = sources.find((source) => source.status === "failed");
  if (failed)
    return `${failed.name} didn't upload. Retry or remove it to send.`;

  const waiting = sources.find(isSourceInFlight);
  if (!waiting) return null;
  if (waiting.status === "preparing") return `Preparing ${waiting.name}…`;
  if (waiting.status === "uploading") return `Uploading ${waiting.name}…`;
  return `Transcribing ${waiting.name} — send unlocks when it lands.`;
}

export function ChatView() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const server = useServer();
  const ready = useServerReady();
  const draftKey = conversationId ?? NEW_CHAT_KEY;

  // Drafts are per chat: switching away and back keeps what you were writing,
  // and the sources already uploading against it.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const text = texts[draftKey] ?? "";
  const setText = (value: string) =>
    setTexts((current) => ({ ...current, [draftKey]: value }));

  const { sources, takeSources, restoreSourcesFor, addFiles } =
    useSources(draftKey);
  const messagesQuery = useMessagesQuery(conversationId);
  const chatModels = useChatModelsQuery(ready);
  const [modelPick, setModelPick] = useState<string | null>(null);
  const {
    pendingTurns,
    sendingKeys,
    stoppingKeys,
    turnStats,
    send,
    edit,
    stop,
  } = useChatSend();

  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const history = messagesQuery.data?.messages;

  /**
   * What the next turn will demand of a model. This is the whole prompt, not
   * just the message being written: the server replays the conversation's
   * recent history, so an image three turns back still makes the request an
   * image request, and the replayed text still has to fit the context window.
   * The API rejects a model that can't serve the assembled context, so the
   * picker hides those rather than letting the send fail.
   */
  const requirements: MessageRequirements = useMemo(() => {
    // Only the window the server actually replays counts.
    const replayed = (history ?? []).slice(-MAX_CONTEXT_MESSAGES);
    const historyChars = replayed.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    const stagedChars = sources.reduce(
      (total, source) =>
        source.kind === "image" ? total : total + (source.charCount ?? 0),
      0,
    );
    // Deliberately not capped at the server's truncation ceiling: a model that
    // only fits because history would be dropped is not a model that can answer
    // this conversation. Once something disqualifies a model it stays
    // disqualified, which makes the list predictable.
    const chars = historyChars + stagedChars + text.length;
    return {
      image:
        sources.some((source) => source.kind === "image") ||
        replayed.some((message) => message.attachments.length > 0),
      tokens: Math.ceil(chars / CHARS_PER_TOKEN),
    };
  }, [history, sources, text]);

  // Requirements narrow the list, so a pick made earlier can fall out of it.
  const eligibleIds = useMemo(
    () =>
      chatModels.models
        .filter((model) => meetsRequirements(model, requirements))
        .map((model) => model.id),
    [chatModels.models, requirements],
  );
  const modelId =
    modelPick && eligibleIds.includes(modelPick)
      ? modelPick
      : resolveDefaultModel(eligibleIds, server.defaultChatModelId);

  const replyInProgress = messagesQuery.data?.replyInProgress ?? null;
  const pending = conversationId
    ? (pendingTurns[conversationId] ??
      (replyInProgress ? pendingTurnOf(replyInProgress) : null))
    : null;
  const sending = !!sendingKeys[draftKey] || !!replyInProgress;
  const blockedReason = blockedReasonFor(sources);
  const historyReady =
    !conversationId || (!!messagesQuery.data && !messagesQuery.error);
  const canSend =
    !!text.trim() && !!modelId && !sending && !blockedReason && historyReady;

  const handleSend = () => {
    if (!canSend || !modelId) return;
    const content = text.trim();
    const staged = takeSources();
    setText("");

    void send({
      conversationId,
      content,
      modelId,
      sources: staged,
      lastMessageId: conversationId
        ? (messagesQuery.data?.lastMessageId ?? null)
        : null,
      onConversation: (createdId) =>
        navigate(sectionPath(server, createdId), { replace: true }),
      onRestore: (restoredContent, restoredSources, restoreKey) => {
        setTexts((current) => ({ ...current, [restoreKey]: restoredContent }));
        restoreSourcesFor(restoreKey, restoredSources);
      },
    });
  };

  // Editing needs what sending needs, bar a draft: a model, a loaded
  // history, and no turn in this chat still being answered.
  const canEdit = !!conversationId && !!modelId && !sending && historyReady;

  /**
   * Sends an edited message in place of `message`, with the attachments it
   * was sent with. If it fails, the composer gets the text and attachments
   * back, as after a failed send.
   */
  const handleEdit = (message: ChatMessage, content: string) => {
    if (!conversationId || !canEdit || !modelId) return;

    void edit({
      conversationId,
      message,
      content,
      modelId,
      sources: sourcesOfMessage(message),
      lastMessageId: messagesQuery.data?.lastMessageId ?? null,
      onRestore: (restoredContent, restoredSources, restoreKey) => {
        setTexts((current) => ({ ...current, [restoreKey]: restoredContent }));
        restoreSourcesFor(restoreKey, restoredSources);
      },
    });
  };

  const handleDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <main
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {messagesQuery.error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="text-sm text-live">
            {messagesQuery.error instanceof Error
              ? messagesQuery.error.message
              : "This chat couldn't be loaded."}
          </p>
        </div>
      ) : (
        <MessageList
          messages={messagesQuery.data?.messages ?? []}
          pending={pending}
          loading={!!conversationId && messagesQuery.isLoading}
          onEdit={handleEdit}
          canEdit={canEdit}
          turnStats={turnStats}
        />
      )}

      <Composer
        draftKey={draftKey}
        text={text}
        onTextChange={setText}
        models={chatModels.models}
        modelId={modelId}
        onModelChange={setModelPick}
        modelsLoading={chatModels.loading}
        modelsError={chatModels.error}
        requirements={requirements}
        sending={sending}
        canSend={canSend}
        onStop={
          conversationId && pending?.stoppable
            ? () => void stop(conversationId)
            : null
        }
        stopping={!!conversationId && !!stoppingKeys[conversationId]}
        blockedReason={blockedReason}
        onSend={handleSend}
      />

      {dragging && <DropOverlay />}
    </main>
  );
}
