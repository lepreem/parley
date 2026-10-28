import { createEventHub } from "@parley/server-kit/sse/hub";

/** The local server has one user, so every open stream hears every event. */
export const EVERYONE = "everyone";

/** The GET /events streams this server's clients hold open. */
export const eventHub = createEventHub<typeof EVERYONE>();
