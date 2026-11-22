import type { Feature } from "@parley/contract/tiers";
import { VALIDATES, type Validates } from "../middleware/validate.middleware";

/**
 * What a tool does to the user's things. Only "read" and "change" are offered
 * to the model for now: a "delete" waits for an approval card the user
 * answers.
 */
type AgentToolEffect = "read" | "change" | "delete";

export type AgentToolMeta = {
  /** What the model calls it: snake_case, as tool names usually are. */
  name: string;
  /** What the model reads to decide when to use it. */
  description: string;
  effect: AgentToolEffect;
  /**
   * The feature the route is behind, if any. A tier without it isn't offered
   * the tool; the route turns it away regardless.
   */
  feature?: Feature;
};

export type MarkedRoute = AgentToolMeta & { inputs: Validates[] };

const AGENT_TOOL = Symbol("agentTool");

/**
 * Makes a route a tool the model can call, as the user whose turn it's
 * answering, with what the route's validate() calls check as its input:
 *
 *     router.patch("/:id", ...agentTool({ name, description, effect }, handlers))
 *
 * The handlers come back as they went in, so the route itself is unchanged.
 * The last one is marked, which is how collectAgentTools finds the route
 * among the app's once it's mounted under its full path.
 */
export function agentTool<const Handlers extends readonly unknown[]>(
  meta: AgentToolMeta,
  handlers: Handlers,
): Handlers {
  const inputs = handlers.flatMap((handler) =>
    typeof handler === "function" && VALIDATES in handler
      ? [handler[VALIDATES] as Validates]
      : [],
  );
  const last = handlers.at(-1);
  if (typeof last !== "function")
    throw new Error(`Agent tool ${meta.name} has no handler`);
  Object.assign(last, { [AGENT_TOOL]: { ...meta, inputs } });
  return handlers;
}

/** The tool a route's handler was marked as, if it was. */
export function markOf(handler: unknown): MarkedRoute | undefined {
  if (typeof handler !== "function") return undefined;
  const marked = (handler as { [AGENT_TOOL]?: MarkedRoute })[AGENT_TOOL];
  if (marked) return marked;
  // Hono wraps a sub-router's handler when that router has an error handler
  // of its own, keeping the original under this key.
  return markOf(
    (handler as { __COMPOSED_HANDLER?: unknown }).__COMPOSED_HANDLER,
  );
}
