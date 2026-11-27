import { defaultAvatar } from "@parley/contract/avatars";
import type { ProfileResponse } from "@parley/contract/profile";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { profilePatchBodySchema } from "../schema/profile.schema";
import * as data from "../data";

/** GET /profile: how the signed-in user appears. */
export const handleGetProfile = authed.createHandlers(async (c) => {
  const { userId } = c.var;
  const { avatar, username } = await data.users.findProfile(userId);
  return c.json({
    avatar: avatar ?? defaultAvatar(userId),
    username,
  } satisfies ProfileResponse);
});

/** PATCH /profile: picks their picture, their username, or both. */
export const handlePatchProfile = authed.createHandlers(
  validate("json", profilePatchBodySchema),
  async (c) => {
    const { userId } = c.var;
    const { avatar, username } = await data.users.updateProfile(
      userId,
      c.req.valid("json"),
    );
    return c.json({
      avatar: avatar ?? defaultAvatar(userId),
      username,
    } satisfies ProfileResponse);
  },
);
