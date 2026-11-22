/**
 * Parley's own routes as tools the chat model can call for the user whose
 * turn it's answering: `agentTools.<what>`.
 *
 * A route becomes one by being wrapped in agentTool where it's declared. Once
 * the app is built, install() finds every wrapped route under its full path;
 * a turn then offers them to the model and runs each call the model makes by
 * sending the route's request to the app, in this process, as that user (see
 * agentCallUser.ts for why nothing from outside can do the same).
 */

import type { Hono } from "hono";
import { logger } from "@parley/server-kit/runtime/logger";
import type { chat } from "../ai";
import type { AgentCallUser } from "./agentCallUser";
import { collectAgentTools, definitionsFor, type AgentTool } from "./registry";
import { runAgentTool } from "./run";

export { agentTool } from "./agentTool";
export { readAgentCallUser } from "./agentCallUser";

const log = logger.child({ component: "agent-tools" });

let installed: { app: Hono; tools: Map<string, AgentTool> } | undefined;

/**
 * Finds the tools among the app's routes. Called once, after the last
 * app.route(): the turn code is imported by the routes, so it can't import
 * the app back.
 */
export function install(app: Hono): void {
  installed = { app, tools: collectAgentTools(app) };
}

/** Which turn the tools are for. */
export type Turn = {
  /** Whose turn it is: every call runs as them. */
  user: AgentCallUser;
  /** The chat it's in, which the model is told so it needn't look it up. */
  conversationId: string;
  /** Hears of each call to an offered tool as it starts. */
  onCall: (name: string) => void;
};

/** The tools for one turn; none before install(). */
export function forTurn({
  user,
  conversationId,
  onCall,
}: Turn): chat.FunctionTools {
  const current = installed;
  if (!current) return { definitions: [], instructions: "", run: notInstalled };

  const definitions = definitionsFor(current.tools, user.tier);
  const offered = new Set(definitions.map((definition) => definition.name));
  return {
    definitions,
    // The same from turn to turn of a chat, so it sits in the cached prefix.
    instructions: `You are inside Parley, a chat app, and can act in it for the user with your tools. Only do what the user asked for. This chat's id is ${conversationId}.`,
    run: async (name, rawArguments, signal) => {
      log.info("Agent tool called", { conversationId, tool: name });
      const tool = current.tools.get(name);
      // Offered or not is checked again here: a model can name any tool.
      if (!tool || !offered.has(name))
        return JSON.stringify({
          status: 404,
          body: { message: `There's no tool called ${name}` },
        });
      onCall(name);
      return runAgentTool(current.app, tool, rawArguments, user, signal);
    },
  };
}

async function notInstalled(): Promise<string> {
  throw new Error("agentTools.install() hasn't been called");
}
