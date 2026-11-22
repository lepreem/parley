import { Hono } from "hono";
import * as projectsController from "../controllers/projects.controller";
import { conversationRateLimiter } from "../middleware/rateLimit.middleware";
import {
  requireAuth,
  requireFeature,
  type AuthEnv,
} from "../middleware/auth.middleware";
import { agentTool } from "../agentTools";

export const projectsRouter = new Hono<AuthEnv>();

// Projects are chat housekeeping like renaming one, so they share its budget.
projectsRouter.use(
  "*",
  requireAuth,
  requireFeature("projects"),
  conversationRateLimiter,
);

projectsRouter.get(
  "/",
  ...agentTool(
    {
      name: "list_projects",
      description:
        "List the user's projects, most recently made first, with each one's id, name and instructions.",
      effect: "read",
      feature: "projects",
    },
    projectsController.handleListProjects,
  ),
);
projectsRouter.post(
  "/",
  ...agentTool(
    {
      name: "create_project",
      description:
        "Make a project: a group of chats, with instructions every chat in it is answered with. Instructions are optional.",
      effect: "change",
      feature: "projects",
    },
    projectsController.handleCreateProject,
  ),
);
projectsRouter.patch("/:projectId", ...projectsController.handleUpdateProject);
projectsRouter.delete("/:projectId", ...projectsController.handleDeleteProject);
