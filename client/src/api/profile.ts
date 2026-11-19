import type {
  Avatar,
  ProfileResponse,
  UpdateProfileBody,
} from "@parley/contract/avatars";
import { apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export async function fetchProfile(server: Server): Promise<ProfileResponse> {
  return apiJson<ProfileResponse>(server, "/profile");
}

export async function updateAvatar(
  server: Server,
  avatar: Avatar,
): Promise<ProfileResponse> {
  return apiJson<ProfileResponse>(
    server,
    "/profile",
    jsonRequest("PATCH", { avatar } satisfies UpdateProfileBody),
  );
}
