import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MAX_PROJECT_INSTRUCTIONS_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
} from "@parley/contract/limits";
import type { Project } from "../../api/projects";
import {
  useConversationsQuery,
  useDeleteConversationMutation,
  useRenameConversationMutation,
} from "../../hooks/queries/useConversationQueries";
import {
  useDeleteProjectMutation,
  useMoveConversationMutation,
  useProjectsQuery,
  useUpdateProjectMutation,
} from "../../hooks/queries/useProjectQueries";
import { useServer } from "../../hooks/server/useServer";
import { useServerReady } from "../../hooks/server/useServerReady";
import { ConversationRow } from "../app/ConversationRow";
import { newChatInProjectPath, sectionPath } from "../app/sections";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { buttonClass } from "../ui/buttonClass";

/** A project's page: its name, its instructions and its chats. */
export function ProjectView() {
  const { projectId } = useParams<{ projectId: string }>();
  const server = useServer();
  const ready = useServerReady();
  const projectsQuery = useProjectsQuery(ready);
  const project = projectsQuery.data?.find(
    (candidate) => candidate.id === projectId,
  );

  if (!project) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center px-6">
        {projectsQuery.isLoading || !ready ? null : (
          <div className="text-center">
            <p className="text-sm text-muted">
              {projectsQuery.error
                ? "Your projects couldn't be loaded."
                : "This project isn't here any more."}
            </p>
            <Link
              to={sectionPath(server)}
              className="mt-3 inline-block text-sm text-signal-ink hover:underline"
            >
              Start a new chat
            </Link>
          </div>
        )}
      </main>
    );
  }

  // Keyed so another project's page starts from its own name and instructions.
  return <ProjectPage key={project.id} project={project} />;
}

function ProjectPage({ project }: { project: Project }) {
  const server = useServer();
  const navigate = useNavigate();
  const ready = useServerReady();
  const conversationsQuery = useConversationsQuery(ready);
  const projectsQuery = useProjectsQuery(ready);
  const updateProject = useUpdateProjectMutation();
  const deleteProject = useDeleteProjectMutation();
  const renameConversation = useRenameConversationMutation();
  const deleteConversation = useDeleteConversationMutation();
  const moveConversation = useMoveConversationMutation();

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [draftInstructions, setDraftInstructions] = useState(
    project.instructions,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingChatDelete, setPendingChatDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const chats = (conversationsQuery.data ?? []).filter(
    (conversation) => conversation.projectId === project.id,
  );
  const instructionsChanged = draftInstructions !== project.instructions;

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const name = draftName.trim();
    setRenaming(false);
    if (!name || name === project.name) {
      setDraftName(project.name);
      return;
    }
    updateProject.mutate({ projectId: project.id, changes: { name } });
  };

  const saveInstructions = (event: FormEvent) => {
    event.preventDefault();
    if (!instructionsChanged) return;
    updateProject.mutate({
      projectId: project.id,
      changes: { instructions: draftInstructions },
    });
  };

  const confirmProjectDelete = () => {
    setConfirmingDelete(false);
    deleteProject.mutate(
      { projectId: project.id },
      {
        onSuccess: () => navigate(sectionPath(server), { replace: true }),
      },
    );
  };

  const confirmChatDelete = () => {
    if (!pendingChatDelete) return;
    const conversationId = pendingChatDelete.id;
    setPendingChatDelete(null);
    deleteConversation.mutate({ conversationId });
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8">
        <header className="flex items-start gap-3">
          <Icon name="folder" className="mt-1 h-5 w-5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            {renaming ? (
              <form onSubmit={submitRename}>
                <input
                  autoFocus
                  value={draftName}
                  maxLength={MAX_PROJECT_NAME_LENGTH}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setDraftName(project.name);
                      setRenaming(false);
                    }
                  }}
                  aria-label="Project name"
                  className="w-full rounded-lg border border-signal bg-surface px-2.5 py-1.5 text-lg font-semibold outline-none"
                />
              </form>
            ) : (
              <h2 className="truncate text-lg font-semibold text-ink">
                {project.name}
              </h2>
            )}
          </div>
          {!renaming && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setDraftName(project.name);
                  setRenaming(true);
                }}
                aria-label="Rename project"
                title="Rename project"
                className="rounded-lg p-2 text-muted transition-colors hover:bg-sunk hover:text-ink"
              >
                <Icon name="pencil" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete project"
                title="Delete project"
                className="rounded-lg p-2 text-muted transition-colors hover:bg-live-tint hover:text-live"
              >
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </div>
          )}
        </header>

        <Link
          to={newChatInProjectPath(server, project.id)}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:border-signal"
        >
          <Icon name="plus" className="h-4 w-4" />
          New chat in this project
        </Link>

        <form onSubmit={saveInstructions} className="space-y-2">
          <label
            htmlFor="project-instructions"
            className="block text-sm font-medium text-ink"
          >
            Instructions
          </label>
          <p className="text-xs text-faint">
            The model reads these before every message in this project's chats.
          </p>
          <textarea
            id="project-instructions"
            value={draftInstructions}
            maxLength={MAX_PROJECT_INSTRUCTIONS_LENGTH}
            onChange={(event) => setDraftInstructions(event.target.value)}
            rows={7}
            placeholder="e.g. I'm studying for an exam. Explain things simply and quiz me at the end."
            className="block w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-signal"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-faint">
              {draftInstructions.length.toLocaleString()} /{" "}
              {MAX_PROJECT_INSTRUCTIONS_LENGTH.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              {instructionsChanged && (
                <button
                  type="button"
                  onClick={() => setDraftInstructions(project.instructions)}
                  className={buttonClass("quiet")}
                >
                  Discard
                </button>
              )}
              <button
                type="submit"
                disabled={!instructionsChanged || updateProject.isPending}
                className={buttonClass("primary")}
              >
                {updateProject.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>

        <section>
          <p className="eyebrow pb-2 text-faint">Chats</p>
          {conversationsQuery.isLoading ? (
            <div className="h-9 rounded-lg bg-surface/60" />
          ) : chats.length === 0 ? (
            <p className="text-sm text-faint">
              No chats yet. Start one above, or move one here from its menu in
              the sidebar.
            </p>
          ) : (
            <div className="space-y-0.5">
              {chats.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={false}
                  onOpen={() => {}}
                  onRename={(title) =>
                    renameConversation.mutate({
                      conversationId: conversation.id,
                      title,
                    })
                  }
                  onDelete={() =>
                    setPendingChatDelete({
                      id: conversation.id,
                      title: conversation.title,
                    })
                  }
                  move={{
                    projects: projectsQuery.data ?? [],
                    onMove: (target) =>
                      moveConversation.mutate({
                        conversationId: conversation.id,
                        projectId: target,
                      }),
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this project?"
          body={`“${project.name}” and its instructions will be removed. Its chats stay, back in your chat list. This can't be undone.`}
          confirmLabel="Delete project"
          onConfirm={confirmProjectDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {pendingChatDelete && (
        <ConfirmDialog
          title="Delete this chat?"
          body={`“${pendingChatDelete.title}” and every message in it will be removed. This can't be undone.`}
          confirmLabel="Delete chat"
          onConfirm={confirmChatDelete}
          onCancel={() => setPendingChatDelete(null)}
        />
      )}
    </main>
  );
}
