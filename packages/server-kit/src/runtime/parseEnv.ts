import type { z } from "zod";

/**
 * `process.env` checked against `schema`. A process with a missing or invalid
 * variable lists every one wrong, under `label`, and exits: nothing can run
 * on an environment that doesn't fit.
 */
export function parseEnv<S extends z.ZodTypeAny>(
  schema: S,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error(`Invalid environment variables (${label}):`);
    for (const [key, errors] of Object.entries(
      result.error.flatten().fieldErrors,
    )) {
      console.error(`  ${key}: ${errors?.join(", ") ?? "invalid"}`);
    }
    process.exit(1);
  }
  return result.data;
}
