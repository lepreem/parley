import { Link, useParams, useSearchParams } from "react-router-dom";
import { useConversationsQuery } from "../../hooks/queries/useConversationQueries";
import {
  useProjectsOffered,
  useProjectsQuery,
} from "../../hooks/queries/useProjectQueries";
import { useServer } from "../../hooks/server/useServer";
import { useServerReady } from "../../hooks/server/useServerReady";
import { useCapabilities } from "../../hooks/auth/useCapabilities";
import { Icon } from "../ui/Icon";
import { NEW_CHAT_PROJECT_PARAM, projectPath } from "./sections";
import { useShell } from "./shellContext";

export function TopBar() {
  const { conversationId, projectId } = useParams<{
    conversationId: string;
    projectId: string;
  }>();
  const [searchParams] = useSearchParams();
  const server = useServer();
  const ready = useServerReady();
  const can = useCapabilities();
  const { setSidebarOpen, setSourcesOpen } = useShell();
  const conversationsQuery = useConversationsQuery(ready);
  const projectsQuery = useProjectsQuery(ready);
  const projectsOffered = useProjectsOffered();

  const conversation = conversationId
    ? conversationsQuery.data?.find(
        (candidate) => candidate.id === conversationId,
      )
    : undefined;
  // The project this page is in: its own page, a chat in it, or a new chat
  // about to start in it.
  const inProjectId = projectsOffered
    ? (projectId ??
      (conversationId
        ? conversation?.projectId
        : searchParams.get(NEW_CHAT_PROJECT_PARAM)))
    : undefined;
  const project = inProjectId
    ? projectsQuery.data?.find((candidate) => candidate.id === inProjectId)
    : undefined;

  const title = projectId
    ? null
    : conversationId
      ? (conversation?.title ?? "Chat")
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

      <h1 className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-sm font-medium">
        {project && (
          <>
            <Link
              to={projectPath(server, project.id)}
              className={`flex min-w-0 shrink items-center gap-1.5 truncate transition-colors hover:text-ink ${
                title === null ? "text-ink" : "max-w-[45%] text-muted"
              }`}
            >
              <Icon name="folder" className="h-4 w-4 shrink-0" />
              <span className="truncate">{project.name}</span>
            </Link>
            {title !== null && <span className="shrink-0 text-faint">/</span>}
          </>
        )}
        {title !== null && <span className="min-w-0 truncate">{title}</span>}
      </h1>

      {/* Without attachments there are no sources. */}
      {can.attachments && (
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
