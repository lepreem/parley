import { useState } from "react";
import { Link, useMatch, useNavigate, useParams } from "react-router-dom";
import {
  useConversationsQuery,
  useDeleteConversationMutation,
  useRenameConversationMutation,
} from "../../hooks/queries/useConversationQueries";
import {
  useMoveConversationMutation,
  useProjectsOffered,
  useProjectsQuery,
} from "../../hooks/queries/useProjectQueries";
import { useAuth } from "../../hooks/auth/useAuth";
import { useTier } from "../../hooks/auth/useCapabilities";
import { useServer } from "../../hooks/server/useServer";
import { useServerReady } from "../../hooks/server/useServerReady";
import {
  authLoginUrl,
  cloudServer,
  canReachLocalServer,
  localServer,
  servedByLocalServer,
} from "../../config";
import { Icon } from "../ui/Icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { UseThisComputer } from "../auth/UseThisComputer";
import { UserAvatar } from "../avatar/AvatarPicker";
import { ConversationRow } from "./ConversationRow";
import { PhoneAccessButton } from "./PhoneAccessButton";
import { ProjectList } from "./ProjectList";
import { groupConversations } from "./conversationGroups";
import { sectionPath, settingsPath } from "./sections";
import { useShell } from "./shellContext";

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center">
        <svg viewBox="0 0 48 46" fill="none" className="h-full w-full">
          <path
            d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z"
            className="fill-signal"
          />
        </svg>
      </span>
      <span className="eyebrow text-ink">Parley</span>
    </span>
  );
}

const SECTIONS = [
  { server: cloudServer, label: "Cloud" },
  { server: localServer, label: "This computer" },
];

/**
 * Cloud or this computer: where the chats below run. Each keeps its own
 * conversations, so switching changes the whole list.
 */
function SectionSwitch() {
  const server = useServer();
  const { setSidebarOpen } = useShell();
  // A page the local server served can't reach the cloud: one section only.
  if (servedByLocalServer) return null;
  // The hosted site can't reach this computer: it offers the app instead.
  if (!canReachLocalServer) {
    return (
      <UseThisComputer className="mx-3 mb-3 rounded-lg border border-line bg-surface px-2 py-1.5 text-center text-[12px] font-medium text-muted transition-colors hover:text-ink" />
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Where chats run"
      className="mx-3 mb-3 grid grid-cols-2 rounded-lg border border-line bg-surface p-0.5"
    >
      {SECTIONS.map(({ server: target, label }) => {
        const active = target.id === server.id;
        return (
          <Link
            key={target.id}
            to={sectionPath(target)}
            role="tab"
            aria-selected={active}
            onClick={() => setSidebarOpen(false)}
            className={`rounded-md px-2 py-1.5 text-center text-[12px] font-medium transition-colors ${
              active
                ? "bg-signal-tint text-signal-ink"
                : "text-muted hover:text-ink"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  const { conversationId, projectId } = useParams<{
    conversationId: string;
    projectId: string;
  }>();
  const navigate = useNavigate();
  const server = useServer();
  const { user } = useAuth();
  const onSettings = useMatch(settingsPath(server)) !== null;
  const guest = useTier() === "guest";
  const { sidebarOpen, setSidebarOpen } = useShell();
  const ready = useServerReady();
  const conversationsQuery = useConversationsQuery(ready);
  const projectsOffered = useProjectsOffered();
  const projectsQuery = useProjectsQuery(ready);
  const projects = projectsQuery.data ?? [];
  const renameConversation = useRenameConversationMutation();
  const deleteConversation = useDeleteConversationMutation();
  const moveConversation = useMoveConversationMutation();
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const conversations = conversationsQuery.data ?? [];
  // Like ChatGPT: a project's chats are on its page, not in this list.
  const groups = groupConversations(
    conversations.filter((conversation) => !conversation.projectId),
  );
  const activeProjectId =
    projectId ??
    conversations.find((conversation) => conversation.id === conversationId)
      ?.projectId ??
    null;

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const deletedId = pendingDelete.id;
    setPendingDelete(null);
    deleteConversation.mutate(
      { conversationId: deletedId },
      {
        onSuccess: () => {
          if (deletedId === conversationId)
            navigate(sectionPath(server), { replace: true });
        },
      },
    );
  };

  return (
    <>
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-ink/40 md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] shrink-0 flex-col border-r border-line bg-sunk transition-transform duration-200 motion-reduce:transition-none md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <Wordmark />
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink md:hidden"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <SectionSwitch />

        <div className="space-y-1 px-3 pb-3">
          <Link
            to={sectionPath(server)}
            onClick={() => setSidebarOpen(false)}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:border-signal"
          >
            <Icon name="plus" className="h-4 w-4" />
            New chat
          </Link>
          <PhoneAccessButton />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {/* Sources are in the top bar; this spot is the projects'. */}
          {projectsOffered && (
            <div className="pb-2">
              <ProjectList
                projects={projects}
                loading={projectsQuery.isLoading}
                activeProjectId={activeProjectId}
                onOpen={() => setSidebarOpen(false)}
              />
            </div>
          )}
          {conversationsQuery.isLoading ? (
            <div className="space-y-2 pt-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="h-9 rounded-lg bg-surface/60" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <p className="px-3 py-6 text-sm text-faint">
              Your chats will show up here.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="pt-4 first:pt-1">
                <p className="eyebrow px-3 pb-2 text-faint">{group.label}</p>
                <div className="space-y-0.5">
                  {group.conversations.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === conversationId}
                      onOpen={() => setSidebarOpen(false)}
                      onRename={(title) =>
                        renameConversation.mutate({
                          conversationId: conversation.id,
                          title,
                        })
                      }
                      onDelete={() =>
                        setPendingDelete({
                          id: conversation.id,
                          title: conversation.title,
                        })
                      }
                      {...(projectsOffered
                        ? {
                            move: {
                              projects,
                              onMove: (target: string | null) =>
                                moveConversation.mutate({
                                  conversationId: conversation.id,
                                  projectId: target,
                                }),
                            },
                          }
                        : {})}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </nav>

        <div className="space-y-1 border-t border-line p-2">
          {guest && (
            // A guest can't sign out, only lose their chats: signing in
            // keeps them, so that's what's offered.
            <a
              href={authLoginUrl()}
              className="block rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface"
            >
              <span className="block font-medium text-ink">Sign in</span>
              <span className="block text-xs text-faint">
                to keep your chats and add files
              </span>
            </a>
          )}
          <Link
            to={settingsPath(server)}
            onClick={() => setSidebarOpen(false)}
            aria-current={onSettings ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface ${
              onSettings ? "bg-surface" : ""
            }`}
          >
            {user && server.signIn === "session" && !guest ? (
              <UserAvatar userId={user.userId} className="h-7 w-7 shrink-0" />
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-muted">
                <Icon name="settings" className="h-3.5 w-3.5" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">
                Settings
              </span>
              <span className="block truncate text-xs text-faint">
                {server.signIn !== "session"
                  ? "Runs on this computer"
                  : guest
                    ? "Appearance"
                    : "Your account and appearance"}
              </span>
            </span>
          </Link>
        </div>
      </aside>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this chat?"
          body={`“${pendingDelete.title}” and every message in it will be removed. This can't be undone.`}
          confirmLabel="Delete chat"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
