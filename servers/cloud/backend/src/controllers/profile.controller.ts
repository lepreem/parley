import { defaultAvatar, type ProfileResponse } from "@parley/contract/avatars";
import { authed } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { profilePatchBodySchema } from "../schema/profile.schema";
import * as data from "../data";

/** GET /profile: how the signed-in user appears. */
export const handleGetProfile = authed.createHandlers(async (c) => {
  const { userId } = c.var;
  const avatar = await data.users.findAvatar(userId);
  return c.json({
    avatar: avatar ?? defaultAvatar(userId),
  } satisfies ProfileResponse);
});

/** PATCH /profile: picks their picture. */
export const handlePatchProfile = authed.createHandlers(
  validate("json", profilePatchBodySchema),
  async (c) => {
    const { userId } = c.var;
    const { avatar } = c.req.valid("json");
    await data.users.setAvatar(userId, avatar);
    return c.json({ avatar } satisfies ProfileResponse);
  },
);
