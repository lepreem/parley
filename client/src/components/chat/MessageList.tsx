import { useEffect, useRef, useState } from "react";
import type { ChatMessage, TurnStats } from "../../api/messages";
import { Icon } from "../ui/Icon";
import { Meter } from "../ui/Meter";
import { AssistantTurn } from "./AssistantTurn";
import { UserTurn } from "./UserTurn";
import type { PendingTurn } from "./types";

const STICK_THRESHOLD_PX = 80;

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Meter state="ready" className="h-5" />
      <h2 className="mt-5 font-mono text-xl tracking-tight">
        Bring a recording.
      </h2>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        Drop audio, video, or a YouTube link and it becomes a transcript you can
        question — several at once, in one message.
      </p>
    </div>
  );
}

function LoadingTurns() {
  return (
    <div className="space-y-6 py-8">
      <div className="ml-auto h-16 w-2/3 rounded-2xl bg-sunk" />
      <div className="h-24 w-full rounded-lg bg-sunk" />
    </div>
  );
}

export function MessageList({
  messages,
  pending,
  loading,
  onEdit,
  canEdit,
  turnStats,
}: {
  messages: ChatMessage[];
  pending: PendingTurn | null;
  loading: boolean;
  /** Replaces a user message, and every turn after it, with a new turn. */
  onEdit: (message: ChatMessage, content: string) => void;
  canEdit: boolean;
  /** Stats for the replies streamed to this page, by message id. */
  turnStats: Record<string, TurnStats>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  const handleScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setStuckToBottom(distanceFromBottom < STICK_THRESHOLD_PX);
  };

  // Following the reply is the default, but reading back through history wins:
  // scrolling up detaches and nothing yanks the view down again until you return.
  useEffect(() => {
    if (!stuckToBottom) return;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, pending?.assistantContent, pending?.content, stuckToBottom]);

  // While an edit is answered, the turns it replaces are already gone on the
  // server; show the conversation as it will read once the edit lands.
  const replacedAt = pending?.replacesMessageId
    ? messages.findIndex((message) => message.id === pending.replacesMessageId)
    : -1;
  const shown = replacedAt >= 0 ? messages.slice(0, replacedAt) : messages;

  const isEmpty = messages.length === 0 && !pending && !loading;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[46rem] px-4 pb-6 pt-8">
          {isEmpty ? (
            <div className="h-[60vh]">
              <EmptyState />
            </div>
          ) : loading ? (
            <LoadingTurns />
          ) : (
            <div className="space-y-8">
              {shown.map((message) =>
                message.role === "user" ? (
                  <UserTurn
                    key={message.id}
                    content={message.content}
                    images={message.attachments}
                    transcripts={message.transcriptAttachments}
                    onEdit={(content) => onEdit(message, content)}
                    canEdit={canEdit && !pending}
                  />
                ) : (
                  <AssistantTurn
                    key={message.id}
                    content={message.content}
                    modelId={message.chosenModelId}
                    stopped={message.stopped}
                    stats={turnStats[message.id]}
                  />
                ),
              )}

              {pending && !pending.reloading && (
                <>
                  <UserTurn
                    content={pending.content}
                    images={pending.images}
                    transcripts={pending.transcripts}
                  />
                  <AssistantTurn
                    content={pending.assistantContent}
                    streaming
                    elsewhere={pending.elsewhere}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {!stuckToBottom && (
        <button
          type="button"
          onClick={() => {
            const scroller = scrollRef.current;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          }}
          aria-label="Jump to the latest message"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface p-2 text-muted shadow-md transition-colors hover:text-ink"
        >
          <Icon name="arrowDown" className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
