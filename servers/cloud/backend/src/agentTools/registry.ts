import type { Hono } from "hono";
import type { chat } from "../ai";
import { CAPABILITIES, type Tier } from "@parley/contract/tiers";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Target } from "../middleware/validate.middleware";
import { markOf, type AgentToolMeta } from "./agentTool";

type JsonObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

/** A route the model can call, with everything needed to call it. */
export type AgentTool = AgentToolMeta & {
  method: string;
  /** The full path, parameters and all: "/conversations/:conversationId". */
  path: string;
  /** Which part of the request each of the model's arguments goes in. */
  targetOf: Record<string, Target>;
  /** The route's params, query and body as one object, which the model fills. */
  parameters: JsonObjectSchema;
};

/** A schema as JSON Schema, read as the object every route input is. */
function objectSchemaOf(schema: Parameters<typeof zodToJsonSchema>[0]) {
  // "input": a preprocess or refine is described by the schema inside it,
  // which is what the model has to write.
  const json = zodToJsonSchema(schema, { effectStrategy: "input" }) as {
    type?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (json.type !== "object")
    throw new Error("A route input that isn't an object can't be a tool's");
  return { properties: json.properties ?? {}, required: json.required ?? [] };
}

/**
 * Every route marked with agentTool, found once the app has them all under
 * their full paths. Throws for two tools of one name, or two inputs of a
 * route that ask for the same field.
 */
export function collectAgentTools(app: Hono): Map<string, AgentTool> {
  const tools = new Map<string, AgentTool>();

  for (const route of app.routes) {
    const marked = markOf(route.handler);
    if (!marked) continue;
    if (tools.has(marked.name))
      throw new Error(`Two agent tools are called ${marked.name}`);

    const parameters: JsonObjectSchema = {
      type: "object",
      properties: {},
      required: [],
    };
    const targetOf: Record<string, Target> = {};
    for (const { target, schema } of marked.inputs) {
      const { properties, required } = objectSchemaOf(schema);
      for (const [field, fieldSchema] of Object.entries(properties)) {
        if (field in targetOf)
          throw new Error(`Agent tool ${marked.name} takes ${field} twice`);
        targetOf[field] = target;
        parameters.properties[field] = fieldSchema;
      }
      parameters.required.push(...required);
    }

    const { inputs: _inputs, ...meta } = marked;
    tools.set(marked.name, {
      ...meta,
      method: route.method,
      path: route.path,
      targetOf,
      parameters,
    });
  }
  return tools;
}

/**
 * The tools this tier is offered, as the model is told of them. Deletes wait for
 * an approval card, and a route behind a feature the tier lacks would only
 * turn the call away.
 */
export function definitionsFor(
  tools: ReadonlyMap<string, AgentTool>,
  tier: Tier,
): chat.FunctionTools["definitions"] {
  return [...tools.values()]
    .filter((tool) => tool.effect !== "delete")
    .filter((tool) => !tool.feature || CAPABILITIES[tier][tool.feature])
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}
