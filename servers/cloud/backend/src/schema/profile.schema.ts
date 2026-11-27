import { z } from "zod";
import { AVATAR_COLORS, AVATAR_GLYPHS } from "@parley/contract/avatars";
import {
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  type UpdateProfileBody,
} from "@parley/contract/profile";
import { takesBody } from "@parley/server-kit/http/takesBody";

/**
 * Control characters, zero-width spaces and the marks that flip text
 * direction: none show as anything, and the flips can make a name read as
 * another. The zero-width joiner stays, since emoji are built with it.
 */
const UNPRINTED = /^[^\p{Cc}\u200b\u202a-\u202e\u2066-\u2069]*$/u;

/**
 * Body for PATCH /profile: a picture, both ids from the offered lists, a
 * username, or both. The username is tidied before its length is checked, and
 * one that's only spaces clears it, as null does.
 */
export const profilePatchBodySchema = takesBody<UpdateProfileBody>()(
  z
    .object({
      avatar: z
        .object({
          glyph: z.enum(AVATAR_GLYPHS),
          color: z.enum(AVATAR_COLORS),
        })
        .optional(),
      username: z
        .string()
        .transform(normalizeUsername)
        .pipe(
          z
            .string()
            .max(USERNAME_MAX_LENGTH)
            .regex(UNPRINTED, "No control characters")
            .nullable(),
        )
        .nullable()
        .optional(),
    })
    .refine(
      (body) => body.avatar !== undefined || body.username !== undefined,
      "Nothing to change",
    ),
);
