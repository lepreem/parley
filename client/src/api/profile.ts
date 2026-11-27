import type {
  ProfileResponse,
  UpdateProfileBody,
} from "@parley/contract/profile";
import { apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export async function fetchProfile(server: Server): Promise<ProfileResponse> {
  return apiJson<ProfileResponse>(server, "/profile");
}

/** Saves whichever of their picture and username the body has. */
export async function updateProfile(
  server: Server,
  changes: UpdateProfileBody,
): Promise<ProfileResponse> {
  return apiJson<ProfileResponse>(
    server,
    "/profile",
    jsonRequest("PATCH", changes),
  );
}
