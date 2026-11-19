import { z } from "zod";
import type {
  CreateProjectConversationBody,
  MoveConversationBody,
  RenameConversationBody,
} from "@parley/contract";
import { MAX_TITLE_LENGTH } from "@parley/contract/limits";
import { takesBody } from "@parley/server-kit/http/takesBody";

export const conversationReqParamSchema = z.object({
  conversationId: z.string().uuid(),
});

const titleSchema = z
  .string()
  .trim()
  .min(1, "Title must not be empty")
  .max(MAX_TITLE_LENGTH, "Title is too long");

/**
 * Body for POST /conversations. Title is optional (the DB default applies), and
 * an empty/absent body parses as `null` in validate, so coerce it to {}.
 */
export const conversationCreateBodySchema =
  takesBody<CreateProjectConversationBody>()(
    z.preprocess(
      (body) => body ?? {},
      z.object({
        conversationTitle: titleSchema.optional(),
        projectId: z.string().uuid().optional(),
      }),
    ),
  );

/** Body for PUT /conversations/:id/project. */
export const conversationMoveBodySchema = takesBody<MoveConversationBody>()(
  z.object({
    projectId: z.string().uuid().nullable(),
  }),
);

/** Body for PATCH /conversations/:id — renaming requires a title. */
export const conversationPatchBodySchema = takesBody<RenameConversationBody>()(
  z.object({
    conversationTitle: titleSchema,
  }),
);
