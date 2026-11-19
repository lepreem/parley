import { Hono } from "hono";
import * as projectsController from "../controllers/projects.controller";
import { conversationRateLimiter } from "../middleware/rateLimit.middleware";
import {
  requireAuth,
  requireFeature,
  type AuthEnv,
} from "../middleware/auth.middleware";

export const projectsRouter = new Hono<AuthEnv>();

// Projects are chat housekeeping like renaming one, so they share its budget.
projectsRouter.use(
  "*",
  requireAuth,
  requireFeature("projects"),
  conversationRateLimiter,
);

projectsRouter.get("/", ...projectsController.handleListProjects);
projectsRouter.post("/", ...projectsController.handleCreateProject);
projectsRouter.patch("/:projectId", ...projectsController.handleUpdateProject);
projectsRouter.delete("/:projectId", ...projectsController.handleDeleteProject);
