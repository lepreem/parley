import { z } from "zod";
import type { CreateProjectBody, UpdateProjectBody } from "@parley/contract";
import {
  MAX_PROJECT_INSTRUCTIONS_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
} from "@parley/contract/limits";
import { takesBody } from "@parley/server-kit/http/takesBody";

export const projectReqParamSchema = z.object({
  projectId: z.string().uuid(),
});

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name must not be empty")
  .max(MAX_PROJECT_NAME_LENGTH, "Name is too long");

const instructionsSchema = z
  .string()
  .max(MAX_PROJECT_INSTRUCTIONS_LENGTH, "Instructions are too long");

/** Body for POST /projects. */
export const projectCreateBodySchema = takesBody<CreateProjectBody>()(
  z.object({
    name: nameSchema,
    instructions: instructionsSchema.optional(),
  }),
);

/** Body for PATCH /projects/:projectId: at least one thing to change. */
export const projectUpdateBodySchema = takesBody<UpdateProjectBody>()(
  z
    .object({
      name: nameSchema.optional(),
      instructions: instructionsSchema.optional(),
    })
    .refine(
      (body) => body.name !== undefined || body.instructions !== undefined,
      "Nothing to change",
    ),
);
