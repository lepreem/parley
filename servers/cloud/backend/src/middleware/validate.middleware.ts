import type { Env, MiddlewareHandler } from "hono";
import type { z } from "zod";

export type Target = "json" | "param" | "query";

/**
 * What a validate() middleware checks, readable from outside: agentTool reads
 * it to tell the model what a route takes, so a route's schema is written
 * once, for the browser and the model alike.
 */
export const VALIDATES = Symbol("validates");
export type Validates = { target: Target; schema: z.ZodTypeAny };

const INVALID_MESSAGE: Record<Target, string> = {
  json: "Invalid request body",
  param: "Invalid request parameters",
  query: "Invalid request query",
};

function readTarget(c: Parameters<MiddlewareHandler>[0], target: Target) {
  switch (target) {
    // An empty or malformed body parses as null, so a schema that preprocesses
    // (e.g. coercing an absent body to {}) still gets to decide.
    case "json":
      return c.req.json().catch(() => null);
    case "param":
      return c.req.param();
    case "query":
      return c.req.query();
  }
}

/**
 * Parses one part of the request with `schema` and answers 400 when it
 * doesn't fit. The handler reads the parsed value, typed, with
 * `c.req.valid(target)`.
 *
 * Parsing is async so a schema with async refinements works too. A body's
 * error surfaces the schema's own message (e.g. "Not a valid YouTube URL"); a
 * generic string would make every custom message in the schema dead code.
 */
export function validate<T extends Target, S extends z.ZodTypeAny>(
  target: T,
  schema: S,
): MiddlewareHandler<Env, string, { out: { [K in T]: z.output<S> } }> & {
  [VALIDATES]: Validates;
} {
  const middleware: MiddlewareHandler<
    Env,
    string,
    { out: { [K in T]: z.output<S> } }
  > = async (c, next) => {
    const result = await schema.safeParseAsync(await readTarget(c, target));
    if (!result.success) {
      const message =
        target === "json"
          ? (result.error.issues[0]?.message ?? INVALID_MESSAGE.json)
          : INVALID_MESSAGE[target];
      return c.json({ message }, 400);
    }

    c.req.addValidatedData(target, result.data);
    await next();
  };
  return Object.assign(middleware, {
    [VALIDATES]: { target, schema } satisfies Validates,
  });
}
