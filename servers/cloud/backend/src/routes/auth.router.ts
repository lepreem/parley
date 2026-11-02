import { Hono } from "hono";
import * as authController from "../controllers/auth.controller";
import { requireAuth } from "../middleware/auth.middleware";
import {
  authCallbackRateLimiter,
  authGuestRateLimiter,
  authLoginRateLimiter,
  authLogoutRateLimiter,
  authMeRateLimiter,
  authRefreshRateLimiter,
} from "../middleware/rateLimit.middleware";

export const authRouter = new Hono();

authRouter.get("/login", authLoginRateLimiter, authController.handleLogin);
authRouter.get(
  "/callback",
  authCallbackRateLimiter,
  authController.handleCallback,
);
authRouter.get(
  "/me",
  authMeRateLimiter,
  requireAuth,
  ...authController.handleMe,
);
authRouter.post(
  "/refresh",
  authRefreshRateLimiter,
  authController.handleRefresh,
);
authRouter.get("/guest", authMeRateLimiter, authController.handleGuestStatus);
authRouter.post(
  "/guest",
  authGuestRateLimiter,
  authController.handleGuestSignIn,
);
authRouter.post("/logout", authLogoutRateLimiter, authController.handleLogout);
