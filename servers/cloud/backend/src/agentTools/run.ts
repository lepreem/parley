import type { Hono } from "hono";
import { agentCallEnv, type AgentCallUser } from "./agentCallUser";
import type { AgentTool } from "./registry";

/**
 * The most of an answer the model reads. A long list of chats is the
 * likeliest to reach it; the model is told the rest was cut.
 */
const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** What the model is told when a call can't be made at all. */
function failure(message: string) {
  return JSON.stringify({ status: 400, body: { message } });
}

/**
 * The request a call becomes: each argument where the route reads it, the
 * path's from the path, the query's in the query string, the body's as JSON.
 */
function requestFor(tool: AgentTool, args: Record<string, unknown>) {
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    const target = tool.targetOf[field];
    if (target === "query") query.set(field, String(value));
    else if (target === "json") body[field] = value;
    // A path parameter is filled in below; an argument the route doesn't
    // take is dropped, as the route's own schema would drop it.
  }

  let missing: string | undefined;
  const path = tool.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = args[name];
    if (typeof value !== "string" || value === "") missing ??= name;
    return encodeURIComponent(String(value));
  });
  if (missing) return { missing };

  const search = query.size > 0 ? `?${query}` : "";
  const sendsBody = Object.values(tool.targetOf).includes("json");
  return {
    url: `${path}${search}`,
    init: {
      method: tool.method,
      ...(sendsBody
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
  };
}

/**
 * Makes the call the model asked for, as `user`, by sending the route's
 * request to the app in this process. Validation, the tier's checks and the
 * route's answers are the ones a request from the browser gets, and the
 * answer goes back to the model as it came: a 404 tells it as much as a 200.
 */
export async function runAgentTool(
  app: Hono,
  tool: AgentTool,
  rawArguments: string,
  user: AgentCallUser,
  signal?: AbortSignal,
): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(rawArguments || "{}");
  } catch {
    return failure("The arguments weren't valid JSON");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return failure("The arguments must be a JSON object");

  const request = requestFor(tool, args as Record<string, unknown>);
  if ("missing" in request) return failure(`${request.missing} is required`);

  const response = await app.request(
    request.url,
    { ...request.init, ...(signal ? { signal } : {}) },
    agentCallEnv(user),
  );
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the model reads the text.
  }

  const output = JSON.stringify({ status: response.status, body });
  return output.length > MAX_TOOL_OUTPUT_CHARS
    ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}… (cut: the answer was ${output.length} characters)`
    : output;
}
