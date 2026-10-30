import { useParams } from "react-router-dom";
import { useConversationsQuery } from "../../hooks/queries/useConversationQueries";
import { useServerReady } from "../../hooks/server/useServerReady";
import { useIsGuest } from "../../hooks/auth/useIsGuest";
import { Icon } from "../ui/Icon";
import { useShell } from "./shellContext";

export function TopBar() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const ready = useServerReady();
  const guest = useIsGuest();
  const { setSidebarOpen, setSourcesOpen } = useShell();
  const conversationsQuery = useConversationsQuery(ready);

  const title = conversationId
    ? (conversationsQuery.data?.find(
        (conversation) => conversation.id === conversationId,
      )?.title ?? "Chat")
    : "New chat";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="Open menu"
        className="rounded-lg p-2 text-muted transition-colors hover:bg-sunk hover:text-ink md:hidden"
      >
        <Icon name="panelLeft" className="h-5 w-5" />
      </button>

      <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
        {title}
      </h1>

      {/* Guests chat in text only, so have no sources. */}
      {!guest && (
        <button
          type="button"
          onClick={() => setSourcesOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-signal hover:text-ink"
        >
          <Icon name="library" className="h-4 w-4" />
          <span className="hidden sm:inline">Sources</span>
        </button>
      )}
    </header>
  );
}
