import { createEventHub } from "@parley/server-kit/sse/hub";

/**
 * The GET /events streams this instance's clients hold open, by user id: a
 * user hears only their own jobs' events.
 */
export const eventHub = createEventHub<string>();
