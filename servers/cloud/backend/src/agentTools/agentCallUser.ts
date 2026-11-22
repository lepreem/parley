import type { Tier } from "@parley/contract/tiers";

/**
 * The user an agent's tool call is made for: the one whose chat turn the model
 * is answering. Their session was checked when that turn's request came in,
 * and the tool call is part of the same turn, so it's not checked again. Its
 * rights are exactly theirs, tier included.
 */
export type AgentCallUser = { userId: string; tier: Tier };

// Known to this file only. A request from outside the process is bytes off a
// socket and can't carry a JavaScript symbol, so the only requests requireAuth
// takes for an agent's call are ones agentCallEnv made.
const AGENT_CALL_USER = Symbol("agentCallUser");

/** The Hono env an agent's tool call is sent to the app with. */
export function agentCallEnv(user: AgentCallUser) {
  return { [AGENT_CALL_USER]: user };
}

/** Who an agent's tool call is for; undefined for every other request. */
export function readAgentCallUser(env: unknown): AgentCallUser | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  return (env as { [AGENT_CALL_USER]?: AgentCallUser })[AGENT_CALL_USER];
}
