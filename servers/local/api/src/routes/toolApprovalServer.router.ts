import { Hono } from "hono";
import { z } from "zod";
import { APPROVAL_TOOL_NAME } from "../../../core/ai/ai_chat_client";
import { memory } from "../memory";

/**
 * The MCP server a chat run's Claude Code sends its permission prompts to, as a
 * call to one tool. It speaks only the part of MCP's HTTP transport that takes:
 * each request gets one JSON response, and nothing is pushed.
 */
export const toolApprovalServerRouter = new Hono();

const callSchema = z.object({
  tool_name: z.string(),
  input: z.record(z.unknown()),
});

const APPROVAL_TOOL = {
  name: APPROVAL_TOOL_NAME,
  description: "Asks the person whether a tool call may go ahead.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

toolApprovalServerRouter.post("/", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!memory.toolApprovals.isOpen(token)) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const request = (await c.req.json().catch(() => null)) as {
    id?: string | number;
    method?: string;
    params?: { protocolVersion?: string; arguments?: unknown };
  } | null;
  // A notification has no id, and takes no answer.
  if (request?.id === undefined) return c.body(null, 202);

  const reply = (result: unknown) =>
    c.json({ jsonrpc: "2.0", id: request.id, result });
  const fail = (code: number, message: string) =>
    c.json({ jsonrpc: "2.0", id: request.id, error: { code, message } });

  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "parley-approvals", version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [APPROVAL_TOOL] });
    case "tools/call": {
      const call = callSchema.safeParse(request.params?.arguments);
      if (!call.success) return fail(INVALID_PARAMS, "Invalid tool call");
      const answer = await memory.toolApprovals.ask(
        token,
        call.data.tool_name,
        call.data.input,
      );
      return reply({
        content: [{ type: "text", text: JSON.stringify(answer) }],
      });
    }
    default:
      return fail(METHOD_NOT_FOUND, "Method not found");
  }
});

// MCP's optional stream of pushes from the server, which this one has no use for.
toolApprovalServerRouter.get("/", (c) => c.body(null, 405));
