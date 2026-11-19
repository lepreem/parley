import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MAX_PROJECT_NAME_LENGTH, MAX_PROJECTS } from "@parley/contract/limits";
import type { Project } from "../../api/projects";
import { useCreateProjectMutation } from "../../hooks/queries/useProjectQueries";
import { useServer } from "../../hooks/server/useServer";
import { Icon } from "../ui/Icon";
import { projectPath } from "./sections";

type ProjectListProps = {
  projects: readonly Project[];
  loading: boolean;
  /** The project being looked at, or the open chat's. */
  activeProjectId: string | null;
  /** Lets the mobile drawer close itself once a project has been chosen. */
  onOpen: () => void;
};

/** The sidebar's projects, and a way to make one. */
export function ProjectList({
  projects,
  loading,
  activeProjectId,
  onOpen,
}: ProjectListProps) {
  const server = useServer();
  const navigate = useNavigate();
  const createProject = useCreateProjectMutation();
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const full = projects.length >= MAX_PROJECTS;

  const stopNaming = () => {
    setNaming(false);
    setDraftName("");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = draftName.trim();
    stopNaming();
    if (!name) return;
    createProject.mutate(name, {
      onSuccess: (created) => {
        onOpen();
        navigate(projectPath(server, created.id));
      },
    });
  };

  return (
    <div className="pt-1">
      <div className="flex items-center justify-between pb-2 pl-3 pr-1">
        <p className="eyebrow text-faint">Projects</p>
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={full || createProject.isPending}
          aria-label="New project"
          title={
            full
              ? `You can have ${MAX_PROJECTS} projects. Delete one to make another.`
              : "New project"
          }
          className="rounded-md p-1 text-faint transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Icon name="plus" className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-0.5">
        {naming && (
          <form onSubmit={submit} className="px-1 py-0.5">
            <input
              autoFocus
              value={draftName}
              maxLength={MAX_PROJECT_NAME_LENGTH}
              placeholder="Project name"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={submit}
              onKeyDown={(event) => {
                if (event.key === "Escape") stopNaming();
              }}
              aria-label="Project name"
              className="w-full rounded-lg border border-signal bg-surface px-2.5 py-2 text-sm outline-none"
            />
          </form>
        )}

        {loading && projects.length === 0 ? (
          <div className="h-9 rounded-lg bg-surface/60" />
        ) : (
          projects.map((project) => (
            <Link
              key={project.id}
              to={projectPath(server, project.id)}
              onClick={onOpen}
              title={project.name}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                project.id === activeProjectId
                  ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line)]"
                  : "text-muted hover:bg-surface/70 hover:text-ink"
              }`}
            >
              <Icon name="folder" className="h-4 w-4 shrink-0" />
              <span className="truncate">{project.name}</span>
            </Link>
          ))
        )}

        {!loading && projects.length === 0 && !naming && (
          <p className="px-3 py-1 text-xs text-faint">
            Group chats and give them shared instructions.
          </p>
        )}
      </div>
    </div>
  );
}
