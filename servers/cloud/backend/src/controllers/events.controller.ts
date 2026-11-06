import { authed } from "../middleware/auth.middleware";
import { eventHub } from "../sse/hub";

/** GET /events — the signed-in user's job updates, while they hold it open. */
export const handleEvents = authed.createHandlers((c) =>
  eventHub.stream(c, c.var.userId),
);
