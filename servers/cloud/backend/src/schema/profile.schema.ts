import { z } from "zod";
import {
  AVATAR_COLORS,
  AVATAR_GLYPHS,
  type UpdateProfileBody,
} from "@parley/contract/avatars";
import { takesBody } from "@parley/server-kit/http/takesBody";

/** Body for PATCH /profile: a picture, both ids from the offered lists. */
export const profilePatchBodySchema = takesBody<UpdateProfileBody>()(
  z.object({
    avatar: z.object({
      glyph: z.enum(AVATAR_GLYPHS),
      color: z.enum(AVATAR_COLORS),
    }),
  }),
);
