import { Hono } from "hono";
import * as profileController from "../controllers/profile.controller";
import { profileRateLimiter } from "../middleware/rateLimit.middleware";
import { requireAuth, type AuthEnv } from "../middleware/auth.middleware";

export const profileRouter = new Hono<AuthEnv>();

profileRouter.use("*", requireAuth, profileRateLimiter);

profileRouter.get("/", ...profileController.handleGetProfile);
profileRouter.patch("/", ...profileController.handlePatchProfile);
