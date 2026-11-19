import type { Project, ProjectsResponse } from "@parley/contract";
import { MAX_PROJECTS } from "@parley/contract/limits";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  projectCreateBodySchema,
  projectReqParamSchema,
  projectUpdateBodySchema,
} from "../schema/projects.schema";
import * as data from "../data";

function toProjectJson(row: data.projects.ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /projects — the user's projects, most recently made first. */
export const handleListProjects = authed.createHandlers(async (c) => {
  const rows = await data.projects.findUserProjects(c.var.userId);
  return c.json({
    projects: rows.map(toProjectJson),
  } satisfies ProjectsResponse);
});

/** POST /projects */
export const handleCreateProject = authed.createHandlers(
  validate("json", projectCreateBodySchema),
  async (c) => {
    const row = await data.projects.createProject(
      c.var.userId,
      c.req.valid("json"),
    );
    if (!row)
      return c.json(
        {
          message: `You can have ${MAX_PROJECTS} projects. Delete one to make another.`,
        },
        409,
      );
    return c.json(toProjectJson(row), 201);
  },
);

/** PATCH /projects/:projectId — rename, or change the instructions. */
export const handleUpdateProject = authed.createHandlers(
  validate("param", projectReqParamSchema),
  validate("json", projectUpdateBodySchema),
  async (c) => {
    const row = await data.projects.updateProject(
      c.var.userId,
      c.req.valid("param").projectId,
      c.req.valid("json"),
    );
    if (!row) return c.json({ message: "Project not found" }, 404);
    return c.json(toProjectJson(row));
  },
);

/** DELETE /projects/:projectId — its chats stay, in no project. */
export const handleDeleteProject = authed.createHandlers(
  validate("param", projectReqParamSchema),
  async (c) => {
    const row = await data.projects.deleteOwnedProject(
      c.var.userId,
      c.req.valid("param").projectId,
    );
    if (!row) return c.json({ message: "Project not found" }, 404);
    return c.json({ message: "Project deleted" }, 200);
  },
);
